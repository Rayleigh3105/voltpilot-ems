package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The current optimizer plan for a site (latest run from the {@code schedule}
 * hypertable). {@code savingsEur} is the headline: projected savings over the
 * horizon vs. leaving the battery idle. Empty {@code slots} (and null metadata)
 * means no plan has been produced yet.
 */
public record SchedulePlanDto(
        UUID planId,
        UUID deviceId,
        Instant generatedAt,
        int slotMinutes,
        BigDecimal savingsEur,
        List<ScheduleSlotDto> slots) {

    public static SchedulePlanDto empty() {
        return new SchedulePlanDto(null, null, null, 15, null, List.of());
    }
}
