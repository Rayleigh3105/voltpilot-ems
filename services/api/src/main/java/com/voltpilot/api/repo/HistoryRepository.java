package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.HistoryPlanPointDto;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * History reads for the current tenant. Everything here is RLS-scoped like
 * telemetry: the raw {@code telemetry} hypertable, the
 * {@code telemetry_rollup_*} tables (migration V20260701030000) and the
 * {@code schedule} hypertable all carry the tenant policy, so no query needs
 * (or trusts) a tenant predicate. {@code day_ahead_prices} is public market
 * data joined read-only.
 */
@Repository
public class HistoryRepository {

    /**
     * Matches a 15-min bucket to its day-ahead price slot: the stored slot
     * (PT15M or PT60M) containing the bucket start, preferring the finer
     * resolution when both exist.
     */
    private static final String PRICE_LATERAL =
            "LEFT JOIN LATERAL ("
                    + "  SELECT p.price_eur_mwh FROM day_ahead_prices p"
                    + "  WHERE p.bidding_zone = ? AND p.ts <= b.bucket"
                    + "    AND p.ts + (CASE p.resolution WHEN 'PT60M' THEN INTERVAL '60 minutes'"
                    + "                ELSE INTERVAL '15 minutes' END) > b.bucket"
                    + "  ORDER BY (p.resolution = 'PT15M') DESC, p.ts DESC LIMIT 1"
                    + ") p ON true ";

    private final JdbcTemplate jdbc;

    public HistoryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Day-view buckets: 15-min aggregation computed from RAW telemetry on the
     * fly (a single day is small), so "today" is live and not behind the rollup
     * refresh. Same energy semantics as the rollups (see the migration), plus
     * the matching day-ahead price and the per-bucket import cost.
     */
    public List<HistoryBucketDto> dayBuckets(UUID siteId, Instant from, Instant to, String biddingZone) {
        return jdbc.query(
                "WITH b AS ("
                        + "  SELECT time_bucket('15 minutes', time) AS bucket,"
                        + "         avg(pv_power_kw) * 0.25 AS pv_kwh,"
                        + "         avg(load_kw) * 0.25 AS load_kwh,"
                        // NULL-safe (audit B2): GREATEST ignores NULLs, so a bare
                        // greatest(power_kw, 0) fabricated 0 for power-less samples -
                        // average only over samples where the source channels exist,
                        // exactly like refresh_telemetry_rollups (V20260712000000).
                        + "         avg(CASE WHEN power_kw IS NOT NULL"
                        + "                  THEN greatest(power_kw, 0) END) * 0.25 AS grid_import_kwh,"
                        + "         avg(CASE WHEN power_kw IS NOT NULL"
                        + "                  THEN greatest(-power_kw, 0) END) * 0.25 AS grid_export_kwh,"
                        + "         avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL"
                        + "                       AND pv_power_kw IS NOT NULL"
                        + "                  THEN greatest(power_kw - load_kw + pv_power_kw, 0)"
                        + "             END) * 0.25 AS battery_charge_kwh,"
                        + "         avg(CASE WHEN power_kw IS NOT NULL AND load_kw IS NOT NULL"
                        + "                       AND pv_power_kw IS NOT NULL"
                        + "                  THEN greatest(-(power_kw - load_kw + pv_power_kw), 0)"
                        + "             END) * 0.25 AS battery_discharge_kwh,"
                        + "         min(soc_pct) AS soc_min_pct, max(soc_pct) AS soc_max_pct,"
                        + "         last(soc_pct, time) AS soc_last_pct"
                        + "  FROM telemetry WHERE site_id = ? AND time >= ? AND time < ?"
                        + "  GROUP BY 1) "
                        + "SELECT b.*, p.price_eur_mwh,"
                        + "       b.grid_import_kwh * p.price_eur_mwh / 1000 AS cost_eur "
                        + "FROM b " + PRICE_LATERAL
                        + "ORDER BY b.bucket",
                HistoryRepository::mapBucket,
                siteId, Timestamp.from(from), Timestamp.from(to), biddingZone);
    }

