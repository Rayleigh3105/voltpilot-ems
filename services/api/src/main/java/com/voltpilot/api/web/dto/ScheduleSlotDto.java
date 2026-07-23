package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

/**
 * One planned 15-min slot of an optimizer run. {@code batteryKw} is signed
 * +charge/-discharge (the frozen schedule contract), {@code gridKw} is signed
 * +import/-export (the telemetry convention); costs are the projected slot cost
 * with the plan vs. with the battery idle (the no-battery baseline).
 *
 * <p>{@code curtailKw} is the planned PV curtailment for the slot (kW the
 * optimizer holds back, only ever &gt;= 0 - {@code schedule.curtail_kw},
 * migration V20260706040000): at negative prices the optimizer curtails feed-in
 * so the plant does not pay to export, and the portal surfaces the avoided loss
 * ("heute X kWh abgeregelt, Y € Verlust vermieden"). Null on runs that predate
 * the curtailment column or slots without curtailment data.
 *
 * <p>{@code pvKw} is the PV forecast input the slot planned with
 * ({@code schedule.pv_kw}). It feeds the portal's pv-aware "Laden aus dem
 * Netz" derivation: since FK3 (PV-bus semantics) an EEG site legitimately
 * charges solar while the house imports its load, so grid-charging is only
 * charge BEYOND the slot's available PV - not merely charging while
 * importing. Null on rows without a persisted PV input.
 *
 * <p><b>Fahrplan-Warum fields</b> (migration V20260723030000, design scout
 * vp-fahrplan-why-design §5.1) - the optimizer-persisted decision facts:
 * {@code slotRole} is the §6 vocabulary id (warten | pv_speichern |
 * guenstig_laden | eigenverbrauch | verkaufen | spitze_kappen |
 * reserve_halten | abregeln); {@code slotFlags} the binding-constraint codes
 * (soc_max, soc_floor, reserve_backup, reserve_peak, charge_cap,
 * discharge_cap, solar_only, grid_limit_14a, feed_in_cap, peak_defining,
 * curtailing - split from the persisted CSV); {@code storedValueCtKwh} the
 * EXACT value of a stored kWh at slot end (the run's SoC shadow price,
 * ct/kWh); {@code gridValueCtKwh} the effective per-kWh energy value at the
 * grid connection point; {@code peakPressureEurKw} the Leistungspreis
 * allocation on the slot (EUR/kW, null when the site runs no peak module).
 * All null on pre-feature rows or runs whose explain layer was off/failed -
 * the portal then renders exactly today's view (its {@code chargeKind}
 * fallback), never a fabricated explanation.
 */
public record ScheduleSlotDto(
        Instant start,
        BigDecimal batteryKw,
        BigDecimal gridKw,
        BigDecimal socPct,
        BigDecimal priceEurMwh,
        BigDecimal costEur,
        BigDecimal baselineCostEur,
        BigDecimal curtailKw,
        BigDecimal pvKw,
        String slotRole,
        List<String> slotFlags,
        BigDecimal storedValueCtKwh,
        BigDecimal gridValueCtKwh,
        BigDecimal peakPressureEurKw) {
}
