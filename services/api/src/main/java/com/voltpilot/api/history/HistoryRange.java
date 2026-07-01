package com.voltpilot.api.history;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;

/**
 * The four history periods and their calendar windows. Boundaries are
 * Europe/Berlin local time - the platform's product timezone (DACH B2C);
 * a per-tenant timezone is future work. Weeks are ISO weeks (Monday start).
 */
public enum HistoryRange {
    DAY(15),
    WEEK(60),
    MONTH(24 * 60),
    YEAR(24 * 60);

    /** The platform timezone all period boundaries are anchored to. */
    public static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    private final int bucketMinutes;

    HistoryRange(int bucketMinutes) {
        this.bucketMinutes = bucketMinutes;
    }

    public int bucketMinutes() {
        return bucketMinutes;
    }

    /** Whether the series comes from the daily rollup (Berlin-day buckets). */
    public boolean dailyBuckets() {
        return this == MONTH || this == YEAR;
    }

    /** The period window containing {@code at}: [from, to) in instants. */
    public Window window(LocalDate at) {
        LocalDate start = switch (this) {
            case DAY -> at;
            case WEEK -> at.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
            case MONTH -> at.withDayOfMonth(1);
            case YEAR -> at.withDayOfYear(1);
        };
        LocalDate end = switch (this) {
            case DAY -> start.plusDays(1);
            case WEEK -> start.plusWeeks(1);
            case MONTH -> start.plusMonths(1);
            case YEAR -> start.plusYears(1);
        };
        return new Window(start.atStartOfDay(ZONE).toInstant(), end.atStartOfDay(ZONE).toInstant());
    }

    /** Case-insensitive parse of the query param, or null for an unknown value. */
    public static HistoryRange parse(String raw) {
        if (raw == null) {
            return null;
        }
        try {
            return valueOf(raw.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** A half-open period window: {@code from} inclusive, {@code to} exclusive. */
    public record Window(Instant from, Instant to) {
    }
}
