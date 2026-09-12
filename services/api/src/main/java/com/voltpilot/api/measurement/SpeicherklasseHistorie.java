package com.voltpilot.api.measurement;

import com.voltpilot.api.uems.LesepfadQuelle;
import com.voltpilot.api.uems.LesepfadQuelle.Quelle;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Der RÜCKFALL des Lesepfads (UEMS AP-07 IP-14): er liest die Speicherklassen
 * {@code messreihe_viertelstunde} (IP-12/AP-08 IP-2) und {@code messreihe_tag} (IP-13) und
 * macht daraus dieselbe Kurve, die der bestehende Weg aus Rohwerten macht — samt der Herkunft,
 * die dort je Intervall gespeichert ist.
 *
 * <p><b>Wann er gefragt wird:</b> NUR wenn der angefragte Zeitraum über die Rohdaten-Frist
 * hinausreicht UND der bestehende Weg für ihn nichts hergibt ({@link LesepfadQuelle}). Er
 * ERSETZT nichts, was heute schon antwortet.
 *
 * <p><b>Die Reihe ist Mandant + Komponente + Messkanal</b> (AP-07 E2) — Gerät und Box sind
 * Herkunft je Wert, nie Schlüssel. Der Verlauf wird über Gerät + Messwert angefragt; die
 * Komponente kommt aus der Anfrage oder aus der Mess-Selektion und wird nie geraten: ohne sie
 * gibt es keinen Rückfall (und die Antwort bleibt die des bestehenden Wegs).
 *
 * <p><b>Was hier NICHT gerechnet wird:</b> die Menge einer Viertelstunde steht schon in der
 * Spalte {@code menge} (AP-08 IP-2) — dieser Leser summiert sie nur und lässt die Summe LEER,
 * sobald eine einzige Viertelstunde des Rasters keine bildbare Menge hat (eine zu kleine Summe
 * wäre schlimmer als keine). Die Tagesklasse hat ausdrücklich KEINE Menge (AP-08 IP-5 bildet
 * sie aus den Periodenständen); für einen Zählerstand bleibt der Tageswert deshalb ohne
 * Kurvenwert und trägt stattdessen Anfangs- und Endstand in der Herkunft.
 */
@Component
public class SpeicherklasseHistorie {

    /** Dieselbe Zeilenbremse wie im bestehenden Verlauf — eine Antwort bleibt zeichenbar. */
    public static final int HOECHSTENS_ZEILEN = 2200;

    /**
     * Die Ereignisarten, die als Marker in den Verlauf gehören (Auftrag IP-14: Lücke,
     * Rücksetzung, Gerätegrenze, Übergabe, Doppelzustellung, Spätankunft). Alles andere des
     * Vokabulars (§4.8) bleibt draußen — ein Verlauf mit 23 Markerarten erklärt nichts mehr.
     */
    private static final String MARKER_ARTEN =
            "'data_gap','counter_reset','device_boundary','handover','duplicate_conflict',"
                    + "'late_arrival'";

    private final JdbcTemplate jdbc;

