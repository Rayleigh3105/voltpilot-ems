package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.measurement.SpeicherklasseHistorie;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.web.dto.MessstelleWerteDto;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Connection;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.NavigableSet;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.info.BuildProperties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Bildet den ABZUG eines Standort-Berichts (UEMS AP-12 IP-5, EW3; Entscheide E1, E2, E3, E9, E10) — eine reine Funktion
 * über der Verbindung ihres Aufrufers. Sie liest, was gespeichert ist: die Messstellen der Geltung je Tag
 * ({@code messstelle_ort} × {@code ort_zuordnung}, Q3), ihre Werte über das Lesemodell (neueste Version), die
 * gespeicherte Herkunft berechneter Zahlen ({@code bilanzwert_eingang}, dieselbe Quelle wie {@link BilanzwertHerkunft}),
 * Namen, Orte und Kennzeichen zum Datenstand (A5) — und rechnet nichts neu. Sie schreibt nur den Entwurf
 * ({@code bericht_entwurf}) und sein Quellenverzeichnis ({@code bericht_quelle}); kanonische Form und Prüfsumme kommen
 * aus {@link BerichtRegeln}, die Datenbank prüft die Summe per CHECK nach.
 *
 * <p><b>Mandant ausdrücklich.</b> Die Kaskade (IP-8) reicht eine Verbindung der Verwaltungsrolle herein, an der keine RLS
 * filtert: jede Abfrage hier nennt {@code tenant_id}, und das Lesemodell wird mit dem Mandanten des Berichts gefragt, nie
 * über ein Kennzeichen allein.
 *
 * <p><b>Unternehmen und Kennzahlen (AP-12 IP-6, Vertrag 1.1).</b> Am Unternehmen trägt der Abzug die Netzbezugs-Zähler
 * der Standorte, die Unternehmens- und Prozess-Messstellen, {@code standorte} und {@code kostenstellen}
 * ({@link BerichtUnternehmen}); an beiden Geltungen den Kennzahlen-Abschnitt nach Q4 hinter der Verfügbarkeitsprüfung
 * seiner Tabellen ({@link BerichtKennzahlen}).
 *
 * <p><b>Was der Abzug (noch) nicht trägt</b> — firstmate 001 = A, Folgepaket {@code vp-uems-b12-tagesverlauf-speicher}:
 * keinen Tagesverlauf, keine Vergleichswerte je Messstelle, einen Speicher mit „Laden / Entladen“ als EINE Netto-Menge,
 * wie das Lesemodell sie führt ({@code speicher_laden_kwh}/{@code speicher_entladen_kwh} fehlen dann, unbekannt ist
 * keine Null), und je Kennzahl weder {@code ort_zum_datenstand} noch {@code endgueltig_ab}.
 *
 * <p><b>Stand nach dem ersten Schnitt des Folgepakets.</b> Der VERTRAG kennt alle drei Formen jetzt (1.2:
 * {@code $defs/abzug.tagesverlauf}, {@code $defs/kennzahl.ort_zum_datenstand}/{@code endgueltig_ab}) und der Träger des
 * Richtungspaars steht in der Verdichtung ({@link Richtungspaar}, {@code V20260918101000}) — diese Bildung schreibt sie
 * noch nicht ab. Solange bleiben die Abzüge in der Form 1.1 und ihre Prüfsummen unberührt; jede Lücke ist in
 * {@code BerichtAbzugBildungTest} als Ist-Zustand benannt und wird rot, sobald sie sich schließt.
 */
@Component
public class BerichtAbzugBildung {

    /** {@code bericht_entwurf.gebildet_von} (bericht.md EW1). */
    public static final List<String> GEBILDET_VON = List.of("anlegen", "abruf", "kaskade", "struktur");

    static final String NETZBEZUG = "netzbezug_kwh";
    static final String EINSPEISUNG = "einspeisung_kwh";
    static final String PV_ERZEUGUNG = "pv_erzeugung_kwh";
    static final String SPEICHER_LADEN = "speicher_laden_kwh";
    static final String SPEICHER_ENTLADEN = "speicher_entladen_kwh";
    static final List<String> SUMMEN = List.of(NETZBEZUG, EINSPEISUNG, PV_ERZEUGUNG, SPEICHER_LADEN, SPEICHER_ENTLADEN);

    /** DA1 — die eingefrorene Darstellung, Wortlaut des B1-Abzugs. */
    static final String ZAHLENFORMAT = "de-DE";
    static final String DEZIMAL = BerichtRegeln.CSV_DEZIMAL;
    static final String RUNDUNG = "AP-08 E11 (Tag/Monat/Jahr ganze kWh; Kennzahl 2 Nachkommastellen)";
    static final String SOMMERZEIT = "AP-08 E10 (Ortszeit mit MESZ/MEZ)";

    /**
     * Q5 — der Kopf eines Vergleichszeitraums. Ohne Zahl „keine Werte — …“; das Datum des Beginns nennt der erste, die
     * folgenden sagen es kurz (B1: Vormonat mit Datum, Vorjahresmonat ohne). Mit Zahlen die Anzahl der Werte — vorläufig
     * bis Vertrag 1.1 die Vergleichswerte je Messstelle trägt.
     */
    static final String KEINE_WERTE_WEIL = ErgebnisZustand.KEINE_WERTE + " — ";
    static final String VOR_BEGINN_KURZ = kurzform("vor_beginn");
    static final String NACH_DEM_ENDE = "nach dem Ende";

    /** Das Wort des Lücken-Ereignisses (events-vocabulary). */
    static final String DATA_GAP = "data_gap";

    private static final String SPEICHER_RICHTUNG = "Laden / Entladen";
    private static final String GEMESSEN_ENDGUELTIG = "endgueltig";
    private static final String GEMESSEN_VORLAEUFIG = "vorlaeufig";
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx");

    /** Eine Zeile des Quellenverzeichnisses des Entwurfs ({@code bericht_quelle}, Tage einschließlich). */
    public record Quelle(String art, String kennzeichen, UUID objekt, String bezug, LocalDate ersterTag,
            LocalDate letzterTag, Integer version, Integer fassung, String name) {}

    /**
     * Was eine Bildung ergab: der Abzug als Baum und als kanonischer Text mit Prüfsumme, die Quellen und jede einbezogene
     * Berechnungszeit (D2).
     */
    public record Ergebnis(UUID tenant, UUID bericht, String kennung, JsonNode abzug, String text, String pruefsumme,
            Instant datenstand, List<Quelle> quellen, List<Instant> berechnetAm) {}

    private record Kopf(UUID tenant, String kennung, String vorlage, String geltungArt, UUID standort,
            UUID unternehmen, String zeitraumArt, String schluessel, ZoneId zone) {}

    record Geltung(String art, String name, String kennzeichen, Instant archiviertAm, String unternehmen, String sitz) {}

    private record Eingang(UUID messstelle, String kennzeichen, String messkanal, String name, String richtung,
            String rolle, String anteil, String vorzeichen, BigDecimal faktor, Integer version) {}

    private record Gelesen(ObjectNode wert, BigDecimal menge, Integer version, String zustand, String fassung,
            Integer abdeckung, List<Instant> zeiten, List<Eingang> eingaenge, List<String> korrekturen,
            List<String> ersatzwerte, Set<UUID> luecken, BigDecimal[] paar, List<Tag> tage) {}

    /** Ein Tag des Tagesverlaufs (Vertrag 1.2): Menge und Zustand, wie die Tageszeile sie führt. */
    private record Tag(LocalDate tag, BigDecimal menge, BigDecimal positiv, BigDecimal negativ, String zustand) {}

