package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.geraetesuche.GeraetesucheRepository.Box;
import com.voltpilot.api.geraetesuche.GeraetesucheRepository.Zeile;
import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.ComponentTemplateRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.ComponentTemplateDto;
import com.voltpilot.api.web.dto.GeraetesucheDto;
import com.voltpilot.api.zugriff.Geltungsbereich;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die Gerätesuche, Cloud-Seite ({@code docs/contracts/v2/mqtt-geraetesuche.md}; Konzept vp-portal-geraetesuche-konzept,
 * DP-1 C, DP-2 bis DP-7 A): Starten und Abbrechen senden einen Auftrag an die Box, Zwischenstand und Ergebnis der Box
 * schreiben die Suche fort, das Lesen gleicht jeden Fund mit den Komponenten der Anlage ab und ordnet ihn seiner Gruppe
 * zu. Gesucht wird hier nichts - Netze, Ports, Takt und Dauer bestimmt allein die Box (DP-5 A).
 *
 * <p>Das Recht ({@code geraet.einrichten} an der Anlage, DP-4 A) prüft der Controller; hier gilt der Zaun der Anfrage:
 * eine fremde Anlage, eine Box an einer anderen Anlage und eine unbekannte Suche sind dieselbe 404.
 */
@Service
public class GeraetesucheDienst {

    public static final String FAEHIGKEIT = "geraetesuche";
    /** Ohne Status-Herzschlag so lange gilt die Box als nicht erreichbar ({@code box_offline}). */
    static final Duration OFFLINE_NACH = Duration.ofMinutes(5);
    static final Duration VERLAUF = Duration.ofDays(30);
    static final int VERLAUF_HOECHSTENS = 200;
    private static final String WARTET = "wartet";
    private static final String LAEUFT = "laeuft";
    private static final String KEINE_ANTWORT = "keine_antwort";

    private final GeraetesucheRepository suchen;
    private final BoxFaehigkeiten faehigkeiten;
    private final ObjectProvider<GeraetesucheVersand> versand;
    private final KlopftAnSpeicher klopftAn;
    private final ComponentTemplateRepository vorlagen;
    private final Geltungsbereich geltungsbereich;
    private final ObjectMapper mapper;
    private Clock uhr = Clock.systemUTC();

    public GeraetesucheDienst(GeraetesucheRepository suchen, BoxFaehigkeiten faehigkeiten,
            ObjectProvider<GeraetesucheVersand> versand, KlopftAnSpeicher klopftAn,
            ComponentTemplateRepository vorlagen, Geltungsbereich geltungsbereich, ObjectMapper mapper) {
        this.suchen = suchen;
        this.faehigkeiten = faehigkeiten;
        this.versand = versand;
        this.klopftAn = klopftAn;
        this.vorlagen = vorlagen;
        this.geltungsbereich = geltungsbereich;
        this.mapper = mapper;
    }

    void uhrStellen(Clock clock) {
        uhr = clock;
    }

    // ------------------------------------------------------------------ Starten und Abbrechen

