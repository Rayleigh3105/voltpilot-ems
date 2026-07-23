package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The admin "why" view of one persisted optimizer run (design
 * vp-admin-optimizer-ui-design §4.2): every slot of the plan PLUS the per-slot
 * €-decomposition the solver actually optimized against since the P1-P5
 * redesign - real tariff import price, real feed-in/Marktprämie export value,
 * the persisted P2 wear spend, and an explicitly-approximate stored-energy
 * value.
 *
 * <p>Null discipline: a field that genuinely cannot be computed for a slot
 * (no persisted spot price, pre-P2 rows without wear, battery-less site) is
 * null so the UI can label it honestly - never a fabricated 0.
 *
 * <p>Run-level context carries the "inputs at a glance" master data (§2.3):
 * plant kind / grid-charging mode / tariff / remuneration / reserve and the
 * battery's EFFECTIVE wear + SoC band ({@code wearCostSource} says whether the
 * per-asset override or the platform default applied). The active forecast
 * models mirror the api config (the optimizer reads the same env); which
 * model/fallback fired for THIS run is not persisted - the UI reads model
 * lifecycle from {@code GET /sites/{id}/forecast-quality}. The §14a limit the
 * run used is likewise not persisted (an honest gap, not a null-able field
 * here). {@code storedEnergyValueIsApproximation}: since Fahrplan-Warum the
 * optimizer persists the EXACT stored-energy value (the run's SoC shadow
 * price, {@code schedule.stored_value_ct_kwh}); the flag is false when every
 * rendered slot carries it, and true when any slot fell back to the forward
 * best-use heuristic (pre-feature runs, explain layer off).
 *
 * <p>Run navigation is DAY-scoped (Europe/Berlin, the platform timezone):
 * {@code availableRuns} lists ONE day's runs ({@code availableRunsDate} - the
 * requested {@code date} or the shown run's day), and
 * {@code firstRunDate}/{@code lastRunDate} carry the site's covered run-day
 * range so the UI can bound its date picker (all three null for a site
 * without any plan). The hypertable keeps every run - the former unscoped
 * newest-30 list only ever reached ~7.5 hours back at the 15-min MPC cadence.
 */
public record OptimizerDiagnosticsDto(
        UUID siteId,
        UUID planId,
        Instant generatedAt,
        int slotMinutes,
        List<Instant> availableRuns,
        LocalDate availableRunsDate,
        LocalDate firstRunDate,
        LocalDate lastRunDate,
        String plantKind,
        boolean netzladenErlaubt,
        String tarifArt,
        BigDecimal tarifParamCtKwh,
        BigDecimal anzulegenderWertCtKwh,
        BigDecimal backupReserveSocPct,
        BatteryContext battery,
        String activeLoadModel,
        String activePvModel,
        boolean storedEnergyValueIsApproximation,
        List<OptimizerDiagnosticsSlotDto> slots) {

    /**
     * The battery parameters the decomposition priced with. Null when the site
     * has no battery asset. {@code wearCostCtPerKwh} is the EFFECTIVE per-cycle
     * rate; {@code wearCostSource} = {@code asset} (override) or
     * {@code platform-default}. {@code socMinPct}/{@code socMaxPct} are the
     * effective usable band (override or the platform 5/95).
     */
    public record BatteryContext(
            BigDecimal capacityKwh,
            BigDecimal roundtripEfficiencyPct,
            double wearCostCtPerKwh,
            String wearCostSource,
            double socMinPct,
            double socMaxPct) {
    }
}
