package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One 15-min slot of the persisted optimizer plan for a history day (the
 * plan-vs-actual overlay): for each slot the value of the LATEST run that
 * planned it, i.e. the final intention the optimizer published for that slot.
 * {@code batteryKw} is signed +charge/-discharge like the schedule contract.
 */
public record HistoryPlanPointDto(
        Instant time,
        BigDecimal batteryKw,
        BigDecimal socPct) {
}