    /**
     * Startet eine Suche an der Box: sie hängt an dieser Anlage, meldet die Fähigkeit {@code geraetesuche}, war in den
     * letzten 5 Minuten zu hören, sucht nicht schon und hat in der letzten Stunde weniger als sechsmal gesucht. Die
     * Suche, ihr Protokoll und {@code vorDemVersand} (die Anfrage-Kennung) stehen in derselben Transaktion; der Auftrag
     * geht als letzter Schritt hinaus. Erreicht er die Box nicht, ist nichts geschrieben (409 {@code box_offline}).
     */
    @Transactional
    public GeraetesucheDto.Suche starten(UUID siteId, UUID deviceId, ProtokollAkteur wer,
            Consumer<GeraetesucheDto.Suche> vorDemVersand) {
        if (!geltungsbereich.siteVisible(siteId)) {
            throw GeraetesucheAbgelehnt.nichtGefunden();
        }
        Box box = suchen.box(deviceId).filter(b -> siteId.equals(b.siteId()) && !b.ausgebaut())
                .orElseThrow(GeraetesucheAbgelehnt::nichtGefunden);
        suchen.sperren(deviceId);
        Instant jetzt = uhr.instant();
        if (!faehigkeiten.kann(deviceId, FAEHIGKEIT)) {
            throw GeraetesucheAbgelehnt.nichtUnterstuetzt();
        }
        if (box.zuletztGesehen() == null || box.zuletztGesehen().isBefore(jetzt.minus(OFFLINE_NACH))) {
            throw GeraetesucheAbgelehnt.boxOffline(box.zuletztGesehen());
        }
        Optional<Zeile> offen = suchen.offene(deviceId);
        if (offen.isPresent() && !KEINE_ANTWORT.equals(zustand(offen.get(), jetzt))) {
            throw GeraetesucheAbgelehnt.laeuftSchon(offen.get().id());
        }
        List<Instant> starts = suchen.starts(deviceId, jetzt.minus(Duration.ofHours(1)));
        if (starts.size() >= GeraetesucheVertrag.MAX_JE_STUNDE) {
            throw GeraetesucheAbgelehnt.zuOft(starts.get(GeraetesucheVertrag.MAX_JE_STUNDE - 1)
                    .plus(Duration.ofHours(1)));
        }
        UUID tenant = TenantContext.get();
        UUID suchId = UUID.randomUUID();
        GeraetesucheAuftrag auftrag = GeraetesucheAuftrag.starten(tenant, siteId, deviceId, suchId, jetzt, null,
                wer.sub());
        suchen.anlegen(tenant, suchId, siteId, deviceId, jetzt, auftrag.gueltigBis(), wer);
        suchen.protokollPerson(tenant, siteId, deviceId, suchId, "gestartet", wer, jetzt);
        GeraetesucheDto.Suche antwort = antwort(suchen.finden(siteId, suchId).orElseThrow(), jetzt);
        vorDemVersand.accept(antwort);
        if (!senden(auftrag)) {
            throw GeraetesucheAbgelehnt.boxOffline(box.zuletztGesehen());
        }
        return antwort;
    }

    /**
     * Bricht eine Suche ab: an einer offenen Suche geht der Auftrag {@code abbrechen} mit der vollen {@code such_id}
     * hinaus, die Box meldet {@code abgebrochen}/{@code auf_wunsch}. Eine beendete Suche bleibt, wie sie ist, und es geht
     * nichts hinaus - die Antwort ist dieselbe Form.
     */
    @Transactional
    public GeraetesucheDto.Suche abbrechen(UUID siteId, UUID suchId, ProtokollAkteur wer) {
        Zeile z = sichtbar(siteId, suchId);
        Instant jetzt = uhr.instant();
        if (WARTET.equals(z.zustand()) || LAEUFT.equals(z.zustand())) {
            UUID tenant = TenantContext.get();
            if (senden(GeraetesucheAuftrag.abbrechen(tenant, siteId, z.deviceId(), suchId, jetzt, wer.sub()))) {
                suchen.abbruchGesendet(suchId, jetzt);
                suchen.protokollPerson(tenant, siteId, z.deviceId(), suchId, "abbruch", wer, jetzt);
            }
        }
        return antwort(suchen.finden(siteId, suchId).orElseThrow(), jetzt);
    }

    private boolean senden(GeraetesucheAuftrag auftrag) {
        GeraetesucheVersand weg = versand.getIfAvailable();
        return weg != null && weg.senden(auftrag.topic(),
                auftrag.json(mapper).toString().getBytes(StandardCharsets.UTF_8));
    }

    // ------------------------------------------------------------------ Lesen

    @Transactional(readOnly = true)
    public GeraetesucheDto.Suche eine(UUID siteId, UUID suchId) {
        return antwort(sichtbar(siteId, suchId), uhr.instant());
    }