    private record Spanne(LocalDate von, LocalDate bis) {}

    private final MeasurementCatalog katalog;
    private final ObjectMapper json;
    private final BerichtRegelwerk regelwerk;
    private final BewertungRanglisteService bewertungRangliste;
    private final BewertungMessabdeckungService bewertungMessabdeckung;
    /** AP-17 IP-21b: der EINE Vergleich-Leser (IP-19) für die Vorlage {@code leistungsvergleich}. */
    @Autowired(required = false)
    private BezugsbasisVergleich vergleichLeser;

    @Autowired
    public BerichtAbzugBildung(MeasurementCatalog katalog, ObjectMapper json, ObjectProvider<BuildProperties> build,
            @Value("${voltpilot.uems.berichte.build:}") String buildKennung,
            BewertungRanglisteService bewertungRangliste,
            BewertungMessabdeckungService bewertungMessabdeckung) {
        this(katalog, json, regelwerk(build.getIfAvailable(), buildKennung), bewertungRangliste,
                bewertungMessabdeckung);
    }

    BerichtAbzugBildung(MeasurementCatalog katalog, ObjectMapper json, BerichtRegelwerk regelwerk) {
        this(katalog, json, regelwerk, null, null);
    }

    private BerichtAbzugBildung(MeasurementCatalog katalog, ObjectMapper json, BerichtRegelwerk regelwerk,
            BewertungRanglisteService bewertungRangliste,
            BewertungMessabdeckungService bewertungMessabdeckung) {
        this.katalog = katalog;
        this.json = json;
        this.regelwerk = regelwerk;
        this.bewertungRangliste = bewertungRangliste;
        this.bewertungMessabdeckung = bewertungMessabdeckung;
    }

    static BerichtRegelwerk regelwerk(BuildProperties build, String buildKennung) {
        return BerichtRegelwerk.heute(build == null ? null : build.getVersion(), build == null ? null : build.getTime(),
                buildKennung);
    }

    /** Das Regelwerk, das diese Bildung in jeden Kopf schreibt (RW1). */
    public BerichtRegelwerk regelwerk() {
        return regelwerk;
    }

    // ============================================================================ Bilden und schreiben

    /**
     * EW3 — bildet den Abzug zum Datenstand {@code jetzt} (D1) und ersetzt Entwurf und Quellenverzeichnis des Entwurfs in
     * der Transaktion des Aufrufers. {@code gebildetVon}: {@link #GEBILDET_VON}.
     *
     * @throws IllegalStateException wenn eine einbezogene Version nach {@code jetzt} gerechnet wurde (D2) — dann ist
     *     nichts geschrieben
     */
    public Ergebnis bilden(Connection con, UUID bericht, Instant jetzt, String gebildetVon) {
        if (!GEBILDET_VON.contains(gebildetVon)) {
            throw new IllegalArgumentException("gebildet_von „" + gebildetVon + "“ gibt es nicht — " + GEBILDET_VON);
        }
        JdbcTemplate j = jdbc(con);
        Ergebnis e = zusammentragen(j, bericht, jetzt);
        schreiben(j, e, gebildetVon);
        return e;
    }

    /** Dieselbe Bildung, ohne zu schreiben (Vergleich eines Entwurfs, Tests). */
    public Ergebnis zusammentragen(Connection con, UUID bericht, Instant jetzt) {
        return zusammentragen(jdbc(con), bericht, jetzt);
    }

    private static JdbcTemplate jdbc(Connection con) {
        return new JdbcTemplate(new SingleConnectionDataSource(con, true));
    }

    private static void schreiben(JdbcTemplate j, Ergebnis e, String gebildetVon) {
        // Die Verwaltungsrolle darf den Entwurf nur ersetzen (IP-4-Grants) — darum erst UPDATE, dann INSERT.
        int ersetzt = j.update("UPDATE bericht_entwurf SET abzug = ?, pruefsumme = ?, datenstand = ?, gebildet_von = ? "
                + "WHERE tenant_id = ? AND bericht_id = ?", e.text(), e.pruefsumme(), Timestamp.from(e.datenstand()),
                gebildetVon, e.tenant(), e.bericht());
        if (ersetzt == 0) {
            j.update("INSERT INTO bericht_entwurf (tenant_id, bericht_id, abzug, pruefsumme, datenstand, gebildet_von) "
                    + "VALUES (?, ?, ?, ?, ?, ?)", e.tenant(), e.bericht(), e.text(), e.pruefsumme(),
                    Timestamp.from(e.datenstand()), gebildetVon);
        }
        j.update("DELETE FROM bericht_quelle WHERE tenant_id = ? AND bericht_id = ? AND stand_nr IS NULL",
                e.tenant(), e.bericht());
        List<Object[]> zeilen = new ArrayList<>();
        for (Quelle q : e.quellen()) {
            zeilen.add(new Object[] {e.tenant(), e.bericht(), q.art(), q.kennzeichen(), q.objekt(), q.bezug(),
                Date.valueOf(q.ersterTag()), Date.valueOf(q.letzterTag()), q.version(), q.fassung(), q.name()});
        }
        j.batchUpdate("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) "
                + "VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)", zeilen);
    }

    // ============================================================================ Leistungsvergleich (AP-17 IP-21b)

    /**
     * S1–S3: Kennzahl + die freigegebene Basis-Fassung am letzten Tag der Berichtsperiode (P4) + der Vergleich aus dem
     * Leser {@link BezugsbasisVergleich} (nur gerufen) → {@link BerichtLeistungsvergleich#abzug}. Ohne Fassung
     * {@code 422 basis_fehlt}; eine Kennzahl außerhalb der Sicht des Aufrufers ist {@code 404} (Zaun über die Kennzahl).
     */
    private Ergebnis leistungsvergleich(JdbcTemplate j, Kopf b, UUID berichtId, BerichtRegeln.Zeitraum z, Instant jetzt) {
        if (vergleichLeser == null) {
            throw new IllegalStateException("Vergleich-Leser ist nicht verdrahtet");
        }
        UUID tenant = b.tenant();
        UUID kennzahl = j.queryForObject("SELECT kennzahl_id FROM bericht WHERE id = ? AND tenant_id = ?", UUID.class,
                berichtId, tenant);
        BerichtLeistungsvergleich.Fassung f = BerichtLeistungsvergleich.fassungAm(j, tenant, kennzahl, z.letzterTag())
                .orElseThrow(() -> BerichtAbgelehnt.von(BerichtAbgelehnt.Ablehnung.BASIS_FEHLT));
        java.time.YearMonth von = java.time.YearMonth.from(z.ersterTag());
        java.time.YearMonth bis = java.time.YearMonth.from(z.letzterTag());
        com.voltpilot.api.web.dto.BezugsbasisVergleichDto.Vergleich v;
        try {
            v = vergleichLeser.vergleich(kennzahl, List.of("basis", "von", "bis"), f.basis(), von.toString(),
                    bis.toString());
        } catch (KennzahlAbgelehnt | BezugsbasisAbgelehnt e) {
            throw BerichtAbgelehnt.von(BerichtAbgelehnt.Ablehnung.NICHT_GEFUNDEN);
        }
        Geltung g = BerichtRegeln.STANDORT.equals(b.geltungArt()) ? geltung(j, tenant, b.standort())
                : BerichtUnternehmen.geltung(j, tenant, b.unternehmen());
        BerichtLeistungsvergleich.Ergebnis x = BerichtLeistungsvergleich.abzug(json,
                new BerichtLeistungsvergleich.Kopf(b.kennung(), g, z, b.zone(), jetzt, regelwerk), v, f,
                BerichtLeistungsvergleich.faktoren(j, tenant, f.fassungId()),
                BerichtLeistungsvergleich.eingaenge(j, tenant, kennzahl, von, bis),
                BerichtLeistungsvergleich.bezugsgroessen(j, tenant));
        String text = BerichtRegeln.kanonisch(x.abzug());
        return new Ergebnis(tenant, berichtId, b.kennung(), x.abzug(), text, BerichtRegeln.pruefsumme(text), jetzt,
                x.quellen(), x.zeiten());
    }

