package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;

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
 *
 * <p>{@link #DAY} optionally names its day ({@code date=YYYY-MM-DD}, see
 * {@link #day}) - the Tagesschalter "Gestern · Heute · Morgen" of the Fahrplan
 * page (Konzept "Tagesuhr und Bildfahrplan", E2 = A).
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
        return dayStart(LocalDate.ofInstant(now, HistoryRange.ZONE));
    }

    /** Midnight of {@code day} in Europe/Berlin (a DST day is 23 or 25 h long). */
    public static Instant dayStart(LocalDate day) {
        return day.atStartOfDay(HistoryRange.ZONE).toInstant();
    }

    /**
     * The day a {@code mode=day} caller asks for: an ISO date
     * ({@code YYYY-MM-DD}, the Europe/Berlin calendar) at most ONE day away
     * from {@code today} - yesterday, today or tomorrow (E2 = A). {@code null}
     * for anything else; the caller turns that into a 400.
     *
     * <p>The window is closed on purpose, not only as a product rule: the
     * splice reads every run that planned the day, so an open date would let
     * one request scan months of runs (the plans are kept 180 days).
     */
    public static LocalDate day(String raw, LocalDate today) {
        if (raw == null) {
            return null;
        }
        LocalDate day;
        try {
            day = LocalDate.parse(raw.trim());
        } catch (DateTimeParseException e) {
            return null;
        }
        return Math.abs(ChronoUnit.DAYS.between(today, day)) <= 1 ? day : null;
    }
}
