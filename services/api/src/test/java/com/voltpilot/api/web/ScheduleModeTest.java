package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The two readings of the Fahrplan endpoint - pure, so it runs without Docker
 * (the splice SQL itself is proven against a real TimescaleDB in
 * {@code PortalApiTest.scheduleDayModeSplicesTheDayFromTheRunsInForce}).
 */
class ScheduleModeTest {

    @Test
    @DisplayName("kein Parameter = die bisherige Lesart, damit nichts still umschaltet")
    void defaultsToLatest() {
        assertThat(ScheduleMode.parse(null)).isEqualTo(ScheduleMode.LATEST);
        assertThat(ScheduleMode.parse("")).isEqualTo(ScheduleMode.LATEST);
        assertThat(ScheduleMode.parse("latest")).isEqualTo(ScheduleMode.LATEST);
        assertThat(ScheduleMode.parse(" LATEST ")).isEqualTo(ScheduleMode.LATEST);
    }

    @Test
    @DisplayName("day waehlt den Tages-Splice")
    void parsesDay() {
        assertThat(ScheduleMode.parse("day")).isEqualTo(ScheduleMode.DAY);
        assertThat(ScheduleMode.parse("Day")).isEqualTo(ScheduleMode.DAY);
    }

    @Test
    @DisplayName("ein unbekannter Wert faellt NIE still auf eine Lesart zurueck")
    void unknownIsRejected() {
        // The two modes answer different questions - guessing would hand the
        // caller a different day than it asked for, so the endpoint 400s.
        assertThat(ScheduleMode.parse("tag")).isNull();
        assertThat(ScheduleMode.parse("splice")).isNull();
        assertThat(ScheduleMode.parse("heute")).isNull();
    }

    @Test
    @DisplayName("der Tag beginnt um Mitternacht in Europe/Berlin, nicht in UTC")
    void dayStartIsBerlinMidnight() {
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        // Summer time (UTC+2): 00:30 Berlin on 2 Aug is 22:30 UTC on 1 Aug -
        // a UTC day start would cut the film's first 2 hours off.
        Instant justAfterMidnight = ZonedDateTime.of(2026, 8, 2, 0, 30, 0, 0, berlin).toInstant();
        assertThat(ScheduleMode.dayStart(justAfterMidnight))
                .isEqualTo(ZonedDateTime.of(2026, 8, 2, 0, 0, 0, 0, berlin).toInstant());

        // Winter time (UTC+1).
        Instant winterEvening = ZonedDateTime.of(2026, 1, 15, 22, 10, 0, 0, berlin).toInstant();
        assertThat(ScheduleMode.dayStart(winterEvening))
                .isEqualTo(ZonedDateTime.of(2026, 1, 15, 0, 0, 0, 0, berlin).toInstant());
    }

    @Test
    @DisplayName("der Tag der Zeitumstellung faengt trotzdem um Mitternacht an")
    void dayStartSurvivesTheDstSwitch() {
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        // 29 March 2026: the 02:00-03:00 hour does not exist.
        Instant duringDstDay = ZonedDateTime.of(2026, 3, 29, 14, 0, 0, 0, berlin).toInstant();
        assertThat(ScheduleMode.dayStart(duringDstDay))
                .isEqualTo(ZonedDateTime.of(2026, 3, 29, 0, 0, 0, 0, berlin).toInstant());
    }
}