    // ============================================================================ Zusammentragen

    private Ergebnis zusammentragen(JdbcTemplate j, UUID berichtId, Instant jetzt) {
        Kopf b = j.query("SELECT tenant_id, kennung, vorlage, geltung_art, standort_id, unternehmen_id, zeitraum_art, "
                + "zeitraum_schluessel, zeitzone FROM bericht WHERE id = ?", (rs, i) -> new Kopf(
                        rs.getObject("tenant_id", UUID.class), rs.getString("kennung"), rs.getString("vorlage"),
                        rs.getString("geltung_art"), rs.getObject("standort_id", UUID.class),
                        rs.getObject("unternehmen_id", UUID.class), rs.getString("zeitraum_art"),
                        rs.getString("zeitraum_schluessel"), ZoneId.of(rs.getString("zeitzone"))), berichtId)
                .stream().findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Den Bericht " + berichtId + " gibt es nicht"));
        UUID tenant = b.tenant();
        ZoneId zone = b.zone();
        boolean amStandort = BerichtRegeln.STANDORT.equals(b.geltungArt());
        BerichtRegeln.Vorlage vorlage = BerichtRegeln.vorlage(b.vorlage());
        BerichtRegeln.Zeitraum z = BerichtRegeln.zeitraum(b.zeitraumArt(), b.schluessel(), zone);
        if (BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(b.vorlage())) {
            if (bewertungRangliste == null || bewertungMessabdeckung == null) {
                throw new IllegalStateException("Bewertungs-Leser sind nicht verdrahtet");
            }
            BerichtUnternehmen.BewertungsAbzug x = BerichtUnternehmen.bewertung(j, json, tenant, berichtId,
                    b.kennung(), b.unternehmen(), z, zone, jetzt, regelwerk, bewertungRangliste,
                    bewertungMessabdeckung);
            String text = BerichtRegeln.kanonisch(x.abzug());
            return new Ergebnis(tenant, berichtId, b.kennung(), x.abzug(), text, BerichtRegeln.pruefsumme(text), jetzt,
                    x.quellen(), x.zeiten());
        }
        if (BerichtRegeln.LEISTUNGSVERGLEICH.equals(b.vorlage())) {
            return leistungsvergleich(j, b, berichtId, z, jetzt);
        }
        MessstelleWerteService lesemodell = lesemodell(j, jetzt);
        MessstelleRepository messstellen = new MessstelleRepository(j);
        Map<UUID, List<Object[]>> stellungen = stellungen(j, tenant);
        Geltung g = amStandort ? geltung(j, tenant, b.standort())
                : BerichtUnternehmen.geltung(j, tenant, b.unternehmen());

        // Q3 — die Messstellen des Berichts je Tag. Am Standort die seiner Orte; am Unternehmen die Netzbezugs-Zähler der
        // Standorte (ihre Abschnitte), die Messstellen am Unternehmen und die Prozess-Messstellen ohne Ort (IP-6).
        UUID geltungId = amStandort ? b.standort() : b.unternehmen();
        java.util.function.BiFunction<LocalDate, LocalDate, BerichtUnternehmen.Umfang> umfangAm = (von, bis) ->
                umfang(j, tenant, b.geltungArt(), geltungId, von, bis);
        BerichtUnternehmen.Umfang umfang = umfangAm.apply(z.ersterTag(), z.letzterTag());
        Map<UUID, TreeMap<LocalDate, String>> tage = umfang.tage();
        List<MessstelleRepository.Messstelle> ordnung = sortiert(messstellen, tage.keySet());
        Map<UUID, BigDecimal> mengen = new HashMap<>();

        Set<Quelle> quellen = new LinkedHashSet<>();
        List<Instant> zeiten = new ArrayList<>();
        ArrayNode werte = json.createArrayNode();
        Map<String, BigDecimal> summen = new HashMap<>();
        Set<String> unbekannt = new TreeSet<>();
        Map<String, String> korrekturReihe = new LinkedHashMap<>();
        Set<String> ersatzwerte = new TreeSet<>();
        Set<UUID> luecken = new LinkedHashSet<>();
        int endgueltig = 0;
        int vollstaendig = 0;
        int vorlaeufig = 0;
        Integer abdeckungMin = null;

        // A2 — der Tagesverlauf steht in der MONATS-Vorlage (die Jahresvorlage zeigt Monatswerte).
        // Er wird abgeschrieben, nicht gerechnet: die Tageszeilen von AP-08 stehen schon da.
        boolean mitTagesverlauf = "monat".equals(z.art());
        ArrayNode tagesverlauf = json.createArrayNode();
        java.util.function.BiFunction<String, List<Object>, List<Tag>> tageLeser =
                (spur, spurArgs) -> tageDerReihe(j, tenant, z.ersterTag(), z.letzterTag(), spur, spurArgs);

        for (MessstelleRepository.Messstelle m : ordnung) {
            TreeMap<LocalDate, String> t = tage.get(m.id());
            Gelesen r = lies(j, lesemodell, tenant, m, z.art(), z.schluessel(), z.ersterTag(), z.letzterTag(), z.von(),
                    zone, t.lastEntry().getValue(), mitTagesverlauf ? tageLeser : null);
            // Vertrag 1.2 — das Richtungspaar wird zu ZWEI Zeilen (B1: MS-04 laden 7 900 / entladen 7 100).
            // Beide tragen denselben Nachweis: es ist EINE gemessene Reihe, nur in ihre zwei Flüsse zerlegt.
            List<ObjectNode> zeilen = r.paar() == null ? List.of(r.wert())
                    : List.of(richtungsZeile(r.wert(), "laden", r.paar()[0]),
                            richtungsZeile(r.wert(), "entladen", r.paar()[1]));
            zeilen.forEach(werte::add);
            if (mitTagesverlauf) {
                zeilen.forEach(zeile -> tagesverlauf.add(tagesverlaufEintrag(json, zeile, r.tage())));
            }
            zeiten.addAll(r.zeiten());
            for (Spanne s : spannen(t.navigableKeySet())) {
                quellen.add(new Quelle(BerichtRegeln.QUELLE_ARTEN.get(0), m.kennzeichen(), m.id(),
                        BerichtRegeln.UNMITTELBAR, s.von(), s.bis(), r.version(), null, m.name()));
            }
            for (Eingang e : r.eingaenge()) {
                if (e.messstelle() != null && !tage.containsKey(e.messstelle())) {
                    for (Spanne s : spannen(t.navigableKeySet())) {
                        quellen.add(new Quelle(BerichtRegeln.QUELLE_ARTEN.get(0), e.kennzeichen(), e.messstelle(),
                                BerichtRegeln.MITTELBAR, s.von(), s.bis(), e.version(), null, e.name()));
                    }
                }
            }
            mengen.put(m.id(), r.menge());
            String stellung = stellungAm(stellungen.get(m.id()), t.lastKey());
            if (r.paar() != null && amStandort && "Speicher".equals(stellung)) {
                // Laden und Entladen speisen ihre eigene Summe — nie die Netto-Menge, die keine von beiden ist.
                summen.merge(SPEICHER_LADEN, r.paar()[0], BigDecimal::add);
                summen.merge(SPEICHER_ENTLADEN, r.paar()[1], BigDecimal::add);
            } else {
                String summe = summenSchluessel(m, stellung);
                // Am Unternehmen fasst die Zusammenfassung nur den Netzbezug (Vorlage: „Netzbezug gesamt“, IP-6).
                if (summe != null && (amStandort || NETZBEZUG.equals(summe))) {
                    if (r.menge() == null) {
                        unbekannt.add(summe);
                    } else {
                        summen.merge(summe, r.menge(), BigDecimal::add);
                    }
                }
            }
            // Eine Reihe, zwei Zeilen: die Zählungen der Zusammenfassung zählen ZEILEN (B1: 16, nicht 15).
            int zeilenZahl = zeilen.size();
            endgueltig += KennzahlRegeln.ENDGUELTIG.equals(r.fassung()) ? zeilenZahl : 0;
            vorlaeufig += KennzahlRegeln.VORLAEUFIG.equals(r.fassung()) ? zeilenZahl : 0;
            vollstaendig += ErgebnisZustand.VOLLSTAENDIG.equals(r.zustand()) ? zeilenZahl : 0;
            if (r.abdeckung() != null) {
                abdeckungMin = abdeckungMin == null ? r.abdeckung() : Math.min(abdeckungMin, r.abdeckung());
            }
            r.korrekturen().forEach(k -> korrekturReihe.putIfAbsent(k, m.kennzeichen()));
            ersatzwerte.addAll(r.ersatzwerte());
            luecken.addAll(r.luecken());
        }

        // Q5 — die Vergleichszeiträume mit ihrem Grund; ihre Werte stehen als Quellen mit bezug = vergleich.
        LocalDate seit = bestehtSeit(j, tenant, b.geltungArt(), geltungId, z.letzterTag());
        LocalDate beendet = g.archiviertAm() == null ? null : LocalDate.ofInstant(g.archiviertAm(), zone);
        ArrayNode vergleiche = json.createArrayNode();
        boolean beginnGenannt = false;
        for (BerichtRegeln.Vergleichszeitraum v : z.vergleiche()) {
            String grund = BerichtRegeln.vergleichGrund(v.ersterTag(), v.letzterTag(), seit, beendet, false);
            int mitWert = 0;
            if (BerichtRegeln.KEINE_WERTE.equals(grund)) {
                Map<UUID, TreeMap<LocalDate, String>> vt = umfangAm.apply(v.ersterTag(), v.letzterTag()).tage();
                for (MessstelleRepository.Messstelle m : sortiert(messstellen, vt.keySet())) {
                    TreeMap<LocalDate, String> t = vt.get(m.id());
                    Gelesen r = lies(j, lesemodell, tenant, m, z.art(), v.schluessel(), v.ersterTag(), v.letzterTag(),
                            v.von(), zone, t.lastEntry().getValue(), null);
                    if (r.menge() == null) {
                        continue;
                    }
                    mitWert++;
                    zeiten.addAll(r.zeiten());
                    for (Spanne s : spannen(t.navigableKeySet())) {
                        quellen.add(new Quelle(BerichtRegeln.QUELLE_ARTEN.get(0), m.kennzeichen(), m.id(),
                                BerichtRegeln.VERGLEICH, s.von(), s.bis(), r.version(), null, m.name()));
                    }
                }
                grund = BerichtRegeln.vergleichGrund(v.ersterTag(), v.letzterTag(), seit, beendet, mitWert > 0);
            }
            String ergebnis;
            if (grund == null) {
                ergebnis = mitWert == 1 ? "1 Wert" : mitWert + " Werte";
            } else if (BerichtRegeln.VOR_BESTEHEN.equals(grund)) {
                ergebnis = KEINE_WERTE_WEIL + (beginnGenannt ? VOR_BEGINN_KURZ : BerichtRegeln.vorBeginn(seit));
                beginnGenannt = true;
            } else if (BerichtRegeln.QUELLE_BEENDET.equals(grund)) {
                ergebnis = KEINE_WERTE_WEIL + NACH_DEM_ENDE;
            } else {
                ergebnis = ErgebnisZustand.KEINE_WERTE;
            }
            ObjectNode n = vergleiche.addObject();
            n.put("art", v.art());
            n.put("schluessel", v.schluessel());
            n.put("ergebnis", ergebnis);
        }

        // Q4 — die Kennzahlen, hinter der Verfügbarkeitsprüfung ihrer Tabellen; am Unternehmen dazu die Standort-Abschnitte
        // und die Kostenstellen (IP-6). Ihre Quellen und Berechnungszeiten zählen für das Verzeichnis und für D2.
        BerichtKennzahlen.Abschnitt kennzahlen = BerichtKennzahlen.abschnitt(j, json, tenant,
                new BerichtKennzahlen.Umfang(berichtId, b.geltungArt(), b.standort(), b.unternehmen(),
                        Set.copyOf(amStandort ? tage.keySet() : umfang.eigene()), Set.copyOf(tage.keySet()), z.art(),
                        z.ersterTag(), z.letzterTag(), zone));
        quellen.addAll(kennzahlen.quellen());
        zeiten.addAll(kennzahlen.zeiten());
        ArrayNode standorte = null;
        ArrayNode kostenstellen = null;
        if (!amStandort) {
            Map<UUID, String> kennzeichenJeId = new HashMap<>();
            ordnung.forEach(m -> kennzeichenJeId.put(m.id(), m.kennzeichen()));
            standorte = BerichtUnternehmen.standorte(json, umfang, mengen, kennzeichenJeId::get);
            // Die Kostenstellen-Sicht (AP-10 IP-11) auf DER Verbindung des Aufrufers, Mandant ausdrücklich; die Warnung
            // vor doppelter Zählung liest sie hier nicht (kein BerechnetePeriodenLauf).
            KostenstelleEnergieService sicht = new KostenstelleEnergieService(new KostenstelleProzessRepository(j),
                    new KostenstelleEnergieRepository(j), messstellen, lesemodell, null);
            kostenstellen = BerichtUnternehmen.kostenstellen(j, json, tenant, sicht, z, zone, jetzt, tage.keySet(),
                    quellen);
        }

        // D2 — kein einbezogener Wert ist jünger als der Datenstand.
        List<BerichtRegeln.Aenderung> d2 = BerichtRegeln.d2(jetzt, zeiten, List.of(), false);
        if (!d2.isEmpty()) {
            throw new IllegalStateException("D2: " + b.kennung() + " kann zum Datenstand " + jetzt
                    + " nicht gebildet werden — ein einbezogener Wert ist " + d2.get(0).zeitpunkt() + " gerechnet");
        }

        ObjectNode abzug = json.createObjectNode();
        ObjectNode kopf = abzug.putObject("kopf");
        kopf.put("bericht", b.kennung());
        kopf.put("vorlage", vorlage.schluessel());
        kopf.put("vorlage_fassung", vorlage.fassung());
        ObjectNode geltung = kopf.putObject("geltung");
        geltung.put("art", g.art());
        geltung.put("kennzeichen", g.kennzeichen());
        geltung.put("name_zum_datenstand", g.name());
        kopf.put("unternehmen", g.unternehmen());
        kopf.put("sitz", g.sitz());
        ObjectNode zeitraum = kopf.putObject("zeitraum");
        zeitraum.put("art", z.art());
        zeitraum.put("schluessel", z.schluessel());
        zeitraum.put("von", iso(z.von(), zone));
        zeitraum.put("bis", iso(z.bis(), zone));
        zeitraum.put("zone", zone.getId());
        kopf.set("vergleichszeitraeume", vergleiche);
        kopf.put("datenstand", iso(jetzt, zone));
        ObjectNode rw = kopf.putObject("regelwerk");
        rw.put("software", regelwerk.software());
        ObjectNode vertraege = rw.putObject("vertraege");
        regelwerk.vertraege().forEach(vertraege::put);
        ObjectNode darstellung = kopf.putObject("darstellung");
        darstellung.put("zeitzone", zone.getId());
        darstellung.put("zahlenformat", ZAHLENFORMAT);
        darstellung.put("dezimal", DEZIMAL);
        darstellung.put("rundung", RUNDUNG);
        darstellung.put("sommerzeit", SOMMERZEIT);
        ArrayNode verzeichnis = kopf.putArray("quellenverzeichnis");
        quellen.stream().map(Quelle::kennzeichen).distinct().sorted().forEach(verzeichnis::add);

        ObjectNode zusammenfassung = abzug.putObject("zusammenfassung");
        for (String s : SUMMEN) {
            if (summen.containsKey(s) && !unbekannt.contains(s)) {
                zusammenfassung.put(s, summen.get(s));
            }
        }
        zusammenfassung.put("werte", werte.size());
        zusammenfassung.put("davon_endgueltig", endgueltig);
        zusammenfassung.put("davon_vollstaendig", vollstaendig);

        abzug.set("werte", werte);
        if (mitTagesverlauf) {
            abzug.set("tagesverlauf", tagesverlauf);
        }
        abzug.set("kennzahlen", kennzahlen.kennzahlen());
        if (!amStandort) {
            abzug.set("standorte", standorte);
            abzug.set("kostenstellen", kostenstellen);
        }

        ObjectNode qualitaet = abzug.putObject("qualitaet");
        qualitaet.put("abdeckung_min_prozent", abdeckungMin == null ? 0 : abdeckungMin);
        qualitaet.put("luecken", luecken.size());
        qualitaet.put("ersatzwerte", ersatzwerte.size());
        qualitaet.put("korrekturen_im_zeitraum", korrekturReihe.size());
        qualitaet.put("vorlaeufig", vorlaeufig);
        if (!korrekturReihe.isEmpty()) {
            korrekturen(j, tenant, korrekturReihe, zone, qualitaet.putArray("korrekturen"));
        }

        String text = BerichtRegeln.kanonisch(abzug);
        return new Ergebnis(tenant, berichtId, b.kennung(), abzug, text, BerichtRegeln.pruefsumme(text), jetzt,
                List.copyOf(quellen), List.copyOf(zeiten));
    }

