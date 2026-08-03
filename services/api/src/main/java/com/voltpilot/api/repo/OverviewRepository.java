package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Fleet-overview aggregates for the current tenant. Every query runs through
 * the RLS-scoped app datasource WITHOUT a tenant predicate - RLS (migration V2)
 * fences the tenant, so omitting the site filter aggregates exactly the
 * caller's fleet and never more.
 */
@Repository
public class OverviewRepository {

    /**
     * The device liveness window. MUST stay in sync with the portal's
     * {@code ONLINE_WINDOW_MS} (frontend/portal/src/api.ts): 5 minutes.
     */
    private static final String ONLINE_WINDOW = "5 minutes";

    /** Berlin days for the daily-savings buckets (HistoryRange.ZONE). */
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private final JdbcTemplate jdbc;

    public OverviewRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Per-site device stats, keyed by site id. Sites without devices are absent. */
    public record DeviceStats(int deviceCount, int onlineCount, int waitingCount, Instant lastSeenAt) {
    }

    /** Newest telemetry observation of a site. */
    public record LiveRow(Instant ts, BigDecimal pvKw, BigDecimal loadKw, BigDecimal gridKw,
            BigDecimal socPct) {
    }

    /** One Berlin day of fleet-wide ex-ante savings. */
    public record DailySavings(LocalDate day, BigDecimal savingsEur) {
    }

    /** Fleet-wide Σ battery capacity (kWh) + Σ discharge power (kW); nulls = no battery. */
    public record StorageTotals(BigDecimal capacityKwh, BigDecimal powerKw) {
    }

    /**
     * Per-site v2-entity counts BY entity_type (a measurement_point row with a
     * non-NULL entity_type IS a v2 entity - the EntityRegistryRepository rule).
     * ONE fleet-wide query, RLS-scoped like the rest; the controller maps each
     * entity_type onto its role via the EntityTypeCatalog (the Σ-per-role
     * badge). Sites without entities are absent.
     */
    public Map<UUID, Map<String, Integer>> entityTypeCountsPerSite() {
        Map<UUID, Map<String, Integer>> counts = new HashMap<>();
        jdbc.query(
                "SELECT site_id, entity_type, count(*) AS n FROM measurement_point "
                        + "WHERE entity_type IS NOT NULL GROUP BY site_id, entity_type",
                rs -> {
                    counts.computeIfAbsent(rs.getObject("site_id", UUID.class), k -> new HashMap<>())
                            .put(rs.getString("entity_type"), rs.getInt("n"));
                });
        return counts;
    }

    /**
     * The {@code vp.strategy.*} node types of each site's ACTIVE flows - the ONLY
     * thing the overview's usage-profile derivation needs from a flow document.
     *
     * <p>Extracted IN SQL (jsonb): the overview is the portal's landing page and
     * is polled every 30 s, so parsing every active document per request scaled
     * with the fleet size for a handful of node names. One fleet-wide query,
     * RLS-scoped; sites without a matching node are absent. A malformed
     * {@code nodes} (not an array) yields no types instead of an error.
     */
    public Map<UUID, Set<String>> activeStrategyNodeTypesPerSite() {
        Map<UUID, Set<String>> types = new HashMap<>();
        jdbc.query(
                "SELECT f.site_id, n.value->>'type' AS node_type FROM flow_definition f "
                        + "CROSS JOIN LATERAL jsonb_array_elements("
                        + "  CASE WHEN jsonb_typeof(f.document->'nodes') = 'array' "
                        + "       THEN f.document->'nodes' ELSE '[]'::jsonb END) AS n "
                        + "WHERE f.lifecycle = 'active' AND n.value->>'type' LIKE 'vp.strategy.%' "
                        + "ORDER BY f.site_id, node_type",
                rs -> {
                    types.computeIfAbsent(rs.getObject("site_id", UUID.class),
                            k -> new LinkedHashSet<>()).add(rs.getString("node_type"));
                });
        return types;
    }

