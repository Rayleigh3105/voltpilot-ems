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
 * Peak-shaving proof numbers (PS-4 reporting) for the current tenant's
 * module-active sites ({@code site.leistungspreis_eur_kw} non-NULL, migration
 * V20260716020000): per Europe/Berlin billing period, the MEASURED grid-import
 * peak and the counterfactual NO-BATTERY peak, both from
 * {@code telemetry_rollup_15m}.
 *
 * <p>Per 15-min bucket (kWh energies; {@code * 4.0} converts a quarter-hour
 * energy to its mean power in kW - the same formula the optimizer's
 * {@code inputs._peak_so_far_kw} anchors its epigraph on):
 *
 * <pre>
 *   measured import  = greatest(grid_import_kwh, 0)                       * 4.0
 *   baseline import  = greatest(grid_import_kwh - grid_export_kwh
 *                               + battery_discharge_kwh
 *                               - battery_charge_kwh, 0)                  * 4.0
 * </pre>
 *
 * and the period peak is the max over the period's buckets (measured and
 * baseline may peak in DIFFERENT buckets - each is its own max).
 *
 * <p><b>The counterfactual and its approximations, explicitly.</b> By the
 * rollups' power-balance identity (battery = grid - load + pv, migration
 * V20260701030000, aggregated with the per-sample import/export split), the
 * baseline expression equals {@code greatest(load_kwh - pv_kwh, 0)}: the SAME
 * plant with the battery idle - same consumption, same generation, PV surplus
 * fed in immediately (the identical counterfactual the realized-earnings
 * baseline prices). Known approximations, accepted deliberately:
 * <ul>
 * <li><b>Bucket granularity.</b> Sub-slot interleaving (importing early in the
 * quarter hour, exporting late) is invisible - the counterfactual import is
 * the bucket's NET floored at 0. This matches the granularity the RLM meter
 * bills anyway (the Leistungspreis is defined on 15-min mean import), so the
 * comparison is like-for-like with the billed quantity.</li>
 * <li><b>No behavioral response.</b> Load and PV are assumed unchanged without
 * the battery (the standard counterfactual assumption of every earnings
 * number here).</li>
 * <li><b>Absent battery channels count as idle.</b> NULL battery energies
 * COALESCE to 0, so the counterfactual then equals the measured peak and the
 * avoided peak is 0 - a site whose battery dispatch the rollups cannot see
 * never gets a fabricated avoidance.</li>
 * <li><b>Rollup-derived, not the DSO meter.</b> The numbers trail live by up
 * to 15 min (rollup refresh) and describe OUR measurement of the site, which
 * is the honest best estimate of what the billing meter records.</li>
 * </ul>
 *
 * <p>Buckets without a measured {@code grid_import_kwh} are skipped entirely
 * (generation-only inverters have no grid channel - no peak is invented for
 * them; a module site with zero import buckets in a period simply has no row
 * for that period).
 *
 * <p>Every query runs through the RLS-scoped app datasource WITHOUT a tenant
 * predicate - RLS (migration V2) fences the tenant, exactly like
 * {@link EarningsRepository}.
 */
@Repository
public class PeakShavingRepository {

    /** Berlin billing periods (HistoryRange.ZONE). */
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /** Periods returned per site (incl. the running one) - the small history. */
    public static final int HISTORY_PERIODS = 12;

    private final JdbcTemplate jdbc;

    public PeakShavingRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * One billing period of one module site: the Berlin period start (first of
     * the month resp. year), the measured import peak and the counterfactual
     * no-battery peak (kW, 15-min mean). Only periods with at least one
     * measured import bucket exist - never a fabricated zero period.
     */
    public record PeriodPeak(LocalDate periodStart, BigDecimal peakKw, BigDecimal baselinePeakKw) {
    }

    /**
     * Per module-active site: its billing-period peaks over the last
     * {@value #HISTORY_PERIODS} periods (per the site's own
     * {@code abrechnung_leistung} - Berlin calendar months for {@code monat},
     * Berlin calendar years for {@code jahr}), ascending, including the
     * running period when it has data. Sites whose module is off (NULL
     * Leistungspreis) are absent; so are module sites without any measured
     * import bucket in the window.
     */
    public Map<UUID, List<PeriodPeak>> peaksByPeriod(LocalDate today) {
        Map<UUID, List<PeriodPeak>> result = new HashMap<>();
        LocalDate monthStart = today.withDayOfMonth(1);
        LocalDate yearStart = today.withDayOfYear(1);
        collect(result, "monat", "month",
                monthStart.minusMonths(HISTORY_PERIODS - 1));
        collect(result, "jahr", "year",
                yearStart.minusYears(HISTORY_PERIODS - 1));
        return result;
    }

    private void collect(Map<UUID, List<PeriodPeak>> result, String abrechnung,
            String truncUnit, LocalDate from) {
        Instant fromInstant = from.atStartOfDay(ZONE).toInstant();
        // truncUnit is a fixed literal per abrechnung mode, never client input.
        jdbc.query(
                "SELECT r.site_id,"
                        + " (date_trunc('" + truncUnit + "',"
                        + "   r.bucket AT TIME ZONE 'Europe/Berlin'))::date AS period_start,"
                        + " max(GREATEST(r.grid_import_kwh, 0)) * 4.0 AS peak_kw,"
                        + " max(GREATEST(r.grid_import_kwh - COALESCE(r.grid_export_kwh, 0)"
                        + "     + COALESCE(r.battery_discharge_kwh, 0)"
                        + "     - COALESCE(r.battery_charge_kwh, 0), 0)) * 4.0 AS baseline_peak_kw "
                        + "FROM telemetry_rollup_15m r "
                        + "JOIN site s ON s.id = r.site_id"
                        + "  AND s.leistungspreis_eur_kw IS NOT NULL"
                        + "  AND s.abrechnung_leistung = ? "
                        + "WHERE r.bucket >= ? AND r.grid_import_kwh IS NOT NULL "
                        + "GROUP BY r.site_id, period_start "
                        + "ORDER BY r.site_id, period_start",
                rs -> {
                    result.computeIfAbsent(rs.getObject("site_id", UUID.class),
                                    k -> new ArrayList<>())
                            .add(new PeriodPeak(
                                    rs.getObject("period_start", LocalDate.class),
                                    rs.getBigDecimal("peak_kw"),
                                    rs.getBigDecimal("baseline_peak_kw")));
                },
                abrechnung, Timestamp.from(fromInstant));
    }
}