    // ============================================================================ Lesen je Messstelle

    /**
     * Der Wert EINER Messstelle für eine Periode (Monat oder Jahr) — Trägerform des Lesemodells, dazu
     * {@code berechnet_am} und bei berechneten Messstellen Formel und Formel-Fassung aus der gespeicherten Herkunft (A3,
     * RW2).
     */
    private Gelesen lies(JdbcTemplate j, MessstelleWerteService lesemodell, UUID tenant, MessstelleRepository.Messstelle m,
            String art, String schluessel, LocalDate erster, LocalDate letzter, Instant beginn, ZoneId zone, String ort,
            java.util.function.BiFunction<String, List<Object>, List<Tag>> tagesverlauf) {
        MessstelleWerteDto.Werte antwort = lesemodell.werte(tenant, m, art, erster.toString(), letzter.toString());
        if (antwort.werte().size() != 1) {
            throw new IllegalStateException("Das Lesemodell nennt für " + m.kennzeichen() + " " + schluessel + " "
                    + antwort.werte().size() + " Werte statt einem");
        }
        MessstelleWerteDto.Wert w = antwort.werte().get(0);
        boolean berechnet = MessstelleRegeln.BERECHNET.equals(m.art());
        Integer version = w.version();
        List<Instant> zeiten = new ArrayList<>();
        List<String> korrekturen = List.of();
        List<String> ersatzwerte = List.of();

        String spur;
        String kanalDerSpur = null;
        List<Object> spurArgs = new ArrayList<>();
        if (berechnet) {
            spur = "messstelle_id = ?";
            spurArgs.add(m.id());
        } else if (w.quelle() != null) {
            Map<String, Object> bindung = j.queryForMap("SELECT entity_id, kanal FROM messstelle_quelle "
                    + "WHERE id = ? AND tenant_id = ?", w.quelle(), tenant);
            spur = "entity_id = ? AND messkanal = ?";
            spurArgs.add(bindung.get("entity_id"));
            spurArgs.add(bindung.get("kanal"));
            kanalDerSpur = (String) bindung.get("kanal");
        } else {
            spur = null;
        }

        Instant berechnetAm = null;
        Integer formelFassung = null;
        if (spur != null) {
            List<Object> args = new ArrayList<>(List.of(tenant, art, Timestamp.from(beginn)));
            args.addAll(spurArgs);
            List<Object[]> basis = j.query("SELECT p.berechnet_am, f.nummer FROM messreihe_periode p "
                    + "LEFT JOIN messstelle_formel_fassung f ON f.id = p.formel_fassung_id AND f.tenant_id = p.tenant_id "
                    + "WHERE p.tenant_id = ? AND p.art = ? AND p.beginn = ? AND p." + spur.replace(" AND ", " AND p."),
                    (rs, i) -> new Object[] {rs.getTimestamp(1).toInstant(), rs.getObject(2, Integer.class)},
                    args.toArray());
            if (!basis.isEmpty()) {
                berechnetAm = (Instant) basis.get(0)[0];
                formelFassung = (Integer) basis.get(0)[1];
                zeiten.add(berechnetAm);
            }
            if (version != null && version > 1) {
                List<Object> vargs = new ArrayList<>(List.of(tenant, art, Timestamp.from(beginn), version));
                vargs.addAll(spurArgs);
                List<Object[]> spaeter = j.query("SELECT created_at, nachgezogen_am, korrekturen, ersatzwerte "
                        + "FROM messreihe_periode_version WHERE tenant_id = ? AND ebene = ? AND periode_beginn = ? "
                        + "AND version = ? AND " + spur, (rs, i) -> new Object[] {rs.getTimestamp(1).toInstant(),
                            rs.getTimestamp(2) == null ? null : rs.getTimestamp(2).toInstant(),
                            texte(rs.getArray(3)), texte(rs.getArray(4))}, vargs.toArray());
                if (!spaeter.isEmpty()) {
                    Instant gebildet = (Instant) spaeter.get(0)[0];
                    Instant nachgezogen = (Instant) spaeter.get(0)[1];
                    berechnetAm = nachgezogen != null && nachgezogen.isAfter(gebildet) ? nachgezogen : gebildet;
                    zeiten.add(gebildet);
                    if (nachgezogen != null) {
                        zeiten.add(nachgezogen);
                    }
                    if (!berechnet) {
                        @SuppressWarnings("unchecked")
                        List<String> k = (List<String>) spaeter.get(0)[2];
                        @SuppressWarnings("unchecked")
                        List<String> e = (List<String>) spaeter.get(0)[3];
                        korrekturen = k;
                        ersatzwerte = e;
                    }
                }
            }
        }
        List<Eingang> eingaenge = berechnet ? eingaenge(j, tenant, m.id(), art, beginn, version == null ? 1 : version)
                : List.of();

        String fassung = fassungWort(w.fassung());
        String zustand = w.zustand() == null ? ErgebnisZustand.KEINE_WERTE : w.zustand();
        Integer abdeckung = w.abdeckungProzent();
        ObjectNode n = json.createObjectNode();
        n.put("quelle", m.kennzeichen());
        n.put("name_zum_datenstand", m.name());
        n.put("ort_zum_datenstand", ort);
        n.put("periode", schluessel);
        n.put("menge", w.menge());
        n.put("einheit", m.hauptgroesse().einheit());
        n.put("zustand", zustand);
        n.put("abdeckung_prozent", abdeckung == null ? 0 : abdeckung);
        ArrayNode kennzeichen = n.putArray("kennzeichen");
        (w.kennzeichen() == null ? List.<String>of() : w.kennzeichen()).forEach(kennzeichen::add);
        n.put("fassung", fassung);
        n.put("endgueltig_ab", w.endgueltigAb() == null ? null : iso(OffsetDateTime.parse(w.endgueltigAb()).toInstant(), zone));
        n.put("version", version);
        n.put("berechnet_am", berechnetAm == null ? null : iso(berechnetAm, zone));
        n.put("zeitzone", zone.getId());
        if (berechnet && !eingaenge.isEmpty()) {
            n.put("formel", formelText(eingaenge));
        }
        if (berechnet && formelFassung != null) {
            n.put("formel_fassung", formelFassung);
        }
        Set<UUID> luecken = new LinkedHashSet<>();
        if (w.ereignisse() != null) {
            w.ereignisse().stream().filter(e -> DATA_GAP.equals(e.art())).map(MessstelleWerteDto.Ereignis::id)
                    .forEach(luecken::add);
        }
        // Vertrag 1.2 — eine Messstelle mit ZWEI Flussrichtungen in einer Größe zeigt beide getrennt.
        // Abgeschrieben, nicht gerechnet (EW3): die Verdichtung hat sie je Rohwert gebildet
        // (V20260918104000) und in der Periodenzeile abgelegt (V20260918101000).
        // Dass diese Messstelle zwei Flüsse führt, sagt ihre HAUPTGRÖSSE (AP-04) — nicht der Katalogpunkt
        // ihrer heutigen Bindung, der wechseln kann. Die beiden Zahlen liefert die Verdichtung — für DIESELBE
        // Version wie die Menge (eine Korrektur trägt ihr Paar seit V20260923231500 mit).
        BigDecimal[] paar = null;
        if (SPEICHER_RICHTUNG.equals(m.hauptgroesse().richtung()) && spur != null && !berechnet) {
            paar = Richtungspaar.mengenDerVersion(j, tenant, art, beginn, version, spur, spurArgs).orElse(null);
        }
        List<Tag> tageDerReihe = tagesverlauf == null || spur == null ? List.of()
                : tagesverlauf.apply(spur, spurArgs);
        return new Gelesen(n, w.menge(), version, zustand, fassung, abdeckung, zeiten, eingaenge, korrekturen,
                ersatzwerte, luecken, paar, tageDerReihe);
    }

