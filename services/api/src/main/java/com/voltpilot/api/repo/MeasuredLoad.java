package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The pure half of "Ist-Last sichtbar" (P3, report vp-netzbezug-nacht-s3 §6):
 * which window of MEASURED telemetry belongs to a plan, and how its 15-min means
 * map back onto the plan's slots.
 *
 * <p>Kept separate from {@link ScheduleRepository} so the window arithmetic and
 * the bucket-to-slot assignment are unit-testable WITHOUT a database - the SQL
 * itself is only the {@code avg(load_kw)} per {@code time_bucket('15 minutes')}
 * aggregation, the same quarter-hour MEAN semantics the forecaster plans with
 * since P2 ({@code voltpilot_forecast.domain.slot_means}) and the same one
 * {@code HistoryRepository.dayBuckets} uses.
 *
 * <p>Two rules the callers depend on:
 * <ul>
 *   <li>The window ENDS at {@code now} (never at the plan's end), so future
 *       slots can never receive a value and the RUNNING slot carries the mean of
 *       the samples measured so far - which is exactly where the forecast error
 *       that caused the Pilsting grid draw becomes visible.</li>
 *   <li>A slot without telemetry stays {@code null}. Never a fabricated 0 - an
 *       absent measurement must not read as "the house consumed nothing".</li>
 * </ul>
 */
public final class MeasuredLoad {

    private MeasuredLoad() {
    }

    /** Half-open telemetry window {@code [from, to)} to aggregate. */
    public record Window(Instant from, Instant to) {
    }

    /**
     * The measured window of a plan: from its first slot up to {@code now},
     * clipped at the plan's own end. Returns {@code null} when nothing of the
     * plan lies in the past yet (a plan generated entirely for the future, or an
     * empty plan) - the caller then skips the query altogether.
     */
    public static Window window(List<Instant> slotStarts, int slotMinutes, Instant now) {
        if (slotStarts == null || slotStarts.isEmpty() || slotMinutes <= 0) {
            return null;
        }
        Instant from = slotStarts.get(0);
        Instant planEnd = slotStarts.get(slotStarts.size() - 1)
                .plusSeconds((long) slotMinutes * 60);
        Instant to = now.isBefore(planEnd) ? now : planEnd;
        return to.isAfter(from) ? new Window(from, to) : null;
    }

    /**
     * Fill each slot's measured load from the aggregated buckets, keyed by the
     * bucket START (which equals the slot start - both are aligned to the same
     * 15-min grid). A slot with no bucket keeps {@code null}.
     */
    public static List<ScheduleSlotDto> assign(
            List<ScheduleSlotDto> slots, Map<Instant, BigDecimal> byBucket) {
        if (slots.isEmpty() || byBucket.isEmpty()) {
            return slots;
        }
        List<ScheduleSlotDto> filled = new ArrayList<>(slots.size());
        for (ScheduleSlotDto slot : slots) {
            BigDecimal measured = byBucket.get(slot.start());
            filled.add(measured == null ? slot : slot.withMeasuredLoadKw(measured));
        }
        return filled;
    }
}
