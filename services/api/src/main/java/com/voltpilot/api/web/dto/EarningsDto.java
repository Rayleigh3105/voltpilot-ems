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
     * Marktprämie) + {@code eigenverbrauchsWertEur} (self-consumed energy valued
     * per the site's tariff). {@code tarifArt}/{@code tarifParamCtKwh} echo the
     * configured tariff ({@code dynamisch}/{@code fest}/{@code ohne} + its
     * ct/kWh parameter) so the portal can render the provenance sentence;
     * {@code tarifPriced} says whether {@code savedEur}'s import side is
     * valued beyond bare spot (a tariff parameter, a maintained
     * {@code site_supply_price} Preisblatt, or the mirrored
     * default-components flag - Stufe 3 of the structured Bezugspreis), so
     * the "bewertet zu Ihrem Stromtarif" copy never over- or under-claims;
     * {@code exportVerguetungPriced} is its EXPORT-side sibling (B2 fix,
     * audit vp-geldzahlen-audit-x7): whether the feed-in terms are valued at
     * the plant's feste EEG-Einspeisevergütung instead of bare spot (false for
     * Direktvermarktung, whose spot + Marktprämie valuation the premium fields
     * already explain, and for plants without a determinable remuneration). The
     * Eigenverbrauchs-Wert is computed slot-by-slot in the repository:
     * {@code dynamisch} prices each self-consumed kWh at that slot's Börsenpreis
     * + the Aufschlag, {@code fest} at the fixed price. For an {@code ohne}
     * tariff {@code eigenverbrauchsWertEur} is null (self-consumption shown only
     * as {@code selbstverbrauchKwh}, never a fabricated euro) and
     * {@code gesamtertragEur} equals {@code einspeiseErloesEur} alone.
     * {@code eingespeistKwh}/{@code selbstverbrauchKwh}/{@code batterieBewegtKwh}
     * are the window's energy sums. All are null when nothing is computable
     * (same {@code reason}). {@code series} is the Ertrag chart (Gesamtertrag per
     * Europe/Berlin hour for the day range, per day for month, per month for
     * year/all); {@code monthlyStrip} is the last 12 months' Gesamtertrag (the
     * tappable month strip) - both list only buckets that had a computable slot.
     *
     * <p><b>Forward benchmark (captain 2026-07-09).</b>
     * {@code expectedMarketValueSolarCtKwh} is this site's expected Marktwert
     * Solar (ct/kWh): the day-ahead price weighted with the site's OWN PV
     * forecast over the coming horizon ({@code Σ(price × pv) / Σ(pv)}), the
     * forward companion to the realized {@code marketValueSolarCtKwh}. It is
     * independent of {@code range} (always the future).
     * {@code expectedMarketValueFrom}/{@code ...To} bound the covered forward
     * slots and {@code expectedMarketValueSlots} counts them, so the portal can
     * say "nächste N h". All four are null when there is no forward PV forecast
     * or no forward price coverage - the portal then hides the figure (never a
     * fabricated 0).
     *
     * <p><b>Peak shaving (PS-4).</b> {@code peakShaving} is the
     * Lastspitzenkappung proof block - present exactly when the site's
     * peak-shaving module is active ({@code site.leistungspreis_eur_kw}
     * non-NULL); null for every other site. Like the forward benchmark it is
     * RANGE-INDEPENDENT: it always describes the RUNNING Europe/Berlin billing
     * period (per {@code abrechnung}), never the selected earnings window. See
     * {@link PeakShavingDto}.
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
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            Boolean tarifPriced,
            Boolean exportVerguetungPriced,
            BigDecimal einspeiseErloesEur,
            BigDecimal eigenverbrauchsWertEur,
            BigDecimal gesamtertragEur,
            BigDecimal selbstverbrauchKwh,
            BigDecimal eingespeistKwh,
            BigDecimal batterieBewegtKwh,
            BigDecimal expectedMarketValueSolarCtKwh,
            Instant expectedMarketValueFrom,
            Instant expectedMarketValueTo,
            Long expectedMarketValueSlots,
            List<EarningsSeriesPointDto> series,
            List<EarningsMonthDto> monthlyStrip,
            PeakShavingDto peakShaving) {
    }

    /**
     * The Lastspitzenkappung proof of a peak-module site ("Vermiedene Spitze:
     * X kW × Y €/kW = Z €"): the RUNNING Europe/Berlin billing period's
     * measured grid-import peak vs. the counterfactual no-battery peak, both
     * the max 15-min mean import from {@code telemetry_rollup_15m} (the exact
     * math + its documented approximations: PeakShavingRepository).
     *
     * <p>{@code leistungspreisEurKw}/{@code abrechnung} echo the configured
     * contract (EUR per kW per billing period; {@code jahr} | {@code monat});
     * {@code periodStart} is the running period's first Berlin day.
     * {@code peakKw} (measured), {@code baselinePeakKw} (counterfactual),
     * {@code avoidedKw} and {@code avoidedEur} are null when the running
     * period has no measured import bucket yet - never fabricated.
     *
     * <p><b>Semantics of the euro number, explicitly.</b>
     * {@code avoidedKw = max(0, baselinePeakKw - peakKw)} - floored at 0, so a
     * battery-CAUSED higher peak (e.g. legacy grid charging into a new period
     * peak) reads as 0 avoided, never as a negative "saving".
     * {@code avoidedEur = avoidedKw × leistungspreisEurKw} with NO pro-rating:
     * the Leistungspreis bills the period's single highest 15-min mean, so an
     * avoided peak is worth the full period price PROVIDED the standing holds
     * to the period end - mid-period it is the current standing (the portal's
     * wording carries that caveat), for the closed {@code history} periods it
     * is final. The CURRENT contract price is applied to history periods too
     * (no historical contract tracking - the netzladen-flag discipline).
     *
     * <p>{@code history} lists the last 12 billing periods (ascending,
     * including the running one) that have at least one measured import
     * bucket - the data behind a later per-period chart.
     */
    public record PeakShavingDto(
            BigDecimal leistungspreisEurKw,
            String abrechnung,
            LocalDate periodStart,
            BigDecimal peakKw,
            BigDecimal baselinePeakKw,
            BigDecimal avoidedKw,
            BigDecimal avoidedEur,
            List<PeakPeriodDto> history) {
    }

    /** One closed-or-running billing period of the peak-shaving history. */
    public record PeakPeriodDto(
            LocalDate periodStart,
            BigDecimal peakKw,
            BigDecimal baselinePeakKw,
            BigDecimal avoidedKw,
            BigDecimal avoidedEur) {
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