    /**
     * Week/month/year buckets from the precomputed rollups: hourly buckets from
     * {@code telemetry_rollup_1h}, daily (Europe/Berlin days) from
     * {@code telemetry_rollup_1d}. Price/cost are merged in separately (they
     * need the 15-min structure, see {@link #costPerBucket}).
     */
    public List<HistoryBucketDto> rollupBuckets(UUID siteId, Instant from, Instant to, boolean daily) {
        String table = daily ? "telemetry_rollup_1d" : "telemetry_rollup_1h";
        return jdbc.query(
                "SELECT bucket, pv_kwh, load_kwh, grid_import_kwh, grid_export_kwh,"
                        + " battery_charge_kwh, battery_discharge_kwh,"
                        + " soc_min_pct, soc_max_pct, soc_last_pct,"
                        + " NULL::numeric AS price_eur_mwh, NULL::numeric AS cost_eur "
                        + "FROM " + table
                        + " WHERE site_id = ? AND bucket >= ? AND bucket < ? ORDER BY bucket",
                HistoryRepository::mapBucket,
                siteId, Timestamp.from(from), Timestamp.from(to));
    }

    /**
     * Grid cost per display bucket for the rollup ranges: 15-min import energy
     * x the matching day-ahead price, summed into the display bucket (hourly or
     * Europe/Berlin-daily). Buckets without any priced slot are absent.
     */
    public Map<Instant, BigDecimal> costPerBucket(
            UUID siteId, Instant from, Instant to, String biddingZone, boolean daily) {
        String bucketExpr = daily
                ? "time_bucket('1 day', b.bucket, 'Europe/Berlin')"
                : "time_bucket('1 hour', b.bucket)";
        Map<Instant, BigDecimal> costs = new HashMap<>();
        jdbc.query(
                "SELECT " + bucketExpr + " AS display_bucket,"
                        + " sum(b.grid_import_kwh * p.price_eur_mwh / 1000) AS cost_eur "
                        + "FROM telemetry_rollup_15m b " + PRICE_LATERAL
                        + "WHERE b.site_id = ? AND b.bucket >= ? AND b.bucket < ? "
                        + "GROUP BY 1",
                rs -> {
                    BigDecimal cost = rs.getBigDecimal("cost_eur");
                    if (cost != null) {
                        costs.put(rs.getTimestamp("display_bucket").toInstant(), cost);
                    }
                },
                biddingZone, siteId, Timestamp.from(from), Timestamp.from(to));
        return costs;
    }

    /**
     * Battery savings over a window from the persisted optimizer plans:
     * sum(baseline_cost - cost) taking, per 15-min slot, the LATEST run that
     * planned it (DISTINCT ON) so overlapping MPC runs never double-count.
     * Returns null when no plan slot covers the window ("where plans exist").
     */
    public BigDecimal savings(UUID siteId, Instant from, Instant to) {
        List<BigDecimal> result = jdbc.query(
                "SELECT sum(baseline_cost_eur - cost_eur) AS savings FROM ("
                        + "  SELECT DISTINCT ON (time) baseline_cost_eur, cost_eur"
                        + "  FROM schedule WHERE site_id = ? AND time >= ? AND time < ?"
                        + "  ORDER BY time, generated_at DESC) s "
                        + "WHERE baseline_cost_eur IS NOT NULL AND cost_eur IS NOT NULL",
                (rs, i) -> rs.getBigDecimal("savings"),
                siteId, Timestamp.from(from), Timestamp.from(to));
        return result.isEmpty() ? null : result.get(0);
    }

    /**
     * The plan trajectory for a day (plan-vs-actual overlay): per 15-min slot
     * the battery power / SoC of the latest run that planned it. Empty when the
     * optimizer never planned the day.
     */
    public List<HistoryPlanPointDto> planForWindow(UUID siteId, Instant from, Instant to) {
        return jdbc.query(
                "SELECT DISTINCT ON (time) time, battery_kw, soc_pct "
                        + "FROM schedule WHERE site_id = ? AND time >= ? AND time < ? "
                        + "ORDER BY time, generated_at DESC",
                (rs, i) -> new HistoryPlanPointDto(
                        rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("battery_kw"),
                        rs.getBigDecimal("soc_pct")),
                siteId, Timestamp.from(from), Timestamp.from(to));
    }

    private static HistoryBucketDto mapBucket(ResultSet rs, int i) throws SQLException {
        return new HistoryBucketDto(
                rs.getTimestamp("bucket").toInstant(),
                rs.getBigDecimal("pv_kwh"),
                rs.getBigDecimal("load_kwh"),
                rs.getBigDecimal("grid_import_kwh"),
                rs.getBigDecimal("grid_export_kwh"),
                rs.getBigDecimal("battery_charge_kwh"),
                rs.getBigDecimal("battery_discharge_kwh"),
                rs.getBigDecimal("soc_min_pct"),
                rs.getBigDecimal("soc_max_pct"),
                rs.getBigDecimal("soc_last_pct"),
                rs.getBigDecimal("price_eur_mwh"),
                rs.getBigDecimal("cost_eur"));
    }
}
