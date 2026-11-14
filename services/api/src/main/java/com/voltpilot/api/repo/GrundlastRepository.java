package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Viertelstunden der <b>Grundlast</b> (Bedienkonzept Privatkunde §5.5): der Hausverbrauch je
 * Viertelstunde aus demselben Lesepfad wie {@code /history} – v1 {@code telemetry_rollup_15m.load_kwh},
 * nach dem Umstieg {@code telemetry_v2_rollup_15m} über {@link HistoryRepository#v2Reconstruction} –
 * und die Leistung der Unterzähler aus {@code telemetry_v2_rollup_15m} (dauerhaft, auch nach den
 * 90 Tagen der Rohdaten).
 *
 * <p>Jede Abfrage geht über {@code site} (Standort-Zaun, {@code SiteScopeArchitekturTest}); der
 * Mandant kommt aus RLS. Die Zeitgrenzen am Umstieg setzt der Aufrufer: v1 für Viertelstunden, die
 * VOR {@code v2_history_cutover_at} beginnen, v2 ab dort – genau der Spleiß von {@code HistoryService}.
 */
@Repository
public class GrundlastRepository {

    /** Nur die Viertelstunden 0–5 Uhr Ortszeit (die Nacht der Regel). */
    private static final String NUR_NACHT = " AND (r.bucket AT TIME ZONE 'Europe/Berlin')::time < '05:00' ";

    private final JdbcTemplate jdbc;

    public GrundlastRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Verbrauch je Viertelstunde und deren Anzahl in einem Fenster (für den Anteil). */
    public record Verbrauch(long viertelstunden, double kwh) {
        public static final Verbrauch NICHTS = new Verbrauch(0, 0);

        public Verbrauch plus(Verbrauch o) {
            return new Verbrauch(viertelstunden + o.viertelstunden, kwh + o.kwh);
        }
    }

    /** v1: Hausverbrauch (kWh) je gemessener Nacht-Viertelstunde in {@code [von, bis)}. */
    public NavigableMap<Instant, Double> v1NachtViertelstunden(UUID siteId, Instant von, Instant bis) {
        NavigableMap<Instant, Double> out = new TreeMap<>();
        if (!von.isBefore(bis)) {
            return out;
        }
        jdbc.query("SELECT r.bucket, r.load_kwh FROM telemetry_rollup_15m r JOIN site s ON s.id = r.site_id"
                        + " WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ? AND r.load_kwh IS NOT NULL"
                        + NUR_NACHT,
                rs -> {
                    out.put(rs.getTimestamp("bucket").toInstant(), rs.getDouble("load_kwh"));
                },
                siteId, Timestamp.from(von), Timestamp.from(bis));
        return out;
    }

    /** v2: Hausverbrauch (kWh) je gemessener Nacht-Viertelstunde in {@code [von, bis)}. */
    public NavigableMap<Instant, Double> v2NachtViertelstunden(UUID siteId, Instant von, Instant bis) {
        NavigableMap<Instant, Double> out = new TreeMap<>();
        if (!von.isBefore(bis)) {
            return out;
        }
        String quarters = "SELECT r.bucket, r.entity_id, r.channel, r.avg_value, r.min_value,"
                + " r.max_value, r.last_value FROM telemetry_v2_rollup_15m r JOIN site s ON s.id = r.site_id"
                + " WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ?" + NUR_NACHT;
        jdbc.query("SELECT b.bucket, b.load_kwh FROM (" + HistoryRepository.v2Reconstruction(quarters, "q.bucket")
                        + ") b WHERE b.load_kwh IS NOT NULL",
                rs -> {
                    out.put(rs.getTimestamp("bucket").toInstant(), rs.getDouble("load_kwh"));
                },
                siteId, Timestamp.from(von), Timestamp.from(bis));
        return out;
    }

    /** v1: gemessene Viertelstunden und Verbrauch im ganzen Fenster {@code [von, bis)}. */
    public Verbrauch v1Verbrauch(UUID siteId, Instant von, Instant bis) {
        if (!von.isBefore(bis)) {
            return Verbrauch.NICHTS;
        }
        return jdbc.queryForObject("SELECT count(*) AS n, coalesce(sum(r.load_kwh), 0) AS kwh"
                        + " FROM telemetry_rollup_15m r JOIN site s ON s.id = r.site_id"
                        + " WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ? AND r.load_kwh IS NOT NULL",
                (rs, i) -> new Verbrauch(rs.getLong("n"), rs.getDouble("kwh")),
                siteId, Timestamp.from(von), Timestamp.from(bis));
    }

    /** v2: gemessene Viertelstunden und Verbrauch im ganzen Fenster {@code [von, bis)}. */
    public Verbrauch v2Verbrauch(UUID siteId, Instant von, Instant bis) {
        if (!von.isBefore(bis)) {
            return Verbrauch.NICHTS;
        }
        String quarters = "SELECT r.bucket, r.entity_id, r.channel, r.avg_value, r.min_value,"
                + " r.max_value, r.last_value FROM telemetry_v2_rollup_15m r JOIN site s ON s.id = r.site_id"
                + " WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ?";
        return jdbc.queryForObject("SELECT count(*) AS n, coalesce(sum(b.load_kwh), 0) AS kwh FROM ("
                        + HistoryRepository.v2Reconstruction(quarters, "q.bucket") + ") b WHERE b.load_kwh IS NOT NULL",
                (rs, i) -> new Verbrauch(rs.getLong("n"), rs.getDouble("kwh")),
                siteId, Timestamp.from(von), Timestamp.from(bis));
    }

    /**
     * Die erste je gemessene Viertelstunde mit Hausverbrauch (v1), sonst die erste v2-Viertelstunde mit
     * Netzleistung, oder {@code null}. Trennt „vor der ersten Messung“ von „Lücke“.
     */
    public Instant ersteMessung(UUID siteId) {
        Timestamp v1 = jdbc.queryForObject("SELECT min(r.bucket) FROM telemetry_rollup_15m r"
                        + " JOIN site s ON s.id = r.site_id WHERE r.site_id = ? AND r.load_kwh IS NOT NULL",
                Timestamp.class, siteId);
        if (v1 != null) {
            return v1.toInstant();
        }
        Timestamp v2 = jdbc.queryForObject("SELECT min(r.bucket) FROM telemetry_v2_rollup_15m r"
                        + " JOIN site s ON s.id = r.site_id"
                        + " JOIN measurement_point mp ON mp.id::text = r.entity_id"
                        + " WHERE r.site_id = ? AND r.channel = 'power_kw' AND mp.entity_type = 'grid-meter'",
                Timestamp.class, siteId);
        return v2 == null ? null : v2.toInstant();
    }

    /**
     * Leistung (kW, Mittel der Viertelstunde) je Teil und Nacht-Viertelstunde in {@code [von, bis)}, aus
     * dem Kanal {@code power_kw}. Ein Teil ohne Zeile hat in dieser Viertelstunde keinen Wert.
     */
    public Map<String, Map<Instant, Double>> teilLeistung(UUID siteId, List<String> entityIds, Instant von,
            Instant bis) {
        Map<String, Map<Instant, Double>> out = new HashMap<>();
        if (entityIds.isEmpty() || !von.isBefore(bis)) {
            return out;
        }
        List<Object> args = new ArrayList<>();
        args.add(siteId);
        args.addAll(entityIds);
        args.add(Timestamp.from(von));
        args.add(Timestamp.from(bis));
        jdbc.query("SELECT r.entity_id, r.bucket, r.avg_value FROM telemetry_v2_rollup_15m r"
                        + " JOIN site s ON s.id = r.site_id"
                        + " WHERE r.site_id = ? AND r.entity_id IN ("
                        + String.join(",", Collections.nCopies(entityIds.size(), "?")) + ")"
                        + " AND r.channel = 'power_kw' AND r.avg_value IS NOT NULL"
                        + " AND r.bucket >= ? AND r.bucket < ?" + NUR_NACHT,
                rs -> {
                    out.computeIfAbsent(rs.getString("entity_id"), k -> new HashMap<>())
                            .put(rs.getTimestamp("bucket").toInstant(), rs.getDouble("avg_value"));
                },
                args.toArray());
        return out;
    }
}
