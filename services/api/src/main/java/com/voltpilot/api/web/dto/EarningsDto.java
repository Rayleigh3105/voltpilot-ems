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
     * <p>{@code anzulegenderWertCtKwh} echoes the site's configured
     * anzulegender Wert (null = none): when non-null on a Direktvermarktung
     * site, the money numbers INCLUDE the dynamic monthly Marktprämie
     * {@code max(0, anzulegender Wert - Monatsmarktwert Solar)} (suspended in
     * negative-price slots - see EarningsRepository), and the portal's fine
     * print names both numbers instead of the generic "zzgl. Marktprämie".
     *
     * <p>The benchmark KPI (Direktvermarktung sites):
     * {@code realizedExportCtKwh} is the export-weighted spot price the site's
     * metered feed-in actually fetched over the window;
     * {@code marketValueSolarCtKwh} is the Monatsmarktwert Solar weighted with
     * the same exports; {@code marketValueProvisional} is true while any
     * contributing month still carries the provisional (not yet TSO-published)
     * value. Null when the window has no exported energy or no market-value
     * coverage - never a fake zero.
     *
     * <p>{@code arbitrageEur}/{@code pvShiftEur} split saved for grid-charging
     * sites ({@code netzladen_erlaubt}, the "davon Arbitrage-Gewinn" line):
     * arbitrage = what the grid-charging permission concretely earned
     * (grid-charged energy's discharge revenue minus its purchase cost, via the
     * storage-mix attribution in EarningsRepository.arbitrageSplit), pvShift =
     * the remainder {@code saved - arbitrage} (solar time-shifting incl. any
     * Marktprämie delta) - so {@code arbitrageEur + pvShiftEur == savedEur}
     * exactly. Both are null when the site may not grid-charge OR the window
     * contains no grid-charged energy - never a fake zero.
     *
     * <p><b>Money-centric "Meine Anlage" fields (v2).</b> The Gesamtertrag of
     * the window = {@code einspeiseErloesEur} (metered feed-in valued at spot +
     * Marktprämie) + {@code eigenverbrauchsWertEur} (self-consumed kWh valued at
     * the customer's retail {@code strompreisCtKwh}). {@code strompreisCtKwh}
     * echoes the site's configured tariff (null = not set); when it is null
     * {@code eigenverbrauchsWertEur} is null too (self-consumption shown only as
     * {@code selbstverbrauchKwh}, never a fabricated euro) and
     * {@code gesamtertragEur} equals {@code einspeiseErloesEur} alone.
     * {@code eingespeistKwh}/{@code selbstverbrauchKwh}/{@code batterieBewegtKwh}
     * are the window's energy sums. All are null when nothing is computable
     * (same {@code reason}). {@code series} is the Ertrag chart (Gesamtertrag per
     * Europe/Berlin hour for the day range, per day for month, per month for
     * year/all); {@code monthlyStrip} is the last 12 months' Gesamtertrag (the
     * tappable month strip) - both list only buckets that had a computable slot.
     */
    public record EarningsSiteDto(
            UUID id,
            String name,
            String plantKind,
            BigDecimal anzulegenderWertCtKwh,
            BigDecimal realizedExportCtKwh,
            BigDecimal marketValueSolarCtKwh,
            Boolean marketValueProvisional,
            BigDecimal baselineEur,
            BigDecimal actualEur,
            BigDecimal savedEur,
            BigDecimal arbitrageEur,
            BigDecimal pvShiftEur,
            long coveredSlots,
            LocalDate firstCoveredDate,
            String reason,
            List<EarningsDailyDto> dailySaved,
            BigDecimal strompreisCtKwh,
            BigDecimal einspeiseErloesEur,
            BigDecimal eigenverbrauchsWertEur,
            BigDecimal gesamtertragEur,
            BigDecimal selbstverbrauchKwh,
            BigDecimal eingespeistKwh,
            BigDecimal batterieBewegtKwh,
            List<EarningsSeriesPointDto> series,
            List<EarningsMonthDto> monthlyStrip) {
    }

    /** One bucket of the Ertrag chart: its Berlin start + the Gesamtertrag. */
    public record EarningsSeriesPointDto(Instant start, BigDecimal gesamtertragEur) {
    }

    /** One month of the 12-month strip: the first day of the Berlin month + Gesamtertrag. */
    public record EarningsMonthDto(LocalDate month, BigDecimal gesamtertragEur) {
    }

    /**
     * Fleet totals over the computable sites. Null money values when NO site
     * has a computable slot (never a fake zero); {@code firstCoveredDate} is
     * the earliest covered Berlin day across the fleet - the honest start of a
     * "Gesamt" range ("seit ...").
     *
     * <p>{@code arbitrageEur} sums the sites' arbitrage attributions (null
     * when no site grid-charged in the window); {@code pvShiftEur} is then
     * {@code savedEur - arbitrageEur} over the WHOLE fleet - sites without a
     * split contribute their entire saved to the PV side (they cannot
     * grid-charge, so that is exact), keeping the fleet-level reconciliation
     * {@code arbitrageEur + pvShiftEur == savedEur}.
     */
    public record EarningsTotalsDto(
            BigDecimal baselineEur,
            BigDecimal actualEur,
            BigDecimal savedEur,
            BigDecimal arbitrageEur,
            BigDecimal pvShiftEur,
            long coveredSlots,
            LocalDate firstCoveredDate) {
    }

    /** One Europe/Berlin day of realized savings. */
    public record EarningsDailyDto(LocalDate day, BigDecimal savedEur) {
    }
}
