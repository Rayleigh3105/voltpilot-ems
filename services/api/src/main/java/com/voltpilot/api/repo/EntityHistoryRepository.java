package com.voltpilot.api.repo;

import com.voltpilot.api.history.HistoryRange;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Per-entity history over the generic v2 telemetry (E1b): channel-keyed
 * bucket series from {@code telemetry_v2} and its rollup cascade. The v1
 * discipline applies verbatim: day = LIVE 15-min buckets straight from raw
 * (never behind the rollup refresh), week = the hourly rollup, month/year =
 * the Europe/Berlin daily rollup. RLS-scoped like every customer repository
 * (no tenant predicate; the site_id predicate anchors the entity to the
 * caller-visible site).
 *
 * <p><b>MIG-B2 — the v1 splice for COMPOSED entities (audit H1).</b> The
 * automatic backfill ({@code V2SiteBackfillRunner}) composes a migrated site's
 * battery-hybrid / grid-meter / house-load entities from its v1 master data,
 * but {@code telemetry_v2} is fed ONLY forward (the writer's
 * {@code ComposedEntityFanout} mirrors NEW live samples). So on deploy day a
 * plant with years of v1 telemetry had an EMPTY Messwerte explorer at every
 * range, while the site's own Historie one tab away showed the full history.
 *
 * <p>The fix is READ-side and additive — nothing is copied, no migration
 * rewrites data: for a composed entity the v1 series is mapped through the
 * SAME channel map the fan-out writes forward with, and spliced in front of
 * the real v2 rows.
 *
 * <table><caption>composed entity → channel (mirrors ComposedEntityFanout)</caption>
 *   <tr><td>battery-hybrid</td><td>{@code soc_pct} ← {@code soc_pct}</td></tr>
 *   <tr><td>battery-hybrid</td><td>{@code pv_power_kw} ← {@code pv_power_kw}</td></tr>
 *   <tr><td>battery-hybrid</td><td>{@code battery_power_kw} ←
 *       {@code power_kw − load_kw + pv_power_kw}</td></tr>
 *   <tr><td>grid-meter</td><td>{@code power_kw} ← {@code power_kw} (signed)</td></tr>
 *   <tr><td>house-load</td><td>{@code power_kw} ← {@code load_kw}</td></tr>
 * </table>
 *
 * <p><b>The splice instant</b> reuses the {@code site.v2_history_cutover_at}
 * mechanism that already models exactly this seam for the site-level Historie,
 * combined with the entity's own first v2 sample IN THE WINDOW:
 * {@code splice = max(cutover, firstV2InWindow)}; no v2 row in the window at
 * all ⇒ the whole window is v1. v1 owns buckets whose START is BEFORE the
 * instant, v2 owns those at/after it — gap-free AND overlap-free by
 * construction (exactly {@code HistoryService.splice}). An un-composed
 * (v2-native) entity — wallbox, generic Modbus — is untouched: pure v2, byte
 * for byte as before.
 *
 * <p><b>Documented approximations.</b> The day range reads RAW {@code telemetry}
 * and filters on the entity's gateway {@code device_id}, exactly like the
 * fan-out. The rollup-backed ranges read {@code telemetry_rollup_15m}, which
 * has no device dimension, so on a (today hypothetical) MULTI-device site they
 * are site-wide. Rollup powers are reconstructed from the stored quarter
 * energies (kWh × 4 = the quarter's average kW, exact by the rollup's own
 * definition); a NULL v1 channel contributes NO bucket — never a fabricated 0.
 */
@Repository
public class EntityHistoryRepository {

    /** One aggregated bucket of one channel. */
    public record Bucket(Instant start, Double avg, Double min, Double max, Double last, long n) {}

    /** The composed entity types the v1 splice can reconstruct. */
    static final String TYPE_BATTERY_HYBRID = "battery-hybrid";
    static final String TYPE_GRID_METER = "grid-meter";
    static final String TYPE_HOUSE_LOAD = "house-load";

