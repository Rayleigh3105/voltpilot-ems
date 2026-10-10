package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Der Anstoß an der BEZUGSBASIS (UEMS AP-17 IP-15, A2–A4; E5 = A, E6 = A, W4): eine freigegebene Fassung bleibt
 * byte-gleich (Trigger {@code bezugsbasis_fassung_eingefroren}) und bekommt einen Zustand „Anstoß liegt vor“ in
 * {@code bezugsbasis_anstoss} — je Fassung, Art und Anlass-Kennung genau einmal — samt Protokollzeile
 * {@code anstoss_gesetzt} in {@code bezugsbasis_aenderung}. Kein Läufer antwortet (A4).
 *
 * <ul>
 *   <li><b>Pfad 1</b> ({@link #nachKorrektur}, A2): die {@link KennzahlKaskade} ruft ihn in DERSELBEN Transaktion wie die
 *       Kennzahl-Neubildung. Angestoßen ({@code grundlage_korrigiert}) wird jede freigegebene Fassung, deren Grundlage
 *       einen Wert zitiert, der eben eine neue Version bekam: einen Kennzahl-Wert (Kennzeichen + Monat, zitierte Version
 *       kleiner als die neue — oder der Monat der Kennzahl der Basis selbst), einen Messstellen-Wert im Zeitraum der
 *       Korrektur, einen Bezugsgrößen-Wert (zitierte Fassung kleiner als die neue, Rücknahme immer) oder eine Fläche des
 *       rückwirkend geänderten Orts. Anlass-Kennung = Vorgang (+ Fassung/Rücknahme), siehe {@link #kennung}.</li>
 *   <li><b>Pfad 2</b> ({@link #strukturLauf}, A3): der {@link StrukturAenderungLaeufer} ruft ihn in seinem Takt; er liest
 *       {@code ort_aenderung} (Fläche, Standort, Anlage), {@code messstelle_aenderung} (Prozesse, Verteilung auf
 *       Kostenstellen), {@code kennzahl_aenderung} (Archivierung) und {@code bezugsgroesse_aenderung} (Bearbeitung,
 *       Archivierung einer Variablen) mit eigenem Wasserzeichen {@code bezugsbasis_struktur_gelesen}. Arten
 *       {@code struktur_geaendert · variable_geaendert · nicht_mehr_anwendbar}; Anlass-Kennung {@code <protokoll>:<id>}.
 *       Ein Wortlaut-Faktor löst nie etwas aus (V3). Eine Änderung vor der Freigabe steckt schon in der Grundlage.</li>
 * </ul>
 *
 * <p><b>Beendete Basis</b> (A4, §15 Pflege; Nachlese 1): beide Pfade übergehen jede Fassung einer Basis mit
 * {@code beendet_am} — ein Anstoß verlangt eine Antwort, an einer beendeten Basis gibt es keine mehr. Beenden (F4) und
 * die Archivierungs-Naht der Kennzahl beantworten die offenen Anstöße selbst mit {@code beendet}; was danach gelesen
 * wird, setzt keinen neuen. Die Historie trägt die Beendigung im Protokoll {@code bezugsbasis_beendet}.
 *
 * <p><b>Schalter</b> {@value #SCHALTER} (Vorgabe AN): aus → Pfad 1 schweigt, Pfad 2 liest weiter und setzt das
 * Wasserzeichen mit dem Urteil {@code abgeschaltet} — nichts wird nachgeholt. Pfad 2 läuft nur, solange der
 * Struktur-Läufer läuft (Schalter der Berichte, {@code berichte.enabled} und {@code berichte.struktur.enabled}).
 *
 * <p><b>A5 (AP-17 IP-23)</b>: jeder NEU gesetzte Anstoß läuft in derselben Transaktion weiter zu jedem gültigen
 * Leistungsvergleichs-Stand, der die Fassung zitiert ({@link BerichtKaskade#basisWeitergeben}, Art
 * {@code bezugsbasis_anstoss}, Anlass-Kennung {@code BB-…/Fassung-n/anstoss:<id>}). Eine freigegebene Fassung n + 1
 * ({@code fassung_freigegeben}) und das Beenden ({@code bezugsbasis_beendet}) liest Pfad 2 aus
 * {@code bezugsbasis_aenderung} mit demselben Wasserzeichen und gibt sie als {@code bezugsbasis_fassung}
 * ({@code BB-…/Fassung-n}, an Stände mit Fassung &lt; n) bzw. {@code bezugsbasis_beendet} ({@code BB-…/beendet}) weiter —
 * setzt dabei keinen Anstoß an der Basis. Ohne {@code berichte.enabled} fehlt die {@link BerichtKaskade}: nichts wird
 * weitergegeben und nichts nachgeholt.
 */
@Component
public class BezugsbasisAnstoss {

    public static final String SCHALTER = "voltpilot.uems.bezugsbasis.enabled";

    static final String GRUNDLAGE_KORRIGIERT = "grundlage_korrigiert";
    static final String STRUKTUR_GEAENDERT = "struktur_geaendert";
    static final String VARIABLE_GEAENDERT = "variable_geaendert";
    static final String NICHT_MEHR_ANWENDBAR = "nicht_mehr_anwendbar";
    static final String PROTOKOLL = "anstoss_gesetzt";

    /** Urteile im Wasserzeichen ohne Anstoß. */
    static final String OHNE_BEZUGSBASIS = "ohne_bezugsbasis";
    static final String NICHT_STRUKTURELL = "nicht_strukturell";
    static final String ABGESCHALTET = "abgeschaltet";
    /** A5 (IP-23): Urteile einer Zeile aus {@code bezugsbasis_aenderung} — sie setzt nie einen Anstoß an der Basis. */
    static final String AN_BERICHTE = "an_berichte";
    static final String OHNE_STAND = "ohne_stand";
    static final String OHNE_BERICHTE = "ohne_berichte";
    static final String BEZUGSBASIS_AENDERUNG = "bezugsbasis_aenderung";

    /** Felder einer Bezugsgröße, deren Bearbeitung die Variable nicht ändert (Name, Beschreibung). */
    private static final Set<String> NUR_WORTLAUT = Set.of("name", "beschreibung", "notiz", "bemerkung", "kennzeichen");

    private static final int ANLASS_LAENGE = 480;
    private static final Logger log = LoggerFactory.getLogger(BezugsbasisAnstoss.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    @Value("${" + SCHALTER + ":true}")
    private boolean eingeschaltet = true;

    /** A5 (IP-23): die Bericht-Naht; {@code null}, solange {@code voltpilot.uems.berichte.enabled} aus ist. */
    private BerichtKaskade berichte;

    /**
     * AP-18 IP-7/IP-17 (Z5, M5): die Naht der Verbesserung — der Anstoß an Zielen und Maßnahmen im Zweig der Bezugsbasis
     * (Pfad 2) läuft über ihren Schalter; ohne sie (Minimal-Kontexte) stößt der Läufer keinen Vorgang an.
     */
    private VerbesserungNaht verbesserung;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public BezugsbasisAnstoss() {}

    @Autowired(required = false)
    void setBerichte(BerichtKaskade berichte) {
        this.berichte = berichte;
    }

    @Autowired(required = false)
    void verbesserung(VerbesserungNaht verbesserung) {
        this.verbesserung = verbesserung;
    }

    /** Ohne Spring (Tests): mit ausdrücklichem Schalter und der Bericht-Naht der Weitergabe (A5). */
    static BezugsbasisAnstoss mitSchalter(boolean an, BerichtKaskade berichte) {
        BezugsbasisAnstoss b = mitSchalter(an);
        b.berichte = berichte;
        return b;
    }

    /** Ohne Spring (Tests): mit ausdrücklichem Schalter. */
    static BezugsbasisAnstoss mitSchalter(boolean an) {
        BezugsbasisAnstoss b = new BezugsbasisAnstoss();
        b.eingeschaltet = an;
        return b;
    }

    /** Ein neu gesetzter Anstoß — was IP-23 (A5) an die Leistungsvergleichs-Stände weitergibt. */
    public record Gesetzt(UUID tenant, UUID bezugsbasis, UUID fassungId, int fassung, int pfad, String art,
            String anlassKennung, UUID anstossId) {}

    // ============================================================================ Pfad 1 (A2)

    /**
     * Nach der Kennzahl-Neubildung der Kaskade, in ihrer Transaktion (Verwaltungsrolle, jede Abfrage nennt den Mandanten).
     * Wirft bei jedem Fehler — die Kaskade rollt dann alles zurück.
     *
     * @param neu die Kennzahl-Perioden, die eben Version n + 1 wurden
     */
    public List<Gesetzt> nachKorrektur(Connection con, KorrekturKaskade.Betroffen b, List<KennzahlLauf.Neu> neu)
            throws SQLException {
        if (!eingeschaltet) {
            return List.of();
        }
        List<Fassung> fassungen = freigegebene(con, b.tenant());
        if (fassungen.isEmpty()) {
            return List.of();
        }
        Zitiert z = zitiert(con, b, neu);
        String kennung = kennung(b);
        String status = KorrekturKaskade.ZURUECKGENOMMEN.equals(b.status()) ? "zurückgenommen" : b.status();
        List<Gesetzt> gesetzt = new ArrayList<>();
        for (Fassung f : fassungen) {
            List<String> treffer = treffer(f, z);
            if (treffer.isEmpty()) {
                continue;
            }
            String anlass = kennung + " (" + status + "): " + String.join(", ", treffer);
            Gesetzt g = setzen(con, f, 1, GRUNDLAGE_KORRIGIERT, kennung, anlass, "VoltPilot (Kaskade)");
            if (g != null) {
                gesetzt.add(g);
                weitergeben(con, g, b.jetzt());
            }
        }
        if (!gesetzt.isEmpty()) {
            log.info("UEMS Bezugsbasis Pfad 1 {}: {} Anstöße gesetzt", kennung, gesetzt.size());
        }
        return gesetzt;
    }

    /**
     * Die Anlass-Kennung des Pfads 1: der Auslöser der Kennzahl-Meldung ({@link KennzahlKaskade#ausloeser}) — dazu bei
     * einer Korrektur ab Fassung 2 die Fassung und bei einer Rücknahme {@code /zurueckgenommen}: dieselbe Korrektur
     * stößt einmal an, ihre Rücknahme ist eine neue Version und stößt noch einmal an.
     */
    static String kennung(KorrekturKaskade.Betroffen b) {
        String k = KennzahlKaskade.ausloeser(b);
        if (KorrekturKaskade.ZURUECKGENOMMEN.equals(b.status())) {
            return k + "/zurueckgenommen";
        }
        if ((KorrekturKaskade.FREIGEGEBEN.equals(b.status()) || KorrekturKaskade.WIRKSAM.equals(b.status()))
                && b.fassung() > 1) {
            return k + "/Fassung-" + b.fassung();
        }
        return k;
    }

    /** Was eine Verarbeitung neu versioniert hat — in der Sprache der Grundlage (Kennzeichen, Monat, Version/Fassung). */
    private record Zitiert(Map<String, Map<YearMonth, Integer>> kennzahlen, Map<UUID, Set<YearMonth>> kennzahlIds,
            Set<String> messstellen, Set<YearMonth> korrekturMonate, List<KorrekturKaskade.Bezugsgroesse> bezugsgroessen,
            String ort, Set<YearMonth> ortMonate) {}

    private static Zitiert zitiert(Connection con, KorrekturKaskade.Betroffen b, List<KennzahlLauf.Neu> neu)
            throws SQLException {
        Map<String, Map<YearMonth, Integer>> kennzahlen = new LinkedHashMap<>();
        Map<UUID, Set<YearMonth>> kennzahlIds = new LinkedHashMap<>();
        for (KennzahlLauf.Neu n : neu) {
            if (!"monat".equals(n.periodeArt())) {
                continue; // Die Grundlage zitiert Monate (F3); Tag/Woche/Jahr stehen nicht darin.
            }
            YearMonth m = YearMonth.from(n.von());
            kennzahlen.computeIfAbsent(n.kennzeichen(), k -> new LinkedHashMap<>()).merge(m, n.version(), Math::max);
            kennzahlIds.computeIfAbsent(n.kennzahl(), k -> new LinkedHashSet<>()).add(m);
        }
        Set<String> messstellen = new LinkedHashSet<>();
        Set<YearMonth> korrekturMonate = new LinkedHashSet<>();
        boolean flaeche = KorrekturKaskade.FLAECHE_GEAENDERT.equals(b.status());
        if (!flaeche && !KorrekturKaskade.BERECHNUNG_GEAENDERT.equals(b.status())
                && !KorrekturKaskade.STAMMDATUM_EINGETRAGEN.equals(b.status()) && b.ersterTag() != null) {
            Set<UUID> ids = KennzahlKaskade.messstellen(con, b);
            if (!ids.isEmpty()) {
                try (PreparedStatement ps = con.prepareStatement(
                        "SELECT kennzeichen FROM messstelle WHERE tenant_id = ? AND id = ANY (?)")) {
                    ps.setObject(1, b.tenant());
                    ps.setArray(2, con.createArrayOf("uuid", ids.toArray()));
                    try (ResultSet rs = ps.executeQuery()) {
                        while (rs.next()) {
                            messstellen.add(rs.getString(1));
                        }
                    }
                }
                korrekturMonate.addAll(monate(b.ersterTag(), b.letzterTag()));
            }
        }
        Set<YearMonth> ortMonate = new LinkedHashSet<>();
        if (flaeche && b.ersterTag() != null) {
            ortMonate.addAll(monate(b.ersterTag(), b.letzterTag()));
        }
        return new Zitiert(kennzahlen, kennzahlIds, messstellen, korrekturMonate, b.bezugsgroessen(),
                flaeche ? b.anlass() : null, ortMonate);
    }

    private static Set<YearMonth> monate(LocalDate von, LocalDate bis) {
        Set<YearMonth> aus = new LinkedHashSet<>();
        YearMonth ende = YearMonth.from(bis == null ? von : bis);
        for (YearMonth m = YearMonth.from(von); !m.isAfter(ende); m = m.plusMonths(1)) {
            aus.add(m);
        }
        return aus;
    }

    /** Welche Einträge der Grundlage die neue Version zitieren — in Worten für den Anlass; leer = kein Anstoß. */
    private static List<String> treffer(Fassung f, Zitiert z) {
        List<String> aus = new ArrayList<>();
        for (JsonNode eintrag : perioden(f.grundlage())) {
            YearMonth m;
            try {
                m = YearMonth.parse(eintrag.path("periode").asText());
            } catch (RuntimeException e) {
                continue;
            }
            boolean kennzahlZitiert = false;
            for (JsonNode wert : zitate(eintrag)) {
                String objekt = wert.path("objekt").asText(null);
                if (objekt == null) {
                    continue;
                }
                Integer neueVersion = z.kennzahlen().getOrDefault(objekt, Map.of()).get(m);
                if (objekt.startsWith("KZ-")) {
                    kennzahlZitiert |= objekt.equals(f.kennzahlKennzeichen());
                    if (neueVersion != null && (!wert.has("version") || wert.path("version").asInt() < neueVersion)) {
                        aus.add(objekt + " " + m + " Version " + neueVersion);
                    }
                    continue;
                }
                if (z.messstellen().contains(objekt) && z.korrekturMonate().contains(m)) {
                    aus.add(objekt + " " + m);
                }
                for (KorrekturKaskade.Bezugsgroesse g : z.bezugsgroessen()) {
                    if (objekt.equals(g.kennzeichen()) && monate(g.periodeVon(), g.periodeBis()).contains(m)
                            && (!wert.has("fassung") || wert.path("fassung").asInt() < g.fassung()
                                    || KorrekturKaskade.ZURUECKGENOMMEN.equals(g.status()))) {
                        aus.add(objekt + " " + m + (g.fassung() > 0 ? " Fassung " + g.fassung() : ""));
                    }
                }
                if (z.ort() != null && z.ort().equals(wert.path("ort").asText(null)) && z.ortMonate().contains(m)) {
                    aus.add("Fläche " + z.ort() + " " + m);
                }
            }
            // Zitiert der Eintrag die Kennzahl der Basis nicht selbst (Modelle: nur Zähler und Nenner), zählt ihr Monat.
            if (!kennzahlZitiert && z.kennzahlIds().getOrDefault(f.kennzahl(), Set.of()).contains(m)) {
                aus.add(f.kennzahlKennzeichen() + " " + m + " Version "
                        + z.kennzahlen().getOrDefault(f.kennzahlKennzeichen(), Map.of()).getOrDefault(m, 0));
            }
        }
        return aus.stream().distinct().toList();
    }

    /**
     * Die zitierten Werte eines Periodeneintrags: jedes Objekt mit {@code objekt} direkt unter dem Eintrag (Referenzdatei
     * 1.8: {@code zaehler}, {@code nenner}, {@code kennzahl}) oder in einer Liste darunter (IP-7: {@code eingaenge[]}).
     */
    private static List<JsonNode> zitate(JsonNode eintrag) {
        List<JsonNode> aus = new ArrayList<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = eintrag.fields(); it.hasNext(); ) {
            JsonNode wert = it.next().getValue();
            if (wert.isArray()) {
                wert.forEach(e -> {
                    if (e.has("objekt")) {
                        aus.add(e);
                    }
                });
            } else if (wert.has("objekt")) {
                aus.add(wert);
            }
        }
        return aus;
    }

    /**
     * Die Periodeneinträge der Grundlage: die Referenzdatei 1.8 schreibt eine Liste
     * ({@code [{periode, zaehler, nenner, kennzahl?, annahme}]}), {@code BezugsbasisGrundlage} (IP-7) ein Objekt mit
     * {@code perioden[]} ({@code {periode, kennzahl, zaehler, nenner, eingaenge[]}}) — beides wird gelesen.
     */
    static List<JsonNode> perioden(JsonNode grundlage) {
        List<JsonNode> aus = new ArrayList<>();
        if (grundlage == null) {
            return aus;
        }
        if (grundlage.isArray()) {
            grundlage.forEach(e -> {
                if (e.has("periode")) {
                    aus.add(e);
                }
            });
        } else if (grundlage.isObject()) {
            grundlage.forEach(feld -> aus.addAll(feld.isArray() ? perioden(feld) : List.of()));
        }
        return aus;
    }

    // ============================================================================ Pfad 2 (A3)

    /** Was ein Lauf des Pfads 2 tat. */
    public record StrukturLauf(int gelesen, List<Gesetzt> gesetzt, Map<String, String> gescheitert) {}

    private record Zeile(String protokoll, long id, UUID tenant, String objektArt, UUID objekt, String art, JsonNode alt,
            JsonNode neu, LocalDate giltAb, boolean rueckwirkend, Instant eingetragen) {}

    private static final String KANDIDATEN = """
            SELECT * FROM (
            SELECT 'ort_aenderung' AS protokoll, a.id, a.tenant_id, a.objekt_art, a.objekt_id, a.art, a.alt::text AS alt,
                   a.neu::text AS neu, a.gilt_ab AS gilt_ab, a.rueckwirkend, a.created_at
              FROM ort_aenderung a
             WHERE a.art IN ('verschoben', 'korrigiert', 'flaeche_geaendert', 'archiviert', 'geloescht')
            UNION ALL
            SELECT 'messstelle_aenderung', m.id, m.tenant_id, 'messstelle', m.messstelle_id, m.art, m.alt::text,
                   m.neu::text, CAST(coalesce(m.gilt_ab, m.created_at) AT TIME ZONE 'Europe/Berlin' AS date),
                   m.rueckwirkend, m.created_at
              FROM messstelle_aenderung m
             WHERE m.art IN ('prozesse_zugeordnet', 'verteilung_geaendert')
            UNION ALL
            SELECT 'kennzahl_aenderung', k.id, k.tenant_id, 'kennzahl', k.kennzahl_id, k.art, k.alt::text, k.neu::text,
                   CAST(k.gilt_ab AT TIME ZONE 'Europe/Berlin' AS date), k.rueckwirkend, k.created_at
              FROM kennzahl_aenderung k
             WHERE k.art = 'kennzahl_archiviert'
            UNION ALL
            SELECT 'bezugsgroesse_aenderung', g.id, g.tenant_id, 'bezugsgroesse', g.bezugsgroesse_id, g.art, g.alt::text,
                   g.neu::text, CAST(g.gilt_ab AT TIME ZONE 'Europe/Berlin' AS date), g.rueckwirkend, g.created_at
              FROM bezugsgroesse_aenderung g
             WHERE g.art IN ('bearbeitet', 'archiviert')
            UNION ALL
            SELECT 'bezugsbasis_aenderung', a.id, a.tenant_id, 'bezugsbasis', a.bezugsbasis_id, a.art, NULL, NULL,
                   CAST(a.created_at AT TIME ZONE 'Europe/Berlin' AS date), false, a.created_at
              FROM bezugsbasis_aenderung a
             WHERE a.art IN ('fassung_freigegeben', 'bezugsbasis_beendet')
            ) z
             WHERE NOT EXISTS (SELECT 1 FROM bezugsbasis_struktur_gelesen w
                                WHERE w.protokoll = z.protokoll AND w.eintrag_id = z.id)
               AND EXISTS (SELECT 1 FROM bezugsbasis_fassung f
                            WHERE f.tenant_id = z.tenant_id AND f.freigabe_status = 'freigegeben'
                              AND f.freigegeben_am < z.created_at)
               AND NOT (z.tenant_id = ANY (?::uuid[]))
             ORDER BY z.created_at, z.protokoll, z.id
             LIMIT ?
            """;

    /**
     * Ein Takt des Pfads 2: je Protokollzeile EINE Transaktion; eine gescheiterte Zeile ist nicht gelesen und kommt im
     * nächsten Takt wieder. Wirft nie.
     *
     * <p>Kandidat ist nur eine Zeile eines Kundenbereichs, der eine VOR ihr freigegebene Fassung hat — alles Ältere steckt
     * schon in der Grundlage, und Kundenbereiche ohne Bezugsbasis füllen kein Wasserzeichen.
     */
    public StrukturLauf strukturLauf(JdbcTemplate adminJdbc, Instant jetzt, int zeilenJeLauf) {
        List<Zeile> kandidaten = adminJdbc.query(KANDIDATEN, (rs, i) -> new Zeile(rs.getString("protokoll"),
                rs.getLong("id"), rs.getObject("tenant_id", UUID.class), rs.getString("objekt_art"),
                rs.getObject("objekt_id", UUID.class), rs.getString("art"), json(rs.getString("alt")),
                json(rs.getString("neu")), rs.getObject("gilt_ab", LocalDate.class), rs.getBoolean("rueckwirkend"),
                rs.getTimestamp("created_at").toInstant()), beendete.sqlFeld(), zeilenJeLauf);
        int gelesen = 0;
        List<Gesetzt> gesetzt = new ArrayList<>();
        Map<String, String> gescheitert = new LinkedHashMap<>();
        for (Zeile z : kandidaten) {
            try {
                List<Gesetzt> g = inTransaktion(adminJdbc, con -> lesen(con, z, jetzt));
                if (g != null) {
                    gelesen++;
                    gesetzt.addAll(g);
                }
            } catch (RuntimeException e) {
                gescheitert.put(z.protokoll() + "-" + z.id(), e.toString());
                log.warn("UEMS Bezugsbasis Pfad 2: {}-{} nicht gelesen, nächster Takt: {}", z.protokoll(), z.id(),
                        e.toString());
            }
        }
        return new StrukturLauf(gelesen, gesetzt, gescheitert);
    }

    /** EINE Protokollzeile; {@code null} = ein anderer Läufer hat sie (oder hatte sie schon). */
    private List<Gesetzt> lesen(Connection con, Zeile z, Instant jetzt) throws SQLException {
        JdbcTemplate j = new JdbcTemplate(new SingleConnectionDataSource(con, true));
        Boolean frei = j.queryForObject("SELECT pg_try_advisory_xact_lock(hashtext(?), ?)", Boolean.class,
                "bezugsbasis_struktur_gelesen:" + z.protokoll(), (int) (z.id() % Integer.MAX_VALUE));
        if (!Boolean.TRUE.equals(frei) || j.queryForObject("SELECT count(*) FROM bezugsbasis_struktur_gelesen "
                + "WHERE protokoll = ? AND eintrag_id = ?", Integer.class, z.protokoll(), z.id()) > 0) {
            return null;
        }
        List<Gesetzt> gesetzt = new ArrayList<>();
        String urteil;
        int weitergegeben = 0;
        int vorgaenge = 0;
        if (!eingeschaltet) {
            urteil = ABGESCHALTET;
        } else if (BEZUGSBASIS_AENDERUNG.equals(z.protokoll())) {
            // AP-18 IP-7/IP-17 (Z5, M5): Basis beendet oder neu gefasst → Anstoß an Zielen und Maßnahmen, dieselbe
            // Transaktion, über die Naht (Schalter). Das Urteil bleibt das der Berichte; die Zahl zählt die Vorgänge mit.
            vorgaenge = verbesserung == null ? 0
                    : verbesserung.messgrundlage(con, z.tenant(), z.objekt(), z.art(), z.id(), jetzt).size();
            weitergegeben = basisWeitergeben(con, z, jetzt);
            urteil = berichte == null ? OHNE_BERICHTE : weitergegeben == 0 ? OHNE_STAND : AN_BERICHTE;
        } else {
            String art = art(z);
            if (art == null) {
                urteil = NICHT_STRUKTURELL;
            } else {
                List<Fassung> getroffen = getroffen(con, z);
                String anlass = anlass(j, z);
                for (Fassung f : getroffen) {
                    Gesetzt g = setzen(con, f, 2, art, z.protokoll() + ":" + z.id(), anlass,
                            "VoltPilot (Struktur-Läufer)");
                    if (g != null) {
                        gesetzt.add(g);
                        weitergeben(con, g, jetzt);
                    }
                }
                urteil = getroffen.isEmpty() ? OHNE_BEZUGSBASIS : art;
            }
        }
        j.update("INSERT INTO bezugsbasis_struktur_gelesen (protokoll, eintrag_id, urteil, anstoesse) VALUES (?, ?, ?, ?)",
                z.protokoll(), z.id(), urteil, gesetzt.size() + weitergegeben + vorgaenge);
        return gesetzt;
    }

    // ============================================================================ A5 (IP-23)

    /** Ein neu gesetzter Anstoß an Fassung n → die gültigen Stände, die Fassung n zitieren. */
    private void weitergeben(Connection con, Gesetzt g, Instant jetzt) throws SQLException {
        if (berichte == null) {
            return;
        }
        String kennung = kennzeichen(con, g.tenant(), g.bezugsbasis()) + "/Fassung-" + g.fassung() + "/anstoss:"
                + g.anstossId();
        berichte.basisWeitergeben(con, new BerichtKaskade.BasisAnlass(g.tenant(), g.bezugsbasis(),
                BerichtRegeln.BEZUGSBASIS_ANSTOSS, kennung, g.fassung(), g.art(), g.fassung(), g.fassung(), jetzt));
    }

    /**
     * Eine Zeile {@code fassung_freigegeben} (Fassung n → Stände mit Fassung &lt; n) oder {@code bezugsbasis_beendet}
     * (jeder Stand der Basis); gibt die Zahl der getroffenen Berichte zurück.
     */
    private int basisWeitergeben(Connection con, Zeile z, Instant jetzt) throws SQLException {
        if (berichte == null) {
            return 0;
        }
        String bb = kennzeichen(con, z.tenant(), z.objekt());
        BerichtKaskade.BasisAnlass a;
        if ("bezugsbasis_beendet".equals(z.art())) {
            a = new BerichtKaskade.BasisAnlass(z.tenant(), z.objekt(), BerichtRegeln.BEZUGSBASIS_BEENDET, bb + "/beendet",
                    null, null, null, null, jetzt);
        } else {
            int n;
            try (PreparedStatement ps = con.prepareStatement(
                    "SELECT fassung FROM bezugsbasis_aenderung WHERE tenant_id = ? AND id = ?")) {
                ps.setObject(1, z.tenant());
                ps.setLong(2, z.id());
                try (ResultSet rs = ps.executeQuery()) {
                    rs.next();
                    n = rs.getInt(1);
                }
            }
            a = new BerichtKaskade.BasisAnlass(z.tenant(), z.objekt(), BerichtRegeln.BEZUGSBASIS_FASSUNG,
                    bb + "/Fassung-" + n, n, null, null, n - 1, jetzt);
        }
        return berichte.basisWeitergeben(con, a).size();
    }

    private static String kennzeichen(Connection con, UUID tenant, UUID basis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT kennzeichen FROM bezugsbasis WHERE tenant_id = ? AND id = ?")) {
            ps.setObject(1, tenant);
            ps.setObject(2, basis);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Bezugsbasis " + basis + " gibt es nicht");
                }
                return rs.getString(1);
            }
        }
    }

    /** Die Anstoß-Art einer Zeile; {@code null} = sie ändert keine Variable und keinen Faktor. */
    private static String art(Zeile z) {
        return switch (z.protokoll()) {
            case "kennzahl_aenderung" -> NICHT_MEHR_ANWENDBAR;
            case "bezugsgroesse_aenderung" -> "archiviert".equals(z.art()) ? NICHT_MEHR_ANWENDBAR
                    : nurWortlaut(z.alt(), z.neu()) ? null : VARIABLE_GEAENDERT;
            default -> STRUKTUR_GEAENDERT;
        };
    }

    /** Hat die Bearbeitung nur Name oder Beschreibung geändert (B10 der Berichte: eine Umbenennung ist keine Änderung)? */
    static boolean nurWortlaut(JsonNode alt, JsonNode neu) {
        if (alt == null || neu == null || !alt.isObject() || !neu.isObject()) {
            return false;
        }
        Set<String> felder = new LinkedHashSet<>();
        alt.fieldNames().forEachRemaining(felder::add);
        neu.fieldNames().forEachRemaining(felder::add);
        return felder.stream().filter(f -> !Objects.equals(alt.get(f), neu.get(f))).allMatch(NUR_WORTLAUT::contains);
    }

    /**
     * Die freigegebenen, zur Zeit der Änderung noch geltenden Fassungen, die das geänderte Objekt verweisen — über einen
     * Faktor (nie Wortlaut), eine Variable oder die Kennzahl der Basis. Nur Fassungen, die VOR der Änderung freigegeben
     * wurden, und nur an einer nicht beendeten Basis (A4) — die Archivierungs-Naht beendet die Basis der Kennzahl schon
     * in ihrer Transaktion, ein späteres {@code kennzahl_archiviert} trifft darum keine Fassung mehr.
     */
    private static List<Fassung> getroffen(Connection con, Zeile z) throws SQLException {
        String text = (z.alt() == null ? "" : z.alt().toString()) + " " + (z.neu() == null ? "" : z.neu().toString());
        String bedingung = switch (z.protokoll()) {
            case "ort_aenderung" -> """
                    EXISTS (SELECT 1 FROM bezugsbasis_faktor x WHERE x.tenant_id = f.tenant_id AND x.fassung_id = f.id
                             AND x.aufgehoben_am IS NULL AND (
                               (x.art = 'flaeche' AND x.verweis = ?::uuid
                                    AND ? IN ('flaeche_geaendert', 'archiviert', 'geloescht'))
                            OR (x.art = 'anlage' AND x.verweis = ?::uuid)
                            OR (x.art = 'standort' AND (x.verweis = ?::uuid
                                    OR (? = 'anlage' AND strpos(?, x.verweis::text) > 0)))))
                    """;
            case "messstelle_aenderung" -> """
                    EXISTS (SELECT 1 FROM bezugsbasis_faktor x WHERE x.tenant_id = f.tenant_id AND x.fassung_id = f.id
                             AND x.aufgehoben_am IS NULL
                             AND x.art = CASE ? WHEN 'prozesse_zugeordnet' THEN 'prozess' ELSE 'kostenstelle' END
                             AND strpos(?, x.verweis::text) > 0)
                    """;
            case "kennzahl_aenderung" -> "b.kennzahl_id = ?::uuid";
            default -> """
                    EXISTS (SELECT 1 FROM bezugsbasis_variable v WHERE v.tenant_id = f.tenant_id AND v.fassung_id = f.id
                             AND v.aufgehoben_am IS NULL AND v.bezugsgroesse_id = ?::uuid)
                    """;
        };
        List<Fassung> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement(FASSUNGEN + " AND f.freigegeben_am < ? "
                + "AND (f.gilt_bis IS NULL OR f.gilt_bis >= ?) AND " + bedingung + " ORDER BY k.kennzeichen, f.fassung")) {
            int i = 1;
            ps.setObject(i++, z.tenant());
            ps.setTimestamp(i++, Timestamp.from(z.eingetragen()));
            ps.setObject(i++, z.giltAb());
            switch (z.protokoll()) {
                case "ort_aenderung" -> {
                    ps.setObject(i++, z.objekt());
                    ps.setString(i++, z.art());
                    ps.setObject(i++, z.objekt());
                    ps.setObject(i++, z.objekt());
                    ps.setString(i++, z.objektArt());
                    ps.setString(i++, text);
                }
                case "messstelle_aenderung" -> {
                    ps.setString(i++, z.art());
                    ps.setString(i++, text);
                }
                default -> ps.setObject(i++, z.objekt());
            }
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(fassung(rs));
                }
            }
        }
        return aus;
    }

    /** Der Anlass in Worten: Protokoll-Art, Kennzeichen, ab wann, und bei einer Fläche alt → neu. */
    private static String anlass(JdbcTemplate j, Zeile z) {
        String kennzeichen = switch (z.objektArt()) {
            case "kennzahl" -> j.queryForList("SELECT kennzeichen FROM kennzahl WHERE tenant_id = ? AND id = ?",
                    String.class, z.tenant(), z.objekt()).stream().findFirst().orElse(null);
            case "bezugsgroesse" -> j.queryForList("SELECT kennzeichen FROM bezugsgroesse WHERE tenant_id = ? AND id = ?",
                    String.class, z.tenant(), z.objekt()).stream().findFirst().orElse(null);
            case "anlage" -> j.queryForList("SELECT name FROM site WHERE tenant_id = ? AND id = ?",
                    String.class, z.tenant(), z.objekt()).stream().findFirst().orElse(null);
            default -> StrukturAufloesung.kennzeichen(j, z.tenant(), z.objektArt(), z.objekt());
        };
        StringBuilder s = new StringBuilder(z.protokoll()).append(' ').append(z.art()).append(' ')
                .append(kennzeichen == null ? z.objekt() : kennzeichen);
        if ("flaeche_geaendert".equals(z.art()) && z.alt() != null && z.neu() != null) {
            s.append(' ').append(z.alt().path("flaeche_m2").asText("?")).append(" → ")
                    .append(z.neu().path("flaeche_m2").asText("?")).append(" m²");
        }
        if (z.giltAb() != null) {
            s.append(" ab ").append(z.giltAb());
        }
        if (z.rueckwirkend()) {
            s.append(" (rückwirkend)");
        }
        return s.append(", Struktur-Läufer Pfad 2").toString();
    }

    // ============================================================================ gemeinsam

    private record Fassung(UUID id, UUID tenant, UUID bezugsbasis, int fassung, UUID kennzahl,
            String kennzahlKennzeichen, JsonNode grundlage) {}

    private static final String FASSUNGEN = """
            SELECT f.id, f.tenant_id, f.bezugsbasis_id, f.fassung, b.kennzahl_id, k.kennzeichen, f.grundlage
              FROM bezugsbasis_fassung f
              JOIN bezugsbasis b ON b.id = f.bezugsbasis_id AND b.tenant_id = f.tenant_id
              JOIN kennzahl k ON k.id = b.kennzahl_id AND k.tenant_id = b.tenant_id
             WHERE f.tenant_id = ? AND f.freigabe_status = 'freigegeben' AND b.beendet_am IS NULL
            """;

    private static List<Fassung> freigegebene(Connection con, UUID tenant) throws SQLException {
        List<Fassung> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement(FASSUNGEN + " AND f.grundlage IS NOT NULL "
                + "ORDER BY k.kennzeichen, f.fassung")) {
            ps.setObject(1, tenant);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(fassung(rs));
                }
            }
        }
        return aus;
    }

    private static Fassung fassung(ResultSet rs) throws SQLException {
        return new Fassung(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                rs.getInt(4), rs.getObject(5, UUID.class), rs.getString(6), json(rs.getString(7)));
    }

    /**
     * Setzt EINEN Anstoß — {@code ON CONFLICT DO NOTHING} über {@code bezugsbasis_anstoss_einmal_uq} — und, nur wenn er
     * neu ist, die Protokollzeile. Die Fassung selbst wird nie angefasst.
     */
    private static Gesetzt setzen(Connection con, Fassung f, int pfad, String art, String kennung, String anlass,
            String akteur) throws SQLException {
        String kurz = anlass.length() > ANLASS_LAENGE ? anlass.substring(0, ANLASS_LAENGE - 1) + "…" : anlass;
        UUID id = null;
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO bezugsbasis_anstoss (tenant_id, fassung_id, pfad, art, anlass_kennung, anlass)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT ON CONSTRAINT bezugsbasis_anstoss_einmal_uq DO NOTHING
                RETURNING id
                """)) {
            ps.setObject(1, f.tenant());
            ps.setObject(2, f.id());
            ps.setShort(3, (short) pfad);
            ps.setString(4, art);
            ps.setString(5, kennung);
            ps.setString(6, kurz);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    id = rs.getObject(1, UUID.class);
                }
            }
        }
        if (id == null) {
            return null;
        }
        ObjectNode neu = JSON.createObjectNode();
        neu.put("anstoss_id", id.toString());
        neu.put("pfad", pfad);
        neu.put("art", art);
        neu.put("anlass_kennung", kennung);
        neu.put("anlass", kurz);
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO bezugsbasis_aenderung (tenant_id, bezugsbasis_id, fassung, art, neu, actor_name, actor_art)
                VALUES (?, ?, ?, ?, ?::jsonb, ?, 'voltpilot')
                """)) {
            ps.setObject(1, f.tenant());
            ps.setObject(2, f.bezugsbasis());
            ps.setInt(3, f.fassung());
            ps.setString(4, PROTOKOLL);
            ps.setString(5, neu.toString());
            ps.setString(6, akteur);
            ps.executeUpdate();
        }
        return new Gesetzt(f.tenant(), f.bezugsbasis(), f.id(), f.fassung(), pfad, art, kennung, id);
    }

    private static JsonNode json(String text) {
        if (text == null) {
            return null;
        }
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    @FunctionalInterface
    private interface Schritt<T> {
        T fahren(Connection con) throws SQLException;
    }

    private static <T> T inTransaktion(JdbcTemplate adminJdbc, Schritt<T> schritt) {
        return adminJdbc.execute((ConnectionCallback<T>) con -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = schritt.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("UEMS Bezugsbasis Pfad 2 fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