    /** Die gespeicherten Eingänge einer berechneten Zahl IN IHRER Version (die jüngste Fassung bis zu ihr). */
    private static List<Eingang> eingaenge(JdbcTemplate j, UUID tenant, UUID messstelle, String art, Instant beginn,
            int version) {
        return j.query("SELECT e.eingang_messstelle_id, e.eingang_kennzeichen, e.messkanal, q.name, q.richtung, e.rolle, "
                + "e.anteil, e.vorzeichen, e.faktor, e.eingang_version FROM bilanzwert_eingang e "
                + "LEFT JOIN messstelle q ON q.id = e.eingang_messstelle_id AND q.tenant_id = e.tenant_id "
                + "WHERE e.tenant_id = ? AND e.messstelle_id = ? AND e.periode = ? AND e.periode_beginn = ? "
                + "AND e.version = (SELECT max(x.version) FROM bilanzwert_eingang x WHERE x.tenant_id = e.tenant_id "
                + "AND x.messstelle_id = e.messstelle_id AND x.periode = e.periode "
                + "AND x.periode_beginn = e.periode_beginn AND x.version <= ?) ORDER BY e.position",
                (rs, i) -> new Eingang(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getString(6), rs.getString(7), rs.getString(8), rs.getBigDecimal(9),
                        rs.getObject(10, Integer.class)),
                tenant, messstelle, art, Timestamp.from(beginn), version);
    }

