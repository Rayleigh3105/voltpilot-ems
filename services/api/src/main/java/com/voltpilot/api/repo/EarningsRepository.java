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
 * Realized-earnings aggregates for the current tenant: the section-3.2 math of
 * the fleet-overview plan over {@code telemetry_rollup_15m} x
 * {@code day_ahead_prices}. Per 15-min slot and site:
 *
 * <pre>
 *   baseline = (load_kwh - pv_kwh) * price/1000        -- unregulated plant, battery idle
 *   actual   = (grid_import_kwh - grid_export_kwh) * price/1000
 *   saved    = baseline - actual
 * </pre>
 *
 * <p>Both sides are priced symmetrically at spot (the platform's
 * Direktvermarktung MVP assumption, services/optimization domain.py) - that is
 * what makes the counterfactual a pure aggregate: the residual's import/export
 * split within a slot never matters. If asymmetric import/export pricing ever
 * lands, this shortcut breaks and the baseline needs a simulation (the
 * planned Phase-3 counterfactual engine).
 *
 * <p>By the rollups' power-balance identity ({@code battery = grid - load +
 * pv}, migration V20260701030000), saved equals
 * {@code (battery_discharge_kwh - battery_charge_kwh) * price/1000}: the
 * battery's actual dispatch valued at the actual price. Round-trip losses are
 * automatically debited, so a badly-run battery shows NEGATIVE savings.
 *
 * <p><b>Marktprämie (Phase 3).</b> A Direktvermarktung site with a configured
 * {@code site.marktpraemie_ct_kwh} (migration V20260706040000) additionally
 * earns the premium on every exported kWh - EXCEPT in slots whose day-ahead
 * price is negative, where §51 EEG suspends it. Both sides get the same rule:
 *
 * <pre>
 *   baseline -= greatest(pv_kwh - load_kwh, 0) * premium   -- immediate feed-in of the surplus
 *   actual   -= grid_export_kwh * premium                  -- the metered feed-in
 *   (premium in EUR/kWh = marktpraemie_ct_kwh / 100; both only when price >= 0)
 * </pre>
 *
 * <p>Crediting the baseline too keeps the DELTA honest: storing PV instead of
 * feeding it in forgoes premium (a real cost of battery operation), and
 * curtailment that avoids negative-price feed-in shows its true value because
 * neither side earns premium in those slots anyway. This is a deliberate
 * SIMPLIFICATION of §51/§51a EEG: the law suspends the premium over negative
 * 4h/1h WINDOWS (rules changed for new plants in 2023/2026); we apply it per
 * 15-min spot slot. Full EEG accounting (including the anzulegender-Wert
 * mechanics behind the premium level) is out of scope - the premium value
 * itself comes from the customer's Direktvermarktungsvertrag. The slot-level
 * baseline export {@code greatest(pv - load, 0)} is likewise an approximation:
 * the rollup cannot see sub-slot import/export interleaving of the
 * counterfactual plant (the same approximation the symmetric-pricing shortcut
 * already makes exact for the SPOT part).
 *
 * <p>An unconfigured premium (NULL, the default) contributes exactly 0 to both
 * sides - the Phase-2 numbers are then unchanged.
 *
 * <p>Every query runs through the RLS-scoped app datasource WITHOUT a tenant
 * predicate - RLS (migration V2) fences the tenant. {@code day_ahead_prices}
 * is public market data joined read-only per each site's OWN bidding zone.
 */
@Repository
public class EarningsRepository {

    /** Berlin days for the daily buckets (HistoryRange.ZONE). */
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /**
     * A slot is computable when the baseline channels (load/PV) AND the meter
     * channels (grid import/export) are present. Generation-only inverters
     * (Deye string/micro: no grid or load registers) never satisfy this - their
     * sites degrade honestly instead of summing garbage.
     */
    private static final String CHANNELS_OK =
            "r.load_kwh IS NOT NULL AND r.pv_kwh IS NOT NULL"
                    + " AND r.grid_import_kwh IS NOT NULL AND r.grid_export_kwh IS NOT NULL";

    /**
     * Matches a 15-min bucket to its day-ahead price slot in the SITE's bidding
     * zone: the stored slot (PT15M or PT60M) containing the bucket start,
     * preferring the finer resolution when both exist - the
     * HistoryRepository.PRICE_LATERAL approach, with the zone taken from the
     * joined site row instead of a parameter (each site prices in its own
     * zone, so multi-zone fleets sum correctly).
     */
    private static final String PRICE_LATERAL =
            "LEFT JOIN LATERAL ("
                    + "  SELECT p.price_eur_mwh FROM day_ahead_prices p"
                    + "  WHERE p.bidding_zone = s.bidding_zone AND p.ts <= r.bucket"
                    + "    AND p.ts + (CASE p.resolution WHEN 'PT60M' THEN INTERVAL '60 minutes'"
                    + "                ELSE INTERVAL '15 minutes' END) > r.bucket"
                    + "  ORDER BY (p.resolution = 'PT15M') DESC, p.ts DESC LIMIT 1"
                    + ") p ON true ";

    /** A slot enters the sums when its channels AND a price are present. */
    private static final String COVERED = CHANNELS_OK + " AND p.price_eur_mwh IS NOT NULL";