    public SpeicherklasseHistorie(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die Komponente der Reihe — aus der Anfrage, sonst aus der Mess-Selektion des Geräts, und
     * nur wenn sie EINDEUTIG ist. Mehrdeutig heißt keine Reihe, nicht „irgendeine".
     */
    public UUID komponente(UUID tenantId, UUID deviceId, String pointKey, UUID ausDerAnfrage) {
        if (ausDerAnfrage != null) {
            return ausDerAnfrage;
        }
        // ⚠ KEIN `SELECT DISTINCT` und kein `GROUP BY`: TimescaleDBs SkipScan bricht darauf
        // mit „unsupported subplan type for SkipScan: Result" ab (2.17.2-pg16, im Test
        // reproduziert). Die Auswahl ist je Gerät und Messwert ohnehin winzig — die
        // Entdopplung gehört hierher, nicht in den Planer.
        List<UUID> gefunden = jdbc.query(
                "SELECT entity_id FROM device_measurement_selection WHERE tenant_id=? "
                        + "AND device_id=? AND " + praedikat("point_key", pointKey)
                        + " AND entity_id IS NOT NULL LIMIT 50",
                (rs, n) -> rs.getObject("entity_id", UUID.class), tenantId, deviceId,
                wert(pointKey));
        List<UUID> eindeutig = gefunden.stream().distinct().toList();
        return eindeutig.size() == 1 ? eindeutig.get(0) : null;
    }

    /**
     * Eine Zeile je Raster-Schritt aus {@code messreihe_viertelstunde}. Das Raster ist nie
     * feiner als die Viertelstunde selbst und nie so fein, dass die Zeilenbremse schneidet.
     */
    public List<Zeile> viertelstunden(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis, int rasterS) {
        String sql = "WITH v AS (SELECT * FROM messreihe_viertelstunde WHERE tenant_id=? "
                + "AND entity_id=? AND " + praedikat("messkanal", messkanal)
                + " AND intervall_beginn>=? AND intervall_beginn<=?),"
                + "b AS (SELECT time_bucket(CAST(? AS interval),intervall_beginn) bucket,"
                + "wertart aggregation_kind,"
                // Eine zu kleine Summe wäre eine Behauptung: fehlt EINE Menge, fehlt die Summe.
                + "CASE WHEN count(*)=count(menge) THEN sum(menge) END menge_summe,"
                + "sum(mittel*erhalten)/NULLIF(sum(erhalten),0) avg_value,"
                + "min(min_wert) min_value,max(max_wert) max_value,"
                + "last(letzter_wert,intervall_beginn) last_numeric,"
                + "last(letzter_text,intervall_beginn) last_text,"
                + "sum(erhalten)::bigint samples,bool_or(erhalten<erwartet) has_gap,"
                + "sum(erhalten)::int h_erhalten,sum(erwartet)::int h_erwartet,"
                + "sum(n_good)::int h_good,sum(n_uncertain)::int h_uncertain,"
                + "sum(n_invalid)::int h_invalid,sum(n_stale)::int h_stale,"
                + "sum(n_device_error)::int h_device_error,"
                // Ein Raster-Schritt steht erst fest, wenn JEDE seiner Viertelstunden feststeht.
                + "CASE WHEN bool_and(zustand='endgueltig') THEN 'endgueltig' ELSE 'vorlaeufig' END "
                + "h_zustand,max(endgueltig_ab) h_endgueltig_ab,max(version)::int h_version,"
                + "sum(n_nachgeliefert)::int h_nachgeliefert,"
                + "CASE WHEN count(DISTINCT zustellart)=1 THEN max(zustellart) END h_zustellart,"
                + "max(letzte_eingangszeit) h_eingang,"
                + anker()
                + "(array_agg(stand_anfang ORDER BY intervall_beginn))[1] h_stand_anfang,"
                + "last(stand_ende,intervall_beginn) h_stand_ende FROM v GROUP BY 1,2) "
                + "SELECT *,CASE WHEN aggregation_kind='counter' THEN menge_summe "
                + "WHEN aggregation_kind='gauge' THEN avg_value ELSE last_numeric END chart_value "
                + "FROM b ORDER BY bucket LIMIT " + HOECHSTENS_ZEILEN;
        return jdbc.query(sql, (rs, n) -> zeile(rs, Quelle.VIERTELSTUNDE), tenantId, entityId,
                wert(messkanal), Timestamp.from(von), Timestamp.from(bis), rasterS + " seconds");
    }

    /**
     * Eine Zeile je TAG aus {@code messreihe_tag} — ohne Raster. Ein Tageswert trägt die
     * Zeitzone seines Standorts (23/24/25 Stunden); ihn in ein UTC-Raster zu zwingen, würde
     * Tage zusammenziehen oder zerschneiden. Ein Jahr sind 366 Zeilen, die Bremse greift nie.
     */
    public List<Zeile> tage(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis) {
        String sql = "SELECT beginn bucket,wertart aggregation_kind,"
                // Die Tagesklasse hat KEINE Menge (AP-08 IP-5) — ein Zähler bleibt ohne Kurve.
                + "NULL::numeric menge_summe,mittel avg_value,min_wert min_value,"
                + "max_wert max_value,letzter_wert last_numeric,letzter_text last_text,"
                + "erhalten::bigint samples,(erhalten<erwartet) has_gap,"
                + "erhalten h_erhalten,erwartet h_erwartet,n_good h_good,n_uncertain h_uncertain,"
                + "n_invalid h_invalid,n_stale h_stale,n_device_error h_device_error,"
                + "zustand h_zustand,endgueltig_ab h_endgueltig_ab,version h_version,"
                + "n_nachgeliefert h_nachgeliefert,zustellart h_zustellart,"
                + "letzte_eingangszeit h_eingang,geraet_einbau h_geraet,"
                + "geraet_einbau_2 h_geraet_2,box h_box,box_2 h_box_2,fassung h_fassung,"
                + "katalog h_katalog,rolle h_rolle,stand_anfang h_stand_anfang,"
                + "stand_ende h_stand_ende,CASE WHEN wertart='gauge' THEN mittel "
                + "WHEN wertart='counter' THEN NULL ELSE letzter_wert END chart_value "
                + "FROM messreihe_tag WHERE tenant_id=? AND entity_id=? AND "
                + praedikat("messkanal", messkanal) + " AND beginn>=? AND beginn<=? "
                + "ORDER BY beginn LIMIT " + HOECHSTENS_ZEILEN;
        return jdbc.query(sql, (rs, n) -> zeile(rs, Quelle.TAG), tenantId, entityId,
                wert(messkanal), Timestamp.from(von), Timestamp.from(bis));
    }

    /**
     * Die Ereignisse der Reihe als GEBÜNDELTE Marken: je Art und Raster-Schritt eine Marke mit
     * ihrer Anzahl — damit ein Sprung in der Kurve erklärbar ist, ohne dass eine Flut von
     * Einzelmarken die Kurve zudeckt.
     *
     * <p>Zwei Fallen sind hier eingebaut: {@code aus_bestand} bleibt draußen (das sind die
     * gespiegelten Zeilen aus {@code device_measurement_event}, die der bestehende Marker-Weg
     * schon zeigt — sonst stünde jede Lücke doppelt), und eine Fortschreibung ist KEIN zweites
     * Ereignis (append-only, gleiche {@code ereignis_id}, jüngste Zeile gewinnt).
     */
    public List<Ereignis> ereignisse(UUID tenantId, UUID entityId, String messkanal, Instant von,
            Instant bis, int rasterS) {
        // Die Übergabe (`handover`) hängt am Vertrag ausdrücklich an der DATENQUELLE und darf
        // gar keine Komponente nennen (§4.8) — sie käme über `entity_id` nie an. Darum der
        // zweite Zweig: Ereignisse ohne Reihen-Bezug, die an der Datenquelle DIESER Komponente
        // hängen. Ohne Datenquelle an der Komponente trifft er nichts (NULL ist nie wahr).
        // `zeit` IST der Beginn: der Vertrag verlangt `zeit = von`, wo es ein `von` gibt
        // (messreihe_ereignis_zeit_erlaubt). Darum kein COALESCE in der Bedingung — sonst
        // liefe die Abfrage an den Indizes `idx_messreihe_ereignis_reihe` und
        // `…_quelle` vorbei, die IP-8 genau für diesen Leser gebaut hat.
        String sql = "WITH e AS (SELECT DISTINCT ON (ereignis_id) ereignis_id,art,"
                + "zeit beginn,bis FROM messreihe_ereignis WHERE tenant_id=? "
                + "AND NOT aus_bestand AND art IN (" + MARKER_ARTEN + ") AND ("
                + "(entity_id=? AND (messkanal IS NULL OR " + praedikat("messkanal", messkanal)
                + ")) OR (entity_id IS NULL AND data_source_id=(SELECT data_source_id "
                + "FROM measurement_point WHERE tenant_id=? AND id=?))) "
                + "AND zeit<=? AND COALESCE(bis,zeit)>=? "
                + "ORDER BY ereignis_id,eingang DESC) "
                + "SELECT art,min(beginn) beginn,max(COALESCE(bis,beginn)) ende,count(*) anzahl "
                + "FROM e GROUP BY art,time_bucket(CAST(? AS interval),beginn) "
                + "ORDER BY 2 LIMIT 200";
        return jdbc.query(sql, (rs, n) -> new Ereignis(rs.getString("art"),
                        rs.getTimestamp("beginn").toInstant(),
                        rs.getTimestamp("ende") == null ? null : rs.getTimestamp("ende").toInstant(),
                        rs.getInt("anzahl")),
                tenantId, entityId, wert(messkanal), tenantId, entityId, Timestamp.from(bis),
                Timestamp.from(von), rasterS + " seconds");
    }

    /** Die je Wert GESPEICHERTEN Katalogfassungen des Zeitraums — nie die heutige. */
    public List<String> katalogfassungen(List<Zeile> zeilen) {
        List<String> out = new ArrayList<>();
        for (Zeile z : zeilen) {
            if (z.katalogVersion() != null && !out.contains(z.katalogVersion())) {
                out.add(z.katalogVersion());
            }
        }
        return List.copyOf(out);
    }

    // ====================================================================== innere Hilfen

    /** Herkunfts-Anker: EIN Wert, wenn alle Intervalle denselben nennen — sonst leer, nie geraten. */
    private static String anker() {
        return "(CASE WHEN count(DISTINCT geraet_einbau)=1 THEN max(geraet_einbau::text) END)::uuid "
                + "h_geraet,(CASE WHEN count(DISTINCT geraet_einbau_2)=1 "
                + "THEN max(geraet_einbau_2::text) END)::uuid h_geraet_2,"
                + "(CASE WHEN count(DISTINCT box)=1 THEN max(box::text) END)::uuid h_box,"
                + "(CASE WHEN count(DISTINCT box_2)=1 THEN max(box_2::text) END)::uuid h_box_2,"
                + "CASE WHEN count(DISTINCT fassung)=1 THEN max(fassung) END h_fassung,"
                + "CASE WHEN count(DISTINCT katalog)=1 THEN max(katalog) END h_katalog,"
                + "CASE WHEN count(DISTINCT rolle)=1 THEN max(rolle) END h_rolle,";
    }

    private static Zeile zeile(ResultSet rs, Quelle quelle) throws SQLException {
        Integer erhalten = nullableInt(rs, "h_erhalten");
        Integer erwartet = nullableInt(rs, "h_erwartet");
        return new Zeile(rs.getTimestamp("bucket").toInstant(), rs.getBigDecimal("chart_value"),
                rs.getBigDecimal("min_value"), rs.getBigDecimal("max_value"),
                rs.getString("last_text"), rs.getLong("samples"), rs.getBoolean("has_gap"),
                quelle, rs.getString("aggregation_kind"), abdeckung(erhalten, erwartet), erhalten,
                erwartet, nullableInt(rs, "h_good"), nullableInt(rs, "h_uncertain"),
                nullableInt(rs, "h_invalid"), nullableInt(rs, "h_stale"),
                nullableInt(rs, "h_device_error"), rs.getString("h_zustand"),
                instant(rs, "h_endgueltig_ab"), nullableInt(rs, "h_version"),
                nullableInt(rs, "h_nachgeliefert"), rs.getString("h_zustellart"),
                instant(rs, "h_eingang"), rs.getObject("h_geraet", UUID.class),
                rs.getObject("h_geraet_2", UUID.class), rs.getObject("h_box", UUID.class),
                rs.getObject("h_box_2", UUID.class), nullableLong(rs, "h_fassung"),
                rs.getString("h_katalog"), rs.getString("h_rolle"),
                rs.getBigDecimal("h_stand_anfang"), rs.getBigDecimal("h_stand_ende"));
    }

    /**
     * Abdeckung in Prozent — und NIE auf 100 gerundet (§4.9 Nr. 6). 100 steht nur da, wo
     * wirklich jeder erwartete Wert angekommen ist.
     */
    public static Integer abdeckung(Integer erhalten, Integer erwartet) {
        if (erhalten == null || erwartet == null || erwartet <= 0) {
            return null;
        }
        if (erhalten >= erwartet) {
            return 100;
        }
        return Math.min(99, (int) Math.floor(100.0 * erhalten / erwartet));
    }

    private static Integer nullableInt(ResultSet rs, String name) throws SQLException {
        int wert = rs.getInt(name);
        return rs.wasNull() ? null : wert;
    }

    private static Long nullableLong(ResultSet rs, String name) throws SQLException {
        long wert = rs.getLong(name);
        return rs.wasNull() ? null : wert;
    }

    private static Instant instant(ResultSet rs, String name) throws SQLException {
        Timestamp t = rs.getTimestamp(name);
        return t == null ? null : t.toInstant();
    }

    /** Dieselbe Behandlung des Platzhalters {@code [*]} wie im bestehenden Verlauf. */
    private static String praedikat(String spalte, String messkanal) {
        return messkanal != null && messkanal.contains("[*]")
                ? spalte + " LIKE ? ESCAPE '\\'" : spalte + "=?";
    }

    private static String wert(String messkanal) {
        if (messkanal == null || !messkanal.contains("[*]")) {
            return messkanal;
        }
        return messkanal.replace("\\", "\\\\").replace("%", "\\%")
                .replace("_", "\\_").replace("[*]", "[%]");
    }

    /** Eine gelesene Zeile einer Speicherklasse — Kurvenwert UND Herkunft in einem. */
    public record Zeile(Instant zeit, BigDecimal wert, BigDecimal minimum, BigDecimal maximum,
            String text, long anzahl, boolean luecke, Quelle quelle, String wertart,
            Integer abdeckungProzent, Integer erhalten, Integer erwartet, Integer nGood,
            Integer nUncertain, Integer nInvalid, Integer nStale, Integer nDeviceError,
            String zustand, Instant endgueltigAb, Integer version, Integer nachgeliefert,
            String zustellart, Instant letzteEingangszeit, UUID geraetEinbau,
            UUID geraetEinbauZwei, UUID box, UUID boxZwei, Long fassung, String katalogVersion,
            String rolle, BigDecimal standAnfang, BigDecimal standEnde) {}

    /** Ein gebündeltes Ereignis des Zeitraums. */
    public record Ereignis(String art, Instant von, Instant bis, int anzahl) {}
}
