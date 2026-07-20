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
 *
 * <p>{@code bankedValueEur} makes the headline honest on "bank days" (FK2,
 * audit vp-solver-xlsx-f2 §4.3): when the plan stores energy into the next day,
 * {@code savingsEur} alone reads negative although real value was banked. It is
 * the run's persisted terminal value times the SoC swing over the horizon
 * ({@code schedule.terminal_value_eur_per_kwh x (socEndPct - socStartPct) / 100
 * x capacity}); positive = energy stored for tomorrow, negative = the plan
 * draws down previously stored energy. {@code socStartPct}/{@code socEndPct}
 * are the plan-start/-end SoC it was computed from. All null when honestly not
 * computable (pre-FK2 runs without a persisted terminal value, no battery
 * asset) - never a fabricated number.
 *
 * <p>{@code peakTargetKw} is the run's planned billing-period grid-import peak
 * target (PS-1, {@code schedule.peak_target_kw}): the "Ziel" a Lastspitzen
 * (peak-shaving) Anlage defends. Null when the site runs no peak-shaving module
 * (no Leistungspreis configured) or on a run that predates the column - the
 * portal's Peak-Band then shows no target line, never a fabricated 0.
 */
public record SchedulePlanDto(
        UUID planId,
        UUID deviceId,
        Instant generatedAt,
        int slotMinutes,
        BigDecimal savingsEur,
        BigDecimal bankedValueEur,
        BigDecimal socStartPct,
        BigDecimal socEndPct,
        BigDecimal peakTargetKw,
        List<ScheduleSlotDto> slots) {

    public static SchedulePlanDto empty() {
        return new SchedulePlanDto(null, null, null, 15, null, null, null, null, null, List.of());
    }
}
