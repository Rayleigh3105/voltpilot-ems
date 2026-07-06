package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