    /** Die Suchen der letzten 30 Tage, jüngste zuerst; je Suche die Zahl der Funde je Gruppe, nie die Funde selbst. */
    @Transactional(readOnly = true)
    public GeraetesucheDto.Verlauf verlauf(UUID siteId, UUID deviceId) {
        if (!geltungsbereich.siteVisible(siteId)) {
            throw GeraetesucheAbgelehnt.nichtGefunden();
        }
        if (deviceId != null && suchen.box(deviceId).filter(b -> siteId.equals(b.siteId())).isEmpty()) {
            throw GeraetesucheAbgelehnt.nichtGefunden();
        }
        Instant jetzt = uhr.instant();
        List<GeraetesucheAbgleich.Komponente> komponenten = suchen.komponenten(siteId);
        List<GeraetesucheDto.VerlaufEintrag> eintraege = new ArrayList<>();
        for (Zeile z : suchen.verlauf(siteId, deviceId, jetzt.minus(VERLAUF), VERLAUF_HOECHSTENS)) {
            eintraege.add(new GeraetesucheDto.VerlaufEintrag(z.id(), z.deviceId(), zustand(z, jetzt), z.grund(),
                    z.ausgeloestAm(), urheber(z.akteur()), z.dauerMs(),
                    zaehler(suchen.funde(z.id()), komponenten)));
        }
        return new GeraetesucheDto.Verlauf(List.copyOf(eintraege));
    }

    private Zeile sichtbar(UUID siteId, UUID suchId) {
        if (!geltungsbereich.siteVisible(siteId)) {
            throw GeraetesucheAbgelehnt.nichtGefunden();
        }
        return suchen.finden(siteId, suchId).orElseThrow(GeraetesucheAbgelehnt::nichtGefunden);
    }

    /**
     * Was gespeichert ist, mit dem abgeleiteten {@code keine_antwort}: 30 s ohne Zwischenstand oder Ergebnis. Eine
     * spätere Meldung der Box gilt trotzdem - gespeichert ist nur, was die Box gesagt hat.
     */
    static String zustand(Zeile z, Instant jetzt) {
        if (!WARTET.equals(z.zustand()) && !LAEUFT.equals(z.zustand())) {
            return z.zustand();
        }
        Instant zuletzt = z.letzteMeldungAm() != null ? z.letzteMeldungAm() : z.ausgeloestAm();
        return zuletzt.isBefore(jetzt.minus(GeraetesucheVertrag.KEINE_ANTWORT)) ? KEINE_ANTWORT : z.zustand();
    }

    private GeraetesucheDto.Suche antwort(Zeile z, Instant jetzt) {
        List<GeraetesucheBericht.Fund> funde = suchen.funde(z.id());
        List<GeraetesucheAbgleich.Komponente> komponenten = suchen.komponenten(z.siteId());
        List<ComponentTemplateDto> katalog = funde.stream()
                .anyMatch(f -> GeraetesucheVertrag.UEBERNEHMEN.equals(f.anbindung()))
                ? vorlagen.findNewest(BuiltinComponentTemplates.PUBLIC_KINDS) : List.of();
        Map<String, List<GeraetesucheDto.Fund>> gruppen = new LinkedHashMap<>();
        GeraetesucheVertrag.GRUPPEN.forEach(g -> gruppen.put(g, new ArrayList<>()));
        for (GeraetesucheBericht.Fund f : funde) {
            GeraetesucheAbgleich.Ergebnis a = GeraetesucheAbgleich.abgleichen(f, komponenten);
            gruppen.get(GeraetesucheVertrag.gruppe(f.anbindung(), a.abgleich(), f.hindernis()))
                    .add(fund(f, a, GeraetesucheAbgleich.vorlagen(f, katalog)));
        }
        List<GeraetesucheDto.Gruppe> liste = new ArrayList<>();
        gruppen.forEach((g, fs) -> liste.add(new GeraetesucheDto.Gruppe(g, List.copyOf(fs))));
        boolean beendet = z.beendetAm() != null;
        GeraetesucheBericht.Weitere w = z.weitere();
        return new GeraetesucheDto.Suche(z.id(), z.deviceId(), zustand(z, jetzt), z.grund(), z.ausgeloestAm(),
                urheber(z.akteur()), z.beendetAm(), z.dauerMs(), z.schritt(), z.erledigt(), z.gesamt(),
                beendet ? null : z.restS(), z.netze().stream().map(GeraetesucheDienst::netz).toList(), z.erkenner(),
                List.copyOf(liste), new GeraetesucheDto.Weitere(w.telefonTablet(), w.rechner(), w.unbekannt()),
                klopftAn(z, jetzt));
    }