    /**
     * RW2 — die Formel einer berechneten Zahl als Text aus ihren gespeicherten Eingängen: erst was hinzukommt (Zufluss,
     * „+“), dann was abgeht (Abfluss, zugeordnet, „−“), in beiden Gruppen nach Kennzeichen; der Anteil eines Speichers
     * heißt „laden“ (positiv = Abfluss) bzw. „entladen“ (negativ = Zufluss, {@link BilanzAbleitung#rolle}), der eines
     * Bezug/Abgabe-Werts nach {@link MessstelleRegeln#ANTEIL_RICHTUNGEN}; ein Faktor ungleich 1 steht davor.
     */
    static String formelText(List<Eingang> eingaenge) {
        Comparator<Eingang> ordnung = Comparator.comparing(BerichtAbzugBildung::bezeichnung)
                .thenComparing(e -> Objects.toString(anteilWort(e), ""));
        List<Eingang> dazu = eingaenge.stream().filter(e -> !abziehen(e)).sorted(ordnung).toList();
        List<Eingang> weg = eingaenge.stream().filter(BerichtAbzugBildung::abziehen).sorted(ordnung).toList();
        StringBuilder sb = new StringBuilder();
        for (Eingang e : dazu) {
            sb.append(sb.isEmpty() ? "" : " + ").append(term(e));
        }
        for (Eingang e : weg) {
            sb.append(sb.isEmpty() ? "− " : " − ").append(term(e));
        }
        return sb.toString();
    }

    private static boolean abziehen(Eingang e) {
        if (e.rolle() != null) {
            return !BilanzAbleitung.ZUFLUSS.equals(e.rolle());
        }
        return "-".equals(e.vorzeichen());
    }

    private static String bezeichnung(Eingang e) {
        return e.kennzeichen() != null ? e.kennzeichen() : Objects.toString(e.messkanal(), "");
    }

    private static String term(Eingang e) {
        String faktor = e.faktor() == null || e.faktor().compareTo(BigDecimal.ONE) == 0 ? ""
                : e.faktor().stripTrailingZeros().toPlainString() + " × ";
        String anteil = anteilWort(e);
        return faktor + bezeichnung(e) + (anteil == null ? "" : " (" + anteil + ")");
    }

    /**
     * Die Tageszeilen EINER Reihe im Zeitraum (Tage einschließlich) — Menge, Richtungspaar und Zustand,
     * genau wie {@code messreihe_tag} sie führt. Ein Tag ohne Zeile ist kein Tag mit 0: er fehlt hier,
     * und damit fehlt er auch im Bericht.
     */
    private static List<Tag> tageDerReihe(JdbcTemplate j, UUID tenant, LocalDate erster, LocalDate letzter,
            String spur, List<Object> spurArgs) {
        List<Object> args = new ArrayList<>(List.of(tenant, Date.valueOf(erster), Date.valueOf(letzter)));
        args.addAll(spurArgs);
        return j.query("SELECT tag, menge, menge_positiv, menge_negativ, menge_zustand FROM messreihe_tag "
                + "WHERE tenant_id = ? AND tag >= ? AND tag <= ? AND " + spur + " ORDER BY tag",
                (rs, i) -> new Tag(rs.getDate(1).toLocalDate(), rs.getBigDecimal(2), rs.getBigDecimal(3),
                        rs.getBigDecimal(4), rs.getString(5)),
                args.toArray());
    }

