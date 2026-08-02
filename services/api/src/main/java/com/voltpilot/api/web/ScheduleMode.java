package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import java.time.Instant;
import java.time.LocalDate;

/**
 * Which reading of a site's Fahrplan the caller wants (Konzept
 * vp-fahrplan-kunde-konzept §8 "PR 5"):
 *
 * <ul>
 *   <li>{@link #LATEST} - THE plan: the newest optimizer run, i.e. what the
 *       device is executing right now. The DEFAULT, byte-identical to the
 *       endpoint before the Tages-Splice shipped; the Jetzt-Held and the
 *       Diagramm keep reading it.
 *   <li>{@link #DAY} - "wie der Tag geplant war": the ex-ante splice over the
 *       runs of the day, so the Film des Tages can show the already-elapsed
 *       morning phases ticked off (Captain-Entscheid D2). Semantics on
 *       {@code ScheduleRepository.dayAsPlanned}.
 * </ul>
 *
 * <p>The vocabulary is CLOSED on purpose: an unknown value is a 400, never a
 * silent fallback to the other reading (the two answer different questions, so
 * guessing would hand the caller a different day than it asked for).
 */
public enum ScheduleMode {
    LATEST,
    DAY;

    /** {@code null} for an unknown value - the caller turns that into a 400. */
    public static ScheduleMode parse(String raw) {
        if (raw == null) {
            return LATEST;
        }
        return switch (raw.trim().toLowerCase()) {
            case "", "latest" -> LATEST;
            case "day" -> DAY;
            default -> null;
        };
    }

    /**
     * The start of the day the splice covers: midnight in the platform's
     * Europe/Berlin calendar (the same zone every period boundary in this
     * product uses - {@link HistoryRange#ZONE}), so "der Tag" means the
     * customer's day, not a UTC one.
     */
    public static Instant dayStart(Instant now) {
        return LocalDate.ofInstant(now, HistoryRange.ZONE)
                .atStartOfDay(HistoryRange.ZONE)
                .toInstant();
    }
}
