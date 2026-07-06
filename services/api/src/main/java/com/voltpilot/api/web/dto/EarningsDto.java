package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Realized earnings behind {@code GET /api/v1/earnings} (see
 * docs/contracts/openapi.yaml): the measured "mit VoltPilot vs. ungeregelte
 * Anlage" money numbers the portal hero shows - computed per 15-min slot from
 * the metering-grade {@code telemetry_rollup_15m} energies valued at the slot's
 * day-ahead price, never from the optimizer's plan.
 *
 * <p>Semantics per slot (the report's section-3.2 math): baseline =
 * {@code (load_kwh - pv_kwh) * price/1000} - the UNREGULATED plant: same
 * generation, same consumption, PV fed in immediately, battery idle; actual =
 * {@code (grid_import_kwh - grid_export_kwh) * price/1000} - what really
 * happened at the meter; saved = baseline - actual. Both are signed COSTS
 * (negative = revenue). Because import and export are priced symmetrically at
 * spot, saved algebraically equals the battery's dispatch valued at spot
 * ({@code (discharge - charge) * price/1000}), so round-trip losses debit
 * VoltPilot automatically - the number is self-honest.
 */
public record EarningsDto(
        String range,
        Instant from,
        Instant to,
        List<EarningsSiteDto> sites,
        EarningsTotalsDto totals) {

    /**
     * One site's realized earnings over the window. All money values are null
     * when the site has no computable slot in the window - then {@code reason}
     * says why, machine-readable: {@code no_data} (no rollup buckets at all,
     * e.g. a fresh site), {@code missing_channels} (buckets exist but the
     * load/PV or grid channels are absent - e.g. a generation-only string/micro
     * inverter, which typically has no battery either), {@code no_prices}
     * (measured slots exist but no day-ahead price covers them). Partial
     * coverage is NOT an error: {@code coveredSlots} counts the slots that
     * entered the sums and {@code firstCoveredDate} is the Berlin day of the
     * first one.
     *
     * <p>{@code dailySaved} carries the site's realized savings per
     * Europe/Berlin day over the last 14 days (independent of {@code range}) -
     * the hero's spark bars and the site card's "Heute +X €" teaser, without a
     * second request. Days without a computable slot are absent, never zero.
     *
     * <p>{@code marktpraemieCtKwh} echoes the site's configured Marktprämie
     * (null = none): when non-null on a Direktvermarktung site, the money
     * numbers INCLUDE the premium (suspended in negative-price slots - see
     * EarningsRepository), and the portal's fine print says so instead of the
     * generic "zzgl. Marktprämie".
     */
    public record EarningsSiteDto(
            UUID id,
            String name,
            String plantKind,
            BigDecimal marktpraemieCtKwh,
            BigDecimal baselineEur,
            BigDecimal actualEur,
            BigDecimal savedEur,
            long coveredSlots,
            LocalDate firstCoveredDate,
            String reason,
            List<EarningsDailyDto> dailySaved) {
    }

    /**
     * Fleet totals over the computable sites. Null money values when NO site
     * has a computable slot (never a fake zero); {@code firstCoveredDate} is
     * the earliest covered Berlin day across the fleet - the honest start of a
     * "Gesamt" range ("seit ...").
     */
    public record EarningsTotalsDto(
            BigDecimal baselineEur,
            BigDecimal actualEur,
            BigDecimal savedEur,
            long coveredSlots,
            LocalDate firstCoveredDate) {
    }

    /** One Europe/Berlin day of realized savings. */
    public record EarningsDailyDto(LocalDate day, BigDecimal savedEur) {
    }
}