    /** One reconstructed channel: its name plus the v1 raw/rollup expressions. */
    private record V1Channel(String channel, String rawExpr, String rollupExpr) {}

    private final JdbcTemplate jdbc;

    public EntityHistoryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Channel-keyed bucket series of one entity over [from, to), pure v2.
     * Kept for callers that have no registry row at hand.
     */
    public Map<String, List<Bucket>> history(UUID siteId, String entityId, HistoryRange range,
            Instant from, Instant to) {
        return history(siteId, entityId, range, from, to, null, null);
    }

    /**
     * Channel-keyed bucket series of one entity over [from, to). For a COMPOSED
     * entity the pre-cutover part of the window is reconstructed from the v1
     * telemetry (see the class javadoc); everything else is pure v2.
     */
    public Map<String, List<Bucket>> history(UUID siteId, String entityId, HistoryRange range,
            Instant from, Instant to, String entityType, UUID deviceId) {
        List<V1Channel> v1Channels = v1Channels(entityType);
        if (v1Channels.isEmpty()) {
            return group(v2Rows(siteId, entityId, range, from, to));
        }

        Instant splice = spliceInstant(siteId, entityId, from, to);
        if (splice != null && !splice.isAfter(from)) {
            // v2 owns the whole window (a plant migrated before it).
            return group(v2Rows(siteId, entityId, range, from, to));
        }

        Instant v1To = splice == null ? to : splice;
        List<ChannelBucket> v1 = v1Rows(siteId, deviceId, range, from, v1To, v1Channels);
        if (splice == null) {
            return group(v1);
        }
        // Mirror HistoryService.splice: v1 keeps buckets STARTING before the
        // instant, v2 those at/after it. The v1 query is already bounded by the
        // instant, so only the straddling bucket needs dropping.
        List<ChannelBucket> merged = new ArrayList<>();
        for (ChannelBucket row : v1) {
            if (row.bucket().start().isBefore(splice)) {
                merged.add(row);
            }
        }
        for (ChannelBucket row : v2Rows(siteId, entityId, range, from, to)) {
            if (!row.bucket().start().isBefore(splice)) {
                merged.add(row);
            }
        }
        merged.sort(Comparator.comparing(r -> r.bucket().start()));
        return group(merged);
    }

    /** The v1→v2 channel map, mirroring the writer's {@code ComposedEntityFanout}. */
    private static List<V1Channel> v1Channels(String entityType) {
        if (entityType == null) {
            return List.of();
        }
        return switch (entityType) {
            case TYPE_BATTERY_HYBRID -> List.of(
                    new V1Channel("battery_power_kw",
                            // The documented v1 balance; an absent input means UNKNOWN.
                            "CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL "
                                    + "AND pv_power_kw IS NOT NULL "
                                    + "THEN power_kw - load_kw + pv_power_kw END",
                            "(battery_charge_kwh - battery_discharge_kwh) * 4"),
                    new V1Channel("pv_power_kw", "pv_power_kw", "pv_kwh * 4"),
                    new V1Channel("soc_pct", "soc_pct", null));
            case TYPE_GRID_METER -> List.of(
                    new V1Channel("power_kw", "power_kw",
                            "(grid_import_kwh - grid_export_kwh) * 4"));
            case TYPE_HOUSE_LOAD -> List.of(
                    new V1Channel("power_kw", "load_kw", "load_kwh * 4"));
            default -> List.of();
        };
    }