    private List<GeraetesucheDto.LadesaeuleKlopftAn> klopftAn(Zeile z, Instant jetzt) {
        Set<String> eigene = new LinkedHashSet<>();
        suchen.box(z.deviceId()).map(Box::lanHost).filter(h -> h != null && !h.isBlank()).ifPresent(eigene::add);
        z.netze().forEach(n -> eigene.add(n.boxAdresse()));
        List<KlopftAn.Eintrag> eintraege = klopftAn.lesen(TenantContext.get(), z.deviceId(), List.copyOf(eigene),
                jetzt);
        return eintraege == null ? null : eintraege.stream().map(e -> new GeraetesucheDto.LadesaeuleKlopftAn(
                e.chargePointId(), e.ip(), e.zuerst(), e.zuletzt(), e.versuche())).toList();
    }

    /** Die Zahl der Funde je Gruppe, alle sechs in fester Reihenfolge. */
    static Map<String, Integer> zaehler(List<GeraetesucheBericht.Fund> funde,
            List<GeraetesucheAbgleich.Komponente> komponenten) {
        Map<String, Integer> z = new LinkedHashMap<>();
        GeraetesucheVertrag.GRUPPEN.forEach(g -> z.put(g, 0));
        for (GeraetesucheBericht.Fund f : funde) {
            String abgleich = GeraetesucheAbgleich.abgleichen(f, komponenten).abgleich();
            z.merge(GeraetesucheVertrag.gruppe(f.anbindung(), abgleich, f.hindernis()), 1, Integer::sum);
        }
        return z;
    }

    private static GeraetesucheDto.Fund fund(GeraetesucheBericht.Fund f, GeraetesucheAbgleich.Ergebnis a,
            List<String> vorlagen) {
        Map<String, Object> verbindung = new LinkedHashMap<>();
        GeraetesucheBericht.Verbindung v = f.verbindung();
        if (v.communication() != null) {
            verbindung.put("communication", v.communication());
        }
        verbindung.put("ip", v.ip());
        verbindung.put("port", v.port());
        if (v.serial() != null) {
            verbindung.put("serial", v.serial());
        }
        if (v.unitId() != null) {
            verbindung.put("unit_id", v.unitId());
        }
        GeraetesucheDto.Komponente komponente = a.komponente() == null ? null
                : new GeraetesucheDto.Komponente(a.komponente().id(), a.komponente().name());
        return new GeraetesucheDto.Fund(f.schluessel(), f.erkenner(), f.art(), f.hersteller(), f.modell(),
                f.seriennummer(), f.firmware(), f.familie(), f.spannung(), f.kanaele(), f.erkennung(), f.merkmale(),
                f.anbindung(), f.hindernis(), verbindung, f.liestBoxSchon(), a.abgleich(), komponente,
                a.bekannteAdresse(), vorlagen);
    }

    private static GeraetesucheDto.Netz netz(GeraetesucheBericht.Netz n) {
        return new GeraetesucheDto.Netz(n.rolle(), n.netz(), n.boxAdresse(), n.ausschnitt(), n.erreichbar(),
                n.aktiv());
    }

    private static GeraetesucheDto.Urheber urheber(ProtokollAkteur a) {
        return new GeraetesucheDto.Urheber(a.name(), a.rolle(), a.art());
    }

    // ------------------------------------------------------------------ Meldungen der Box

    /** Ein Zwischenstand der Box (Mandant aus dem Topic, schon gesetzt); false = verworfen. */
    @Transactional
    public boolean standEmpfangen(GeraetesucheBericht.Stand s, Instant empfangenUm) {
        return suchen.standSchreiben(s, empfangenUm);
    }

    /**
     * Das Ergebnis der Box: genau eines je Suche. Das Protokoll hält Zustand, Grund, Dauer, Netze und die Zahl der Funde
     * je Gruppe fest - nie die Funde selbst. false = verworfen (unbekannt, fremd, schon beendet).
     */
    @Transactional
    public boolean ergebnisEmpfangen(GeraetesucheBericht.Ergebnis e, Instant empfangenUm) {
        if (!suchen.ergebnisSchreiben(e, empfangenUm)) {
            return false;
        }
        suchen.protokollBeendet(e, zaehler(e.funde(), suchen.komponenten(e.siteId())), empfangenUm);
        return true;
    }

    // ------------------------------------------------------------------ Läufer

    /** DP-3 A: Suchen und Funde nach 30 Tagen; das Protokoll bleibt. */
    public int aufraeumen() {
        return suchen.aufraeumen();
    }
}