    /**
     * Der Tagesverlauf EINER Wert-Zeile: dieselbe Kennung wie im Abschnitt „werte“ ({@code quelle} plus
     * {@code menge_art}), dazu je Tag Menge und Zustand. Eine Richtungs-Zeile nimmt den Anteil ihres
     * Tages; fehlt er, fehlt die Menge — unbekannt ist keine Null.
     */
    private static ObjectNode tagesverlaufEintrag(ObjectMapper json, ObjectNode zeile, List<Tag> tage) {
        ObjectNode n = json.createObjectNode();
        n.put("quelle", zeile.path("quelle").asText());
        String art = zeile.hasNonNull("menge_art") ? zeile.path("menge_art").asText() : null;
        if (art != null) {
            n.put("menge_art", art);
        }
        ArrayNode aus = n.putArray("tage");
        for (Tag t : tage) {
            ObjectNode x = aus.addObject();
            x.put("tag", t.tag().toString());
            x.put("menge", art == null ? t.menge() : "laden".equals(art) ? t.positiv() : t.negativ());
            x.put("zustand", t.zustand() == null ? ErgebnisZustand.KEINE_WERTE : t.zustand());
        }
        return n;
    }

    /**
     * Eine der beiden Richtungs-Zeilen einer Reihe mit zwei Flüssen: dieselbe Zeile, nur mit der Menge
     * des Anteils und dem Wort, das sie benennt. Alles andere — Ort, Zustand, Abdeckung, Kennzeichen,
     * Fassung, Endgültigkeit, Version, Berechnungszeit — ist der Nachweis der EINEN Reihe und bleibt
     * gleich; es gibt keine zweite Messung.
     */
    private static ObjectNode richtungsZeile(ObjectNode vorlage, String art, BigDecimal menge) {
        ObjectNode n = vorlage.deepCopy();
        n.put("menge", menge);
        n.put("menge_art", art);
        return n;
    }

    private static String anteilWort(Eingang e) {
        if (e.anteil() == null || "gesamt".equals(e.anteil())) {
            return null;
        }
        if (SPEICHER_RICHTUNG.equals(e.richtung())) {
            return MessstelleRegeln.ANTEIL_POSITIV.equals(e.anteil()) ? "laden" : "entladen";
        }
        return MessstelleRegeln.ANTEIL_RICHTUNGEN.get("import_export").getOrDefault(e.anteil(), e.anteil());
    }

    /** Die Zusammenfassung zählt Hauptzähler (Bezug/Abgabe), Erzeuger und Speicher mit EINER Richtung — in kWh. */
    private static String summenSchluessel(MessstelleRepository.Messstelle m, String stellung) {
        MessstelleRegeln.Groesse h = m.hauptgroesse();
        if (stellung == null || !"Strom".equals(m.medium()) || !"kWh".equals(h.einheit())) {
            return null;
        }
        return switch (stellung) {
            case "Hauptzähler" -> "Bezug".equals(h.richtung()) ? NETZBEZUG : "Abgabe".equals(h.richtung()) ? EINSPEISUNG : null;
            case "Erzeuger" -> "Erzeugung".equals(h.richtung()) ? PV_ERZEUGUNG : null;
            case "Speicher" -> "Laden".equals(h.richtung()) ? SPEICHER_LADEN
                    : "Entladen".equals(h.richtung()) ? SPEICHER_ENTLADEN : null;
            default -> null;
        };
    }

    private void korrekturen(JdbcTemplate j, UUID tenant, Map<String, String> reihen, ZoneId zone, ArrayNode aus) {
        Map<String, WertVersionenLeser.Fassung> neueste = new TreeMap<>();
        for (WertVersionenLeser.Fassung f : new WertVersionenLeser(j).fassungen(tenant, reihen.keySet())) {
            neueste.merge(f.kennung(), f, (a, c) -> c.fassung() > a.fassung() ? c : a);
        }
        for (Map.Entry<String, WertVersionenLeser.Fassung> e : neueste.entrySet()) {
            WertVersionenLeser.Fassung f = e.getValue();
            ObjectNode n = aus.addObject();
            n.put("kennung", f.kennung());
            n.put("reihe", reihen.get(f.kennung()));
            n.put("freigegeben", f.am() == null ? null : iso(f.am(), zone));
            n.put("wer", f.actorRolle() == null ? f.actorName() : f.actorName() + " (" + f.actorRolle() + ")");
            n.put("warum", f.begruendung());
        }
    }

    // ============================================================================ Geltung, Tage, Stammdaten

    private static Geltung geltung(JdbcTemplate j, UUID tenant, UUID standort) {
        return j.queryForObject("SELECT s.name, s.kurzzeichen, s.archiviert_am, u.name AS unternehmen, u.sitz_strasse, "
                + "u.sitz_plz, u.sitz_ort FROM standort s JOIN unternehmen u ON u.id = s.unternehmen_id "
                + "AND u.tenant_id = s.tenant_id WHERE s.id = ? AND s.tenant_id = ?", (rs, i) -> {
                    Timestamp archiviert = rs.getTimestamp("archiviert_am");
                    return new Geltung(BerichtRegeln.STANDORT, rs.getString("name"), rs.getString("kurzzeichen"),
                            archiviert == null ? null : archiviert.toInstant(), rs.getString("unternehmen"),
                            BerichtUnternehmen.sitz(rs.getString("sitz_strasse"), rs.getString("sitz_plz"),
                                    rs.getString("sitz_ort")));
                }, standort, tenant);
    }

    private static final String MESSSTELLEN_DER_GELTUNG = """
            WITH RECURSIVE tage AS (
                SELECT d::date AS tag FROM generate_series(?::date, ?::date, interval '1 day') AS d),
            mo AS (
                SELECT t.tag, o.messstelle_id, o.standort_id, o.ort_id
                  FROM tage t JOIN messstelle_ort o ON o.tenant_id = ? AND o.aufgehoben_am IS NULL
                   AND daterange(o.gueltig_ab, o.gueltig_bis, '[]') @> t.tag),
            kette (tag, messstelle_id, ort_id, eltern_standort_id, eltern_ort_id, tiefe) AS (
                SELECT mo.tag, mo.messstelle_id, mo.ort_id, z.eltern_standort_id, z.eltern_ort_id, 0
                  FROM mo JOIN ort_zuordnung z ON z.tenant_id = ? AND z.ort_id = mo.ort_id AND z.aufgehoben_am IS NULL
                   AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> mo.tag
                UNION ALL
                SELECT k.tag, k.messstelle_id, k.ort_id, z.eltern_standort_id, z.eltern_ort_id, k.tiefe + 1
                  FROM kette k JOIN ort_zuordnung z ON z.tenant_id = ? AND z.ort_id = k.eltern_ort_id
                   AND z.aufgehoben_am IS NULL AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> k.tag
                 WHERE k.tiefe < 8)
            SELECT x.tag, x.messstelle_id, coalesce(o.kurzzeichen, s.kurzzeichen) AS ort
              FROM (SELECT tag, messstelle_id, NULL::uuid AS ort_id FROM mo WHERE standort_id = ?
                    UNION
                    SELECT tag, messstelle_id, ort_id FROM kette WHERE eltern_standort_id = ?) x
              LEFT JOIN ort o ON o.id = x.ort_id AND o.tenant_id = ?
              JOIN standort s ON s.id = ? AND s.tenant_id = ?
             ORDER BY x.messstelle_id, x.tag
            """;