    /**
     * When a slot earns the Marktprämie: the site markets directly AND has a
     * premium configured AND the slot's price is non-negative (the simplified
     * §51-EEG rule - see the class Javadoc). NULL premium => never eligible =>
     * both premium terms are exactly 0 and Phase-2 numbers are unchanged.
     */
    private static final String PREMIUM_ELIGIBLE =
            "s.plant_kind = 'direktvermarktung' AND s.marktpraemie_ct_kwh IS NOT NULL"
                    + " AND p.price_eur_mwh >= 0";

    /** Premium EUR earned by the slot's METERED export (the actual side). */
    private static final String ACTUAL_PREMIUM_EUR =
            "(CASE WHEN " + PREMIUM_ELIGIBLE
                    + " THEN r.grid_export_kwh * s.marktpraemie_ct_kwh / 100 ELSE 0 END)";

    /**
     * Premium EUR the UNREGULATED plant would earn: it feeds its PV surplus in
     * immediately, so its export is {@code greatest(pv - load, 0)} per slot.
     */
    private static final String BASELINE_PREMIUM_EUR =
            "(CASE WHEN " + PREMIUM_ELIGIBLE
                    + " THEN GREATEST(r.pv_kwh - r.load_kwh, 0) * s.marktpraemie_ct_kwh / 100"
                    + " ELSE 0 END)";

    private final JdbcTemplate jdbc;

    public EarningsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * One site's aggregate over a window. {@code bucketCount} counts ALL rollup
     * buckets in the window, {@code channelBuckets} those with computable
     * channels, {@code coveredSlots} those that also found a price - the three
     * tiers let the caller derive an honest non-computability reason. Money
     * sums and {@code firstCovered} span covered slots only.
     */
    public record SiteAggregate(
            long bucketCount,
            long channelBuckets,
            long coveredSlots,
            BigDecimal baselineEur,
            BigDecimal actualEur,
            Instant firstCovered) {
    }

    /** One Europe/Berlin day of realized savings of one site. */
    public record DailySaved(LocalDate day, BigDecimal savedEur) {
    }

    /**
     * The per-site earnings aggregate over {@code [from, to)}. Sites without
     * any rollup bucket in the window are absent from the map.
     */
    public Map<UUID, SiteAggregate> aggregate(Instant from, Instant to) {
        Map<UUID, SiteAggregate> result = new HashMap<>();
        jdbc.query(
                "SELECT r.site_id,"
                        + " count(*) AS bucket_count,"
                        + " count(*) FILTER (WHERE " + CHANNELS_OK + ") AS channel_buckets,"
                        + " count(*) FILTER (WHERE " + COVERED + ") AS covered_slots,"
                        + " sum((r.load_kwh - r.pv_kwh) * p.price_eur_mwh / 1000"
                        + "     - " + BASELINE_PREMIUM_EUR + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS baseline_eur,"
                        + " sum((r.grid_import_kwh - r.grid_export_kwh) * p.price_eur_mwh / 1000"
                        + "     - " + ACTUAL_PREMIUM_EUR + ")"
                        + "   FILTER (WHERE " + COVERED + ") AS actual_eur,"
                        + " min(r.bucket) FILTER (WHERE " + COVERED + ") AS first_covered "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + PRICE_LATERAL
                        + "WHERE r.bucket >= ? AND r.bucket < ? "
                        + "GROUP BY r.site_id",
                rs -> {
                    Timestamp firstCovered = rs.getTimestamp("first_covered");
                    result.put(rs.getObject("site_id", UUID.class), new SiteAggregate(
                            rs.getLong("bucket_count"),
                            rs.getLong("channel_buckets"),
                            rs.getLong("covered_slots"),
                            rs.getBigDecimal("baseline_eur"),
                            rs.getBigDecimal("actual_eur"),
                            firstCovered == null ? null : firstCovered.toInstant()));
                },
                Timestamp.from(from), Timestamp.from(to));
        return result;
    }

    /**
     * Realized savings per site and Europe/Berlin day over {@code [from, to)}
     * (the hero's spark bars + the "Heute" teasers). Only covered slots count;
     * days without one are absent - never a fake zero.
     */
    public Map<UUID, List<DailySaved>> dailySavedPerSite(Instant from, Instant to) {
        Map<UUID, List<DailySaved>> result = new HashMap<>();
        jdbc.query(
                "SELECT r.site_id, time_bucket('1 day', r.bucket, 'Europe/Berlin') AS day,"
                        // saved = baseline - actual, incl. the premium delta
                        // (actual premium - baseline premium).
                        + " sum(((r.load_kwh - r.pv_kwh) - (r.grid_import_kwh - r.grid_export_kwh))"
                        + "     * p.price_eur_mwh / 1000"
                        + "     + " + ACTUAL_PREMIUM_EUR + " - " + BASELINE_PREMIUM_EUR + ") AS saved_eur "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id "
                        + PRICE_LATERAL
                        + "WHERE r.bucket >= ? AND r.bucket < ? AND " + COVERED + " "
                        + "GROUP BY 1, 2 ORDER BY 1, 2",
                rs -> {
                    BigDecimal saved = rs.getBigDecimal("saved_eur");
                    if (saved != null) {
                        result.computeIfAbsent(rs.getObject("site_id", UUID.class),
                                        k -> new ArrayList<>())
                                .add(new DailySaved(
                                        rs.getTimestamp("day").toInstant().atZone(ZONE).toLocalDate(),
                                        saved));
                    }
                },
                Timestamp.from(from), Timestamp.from(to));
        return result;
    }
}
