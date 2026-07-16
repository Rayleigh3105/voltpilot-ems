package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

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
        BigDecimal pvKw) {
}
