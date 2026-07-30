package com.voltpilot.api.repo;

import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.optimizer.SlotEconomics;
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
 *
 * <p><b>{@code cost_eur} is the site's REAL supply cost since Stufe 3 of the
 * structured Bezugspreis</b> (report vp-nacht-bezug-e7 §3.4): import energy ×
 * the SAME per-slot import-price composition the optimizer plans with
 * ({@link SlotEconomics#importPriceCtSql} - flat tariff / spot + Aufschlag /
 * {@code (spot + Preisblatt-Komponenten) × (1+USt)}; a site without any price
 * data stays at bare spot, byte-identical to before). Like the earnings
 * engine, every slot is valued at the CURRENTLY maintained tariff - there is
 * no price-sheet history (documented v1 simplification).
 */
@Repository
public class HistoryRepository {

    /**
     * The price series for the queried zone and window, materialized once per
     * query - see {@link PriceSlots} for the why and for the proof that the
     * slot choice is identical to the per-bucket lateral this replaced.
     * Binds: bidding zone, window start, window end.
     */
    private static final String PRICE_SLOT_CTE = PriceSlots.forZone();

    /**
     * Matches a 15-min bucket (alias {@code b}) to its day-ahead price slot:
     * the stored slot (PT15M or PT60M) containing the bucket start, preferring
     * the finer resolution when both exist. The zone is already fixed by
     * {@link #PRICE_SLOT_CTE}, so the equi-join is on the slot alone.
     */
    private static final String PRICE_JOIN =
            "LEFT JOIN price_slot p ON p.slot = b.bucket ";

    /** The site + supply-price-sheet join the import valuation needs (fixed
     * {@code s}/{@code ssp} aliases, the importPriceCtSql contract; the site
     * id binds a parameter). */
    private static final String SITE_TARIFF_JOIN =
            "JOIN site s ON s.id = ? "
                    + "LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id ";

    private final JdbcTemplate jdbc;

    /** Per-slot grid cost in EUR: import kWh × the ONE import-price
     * composition (EUR/kWh), flag-built once at construction. */
    private final String costEur;

    private final String tarifPricedExpr;

    public HistoryRepository(JdbcTemplate jdbc, OptimizerProperties optimizer) {
        this.jdbc = jdbc;
        this.costEur = "(b.grid_import_kwh * " + SlotEconomics.importPriceCtSql(
                "p.price_eur_mwh", optimizer.defaultSupplyComponents()) + " / 100.0)";
        this.tarifPricedExpr = SlotEconomics.tarifPricedSql(optimizer.defaultSupplyComponents());
    }

    /**
     * Day-view buckets: 15-min aggregation computed from RAW telemetry on the
     * fly (a single day is small), so "today" is live and not behind the rollup
     * refresh. Same energy semantics as the rollups (see the migration), plus
     * the matching day-ahead price and the per-bucket import cost.
     */
    public List<HistoryBucketDto> dayBuckets(UUID siteId, Instant from, Instant to, String biddingZone) {
        return jdbc.query(
                "WITH " + PRICE_SLOT_CTE + ", b AS ("
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
                        + "       " + costEur + " AS cost_eur "
                        + "FROM b " + SITE_TARIFF_JOIN + PRICE_JOIN
                        + "ORDER BY b.bucket",
                HistoryRepository::mapBucket,
                biddingZone, Timestamp.from(from), Timestamp.from(to),
                siteId, Timestamp.from(from), Timestamp.from(to), siteId);
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
                "WITH " + PRICE_SLOT_CTE
                        + "SELECT " + bucketExpr + " AS display_bucket,"
                        + " sum(" + costEur + ") AS cost_eur "
                        + "FROM telemetry_rollup_15m b " + SITE_TARIFF_JOIN + PRICE_JOIN
                        + "WHERE b.site_id = ? AND b.bucket >= ? AND b.bucket < ? "
                        + "GROUP BY 1",
                rs -> {
                    BigDecimal cost = rs.getBigDecimal("cost_eur");
                    if (cost != null) {
                        costs.put(rs.getTimestamp("display_bucket").toInstant(), cost);
                    }
                },
                biddingZone, Timestamp.from(from), Timestamp.from(to),
                siteId, siteId, Timestamp.from(from), Timestamp.from(to));
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
     * The labeling context of {@code gridCostEur}: the site's configured
     * tariff kind ({@code dynamisch|fest|ohne}, audit H8) plus whether the
     * import valuation actually engaged a tariff/Preisblatt beyond bare spot
     * ({@code tarifPriced} - the {@link SlotEconomics#tarifPricedSql} branch
     * conditions, so the label always matches the number: a bare
     * {@code tarif_art} echo cannot tell an {@code ohne} site with a
     * maintained sheet from one without). Null when the site is unreadable
     * (RLS/deleted).
     */
    public record TariffContext(String tarifArt, boolean tarifPriced) {
    }

    public TariffContext tariffContext(UUID siteId) {
        List<TariffContext> rows = jdbc.query(
                "SELECT s.tarif_art, " + tarifPricedExpr + " AS tarif_priced "
                        + "FROM site s LEFT JOIN site_supply_price ssp ON ssp.site_id = s.id "
                        + "WHERE s.id = ?",
                (rs, i) -> new TariffContext(rs.getString("tarif_art"),
                        rs.getBoolean("tarif_priced")),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
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

    // ---- v1 -> v2 history bridge (MIG) --------------------------------------
    //
    // A migrated site's Historie splices two eras at site.v2_history_cutover_at:
    // v1 owns buckets whose start is BEFORE the instant, v2 owns those at/after
    // it (HistoryService). The methods below RECONSTRUCT the v1 HistoryBucketDto
    // shape read-side from the v2 per-entity telemetry, so the two eras render
    // as ONE continuous series. NOTHING is copied.
    //
    // Channel reconstruction (per bucket, summed across the site's v2 entities):
    //   pv_power_kw (any entity)                 -> site PV
    //   battery_power_kw (any storage)           -> site battery (MEASURED,
    //                                               not the v1 balance derivation)
    //   power_kw of a grid-meter entity ONLY     -> site grid (import/export)
    //   soc_pct                                  -> site SoC (min/max across
    //                                               entities; last = mean, exact
    //                                               for the single-battery pilot)
    //   load                                     -> RESIDUAL grid + pv - battery
    //                                               (a consumer entity's own
    //                                               power_kw is already inside it)
    // Import/export are split from the bucket-AVERAGE grid power (a slot that
    // both imports and exports nets out - the documented seam approximation;
    // the money-critical earnings keep reading the v1 rollups during the shadow
    // phase). A site with no grid-meter entity (bare hybrid) yields NULL grid/
    // load for the v2 era - PV/battery/SoC still bridge continuously.

    /** The site's history cutover instant, or null when un-migrated (pure v1). */
    public Instant v2HistoryCutover(UUID siteId) {
        List<Timestamp> rows = jdbc.query(
                "SELECT v2_history_cutover_at FROM site WHERE id = ?",
                (rs, i) -> rs.getTimestamp("v2_history_cutover_at"), siteId);
        if (rows.isEmpty() || rows.get(0) == null) {
            return null;
        }
        return rows.get(0).toInstant();
    }

    /**
     * v2-era day buckets: 15-min aggregation reconstructed from RAW
     * {@code telemetry_v2} into the v1 HistoryBucketDto shape, incl. the matching
     * day-ahead price and per-bucket import cost (mirrors {@link #dayBuckets}).
     */
    public List<HistoryBucketDto> v2DayBuckets(UUID siteId, Instant from, Instant to,
            String biddingZone) {
        String quarters = "SELECT time_bucket('15 minutes', t.time) AS bucket, t.entity_id,"
                + " t.channel, avg(t.value) AS avg_value, min(t.value) AS min_value,"
                + " max(t.value) AS max_value, last(t.value, t.time) AS last_value"
                + " FROM telemetry_v2 t"
                + " WHERE t.site_id = ? AND t.time >= ? AND t.time < ? GROUP BY 1, 2, 3";
        return jdbc.query(
                "WITH " + PRICE_SLOT_CTE
                        + ", b AS (" + v2Reconstruction(quarters, "q.bucket") + ") "
                        + "SELECT b.*, p.price_eur_mwh,"
                        + "       " + costEur + " AS cost_eur "
                        + "FROM b " + SITE_TARIFF_JOIN + PRICE_JOIN + "ORDER BY b.bucket",
                HistoryRepository::mapBucket,
                biddingZone, Timestamp.from(from), Timestamp.from(to),
                siteId, Timestamp.from(from), Timestamp.from(to), siteId);
    }

    /**
     * v2-era week/month/year buckets reconstructed from {@code
     * telemetry_v2_rollup_15m} by SUMMING quarter energies into the display
     * bucket (hourly / Europe/Berlin-daily) - the SAME energy semantics as the
     * v1 rollups (not avg x span, which would overstate a partly-covered
     * bucket). Price/cost are merged in separately via {@link #v2CostPerBucket}.
     */
    public List<HistoryBucketDto> v2RollupBuckets(UUID siteId, Instant from, Instant to,
            boolean daily) {
        String disp = daily
                ? "time_bucket('1 day', q.bucket, 'Europe/Berlin')"
                : "time_bucket('1 hour', q.bucket)";
        String quarters = "SELECT r.bucket, r.entity_id, r.channel, r.avg_value, r.min_value,"
                + " r.max_value, r.last_value FROM telemetry_v2_rollup_15m r"
                + " WHERE r.site_id = ? AND r.bucket >= ? AND r.bucket < ?";
        return jdbc.query(
                "SELECT b.*, NULL::numeric AS price_eur_mwh, NULL::numeric AS cost_eur "
                        + "FROM (" + v2Reconstruction(quarters, disp) + ") b ORDER BY b.bucket",
                HistoryRepository::mapBucket,
                siteId, Timestamp.from(from), Timestamp.from(to));
    }

    /**
     * v2-era grid cost per display bucket: 15-min import energy from the
     * grid-meter entity x the matching day-ahead price, summed into the display
     * bucket (mirrors {@link #costPerBucket} on {@code telemetry_v2_rollup_15m}).
     */
    public Map<Instant, BigDecimal> v2CostPerBucket(
            UUID siteId, Instant from, Instant to, String biddingZone, boolean daily) {
        String bucketExpr = daily
                ? "time_bucket('1 day', b.bucket, 'Europe/Berlin')"
                : "time_bucket('1 hour', b.bucket)";
        Map<Instant, BigDecimal> costs = new HashMap<>();
        jdbc.query(
                "WITH " + PRICE_SLOT_CTE + ", g AS ("
                        + "  SELECT r.bucket, greatest(r.avg_value, 0) * 0.25 AS grid_import_kwh"
                        + "  FROM telemetry_v2_rollup_15m r"
                        + "  JOIN measurement_point mp ON mp.id::text = r.entity_id"
                        + "  WHERE r.site_id = ? AND mp.entity_type = 'grid-meter'"
                        + "    AND r.channel = 'power_kw' AND r.bucket >= ? AND r.bucket < ?) "
                        + "SELECT " + bucketExpr + " AS display_bucket,"
                        + " sum(" + costEur + ") AS cost_eur "
                        + "FROM g AS b " + SITE_TARIFF_JOIN + PRICE_JOIN + "GROUP BY 1",
                rs -> {
                    BigDecimal cost = rs.getBigDecimal("cost_eur");
                    if (cost != null) {
                        costs.put(rs.getTimestamp("display_bucket").toInstant(), cost);
                    }
                },
                biddingZone, Timestamp.from(from), Timestamp.from(to),
                siteId, Timestamp.from(from), Timestamp.from(to), siteId);
        return costs;
    }

    /**
     * The shared v2 reconstruction: given a {@code quarters} sub-select yielding
     * 15-min rows (bucket, entity_id, channel, avg/min/max/last value), pivots
     * per quarter into site-channel power (grid classified by the grid-meter
     * entity_type join) and SUMS quarter energies (power x 0.25 h) into the
     * {@code displayBucketExpr} (identity for day, hour/day for the rollups) -
     * so the v1 HistoryBucketDto shape holds at every range. Grid import/export
     * is split per QUARTER before summing; a bucket without any grid-meter
     * quarter leaves grid/load NULL (a bare hybrid); SoC is min/max across
     * quarters, last = the latest quarter's value.
     */
    private static String v2Reconstruction(String quarters, String displayBucketExpr) {
        return "WITH typed AS (SELECT src.bucket, src.channel, src.avg_value, src.min_value,"
                + "   src.max_value, src.last_value, mp.entity_type"
                + "   FROM (" + quarters + ") src"
                + "   LEFT JOIN measurement_point mp ON mp.id::text = src.entity_id),"
                + " q AS (SELECT bucket,"
                + "   sum(avg_value) FILTER (WHERE channel = 'pv_power_kw') AS pv_kw,"
                + "   sum(avg_value) FILTER (WHERE channel = 'battery_power_kw') AS batt_kw,"
                + "   sum(avg_value) FILTER (WHERE channel = 'power_kw'"
                + "        AND entity_type = 'grid-meter') AS grid_kw,"
                + "   bool_or(channel = 'power_kw' AND entity_type = 'grid-meter') AS has_grid,"
                + "   min(min_value) FILTER (WHERE channel = 'soc_pct') AS soc_min,"
                + "   max(max_value) FILTER (WHERE channel = 'soc_pct') AS soc_max,"
                + "   avg(last_value) FILTER (WHERE channel = 'soc_pct') AS soc_last"
                + "   FROM typed GROUP BY bucket)"
                + " SELECT " + displayBucketExpr + " AS bucket,"
                + "   greatest(sum(greatest(coalesce(pv_kw, 0), 0) * 0.25), 0) AS pv_kwh,"
                + "   CASE WHEN bool_or(has_grid) THEN sum(greatest(coalesce(grid_kw, 0)"
                + "     + coalesce(pv_kw, 0) - coalesce(batt_kw, 0), 0) * 0.25) END AS load_kwh,"
                + "   CASE WHEN bool_or(has_grid)"
                + "     THEN sum(greatest(coalesce(grid_kw, 0), 0) * 0.25) END AS grid_import_kwh,"
                + "   CASE WHEN bool_or(has_grid)"
                + "     THEN sum(greatest(-coalesce(grid_kw, 0), 0) * 0.25) END AS grid_export_kwh,"
                + "   sum(greatest(coalesce(batt_kw, 0), 0) * 0.25) AS battery_charge_kwh,"
                + "   sum(greatest(-coalesce(batt_kw, 0), 0) * 0.25) AS battery_discharge_kwh,"
                + "   min(soc_min) AS soc_min_pct, max(soc_max) AS soc_max_pct,"
                + "   last(soc_last, bucket) AS soc_last_pct"
                + " FROM q GROUP BY " + displayBucketExpr;
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