    /**
     * Q3 — die Messstellen, deren Ort an einem Tag des Zeitraums zum Standort gehört (Standort direkt oder über Gebäude
     * und Bereich), je Tag mit dem Kennzeichen dieses Orts. Zuordnungen tagesgenau, letzter Tag eingeschlossen.
     */
    static Map<UUID, TreeMap<LocalDate, String>> messstellenDerGeltung(JdbcTemplate j, UUID tenant, UUID standort,
            LocalDate von, LocalDate bis) {
        Map<UUID, TreeMap<LocalDate, String>> aus = new LinkedHashMap<>();
        j.query(MESSSTELLEN_DER_GELTUNG, rs -> {
            aus.computeIfAbsent(rs.getObject("messstelle_id", UUID.class), x -> new TreeMap<>())
                    .put(rs.getObject("tag", LocalDate.class), rs.getString("ort"));
        }, Date.valueOf(von), Date.valueOf(bis), tenant, tenant, tenant, standort, standort, tenant, standort, tenant);
        return aus;
    }

    /**
     * Seit wann der Standort Messstellen hat — „Energiemanagement seit“ (Q5): der früheste Tag bis {@code bis}, an dem eine
     * Messstelle zur Geltung gehört. Eine Zugehörigkeit beginnt nur am {@code gueltig_ab} einer Orts- oder
     * Messstellen-Zuordnung; {@code null}, wenn es keinen solchen Tag gibt.
     */
    static LocalDate bestehtSeit(JdbcTemplate j, UUID tenant, UUID standort, LocalDate bis) {
        List<LocalDate> kandidaten = j.query("SELECT tag FROM (SELECT gueltig_ab AS tag FROM messstelle_ort "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL UNION SELECT gueltig_ab FROM ort_zuordnung "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL) k WHERE tag <= ? ORDER BY tag",
                (rs, i) -> rs.getObject(1, LocalDate.class), tenant, tenant, Date.valueOf(bis));
        for (LocalDate tag : kandidaten) {
            if (!messstellenDerGeltung(j, tenant, standort, tag, tag).isEmpty()) {
                return tag;
            }
        }
        return null;
    }

    /**
     * Hat die Geltung an einem Tag von {@code von} bis {@code bis} eine Messstelle (Q3)? Die Routen fragen es vor dem
     * Anlegen (422 {@code keine_quellen}) — für Standort und Unternehmen dieselbe Auswahl wie die Bildung.
     */
    static boolean hatMessstellen(JdbcTemplate j, UUID tenant, String geltungArt, UUID geltung, LocalDate von,
            LocalDate bis) {
        return !umfang(j, tenant, geltungArt, geltung, von, bis).tage().isEmpty();
    }

    /** „Energiemanagement seit“ (Q5) für Standort und Unternehmen. */
    static LocalDate bestehtSeit(JdbcTemplate j, UUID tenant, String geltungArt, UUID geltung, LocalDate bis) {
        return BerichtRegeln.STANDORT.equals(geltungArt) ? bestehtSeit(j, tenant, geltung, bis)
                : BerichtUnternehmen.bestehtSeit(j, tenant, bis,
                        tag -> hatMessstellen(j, tenant, geltungArt, geltung, tag, tag));
    }

    /**
     * Die Messstellen des Berichts je Tag: am Standort {@link #messstellenDerGeltung}, am Unternehmen
     * {@link BerichtUnternehmen#umfang} mit den Netzbezugs-Zählern nach der elektrischen Stellung am letzten Tag.
     */
    static BerichtUnternehmen.Umfang umfang(JdbcTemplate j, UUID tenant, String geltungArt, UUID geltung, LocalDate von,
            LocalDate bis) {
        if (BerichtRegeln.STANDORT.equals(geltungArt)) {
            return new BerichtUnternehmen.Umfang(messstellenDerGeltung(j, tenant, geltung, von, bis), Set.of(), List.of());
        }
        Map<UUID, List<Object[]>> stellungen = stellungen(j, tenant);
        return BerichtUnternehmen.umfang(j, tenant, geltung, von, bis, new MessstelleRepository(j),
                (m, tag) -> NETZBEZUG.equals(summenSchluessel(m, stellungAm(stellungen.get(m.id()), tag))));
    }

    private static List<MessstelleRepository.Messstelle> sortiert(MessstelleRepository messstellen, Set<UUID> ids) {
        return ids.stream().map(id -> messstellen.finde(id).orElseThrow(() ->
                        new IllegalStateException("Messstelle " + id + " fehlt")))
                .sorted(Comparator.comparing(MessstelleRepository.Messstelle::kennzeichen)).toList();
    }

    /** Die elektrischen Stellungen des Kundenbereichs je Messstelle: {stellung, gueltig_ab, gueltig_bis}. */
    private static Map<UUID, List<Object[]>> stellungen(JdbcTemplate j, UUID tenant) {
        Map<UUID, List<Object[]>> aus = new HashMap<>();
        j.query("SELECT messstelle_id, stellung, gueltig_ab, gueltig_bis FROM messstelle_stellung "
                + "WHERE tenant_id = ? AND aufgehoben_am IS NULL", rs -> {
                    aus.computeIfAbsent(rs.getObject(1, UUID.class), x -> new ArrayList<>()).add(new Object[] {
                        rs.getString(2), rs.getObject(3, LocalDate.class), rs.getObject(4, LocalDate.class)});
                }, tenant);
        return aus;
    }

    private static String stellungAm(List<Object[]> zeilen, LocalDate tag) {
        if (zeilen == null) {
            return null;
        }
        for (Object[] z : zeilen) {
            LocalDate ab = (LocalDate) z[1];
            LocalDate bis = (LocalDate) z[2];
            if (!tag.isBefore(ab) && (bis == null || !tag.isAfter(bis))) {
                return (String) z[0];
            }
        }
        return null;
    }

    private MessstelleWerteService lesemodell(JdbcTemplate j, Instant jetzt) {
        MessstelleQuelleRepository quellen = new MessstelleQuelleRepository(j);
        MessstelleWerteService s = new MessstelleWerteService(j, new MessstelleRepository(j), quellen,
                new QuelleKadenzRepository(j), new MesskanalService(j, new Geltungsbereich(j), katalog, json,
                        new GeraetRepository(j), quellen), new SpeicherklasseHistorie(j, katalog),
                new BerechnetePeriodenRepository(j));
        s.uhrStellen(Clock.fixed(jetzt, ZoneOffset.UTC));
        return s;
    }

    // ============================================================================ Hilfen

    static List<Spanne> spannen(NavigableSet<LocalDate> tage) {
        List<Spanne> aus = new ArrayList<>();
        LocalDate von = null;
        LocalDate bis = null;
        for (LocalDate t : tage) {
            if (von != null && t.equals(bis.plusDays(1))) {
                bis = t;
                continue;
            }
            if (von != null) {
                aus.add(new Spanne(von, bis));
            }
            von = t;
            bis = t;
        }
        if (von != null) {
            aus.add(new Spanne(von, bis));
        }
        return aus;
    }

    private static String fassungWort(String gespeichert) {
        if (GEMESSEN_ENDGUELTIG.equals(gespeichert)) {
            return KennzahlRegeln.ENDGUELTIG;
        }
        return GEMESSEN_VORLAEUFIG.equals(gespeichert) ? KennzahlRegeln.VORLAEUFIG : null;
    }

    private static List<String> texte(Array a) throws SQLException {
        return a == null ? List.of() : List.of((String[]) a.getArray());
    }

    static String iso(Instant t, ZoneId zone) {
        return t.atZone(zone).format(ISO);
    }

    private static String kurzform(String kennzeichen) {
        String muster = BerichtRegeln.KENNZEICHEN.stream().filter(k -> k.schluessel().equals(kennzeichen)).findFirst()
                .orElseThrow().muster();
        int klammer = muster.indexOf(" (");
        return klammer < 0 ? muster : muster.substring(0, klammer);
    }
}