    /**
     * Where the v2 era takes over inside this window, or null when it never
     * does (no v2 row at all ⇒ the whole window renders from v1).
     */
    private Instant spliceInstant(UUID siteId, String entityId, Instant from, Instant to) {
        List<Timestamp> first = jdbc.query(
                "SELECT min(time) AS first_v2 FROM telemetry_v2 "
                        + "WHERE site_id = ? AND entity_id = ? AND time >= ? AND time < ?",
                (rs, i) -> rs.getTimestamp("first_v2"),
                siteId, entityId, Timestamp.from(from), Timestamp.from(to));
        if (first.isEmpty() || first.get(0) == null) {
            return null;
        }
        Instant firstV2 = first.get(0).toInstant();
        Instant cutover = cutover(siteId);
        return cutover != null && cutover.isAfter(firstV2) ? cutover : firstV2;
    }

    /** The site's configured history cutover, or null when un-migrated. */
    private Instant cutover(UUID siteId) {
        List<Timestamp> rows = jdbc.query(
                "SELECT v2_history_cutover_at FROM site WHERE id = ?",
                (rs, i) -> rs.getTimestamp("v2_history_cutover_at"), siteId);
        return rows.isEmpty() || rows.get(0) == null ? null : rows.get(0).toInstant();
    }

    private List<ChannelBucket> v2Rows(UUID siteId, String entityId, HistoryRange range,
            Instant from, Instant to) {
        if (range == HistoryRange.DAY) {
            return jdbc.query(
                    "SELECT time_bucket('15 minutes', time) AS bucket, channel, "
                            + "avg(value) AS avg_value, min(value) AS min_value, "
                            + "max(value) AS max_value, last(value, time) AS last_value, "
                            + "count(*) AS n_samples "
                            + "FROM telemetry_v2 WHERE site_id = ? AND entity_id = ? "
                            + "AND time >= ? AND time < ? "
                            + "GROUP BY 1, 2 ORDER BY channel, bucket",
                    EntityHistoryRepository::mapRow,
                    siteId, entityId, Timestamp.from(from), Timestamp.from(to));
        }
        String table = range.dailyBuckets() ? "telemetry_v2_rollup_1d" : "telemetry_v2_rollup_1h";
        return jdbc.query(
                "SELECT bucket, channel, avg_value, min_value, max_value, last_value, "
                        + "n_samples FROM " + table + " WHERE site_id = ? AND entity_id = ? "
                        + "AND bucket >= ? AND bucket < ? ORDER BY channel, bucket",
                EntityHistoryRepository::mapRow,
                siteId, entityId, Timestamp.from(from), Timestamp.from(to));
    }

    /**
     * The v1-era rows for a composed entity, mapped onto its v2 channel names.
     * Channel names are our own compile-time constants (never client input), so
     * they are inlined as SQL literals; every value is bound.
     */
    private List<ChannelBucket> v1Rows(UUID siteId, UUID deviceId, HistoryRange range,
            Instant from, Instant to, List<V1Channel> channels) {
        return range == HistoryRange.DAY
                ? v1DayRows(siteId, deviceId, from, to, channels)
                : v1RollupRows(siteId, from, to, range.dailyBuckets(), channels);
    }

    private List<ChannelBucket> v1DayRows(UUID siteId, UUID deviceId, Instant from, Instant to,
            List<V1Channel> channels) {
        StringBuilder sql = new StringBuilder("WITH s AS (SELECT time");
        for (int i = 0; i < channels.size(); i++) {
            sql.append(", (").append(channels.get(i).rawExpr()).append(") AS v").append(i);
        }
        sql.append(" FROM telemetry WHERE site_id = ? AND time >= ? AND time < ?");
        if (deviceId != null) {
            sql.append(" AND device_id = ?");
        }
        sql.append(") ");
        appendChannelUnion(sql, channels, "time_bucket('15 minutes', time)", "time");

        List<Object> args = new ArrayList<>();
        args.add(siteId);
        args.add(Timestamp.from(from));
        args.add(Timestamp.from(to));
        if (deviceId != null) {
            args.add(deviceId);
        }
        return jdbc.query(sql.toString(), EntityHistoryRepository::mapRow, args.toArray());
    }