    /**
     * Fleet-wide Σ battery capacity (kWh) and Σ discharge power (kW) for the
     * portfolio KPI row - from the v1 {@code asset} rows (no new schema).
     * RLS-scoped; both null when the fleet has no battery (never a fake zero).
     */
    public StorageTotals storageTotals() {
        return jdbc.queryForObject(
                "SELECT sum(capacity_kwh) AS kwh, sum(max_discharge_kw) AS kw "
                        + "FROM asset WHERE type = 'battery'",
                (rs, n) -> new StorageTotals(rs.getBigDecimal("kwh"), rs.getBigDecimal("kw")));
    }

    /**
     * Site ids that own a battery asset with NO controlling device (device_id
     * NULL). Such a battery gets a plan but no publish, so the edge never
     * receives a Fahrplan - the portal warns and links to the fix. RLS-scoped,
     * so it only ever reports the caller's own sites.
     */
    public java.util.Set<UUID> sitesWithUnlinkedBattery() {
        java.util.Set<UUID> ids = new java.util.HashSet<>();
        jdbc.query(
                "SELECT DISTINCT site_id FROM asset WHERE type = 'battery' AND device_id IS NULL",
                rs -> {
                    ids.add(rs.getObject("site_id", UUID.class));
                });
        return ids;
    }

    /**
     * Device count / online count / never-seen count / newest arrival per site.
     * Liveness derives from {@code max(received_at)} per device - the ARRIVAL
     * time, never the observation time: a store-and-forward edge replays old
     * observation timestamps while being perfectly online (migration
     * V20260703000000).
     */
    public Map<UUID, DeviceStats> deviceStatsPerSite() {
        Map<UUID, DeviceStats> stats = new HashMap<>();
        jdbc.query(
                "SELECT d.site_id, count(*) AS device_count,"
                        + " count(*) FILTER (WHERE ls.last_seen >= now() - interval '" + ONLINE_WINDOW + "')"
                        + "   AS online_count,"
                        + " count(*) FILTER (WHERE ls.last_seen IS NULL) AS waiting_count,"
                        + " max(ls.last_seen) AS last_seen "
                        + "FROM device d "
                        + "LEFT JOIN LATERAL (SELECT max(received_at) AS last_seen"
                        + "  FROM telemetry t WHERE t.device_id = d.id) ls ON true "
                        + "GROUP BY d.site_id",
                rs -> {
                    Timestamp lastSeen = rs.getTimestamp("last_seen");
                    stats.put(rs.getObject("site_id", UUID.class), new DeviceStats(
                            rs.getInt("device_count"),
                            rs.getInt("online_count"),
                            rs.getInt("waiting_count"),
                            lastSeen == null ? null : lastSeen.toInstant()));
                });
        return stats;
    }

    /**
     * The newest telemetry row per site (the fleet cards' live snapshot) - a
     * top-1 LATERAL per site so the (site_id, time DESC) index answers it
     * without scanning history.
     */
    public Map<UUID, LiveRow> latestLivePerSite() {
        Map<UUID, LiveRow> live = new HashMap<>();
        jdbc.query(
                "SELECT s.id AS site_id, t.time, t.pv_power_kw, t.load_kw, t.power_kw, t.soc_pct "
                        + "FROM site s "
                        + "JOIN LATERAL (SELECT time, pv_power_kw, load_kw, power_kw, soc_pct"
                        + "  FROM telemetry WHERE site_id = s.id ORDER BY time DESC LIMIT 1) t ON true",
                rs -> {
                    live.put(rs.getObject("site_id", UUID.class), new LiveRow(
                            rs.getTimestamp("time").toInstant(),
                            rs.getBigDecimal("pv_power_kw"),
                            rs.getBigDecimal("load_kw"),
                            rs.getBigDecimal("power_kw"),
                            rs.getBigDecimal("soc_pct")));
                });
        return live;
    }

