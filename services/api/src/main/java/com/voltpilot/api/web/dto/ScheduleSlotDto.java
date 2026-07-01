package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One planned 15-min slot of an optimizer run. {@code batteryKw} is signed
 * +charge/-discharge (the frozen schedule contract), {@code gridKw} is signed
 * +import/-export (the telemetry convention); costs are the projected slot cost
 * with the plan vs. with the battery idle (the no-battery baseline).
 */
public record ScheduleSlotDto(
        Instant start,
        BigDecimal batteryKw,
        BigDecimal gridKw,
        BigDecimal socPct,
        BigDecimal priceEurMwh,
        BigDecimal costEur,
        BigDecimal baselineCostEur) {
}
