package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.probe.ProbeRequest;
import com.voltpilot.api.probe.ProbeResult;
import com.voltpilot.api.probe.ProbeService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DatenquelleAbgelehnt.Schnittstelle;
import com.voltpilot.api.uems.DatenquelleAenderungRepository.Eintrag;
import com.voltpilot.api.uems.DatenquelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.DatenquelleRegeln.Antrag;
import com.voltpilot.api.uems.DatenquelleRegeln.AntragErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Art;
import com.voltpilot.api.uems.DatenquelleRegeln.Fehlerklasse;
import com.voltpilot.api.uems.DatenquelleRegeln.Grund;
import com.voltpilot.api.uems.DatenquelleRegeln.Herkunft;
import com.voltpilot.api.uems.DatenquelleRegeln.Kandidat;
import com.voltpilot.api.uems.DatenquelleRegeln.Protokoll;
import com.voltpilot.api.uems.DatenquelleRegeln.Pruefung;
import com.voltpilot.api.uems.DatenquelleRegeln.Quelle;
import com.voltpilot.api.uems.DatenquelleRegeln.Urteil;
import com.voltpilot.api.uems.DatenquelleRegeln.ZeitraumErgebnis;
import com.voltpilot.api.uems.DatenquelleRepository.Bearbeitung;
import com.voltpilot.api.uems.DatenquelleRepository.Box;
import com.voltpilot.api.uems.DatenquelleRepository.Datenquelle;
import com.voltpilot.api.uems.DatenquelleRepository.NeueDatenquelle;
import com.voltpilot.api.web.dto.DatenquelleDto;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Datenquellen einer Anlage (UEMS AP-06 IP-3): anlegen, bearbeiten, von GENAU der gewählten
 * Box prüfen, einer Box zuweisen — und jeder Schritt mit Urheber im Protokoll der Quelle.
 *
 * <p><b>Keine zweite Prüflogik.</b> Ob eine Box eine Quelle ab einem Zeitpunkt lesen darf,
 * entscheidet allein {@link DatenquelleRegeln#pruefeAntrag} in der festen Reihenfolge des
 * Vertrags ({@code docs/contracts/v2/data-source-assignment.md} §5); was ein Zeitraum darf,
 * {@link DatenquelleRegeln#pruefeZeitraum} (§4). Dieser Dienst sammelt nur die Eingänge — alle
 * Quellen des Kundenbereichs mit ihren Zeiträumen (eine Box darf Quellen anderer Anlagen lesen,
 * §1), die Namen der Boxen, das jüngste Prüfergebnis — und schreibt, was das Urteil erlaubt.
 * Die Exklusions-Constraints aus V20260911150000 sind die Rückwand: sie greifen nur noch bei
 * einem gleichzeitigen Schreibvorgang ({@code gleichzeitig_geaendert}).
 *
 * <p><b>Die Prüfung kommt nie aus der Anfrage.</b> Eine Zuständigkeit braucht die bestandene
 * Erreichbarkeitsprüfung von GENAU der Ziel-Box (E11). Dieser Dienst schreibt ihr Ergebnis nur,
 * wenn die Box selbst geantwortet hat, ins append-only Protokoll
 * ({@code erreichbarkeit_geprueft}) — und liest es beim Zuweisen genau dort wieder, gebunden an
 * Protokoll und Adresse, die geprüft wurden.
 *
 * <p><b>Anlegen oder wechseln.</b> Die ERSTE Box einer Quelle ist ein Antrag {@code anlegen} (die
 * gespeicherte Quelle ist der Kandidat, eine Steuerquelle darf ihre erste Box bekommen), jede
 * weitere ein {@code wechsel} (eine Steuerquelle wechselt nicht, §5 Grund 4). Ein Wechsel ab
 * {@code t} beendet den laufenden Zeitraum bei {@code t} und trägt den neuen ab {@code t} ein —
 * in EINER Transaktion unter der Zeilensperre der Quelle; „jetzt“ zählt auf die Minute
 * abgerundet, ein Zeitpunkt mit Sekunden wird abgelehnt, nie gerundet (§4).
 *
 * <p><b>Rechte:</b> bis AP-03 durchsetzt, gilt {@code authenticated()} plus die Mandanten-RLS —
 * eine fremde Anlage, Quelle oder Box ist 404, nie 403. Der Urheber kommt aus
 * {@link ProtokollAkteur}.
 */
@Service
public class DatenquelleService {

    /**
     * Die Zone der Sätze („Ab 10.04.2027 07:30 liest …“) — die der Vektor-Datei. Gespeichert wird
     * UTC; die Zone des Standorts (AP-02) übernimmt ein späteres Paket.
     */
    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /** Die Kennung des einen Lese-Schritts der Prüfung (Muster {@code op.id} des Probe-Vertrags). */
    static final String PRUEF_SCHRITT = "erreichbarkeit";

    /** SunSpec: Register 40000 trägt die Kennung „SunS“ — der Einstieg jeder SunSpec-Karte. */
    static final int SUNSPEC_KENNUNG = 40000;

    /** Der Satz einer bestandenen Prüfung — das Gegenstück zu {@code unreachable} (§7). */
    static final String SATZ_ERREICHT = "{box} erreicht {adresse}";

    /** Die Felder, die Eingänge der Antrags-Regeln sind — sie bleiben nach der ersten Box. */
    private static final Set<String> WEG = Set.of("protokoll", "adresse", "mehrere_leser", "steuerquelle");

    /** Welcher Constraint welchen Grund des Vertrags trägt (wie {@code UemsDatenquelleMigrationTest}). */
    private static final Map<String, Grund> GRUND_DES_CONSTRAINTS = Map.of(
            "data_source_assignment_eine_box_je_zeitpunkt", Grund.UEBERSCHNEIDUNG,
            "data_source_assignment_ein_weg_je_box", Grund.ADRESSE_AN_BOX_VERGEBEN,
            "data_source_assignment_nicht_leer", Grund.LEERER_ZEITRAUM,
            "data_source_assignment_volle_minute", Grund.KEINE_VOLLE_MINUTE,
            "data_source_protokoll_chk", Grund.PROTOKOLL_UNBEKANNT);

    private final DatenquelleRepository quellen;
    private final ZustaendigkeitRepository zustaendigkeiten;
    private final DatenquelleAenderungRepository protokoll;
    private final Geltungsbereich geltungsbereich;
    private final ProbeService probes;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private final Clock uhr;
    private UebergabeRepository uebergaben;
    private DatenquelleBudgetService budget;

    @org.springframework.beans.factory.annotation.Autowired
    void uebergaben(UebergabeRepository repo) { this.uebergaben = repo; }

    @org.springframework.beans.factory.annotation.Autowired
    void budget(DatenquelleBudgetService service) { this.budget = service; }

    /**
     * @param uhr die Uhr des Dienstes — ohne eigene {@link Clock}-Bean die Systemuhr (UTC);
     *     die Schnittstellen-Tests setzen eine, um die „jetzt“-Zeitpunkte der Vektor-Datei zu
     *     spielen
     */
    public DatenquelleService(DatenquelleRepository quellen, ZustaendigkeitRepository zustaendigkeiten,
            DatenquelleAenderungRepository protokoll, Geltungsbereich geltungsbereich, ProbeService probes,
            PlatformTransactionManager transaktionen, ObjectMapper json, ObjectProvider<Clock> uhr) {
        this.quellen = quellen;
        this.zustaendigkeiten = zustaendigkeiten;
        this.protokoll = protokoll;
        this.geltungsbereich = geltungsbereich;
        this.probes = probes;
        this.transaktion = new TransactionTemplate(transaktionen);
        this.json = json;
        this.uhr = uhr.getIfAvailable(Clock::systemUTC);
    }

    // ------------------------------------------------------------------- Lesen

    public DatenquelleDto.Liste alle(UUID siteId) {
        anlage(siteId);
        Lage lage = lage();
        return new DatenquelleDto.Liste(
                quellen.fuerAnlage(siteId).stream().map(q -> darstellung(q, lage)).toList());
    }

    public DatenquelleDto.Datenquelle eine(UUID siteId, UUID id) {
        return darstellung(finde(siteId, id), lage());
    }

    public DatenquelleDto.Protokoll protokoll(UUID siteId, UUID id) {
        finde(siteId, id);
        Map<UUID, Box> boxen = boxen();
        return new DatenquelleDto.Protokoll(
                protokoll.fuerQuelle(id).stream().map(e -> eintrag(e, boxen)).toList());
    }

    // ------------------------------------------------------------------ Anlegen

    /**
     * Legt eine Quelle als Entwurf an (Kennzeichen DQ-n vergibt die Datenbank). Mit gewählter Box
     * laufen vorher die Regeln des Antrags {@code anlegen} bis vor die Prüfung — ein Grund vor
     * {@code pruefung_fehlt} (Eindeutigkeit je Box, Doppel-Lesen, …) lehnt ab, bevor ein
     * Entwurf entsteht, den diese Box nie lesen dürfte.
     */
    public DatenquelleDto.Datenquelle anlegen(UUID siteId, DatenquelleDto.Anlegen a, ProtokollAkteur wer) {
        anlage(siteId);
        UUID mandant = mandant();
        Felder f = felder(a.name(), a.protokoll(), a.adresse(), a.geraeteIds(), a.netz(),
                a.mehrereLeser(), a.steuerquelle(), a.kadenzS());
        if (a.deviceId() != null) {
            Lage lage = lage();
            Box box = boxImZaun(a.deviceId(), lage.boxen());
            Antrag antrag = new Antrag(Art.ANLEGEN, null, f.kandidat(), box.id().toString(),
                    minute(lage.jetzt()), null, Boolean.TRUE.equals(a.vergleichBestaetigt()));
            AntragErgebnis e = DatenquelleRegeln.pruefeAntrag(antrag, regelQuellen(lage, null),
                    lage.boxNamen(), lage.jetzt(), ZONE);
            if (e.grund() != Grund.PRUEFUNG_FEHLT) {
                throw DatenquelleAbgelehnt.regel(e);
            }
        }
        Instant jetzt = minute(uhr.instant());
        Datenquelle neu = transaktion.execute(s -> {
            Datenquelle q = quellen.anlegen(new NeueDatenquelle(mandant, siteId, f.name(),
                    f.protokoll(), f.adresse(), f.geraeteIds(), f.netz(), f.mehrereLeser(),
                    f.steuerquelle(), f.kadenzS(), wer.sub()));
            Map<String, Object> werte = new LinkedHashMap<>();
            werte.put("kennzeichen", q.kennzeichen());
            werte.putAll(f.alsJson());
            eintragen(mandant, q.id(), "angelegt", null, null, null, werte, jetzt, wer);
            return q;
        });
        return darstellung(neu, lage());
    }

    // --------------------------------------------------------------- Bearbeiten

    /**
     * Schreibt die bearbeitbaren Felder (volle Darstellung) und protokolliert nur, was sich
     * ändert. Protokoll, Adresse, Ein-Leser-Eigenschaft und Steuerquelle — die Eingänge der
     * Antrags-Regeln — bleiben, sobald die Quelle einen Zeitraum hat ({@code weg_fest}): sonst
     * gälte ein Urteil über einen Weg, den es so nicht mehr gibt.
     */
    public DatenquelleDto.Datenquelle bearbeiten(UUID siteId, UUID id, DatenquelleDto.Bearbeiten b,
            ProtokollAkteur wer) {
        finde(siteId, id);
        UUID mandant = mandant();
        Felder f = felder(b.name(), b.protokoll(), b.adresse(), b.geraeteIds(), b.netz(),
                b.mehrereLeser(), b.steuerquelle(), b.kadenzS());
        Instant jetzt = minute(uhr.instant());
        transaktion.executeWithoutResult(s -> {
            Datenquelle q = quellen.sperren(id).orElseThrow(DatenquelleService::quelleFehlt);
            nichtArchiviert(q);
            Map<String, Object> vorher = Felder.aus(q).alsJson();
            Map<String, Object> nachher = f.alsJson();
            Map<String, Object> alt = new LinkedHashMap<>();
            Map<String, Object> neu = new LinkedHashMap<>();
            for (String feld : nachher.keySet()) {
                if (!Objects.equals(vorher.get(feld), nachher.get(feld))) {
                    alt.put(feld, vorher.get(feld));
                    neu.put(feld, nachher.get(feld));
                }
            }
            if (neu.isEmpty()) {
                return;
            }
            TreeSet<String> fest = new TreeSet<>(neu.keySet());
            fest.retainAll(WEG);
            if (!fest.isEmpty() && !zustaendigkeiten.fuerQuelle(id).isEmpty()) {
                throw DatenquelleAbgelehnt.schnittstelle(Schnittstelle.WEG_FEST,
                        "Protokoll, Adresse, Ein-Leser-Eigenschaft und Steuerquelle bleiben, sobald"
                                + " eine Box die Quelle liest oder gelesen hat — für einen anderen Weg"
                                + " bitte eine neue Datenquelle anlegen",
                        Map.of("felder", List.copyOf(fest)));
            }
            quellen.bearbeiten(id, new Bearbeitung(f.name(), f.protokoll(), f.adresse(),
                    f.geraeteIds(), f.netz(), f.mehrereLeser(), f.steuerquelle(), f.kadenzS()))
                    .orElseThrow(DatenquelleService::quelleFehlt);
            eintragen(mandant, id, "bearbeitet", null, null, alt, neu, jetzt, wer);
        });
        return eine(siteId, id);
    }

    // ------------------------------------------------------------------ Prüfen

    /**
     * Die Erreichbarkeitsprüfung von GENAU der Box {@code device_id} (E11): EIN Lese-Schritt über den
     * Probe-Kanal an die gespeicherte Adresse der Quelle. Ein Ergebnis, das die BOX feststellt
     * („ok“ oder eine Fehlerklasse der Box, §7), steht danach im Protokoll und zählt für eine
     * Zuständigkeit; schweigt die Box oder lehnt ihr Prüf-Kanal ab, zählt nichts und nichts wird
     * geschrieben. Die Antwort ist ein ehrlicher AUSGANG (200), auch wenn die Prüfung scheitert.
     */
    public DatenquelleDto.Pruefergebnis pruefen(UUID siteId, UUID id, DatenquelleDto.Pruefen p,
            ProtokollAkteur wer) {
        Datenquelle q = finde(siteId, id);
        nichtArchiviert(q);
        if (p.deviceId() == null) {
            throw DatenquelleAbgelehnt.anfrage("device_id", "Welche Box soll die Quelle prüfen?");
        }
        UUID mandant = mandant();
        Box box = boxImZaun(p.deviceId(), boxen());
        ProbeRequest.Op schritt = leseSchritt(q, p);
        long start = System.nanoTime();
        Optional<ProbeResult> antwort = probes.probeBox(box.id(), List.of(schritt), wer.sub());
        long dauerMs = (System.nanoTime() - start) / 1_000_000;
        Instant jetzt = uhr.instant();
        Bewertung b = bewerte(antwort, anzeigename(box), q.adresse());
        if (b.gewertet()) {
            Map<String, Object> neu = new LinkedHashMap<>();
            neu.put("protokoll", q.protokoll());
            neu.put("adresse", q.adresse());
            neu.put("dauer_ms", dauerMs);
            eintragen(mandant, q.id(), "erreichbarkeit_geprueft", box.id(), b.ergebnis(), null, neu,
                    minute(jetzt), wer);
        }
        return new DatenquelleDto.Pruefergebnis(dto(box.id(), Map.of(box.id(), box)), q.adresse(),
                b.ergebnis(), b.gewertet(), b.text(), jetzt, dauerMs, antwort.orElse(null));
    }

    /** Wie eine Antwort der Box zählt — rein, damit die Regel ohne Box prüfbar ist. */
    record Bewertung(String ergebnis, boolean gewertet, String text) {}

    static Bewertung bewerte(Optional<ProbeResult> antwort, String boxName, String adresse) {
        if (antwort.isEmpty()) {
            // Die Box hat geschwiegen: eine Aussage über die BOX, die nur die Cloud treffen kann —
            // nie ein Prüfergebnis über die Quelle (§7: eine Box meldet nie, dass sie schweigt).
            Fehlerklasse k = Fehlerklasse.BOX_MELDET_SICH_NICHT;
            return new Bewertung(k.code(), false, k.satz(boxName, adresse));
        }
        ProbeResult r = antwort.get();
        if (r.errorCode() != null) {
            // Die GANZE Anfrage abgelehnt (heute: rate_limited) — kein Lese-Ergebnis.
            return new Bewertung(r.errorCode(), false, r.message());
        }
        ProbeResult.OpResult zeile = r.results() == null ? null : r.results().stream()
                .filter(l -> PRUEF_SCHRITT.equals(l.id())).findFirst().orElse(null);
        if (zeile == null) {
            return new Bewertung(null, false, "Die Box hat die Prüfung nicht beantwortet — bitte erneut prüfen");
        }
        if (zeile.ok()) {
            return new Bewertung("ok", true, SATZ_ERREICHT.replace("{box}", boxName).replace("{adresse}", adresse));
        }
        Optional<Fehlerklasse> k = DatenquelleRegeln.fehlerklasse(zeile.errorCode(), Herkunft.BOX);
        if (k.isPresent()) {
            return new Bewertung(k.get().code(), true, k.get().satz(boxName, adresse));
        }
        // invalid_request, not_supported, rate_limited oder ein fremdes Wort: kein Leseergebnis,
        // wird verworfen (§7) — der Satz der Box geht unverändert an den Kunden.
        return new Bewertung(zeile.errorCode(), false, zeile.message());
    }

    // ------------------------------------------------------------------ Zuweisen

    /**
     * „Ab {@code effective_from} liest {@code device_id}“ — der Antrag {@code anlegen} (erste Box)
     * oder {@code wechsel}, geprüft von {@link DatenquelleRegeln#pruefeAntrag}; erlaubt, wird in
     * EINER Transaktion der laufende Zeitraum beendet und der neue eingetragen.
     */
    public DatenquelleDto.Zugewiesen zuweisen(UUID siteId, UUID id, DatenquelleDto.Zuweisen z,
            ProtokollAkteur wer) {
        finde(siteId, id);
        if (z.deviceId() == null) {
            throw DatenquelleAbgelehnt.anfrage("device_id", "Welche Box soll die Quelle lesen?");
        }
        UUID mandant = mandant();
        AntragErgebnis erlaubt;
        try {
            erlaubt = transaktion.execute(s -> zuweisenInDerTransaktion(mandant, id, z, wer));
        } catch (DataIntegrityViolationException e) {
            throw rueckwand(e);
        }
        return new DatenquelleDto.Zugewiesen(Urteil.ERLAUBT.code(), erlaubt.text(), erlaubt.hinweis(),
                erlaubt.vergleichsquelle(), eine(siteId, id));
    }

    private AntragErgebnis zuweisenInDerTransaktion(UUID mandant, UUID id, DatenquelleDto.Zuweisen z,
            ProtokollAkteur wer) {
        // Die Zeilensperre zuerst: wer danach liest, sieht den Stand, gegen den er schreibt.
        Datenquelle q = quellen.sperren(id).orElseThrow(DatenquelleService::quelleFehlt);
        nichtArchiviert(q);
        Lage lage = lage();
        Box box = boxImZaun(z.deviceId(), lage.boxen());
        Instant ab = z.effectiveFrom() == null ? minute(lage.jetzt()) : z.effectiveFrom().toInstant();
        List<ZustaendigkeitRepository.Zeitraum> eigene = lage.von(id);
        boolean wechsel = !eigene.isEmpty();
        String ziel = box.id().toString();
        boolean bestaetigt = Boolean.TRUE.equals(z.vergleichBestaetigt()) || q.vergleichsquelle();
        Antrag antrag = wechsel
                ? new Antrag(Art.WECHSEL, q.kennzeichen(), null, ziel, ab, pruefung(q, box.id()), bestaetigt)
                : new Antrag(Art.ANLEGEN, null, Felder.aus(q).kandidat(), ziel, ab, pruefung(q, box.id()),
                        bestaetigt);
        AntragErgebnis e = DatenquelleRegeln.pruefeAntrag(antrag, regelQuellen(lage, wechsel ? null : id),
                lage.boxNamen(), lage.jetzt(), ZONE);
        if (e.urteil() != Urteil.ERLAUBT) {
            throw DatenquelleAbgelehnt.regel(e);
        }

        // E6: erst vollständig vorrechnen, dann überhaupt einen Zeitraum anfassen. So kann eine
        // neue Quelle nie die ganze bestehende Auswahl einer Box in den Edge-Deckel laufen lassen.
        DatenquelleBudget.Ablehnung ueber = budget == null ? null : budget.pruefe(q.id(), box.id(), ab);
        if (ueber != null) {
            throw DatenquelleAbgelehnt.budget(ueber);
        }

        // Die Speicher-Regel (§4) über jeden Zeitraum, der sich ändert oder neu ist — dieselbe
        // Regel, die die Datenbank als Constraint trägt, hier mit dem Satz des Vertrags (ein
        // Wechsel genau zum Beginn eines geplanten Zeitraums ließe diesen leer zurück).
        List<DatenquelleRegeln.Zeitraum> vorher = regelZeitraeume(eigene);
        List<DatenquelleRegeln.Zeitraum> danach = e.zeitraeume();
        for (int i = 0; i < danach.size(); i++) {
            if (i < vorher.size() && vorher.get(i).equals(danach.get(i))) {
                continue;
            }
            List<DatenquelleRegeln.Zeitraum> andere = new ArrayList<>(danach);
            andere.remove(i);
            ZeitraumErgebnis zr = DatenquelleRegeln.pruefeZeitraum(andere, danach.get(i), lage.boxNamen());
            if (!zr.gueltig()) {
                throw DatenquelleAbgelehnt.zeitraum(zr);
            }
        }

        // Schreiben: erst beenden, dann eintragen (Ende alt = Beginn neu, §4).
        for (int i = 0; i < vorher.size(); i++) {
            Instant bis = danach.get(i).bis();
            if (!Objects.equals(vorher.get(i).bis(), bis) && !zustaendigkeiten.beenden(eigene.get(i).id(), bis)) {
                throw gleichzeitig(Grund.UEBERSCHNEIDUNG);
            }
        }
        DatenquelleRegeln.Zeitraum neuer = danach.get(danach.size() - 1);
        zustaendigkeiten.eintragen(mandant, id, box.id(), neuer.von(), neuer.bis(), wer.sub())
                .orElseThrow(DatenquelleService::quelleFehlt);
        if (e.vergleichsquelle() && !q.vergleichsquelle()) {
            quellen.alsVergleichsquelleKennzeichnen(id);
        }

        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("box", box.id().toString());
        neu.put("box_name", anzeigename(box));
        neu.put("ab", neuer.von().toString());
        if (e.hinweis() != null) {
            neu.put("hinweis", e.hinweis());
        }
        if (e.vergleichsquelle()) {
            neu.put("vergleichsquelle", true);
        }
        Map<String, Object> alt = null;
        if (wechsel) {
            ZustaendigkeitRepository.Zeitraum letzter = eigene.get(eigene.size() - 1);
            alt = new LinkedHashMap<>();
            alt.put("box", letzter.deviceId().toString());
            alt.put("box_name", lage.boxNamen().get(letzter.deviceId().toString()));
            alt.put("ab", letzter.effectiveFrom().toString());
        }
        eintragen(mandant, id, wechsel ? "zustaendigkeit_gewechselt" : "zustaendigkeit_begonnen", box.id(),
                null, alt, neu, neuer.von(), wer);
        return e;
    }

    /**
     * Das jüngste Prüfergebnis dieser Quelle von GENAU dieser Box — und nur, wenn es denselben
     * Weg geprüft hat, den die Quelle heute hat. Sonst keins ({@code pruefung_fehlt}).
     */
    private Pruefung pruefung(Datenquelle q, UUID box) {
        return protokoll.letztePruefung(q.id(), box)
                .filter(e -> {
                    JsonNode geprueft = lies(e.neuJson());
                    return q.protokoll().equals(geprueft.path("protokoll").asText(null))
                            && q.adresse().equals(geprueft.path("adresse").asText(null));
                })
                .map(e -> new Pruefung(box.toString(), e.ergebnis(), e.giltAb()))
                .orElse(null);
    }

    // ---------------------------------------------------------------- Die Lage

    /** Alles, woraus ein Urteil entsteht — einmal gelesen, unter RLS. */
    private record Lage(Instant jetzt, List<Datenquelle> quellen,
            Map<UUID, List<ZustaendigkeitRepository.Zeitraum>> zeitraeume, Map<UUID, Box> boxen) {

        List<ZustaendigkeitRepository.Zeitraum> von(UUID quelle) {
            return zeitraeume.getOrDefault(quelle, List.of());
        }

        /** Box-Kennung (UUID als Text) → der Name, den die Sätze der Regeln nennen. */
        Map<String, String> boxNamen() {
            Map<String, String> namen = new LinkedHashMap<>();
            boxen.values().forEach(b -> namen.put(b.id().toString(), anzeigename(b)));
            return namen;
        }
    }

    private Lage lage() {
        Map<UUID, List<ZustaendigkeitRepository.Zeitraum>> je = new LinkedHashMap<>();
        for (ZustaendigkeitRepository.Zeitraum z : zustaendigkeiten.alle()) {
            je.computeIfAbsent(z.dataSourceId(), k -> new ArrayList<>()).add(z);
        }
        return new Lage(uhr.instant(), quellen.alle(), je, boxen());
    }

    private Map<UUID, Box> boxen() {
        Map<UUID, Box> boxen = new LinkedHashMap<>();
        quellen.boxen().forEach(b -> boxen.put(b.id(), b));
        return boxen;
    }

    /** Die Quellen des Kundenbereichs in der Form der Regeln — {@code ohne} bleibt draußen. */
    private static List<Quelle> regelQuellen(Lage lage, UUID ohne) {
        return lage.quellen().stream()
                .filter(q -> !q.id().equals(ohne))
                .map(q -> new Quelle(q.kennzeichen(), q.protokoll(), q.adresse(), q.netz(),
                        q.steuerquelle(), q.mehrereLeser(), regelZeitraeume(lage.von(q.id()))))
                .toList();
    }

    private static List<DatenquelleRegeln.Zeitraum> regelZeitraeume(List<ZustaendigkeitRepository.Zeitraum> zs) {
        return zs.stream()
                .map(z -> new DatenquelleRegeln.Zeitraum(z.deviceId().toString(), z.effectiveFrom(), z.effectiveTo()))
                .toList();
    }

    // ------------------------------------------------------------ Darstellung

    private DatenquelleDto.Datenquelle darstellung(Datenquelle q, Lage lage) {
        List<ZustaendigkeitRepository.Zeitraum> zs = lage.von(q.id());
        String jetzt = DatenquelleRegeln.zustaendigeBox(regelZeitraeume(zs), lage.jetzt());
        return new DatenquelleDto.Datenquelle(q.id(), q.kennzeichen(), q.name(), q.siteId(), q.protokoll(),
                q.adresse(), q.geraeteIds(), q.netz(), q.mehrereLeser(), q.steuerquelle(), q.vergleichsquelle(),
                q.kadenzS(), q.archiviertAm(), jetzt == null ? null : dto(UUID.fromString(jetzt), lage.boxen()),
                zs.stream().map(z -> new DatenquelleDto.Zeitraum(dto(z.deviceId(), lage.boxen()),
                        z.effectiveFrom(), z.effectiveTo())).toList(), uebergabe(q.id(), lage));
    }

    private DatenquelleDto.Uebergabe uebergabe(UUID quelle, Lage lage) {
        var s = uebergaben == null ? null : uebergaben.stand(quelle);
        if (s == null || s.phase().equals("active")) return null;
        return new DatenquelleDto.Uebergabe("Übergabe ausstehend", s.faellig(),
                dto(s.leser(), lage.boxen()), dto(s.ziel(), lage.boxen()));
    }

    private DatenquelleDto.ProtokollEintrag eintrag(Eintrag e, Map<UUID, Box> boxen) {
        return new DatenquelleDto.ProtokollEintrag(e.id(), e.art(),
                e.deviceId() == null ? null : dto(e.deviceId(), boxen), e.ergebnis(),
                e.altJson() == null ? null : lies(e.altJson()), e.neuJson() == null ? null : lies(e.neuJson()),
                e.giltAb(), new DatenquelleDto.Urheber(e.actorName(), e.actorRolle(), e.actorArt()),
                e.createdAt());
    }

    /** Eine Box, die es nicht mehr gibt (entfernt), bleibt im Zeitraum stehen — nur ohne Namen. */
    static DatenquelleDto.Box dto(UUID id, Map<UUID, Box> boxen) {
        Box b = boxen.get(id);
        return b == null ? new DatenquelleDto.Box(id, null, null)
                : new DatenquelleDto.Box(id, anzeigename(b), b.siteId());
    }

    /** Der Kundenname der Box, sonst die Geräte-ID vom Aufkleber. */
    static String anzeigename(Box b) {
        if (b.name() != null && !b.name().isBlank()) {
            return b.name().strip();
        }
        return b.externalRef() != null && !b.externalRef().isBlank() ? b.externalRef().strip() : b.id().toString();
    }

    // ----------------------------------------------------------------- Felder

    /** Die bearbeitbaren Felder in der gespeicherten Form. */
    private record Felder(String name, String protokoll, String adresse, List<Integer> geraeteIds,
            String netz, boolean mehrereLeser, boolean steuerquelle, Integer kadenzS) {

        static Felder aus(Datenquelle q) {
            return new Felder(q.name(), q.protokoll(), q.adresse(), q.geraeteIds(), q.netz(),
                    q.mehrereLeser(), q.steuerquelle(), q.kadenzS());
        }

        /**
         * Der Kandidat des Antrags {@code anlegen}. Er kennt keine Steuerquelle; eine
         * Steuerquelle verträgt nie einen zweiten Leser (§6) — also geht sie als Ein-Leser-Quelle
         * hinein, dasselbe Urteil ohne eine zweite Regel.
         */
        Kandidat kandidat() {
            return new Kandidat(protokoll, adresse, netz, geraeteIds, mehrereLeser && !steuerquelle);
        }

        Map<String, Object> alsJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", name);
            m.put("protokoll", protokoll);
            m.put("adresse", adresse);
            m.put("geraete_ids", geraeteIds);
            m.put("netz", netz);
            m.put("mehrere_leser", mehrereLeser);
            m.put("steuerquelle", steuerquelle);
            m.put("kadenz_s", kadenzS);
            return m;
        }
    }

    private static Felder felder(String name, String protokoll, String adresse, List<Integer> geraeteIds,
            String netz, Boolean mehrereLeser, Boolean steuerquelle, Integer kadenzS) {
        String n = text(name);
        if (n == null) {
            throw DatenquelleAbgelehnt.anfrage("name", "Jede Datenquelle braucht einen Namen, z. B. „WAGO-Steuerung Halle 2“.");
        }
        if (n.length() > 120) {
            throw DatenquelleAbgelehnt.anfrage("name", "Der Name hat höchstens 120 Zeichen.");
        }
        if (protokoll == null || protokoll.isBlank()) {
            throw DatenquelleAbgelehnt.anfrage("protokoll", "Welches Protokoll spricht die Quelle?");
        }
        if (Protokoll.vonCode(protokoll).isEmpty()) {
            throw DatenquelleAbgelehnt.grund(Grund.PROTOKOLL_UNBEKANNT);
        }
        String a;
        try {
            a = DatenquelleAdresse.normalisiere(protokoll, adresse);
        } catch (DatenquelleAdresse.Ungueltig e) {
            throw DatenquelleAbgelehnt.anfrage("adresse", e.getMessage());
        }
        TreeSet<Integer> ids = new TreeSet<>();
        for (Integer i : geraeteIds == null ? List.<Integer>of() : geraeteIds) {
            if (i == null || i < 0) {
                throw DatenquelleAbgelehnt.anfrage("geraete_ids", "Geräte-IDs sind ganze Zahlen ab 0.");
            }
            ids.add(i);
        }
        if (kadenzS == null) {
            throw DatenquelleAbgelehnt.anfrage("kadenz_s", "Wie oft soll die Box die Quelle lesen (in Sekunden)?");
        }
        if (kadenzS < 1 || kadenzS > 86_400) {
            throw DatenquelleAbgelehnt.anfrage("kadenz_s", "Der Lesetakt liegt zwischen einer Sekunde und einem Tag.");
        }
        return new Felder(n, protokoll, a, List.copyOf(ids), text(netz), Boolean.TRUE.equals(mehrereLeser),
                Boolean.TRUE.equals(steuerquelle), kadenzS);
    }

    /**
     * Der eine Lese-Schritt der Prüfung ({@code op: read} des Probe-Vertrags) — Host und Port von
     * der Quelle. Heute kennt der Prüf-Kanal der Box nur Modbus-Register; für MQTT, HTTP und
     * OCPP gibt es noch keinen Schritt, der die Adresse der QUELLE prüft.
     */
    private static ProbeRequest.Op leseSchritt(Datenquelle q, DatenquelleDto.Pruefen p) {
        Protokoll proto = Protokoll.vonCode(q.protokoll()).orElseThrow();
        if (proto != Protokoll.MODBUS_TCP && proto != Protokoll.SUNSPEC_MODBUS) {
            throw DatenquelleAbgelehnt.schnittstelle(Schnittstelle.PRUEFUNG_NICHT_MOEGLICH,
                    "Für „" + proto.kundenwort() + "“ kann eine Box die Erreichbarkeit noch nicht prüfen"
                            + " — diese Quelle lässt sich deshalb noch keiner Box zuweisen",
                    Map.of("protokoll", q.protokoll()));
        }
        if (p.unitId() == null || p.unitId() < 0 || p.unitId() > 255) {
            throw DatenquelleAbgelehnt.anfrage("unit_id", "Welche Geräte-ID (0 bis 255) soll die Box lesen?");
        }
        Integer register = p.register() != null ? p.register()
                : proto == Protokoll.SUNSPEC_MODBUS ? SUNSPEC_KENNUNG : null;
        if (register == null || register < 0 || register > 65_535) {
            throw DatenquelleAbgelehnt.anfrage("register", "Welches Register (0 bis 65535) soll die Box lesen?");
        }
        String art = p.registerKind() == null ? "holding" : p.registerKind();
        if (!art.equals("holding") && !art.equals("input")) {
            throw DatenquelleAbgelehnt.anfrage("register_kind", "Die Registerart ist „holding“ oder „input“.");
        }
        String typ = p.dataType() != null ? p.dataType() : p.register() == null ? "u32" : "u16";
        if (!Set.of("u16", "s16", "u32", "s32", "float32").contains(typ)) {
            throw DatenquelleAbgelehnt.anfrage("data_type", "Der Datentyp ist u16, s16, u32, s32 oder float32.");
        }
        if (p.wordOrder() != null && !p.wordOrder().equals("big") && !p.wordOrder().equals("little")) {
            throw DatenquelleAbgelehnt.anfrage("word_order", "Die Wortfolge ist „big“ oder „little“.");
        }
        DatenquelleAdresse.HostPort hp = DatenquelleAdresse.hostPort(q.adresse());
        return new ProbeRequest.Op(PRUEF_SCHRITT, hp.host(), hp.port(), p.unitId(), art, register, typ,
                p.wordOrder(), null, null);
    }

    // ------------------------------------------------------------------ Gerüst

    void anlage(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }

    /** Die Quelle DIESER Anlage im Zaun — sonst 404 (auch für eine fremde, nie 403). */
    private Datenquelle finde(UUID siteId, UUID id) {
        anlage(siteId);
        return quellen.finde(id).filter(q -> q.siteId().equals(siteId))
                .orElseThrow(DatenquelleService::quelleFehlt);
    }

    private static ResponseStatusException quelleFehlt() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Datenquelle nicht gefunden.");
    }

    /** Die genannte Box im Kundenbereich — eine fremde oder unbekannte ist 404. */
    private static Box boxImZaun(UUID id, Map<UUID, Box> boxen) {
        Box b = boxen.get(id);
        if (b == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden.");
        }
        return b;
    }

    private static void nichtArchiviert(Datenquelle q) {
        if (q.archiviertAm() != null) {
            throw DatenquelleAbgelehnt.schnittstelle(Schnittstelle.QUELLE_ARCHIVIERT,
                    q.kennzeichen() + " ist archiviert", Map.of("kennzeichen", q.kennzeichen()));
        }
    }

    static UUID mandant() {
        UUID t = TenantContext.get();
        if (t == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
        return t;
    }

    static DatenquelleAbgelehnt gleichzeitig(Grund g) {
        return DatenquelleAbgelehnt.schnittstelle(Schnittstelle.GLEICHZEITIG_GEAENDERT,
                "Gleichzeitig hat sich an den Zuständigkeiten dieser Quelle etwas geändert — bitte neu"
                        + " laden und erneut versuchen",
                Map.of("grund", g.code()));
    }

    /**
     * Die Rückwand hat gegriffen: ein Constraint aus V20260911150000 — also hat ein
     * gleichzeitiger Schreibvorgang die Lage geändert, die die Regeln gerade noch erlaubt hatten.
     */
    static RuntimeException rueckwand(DataIntegrityViolationException e) {
        String text = String.valueOf(e.getMostSpecificCause().getMessage());
        if (text.contains("data_source_assignment_box_fk")) {
            return new ResponseStatusException(HttpStatus.NOT_FOUND, "Box nicht gefunden.");
        }
        for (Map.Entry<String, Grund> c : GRUND_DES_CONSTRAINTS.entrySet()) {
            if (text.contains(c.getKey())) {
                return gleichzeitig(c.getValue());
            }
        }
        return e;
    }

    void eintragen(UUID mandant, UUID quelle, String art, UUID box, String ergebnis,
            Map<String, Object> alt, Map<String, Object> neu, Instant giltAb, ProtokollAkteur wer) {
        protokoll.eintragen(new NeuerEintrag(mandant, quelle, art, box, ergebnis, schreib(alt),
                schreib(neu), giltAb, wer));
    }

    private String schreib(Map<String, Object> werte) {
        if (werte == null) {
            return null;
        }
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private JsonNode lies(String text) {
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Instant minute(Instant t) {
        return t.truncatedTo(ChronoUnit.MINUTES);
    }

    private static String text(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