    /**
     * Wann der Optimierer zuletzt für jede Anlage GERECHNET hat
     * ({@code max(generated_at)} über die persistierten Läufe) - die Spalte
     * „Plan" der Plattform-Übersicht. Sie macht einen toten Optimierer
     * flottenweit sichtbar; der Optimierer plant alle 15 Minuten neu, ein Lauf
     * von vor Stunden ist also selbst die Aussage.
     *
     * <p>Das Fenster ist BEWUSST begrenzt ({@code generated_at >= from}, die
     * Aufrufer geben wenige Tage): ohne Untergrenze wäre es ein Scan über die
     * ganze Historie des Hypertables. Eine Anlage ohne Lauf im Fenster ist
     * ABWESEND - „kein aktueller Plan", nie ein erfundenes Alter.
     */
    public Map<UUID, Instant> lastPlanPerSite(Instant from) {
        Map<UUID, Instant> runs = new HashMap<>();
        jdbc.query(
                "SELECT site_id, max(generated_at) AS last_run FROM schedule "
                        + "WHERE generated_at >= ? GROUP BY site_id",
                rs -> {
                    Timestamp last = rs.getTimestamp("last_run");
                    if (last != null) {
                        runs.put(rs.getObject("site_id", UUID.class), last.toInstant());
                    }
                },
                Timestamp.from(from));
        return runs;
    }

    /**
     * Ex-ante battery savings per site over one window, from the persisted
     * optimizer plans: sum(baseline_cost - cost) taking per 15-min slot the
     * LATEST run that planned it (DISTINCT ON - the HistoryRepository.savings
     * semantics, grouped per site). Sites without any priced plan slot in the
     * window are absent (null = "no plan", never a fake zero).
     */
    public Map<UUID, BigDecimal> savingsPerSite(Instant from, Instant to) {
        Map<UUID, BigDecimal> savings = new HashMap<>();
        jdbc.query(
                "SELECT site_id, sum(baseline_cost_eur - cost_eur) AS savings FROM ("
                        + "  SELECT DISTINCT ON (site_id, time) site_id, baseline_cost_eur, cost_eur"
                        + "  FROM schedule WHERE time >= ? AND time < ?"
                        + "  ORDER BY site_id, time, generated_at DESC) s "
                        + "WHERE baseline_cost_eur IS NOT NULL AND cost_eur IS NOT NULL "
                        + "GROUP BY site_id",
                rs -> {
                    BigDecimal value = rs.getBigDecimal("savings");
                    if (value != null) {
                        savings.put(rs.getObject("site_id", UUID.class), value);
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        return savings;
    }

    /**
     * Fleet-wide ex-ante savings per Europe/Berlin day (the hero's 14-day mini
     * chart): the same latest-run-per-slot de-duplication, then day buckets.
     * Days without any plan are absent.
     */
    public List<DailySavings> dailySavings(Instant from, Instant to) {
        List<DailySavings> days = new ArrayList<>();
        jdbc.query(
                "SELECT time_bucket('1 day', time, 'Europe/Berlin') AS day,"
                        + " sum(baseline_cost_eur - cost_eur) AS savings FROM ("
                        + "  SELECT DISTINCT ON (site_id, time) time, baseline_cost_eur, cost_eur"
                        + "  FROM schedule WHERE time >= ? AND time < ?"
                        + "  ORDER BY site_id, time, generated_at DESC) s "
                        + "WHERE baseline_cost_eur IS NOT NULL AND cost_eur IS NOT NULL "
                        + "GROUP BY 1 ORDER BY 1",
                rs -> {
                    BigDecimal value = rs.getBigDecimal("savings");
                    if (value != null) {
                        days.add(new DailySavings(
                                rs.getTimestamp("day").toInstant().atZone(ZONE).toLocalDate(),
                                value));
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        return days;
    }
}