    private List<ChannelBucket> v1RollupRows(UUID siteId, Instant from, Instant to, boolean daily,
            List<V1Channel> channels) {
        String disp = daily ? "time_bucket('1 day', qb, 'Europe/Berlin')" : "time_bucket('1 hour', qb)";
        StringBuilder sql = new StringBuilder("WITH s AS (SELECT bucket AS qb, n_samples,"
                + " soc_min_pct, soc_max_pct, soc_last_pct");
        for (int i = 0; i < channels.size(); i++) {
            String expr = channels.get(i).rollupExpr();
            // soc has no energy twin - the rollup stores it directly (below).
            sql.append(", ").append(expr == null ? "soc_last_pct" : "(" + expr + ")")
                    .append(" AS v").append(i);
        }
        sql.append(" FROM telemetry_rollup_15m WHERE site_id = ? AND bucket >= ? AND bucket < ?) ");
        appendChannelUnion(sql, channels, disp, "qb");
        return jdbc.query(sql.toString(), EntityHistoryRepository::mapRow,
                siteId, Timestamp.from(from), Timestamp.from(to));
    }

    /**
     * One {@code SELECT ... UNION ALL} arm per channel over the prepared {@code s}
     * CTE. {@code soc_pct} takes its min/max from the rollup's own SoC extremes
     * when they exist (the raw path has no such columns and falls back to the
     * value itself). A bucket with no non-null sample is dropped by the HAVING —
     * an absent channel never renders as 0.
     */
    private static void appendChannelUnion(StringBuilder sql, List<V1Channel> channels,
            String bucketExpr, String timeExpr) {
        boolean rollup = !"time".equals(timeExpr);
        for (int i = 0; i < channels.size(); i++) {
            V1Channel c = channels.get(i);
            boolean socFromRollup = rollup && c.rollupExpr() == null;
            String min = socFromRollup ? "min(soc_min_pct)" : "min(v" + i + ")";
            String max = socFromRollup ? "max(soc_max_pct)" : "max(v" + i + ")";
            String n = rollup
                    ? "coalesce(sum(n_samples) FILTER (WHERE v" + i + " IS NOT NULL), 0)"
                    : "count(v" + i + ")";
            if (i > 0) {
                sql.append(" UNION ALL ");
            }
            // The v1 columns are NUMERIC while the v2 series is DOUBLE PRECISION -
            // cast so both eras map through the same Double-typed row mapper.
            sql.append("SELECT ").append(bucketExpr).append(" AS bucket, '")
                    .append(c.channel()).append("' AS channel,")
                    .append(" avg(v").append(i).append(")::double precision AS avg_value,")
                    .append(' ').append(min).append("::double precision AS min_value,")
                    .append(' ').append(max).append("::double precision AS max_value,")
                    .append(" last(v").append(i).append(", ").append(timeExpr)
                    .append(")::double precision AS last_value, ")
                    .append(n).append("::bigint AS n_samples")
                    .append(" FROM s GROUP BY 1 HAVING count(v").append(i).append(") > 0");
        }
        sql.append(" ORDER BY channel, bucket");
    }

    private static Map<String, List<Bucket>> group(List<ChannelBucket> rows) {
        Map<String, List<Bucket>> channels = new LinkedHashMap<>();
        for (ChannelBucket row : rows) {
            channels.computeIfAbsent(row.channel(), k -> new ArrayList<>()).add(row.bucket());
        }
        for (List<Bucket> buckets : channels.values()) {
            buckets.sort(Comparator.comparing(Bucket::start));
        }
        return channels;
    }

    private record ChannelBucket(String channel, Bucket bucket) {}

    private static ChannelBucket mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new ChannelBucket(rs.getString("channel"), new Bucket(
                rs.getTimestamp("bucket").toInstant(),
                (Double) rs.getObject("avg_value"),
                (Double) rs.getObject("min_value"),
                (Double) rs.getObject("max_value"),
                (Double) rs.getObject("last_value"),
                rs.getLong("n_samples")));
    }
}
