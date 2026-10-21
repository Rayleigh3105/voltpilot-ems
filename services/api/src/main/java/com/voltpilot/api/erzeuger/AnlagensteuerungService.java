package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Jungster;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Quelle;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Stammdaten;
import com.voltpilot.api.erzeuger.AnlagensteuerungRepository.Steuerung;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.GeraetRepository;
import com.voltpilot.api.web.dto.AnlagensteuerungDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.stream.IntStream;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * UEMS EZ-6 „Cloud-Modell“ (Konzept vp-erzeuger-wago-konzept §4.2, EW-3 A): die Anlagensteuerung einer
 * Erzeugeranlage — ein Gerät mit Geräteart {@code controller}, seine Datenquelle (modbus_tcp host:port +
 * Geräte-ID), die Registerbild-Fassung (Bildart {@code erzeuger}), die Erzeugungseinheiten als Teile und EINE
 * Komponente vom Typ {@code anlagensteuerung}, die die Messpunkte an die Datenquelle bindet. Keine neue
 * Anlagenart, kein neuer Reiter.
 *
 * <p><b>Mischbetrieb.</b> Angelegt wird nur, wenn die Box, die die Datenquelle liest, das Fähigkeitswort
 * {@value ErzeugerRegisterbild#FAEHIGKEIT} meldet — eine ältere Box bekommt nie eine Konfiguration, die sie nicht
 * lesen kann; das Portal bietet die Einrichtung dann nicht an ({@link AnlagensteuerungDto.Einrichtung}). Ohne
 * Werte heißt es „noch keine Daten“, nie 0.
 */
@Service
public class AnlagensteuerungService {

    /** Ein Wert gilt als aktuell, solange er gut und jünger als zwei Herzschläge der Box (2 × 60 s) ist. Die Überwachung
     * (EZ-11, {@code ErzeugerWerteLeser}) liest mit derselben Grenze. */
    public static final long AKTUELL_BIS_S = 120;
    static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final Set<String> ANLAGENARTEN = Set.of("pv", "bhkw", "gemischt");
    private static final Set<String> EINHEIT_ARTEN = Set.of("pv_wechselrichter", "bhkw_motor");
    private static final Set<String> WORTFOLGEN = Set.of("big", "little");
    private static final Set<String> DV_KANAELE = Set.of("keiner", "relais_ma", "modbus");
    private static final Set<String> EINSPEISEMANAGEMENT = Set.of("statisch", "stufen", "fernwirk");

    private final AnlagensteuerungRepository repo;
    private final EntityRegistryService entities;
    private final BoxFaehigkeiten faehigkeiten;
    private final ObjectMapper json;
    private final Clock uhr;

    @Autowired
    public AnlagensteuerungService(AnlagensteuerungRepository repo, EntityRegistryService entities,
            BoxFaehigkeiten faehigkeiten, ObjectMapper json) {
        this(repo, entities, faehigkeiten, json, Clock.systemUTC());
    }

    AnlagensteuerungService(AnlagensteuerungRepository repo, EntityRegistryService entities,
            BoxFaehigkeiten faehigkeiten, ObjectMapper json, Clock uhr) {
        this.repo = repo;
        this.entities = entities;
        this.faehigkeiten = faehigkeiten;
        this.json = json;
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------ lesen

    @Transactional(readOnly = true)
    public AnlagensteuerungDto.Liste liste(UUID siteId) {
        sichtbar(siteId);
        List<AnlagensteuerungDto.Box> boxen = repo.boxen(siteId).stream()
                .map(b -> new AnlagensteuerungDto.Box(b, faehigkeiten.kann(b, ErzeugerRegisterbild.FAEHIGKEIT)))
                .toList();
        boolean moeglich = boxen.stream().anyMatch(AnlagensteuerungDto.Box::faehig);
        String grund = moeglich ? null : boxen.isEmpty() ? "keine_box" : "box_ohne_faehigkeit";
        return new AnlagensteuerungDto.Liste(new AnlagensteuerungDto.Einrichtung(moeglich, grund, boxen),
                repo.steuerungen(siteId).stream().map(this::dto).toList());
    }

    @Transactional(readOnly = true)
    public AnlagensteuerungDto.Werte werte(UUID siteId, UUID geraetId) {
        sichtbar(siteId);
        Steuerung s = repo.steuerung(geraetId).filter(x -> x.siteId().equals(siteId))
                .orElseThrow(() -> nichtGefunden("Anlagensteuerung nicht gefunden."));
        int teAnzahl = repo.fassung(geraetId).map(AnlagensteuerungRepository.Fassung::teAnzahl)
                .orElseGet(() -> Math.max(1, repo.einheiten(geraetId).size()));
        Instant jetzt = uhr.instant();
        List<AnlagensteuerungDto.Wert> werte = new ArrayList<>();
        for (Jungster j : repo.juengste(TenantContext.get(), s.entityId(), ErzeugerRegisterbild.punkte(teAnzahl))) {
            werte.add(wert(j, jetzt));
        }
        boolean daten = werte.stream().anyMatch(w -> w.gemessenAm() != null);
        return new AnlagensteuerungDto.Werte(geraetId, s.entityId(), daten ? "daten" : "noch_keine_daten",
                zeit(jetzt), werte);
    }

    /**
     * Die Kurven des Bilds (UEMS EZ-10) über das Fenster der Historie: dieselben Tage und Eimer wie die übrigen
     * Kurven in Verlauf › Messwerte (Tag 15 min, Woche 1 h, Monat und Jahr je Berliner Tag).
     */
    @Transactional(readOnly = true)
    public AnlagensteuerungDto.Verlauf verlauf(UUID siteId, UUID geraetId, String range, LocalDate at) {
        HistoryRange zeitraum = HistoryRange.parse(range);
        if (zeitraum == null) {
            throw bad("range ist eines von day · week · month · year.");
        }
        sichtbar(siteId);
        Steuerung s = repo.steuerung(geraetId).filter(x -> x.siteId().equals(siteId))
                .orElseThrow(() -> nichtGefunden("Anlagensteuerung nicht gefunden."));
        int teAnzahl = repo.fassung(geraetId).map(AnlagensteuerungRepository.Fassung::teAnzahl)
                .orElseGet(() -> Math.max(1, repo.einheiten(geraetId).size()));
        HistoryRange.Window fenster = zeitraum.window(at != null ? at : LocalDate.now(uhr.withZone(ZONE)));
        List<String> kurven = ErzeugerRegisterbild.kurven(teAnzahl);
        java.util.Map<String, List<AnlagensteuerungDto.Eimer>> je = new java.util.LinkedHashMap<>();
        kurven.forEach(k -> je.put(k, new ArrayList<>()));
        for (AnlagensteuerungRepository.Eimer e : repo.verlauf(TenantContext.get(), s.entityId(), kurven,
                fenster.from(), fenster.to(), zeitraum.bucketMinutes(), zeitraum.dailyBuckets())) {
            je.get(e.pointKey()).add(new AnlagensteuerungDto.Eimer(zeit(e.start()), e.avg(), e.min(), e.max(),
                    e.last(), e.n()));
        }
        List<AnlagensteuerungDto.Kurve> out = new ArrayList<>();
        je.forEach((k, eimer) -> {
            ErzeugerRegisterbild.Feld feld = ErzeugerRegisterbild.feld(k).orElseThrow();
            out.add(new AnlagensteuerungDto.Kurve(k, feld.abschnitt(), feld.feld(),
                    ErzeugerRegisterbild.teNr(k).orElse(null), feld.einheit(), List.copyOf(eimer)));
        });
        return new AnlagensteuerungDto.Verlauf(geraetId, s.entityId(), zeitraum.name().toLowerCase(Locale.ROOT),
                zeit(fenster.from()), zeit(fenster.to()), zeitraum.bucketMinutes(), out);
    }

    /** Ein jüngster Wert in der Sprache des Bilds: Zustand mit Wort, Bitfeld mit gesetzten Bits, nie 0 statt nichts. */
    static AnlagensteuerungDto.Wert wert(Jungster j, Instant jetzt) {
        ErzeugerRegisterbild.Feld feld = ErzeugerRegisterbild.feld(j.pointKey()).orElseThrow();
        Integer teNr = ErzeugerRegisterbild.teNr(j.pointKey()).orElse(null);
        if (j.zeit() == null || j.zahl() == null) {
            return new AnlagensteuerungDto.Wert(j.pointKey(), feld.abschnitt(), feld.feld(), teNr, feld.art(),
                    feld.einheit(), null, j.zeit() == null ? null : zeit(j.zeit()), j.qualitaet(), "keine_daten",
                    null, null, null);
        }
        boolean aktuell = "good".equals(j.qualitaet())
                && !j.zeit().isBefore(jetzt.minusSeconds(AKTUELL_BIS_S));
        String wort = null;
        String text = null;
        List<AnlagensteuerungDto.Bit> bits = null;
        long roh = j.zahl().longValue();
        if (!feld.vokabular().isEmpty()) {
            var w = ErzeugerRegisterbild.wort(feld, roh);
            wort = w.map(ErzeugerRegisterbild.Wort::wort).orElse(null);
            text = w.map(ErzeugerRegisterbild.Wort::text).orElse(null);
        }
        if (!feld.bits().isEmpty()) {
            bits = ErzeugerRegisterbild.gesetzt(feld, roh).stream()
                    .map(b -> new AnlagensteuerungDto.Bit(b.bit(), b.wort(), b.text())).toList();
        }
        return new AnlagensteuerungDto.Wert(j.pointKey(), feld.abschnitt(), feld.feld(), teNr, feld.art(),
                feld.einheit(), j.zahl(), zeit(j.zeit()), j.qualitaet(), aktuell ? "aktuell" : "veraltet", wort, text,
                bits);
    }

    @Transactional(readOnly = true)
    public AnlagensteuerungDto.NetzVermarktung netzVermarktung(UUID siteId) {
        sichtbar(siteId);
        return stammdatenDto(siteId);
    }

    // ---------------------------------------------------------------- anlegen

    /**
     * Steuerung, Komponente, Einheiten und Fassung in EINER Transaktion, eingebaut ab der laufenden vollen Minute.
     * Der Anlege-Trigger legt für die Komponente kein zweites Gerät an (sie hat ihre Speisung schon).
     */
    @Transactional
    public AnlagensteuerungDto.Anlagensteuerung anlegen(UUID siteId, AnlagensteuerungDto.Anlegen in, String subject) {
        sichtbar(siteId);
        // Erst die Form der Anfrage (400), dann der Zustand der Anlage (404/409).
        String anlagenart = wort(in.anlagenart(), ANLAGENARTEN, "anlagenart");
        int funktionscode = in.funktionscode() == null ? 4 : in.funktionscode();
        if (funktionscode != 3 && funktionscode != 4) {
            throw bad("funktionscode ist 4 (Eingangsregister, EW-2) oder 3.");
        }
        String wortfolge = in.wortfolge() == null ? "big" : wort(in.wortfolge(), WORTFOLGEN, "wortfolge");
        int basisadresse = in.basisadresse() == null ? 0 : in.basisadresse();
        int teAnzahl = in.einheiten().size();
        Set<Integer> nummern = new HashSet<>();
        in.einheiten().forEach(e -> nummern.add(e.teNr()));
        if (!nummern.equals(new HashSet<>(IntStream.rangeClosed(1, teAnzahl).boxed().toList()))) {
            throw bad("Die Einheiten tragen genau die Nummern 1 … " + teAnzahl + " — so viele Blöcke hat das Bild.");
        }
        if (basisadresse + 38 + 10 * teAnzahl > 65536) {
            throw bad("Das Bild passt ab Basisadresse " + basisadresse + " nicht in den Adressraum.");
        }
        if (in.rseStufen() != null && in.rseStufen().stream().map(AnlagensteuerungDto.RseStufe::stufe).distinct()
                .count() != in.rseStufen().size()) {
            throw bad("Jede Rundsteuer-Stufe hat genau eine Bedeutung.");
        }
        in.einheiten().forEach(e -> {
            if (e.einheitArt() != null) wort(e.einheitArt(), EINHEIT_ARTEN, "einheit_art");
        });
        if (in.programmstandSoll() != null && !Programmstand.gueltig(in.programmstandSoll())) {
            throw bad("programmstand_soll ist ein Stand JJMM (2610 = Oktober 2026).");
        }
        AnlagensteuerungDto.NetzVermarktungVorbelegen nv = in.netzVermarktung();
        String nvKanal = nv == null || nv.direktvermarkterKanal() == null ? null
                : wort(nv.direktvermarkterKanal(), DV_KANAELE, "direktvermarkter_kanal");
        String nvEm = nv == null || nv.einspeisemanagement() == null ? null
                : wort(nv.einspeisemanagement(), EINSPEISEMANAGEMENT, "einspeisemanagement");
        if (nv != null && nv.einspeisemanagementProzent() != null && !"statisch".equals(nvEm)) {
            throw bad("Eine Prozentgrenze gehört nur zum statischen Einspeisemanagement.");
        }

        Quelle q = repo.quelle(in.dataSourceId()).filter(x -> x.siteId().equals(siteId))
                .orElseThrow(() -> nichtGefunden("Datenquelle an dieser Anlage nicht gefunden."));
        if (!"modbus_tcp".equals(q.protokoll())) {
            throw bad("Die Steuerung wird über eine Datenquelle mit Modbus TCP gelesen (host:port).");
        }
        if (!q.geraeteIds().contains(in.unitId())) {
            throw bad("Die Geräte-ID " + in.unitId() + " gehört nicht zur Datenquelle " + q.kennzeichen() + ".");
        }
        if (q.archiviert()) {
            throw konflikt("Die Datenquelle " + q.kennzeichen() + " ist archiviert.");
        }
        UUID box = repo.leser(q.id()).orElseThrow(() -> konflikt("Keine Box liest die Datenquelle "
                + q.kennzeichen() + " — erst die zuständige Box festlegen."));
        if (!faehigkeiten.kann(box, ErzeugerRegisterbild.FAEHIGKEIT)) {
            throw konflikt("Die zuständige Box liest das VoltPilot-Registerbild Erzeuger noch nicht "
                    + "(Fähigkeit " + ErzeugerRegisterbild.FAEHIGKEIT + " fehlt) — erst nach einem Box-Update.");
        }
        if (repo.steuerungAnQuelle(q.id(), in.unitId())) {
            throw konflikt("An " + q.kennzeichen() + " mit Geräte-ID " + in.unitId()
                    + " ist schon eine Anlagensteuerung eingebaut.");
        }

        UUID tenant = TenantContext.get();
        Instant ab = uhr.instant().truncatedTo(ChronoUnit.MINUTES);
        String bezeichnung = leer(in.bezeichnung());
        UUID entityId = entities.createEntity(siteId, AnlagensteuerungRepository.ENTITY_TYPE,
                bezeichnung == null ? "Anlagensteuerung" : bezeichnung, null, null, null).id();
        Steuerung g = repo.geraetAnlegen(tenant, siteId, bezeichnung, leer(in.hersteller()), leer(in.typ()), q.id(),
                in.unitId(), ab, subject);
        repo.komponenteBinden(tenant, g.geraetId(), entityId, q.id(), ab, subject);
        for (AnlagensteuerungDto.NeueEinheit e : in.einheiten().stream()
                .sorted(java.util.Comparator.comparing(AnlagensteuerungDto.NeueEinheit::teNr)).toList()) {
            String typBild = leer(e.typBild());
            String typ = leer(e.typ());
            repo.einheitAnlegen(tenant, g.geraetId(), e.teNr(), e.einheitArt(), leer(e.bezeichnung()),
                    typ == null ? typBild : typ, typBild, e.nennleistungKw(), e.registryUnitId(), ab, subject);
        }
        repo.fassungAnlegen(tenant, siteId, g.geraetId(), basisadresse, funktionscode, wortfolge, teAnzahl,
                anlagenart, in.steuerungKennung(), in.rseStufen(),
                in.veraltetNetzpunktS() == null ? 30 : in.veraltetNetzpunktS(), in.programmstandSoll(), ab, subject);
        repo.stammdatenSicherstellen(tenant, siteId, subject);
        if (nv != null) {
            repo.stammdatenVorbelegen(siteId, leer(nv.direktvermarkter()), nvKanal, nvEm,
                    nv.einspeisemanagementProzent(), subject);
        }
        return dto(repo.steuerung(g.geraetId()).orElseThrow());
    }

    // ---------------------------------------------------------------- ändern

    @Transactional
    public AnlagensteuerungDto.Einheit einheitAendern(UUID geraetId, int teNr, AnlagensteuerungDto.EinheitAendern in) {
        repo.steuerung(geraetId).orElseThrow(() -> nichtGefunden("Anlagensteuerung nicht gefunden."));
        String art = in.einheitArt() == null ? null : wort(in.einheitArt(), EINHEIT_ARTEN, "einheit_art");
        if (!repo.einheitAendern(geraetId, teNr, art, leer(in.bezeichnung()), leer(in.typ()), in.nennleistungKw(),
                in.registryUnitId())) {
            throw nichtGefunden("Einheit " + teNr + " ist an dieser Steuerung nicht eingebaut.");
        }
        return repo.einheiten(geraetId).stream().filter(t -> t.teNr() == teNr).map(AnlagensteuerungService::einheit)
                .findFirst().orElseThrow();
    }

    /**
     * Die Namen, die das Bild nennt (Konzept §3.10): gespeichert wie gelesen, eine leere Anzeige wird vorbelegt,
     * nie eine vorhandene überschrieben. Eine Einheit, die die Steuerung nicht trägt, ist ein Fehler — nie still
     * umgehängt.
     */
    @Transactional
    public AnlagensteuerungDto.NetzVermarktung namenAusBild(UUID geraetId, AnlagensteuerungDto.NamenAusBild in,
            String subject) {
        Steuerung s = repo.steuerung(geraetId).orElseThrow(() -> nichtGefunden("Anlagensteuerung nicht gefunden."));
        Set<Integer> vorhanden = new HashSet<>();
        repo.einheiten(geraetId).forEach(t -> vorhanden.add(t.teNr()));
        List<AnlagensteuerungDto.TypAusBild> typen = in.einheiten() == null ? List.of() : in.einheiten();
        for (AnlagensteuerungDto.TypAusBild t : typen) {
            if (!vorhanden.contains(t.teNr())) {
                throw konflikt("Das Bild nennt Einheit " + t.teNr() + ", die Steuerung trägt sie nicht. "
                        + "Eine neue Einheit kommt mit einer neuen Fassung, nie still.");
            }
        }
        for (AnlagensteuerungDto.TypAusBild t : typen) {
            repo.typAusBild(geraetId, t.teNr(), leer(t.typ()));
        }
        repo.stammdatenSicherstellen(TenantContext.get(), s.siteId(), subject);
        repo.namenAusBild(s.siteId(), leer(in.netzbetreiber()), leer(in.direktvermarkter()), uhr.instant(), subject);
        return stammdatenDto(s.siteId());
    }

    @Transactional
    public AnlagensteuerungDto.NetzVermarktung netzVermarktungAendern(UUID siteId,
            AnlagensteuerungDto.NetzVermarktungAendern in, String subject) {
        sichtbar(siteId);
        String kanal = in.direktvermarkterKanal() == null ? null
                : wort(in.direktvermarkterKanal(), DV_KANAELE, "direktvermarkter_kanal");
        String em = in.einspeisemanagement() == null ? null
                : wort(in.einspeisemanagement(), EINSPEISEMANAGEMENT, "einspeisemanagement");
        if (in.einspeisemanagementProzent() != null && !"statisch".equals(em)) {
            throw bad("Eine Prozentgrenze gehört nur zum statischen Einspeisemanagement.");
        }
        // Noch nie gespeichert heißt Revision 0 (GET); die erste Zeile beginnt mit Revision 1.
        boolean neu = repo.stammdaten(siteId).isEmpty();
        repo.stammdatenSicherstellen(TenantContext.get(), siteId, subject);
        int erwartet = neu && in.expectedRevision() == 0 ? 1 : in.expectedRevision();
        if (!repo.stammdatenAendern(siteId, erwartet, leer(in.direktvermarkter()), kanal, em,
                in.einspeisemanagementProzent(), subject)) {
            throw konflikt("Die Stammdaten wurden inzwischen geändert. Bitte neu laden.");
        }
        return stammdatenDto(siteId);
    }

    // --------------------------------------------------------------- Formen

    private AnlagensteuerungDto.Anlagensteuerung dto(Steuerung s) {
        var laufend = repo.fassung(s.geraetId());
        AnlagensteuerungDto.Fassung fassung = laufend.map(f -> new AnlagensteuerungDto.Fassung(
                f.id(), f.bildart(), f.basisadresse(), f.funktionscode(), f.wortfolge(), f.teAnzahl(), f.anlagenart(),
                f.steuerungKennung(), stufen(f.rseStufen()), f.veraltetNetzpunktS(), f.programmstandSoll(),
                zeit(f.gueltigAb())))
                .orElse(null);
        Jungster gelesen = repo.juengste(TenantContext.get(), s.entityId(), List.of(Programmstand.PUNKT)).get(0);
        AnlagensteuerungDto.Programmstand programmstand = programmstand(Programmstand.vergleiche(gelesen.zahl(),
                gelesen.zeit(), laufend.map(AnlagensteuerungRepository.Fassung::programmstandSoll).orElse(null)));
        UUID box = s.dataSourceId() == null ? null : repo.leser(s.dataSourceId()).orElse(null);
        return new AnlagensteuerungDto.Anlagensteuerung(s.geraetId(), s.kennzeichen(), s.einbauKennzeichen(),
                s.bezeichnung(), s.hersteller(), s.typ(), zeit(s.eingebautAm()), s.entityId(),
                s.dataSourceId() == null ? null : new AnlagensteuerungDto.Datenquelle(s.dataSourceId(),
                        s.quelleKennzeichen(), s.adresse(), s.unitId(), box),
                fassung, repo.einheiten(s.geraetId()).stream().map(AnlagensteuerungService::einheit).toList(),
                programmstand);
    }

    static AnlagensteuerungDto.Programmstand programmstand(Programmstand.Vergleich v) {
        return new AnlagensteuerungDto.Programmstand(v.zustand(), v.ist(), v.istText(), v.soll(), v.sollText(),
                v.sollAusFassung() ? "fassung" : "bibliothek", zeit(v.gemessenAm()), v.warnen());
    }

    private static AnlagensteuerungDto.Einheit einheit(GeraetRepository.Teil t) {
        return new AnlagensteuerungDto.Einheit(t.id(), t.teNr(), t.einheitArt(), t.bezeichnung(), t.typ(), t.typBild(),
                t.nennleistungKw(), t.registryUnitId(), zeit(t.eingebautAm()));
    }

    private AnlagensteuerungDto.NetzVermarktung stammdatenDto(UUID siteId) {
        Stammdaten d = repo.stammdaten(siteId).orElse(new Stammdaten(null, null, null, null, null, null, null, 0));
        String netzbetreiber = repo.netzbetreiber(siteId, LocalDate.now(uhr.withZone(ZONE))).orElse(null);
        return new AnlagensteuerungDto.NetzVermarktung(siteId, netzbetreiber, d.direktvermarkter(),
                d.direktvermarkterKanal(), d.einspeisemanagement(), d.einspeisemanagementProzent(),
                new AnlagensteuerungDto.NamenImBild(d.netzbetreiberBild(), d.direktvermarkterBild(),
                        d.namenGelesenAm() == null ? null : zeit(d.namenGelesenAm())),
                hinweise(d.netzbetreiberBild(), netzbetreiber), d.revision());
    }

    /**
     * Weicht der Netzbetreiber im Bild vom Eintrag am Netzanschluss ab, wird das gemeldet und nichts
     * überschrieben (Konzept §3.10). Verglichen wird ohne Groß-/Kleinschreibung und Leerraum-Unterschiede.
     */
    static List<AnlagensteuerungDto.Hinweis> hinweise(String bild, String eintrag) {
        if (bild == null) {
            return List.of();
        }
        if (eintrag == null) {
            return List.of(new AnlagensteuerungDto.Hinweis("netzbetreiber_nicht_eingetragen",
                    "Die Steuerung nennt den Netzbetreiber „" + bild + "“; am Netzanschluss ist keiner eingetragen.",
                    bild, null));
        }
        if (normal(bild).equals(normal(eintrag))) {
            return List.of();
        }
        return List.of(new AnlagensteuerungDto.Hinweis("netzbetreiber_abweichung",
                "Die Steuerung nennt den Netzbetreiber „" + bild + "“, am Netzanschluss steht „" + eintrag
                        + "“. Nichts wurde überschrieben.", bild, eintrag));
    }

    private static String normal(String text) {
        return text.strip().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private List<AnlagensteuerungDto.RseStufe> stufen(String text) {
        if (text == null) {
            return null;
        }
        try {
            return json.readValue(text, new TypeReference<List<AnlagensteuerungDto.RseStufe>>() {});
        } catch (Exception e) {
            throw new IllegalStateException("rse_stufen nicht lesbar", e);
        }
    }

    private void sichtbar(UUID siteId) {
        if (!repo.anlageSichtbar(siteId)) {
            throw nichtGefunden("Anlage nicht gefunden.");
        }
    }

    private static String wort(String wert, Set<String> erlaubt, String feld) {
        if (!erlaubt.contains(wert)) {
            throw bad(feld + " ist eines von " + new java.util.TreeSet<>(erlaubt) + ".");
        }
        return wert;
    }

    private static String leer(String text) {
        return text == null || text.isBlank() ? null : text.strip();
    }

    static OffsetDateTime zeit(Instant t) {
        return t == null ? null : t.atOffset(ZoneOffset.UTC);
    }

    private static ResponseStatusException nichtGefunden(String grund) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, grund);
    }

    private static ResponseStatusException konflikt(String grund) {
        return new ResponseStatusException(HttpStatus.CONFLICT, grund);
    }

    private static ResponseStatusException bad(String grund) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, grund);
    }
}
