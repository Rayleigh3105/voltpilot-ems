package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.time.LocalDate;
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
    @DisplayName("date= nennt gestern, heute oder morgen - sonst nichts (E2 = A)")
    void dayIsYesterdayTodayOrTomorrow() {
        LocalDate heute = LocalDate.of(2026, 9, 25);
        assertThat(ScheduleMode.day("2026-09-24", heute)).isEqualTo(LocalDate.of(2026, 9, 24));
        assertThat(ScheduleMode.day("2026-09-25", heute)).isEqualTo(heute);
        assertThat(ScheduleMode.day(" 2026-09-26 ", heute)).isEqualTo(LocalDate.of(2026, 9, 26));
        // Ein offenes Datum liesse EINE Anfrage Monate an Laeufen lesen.
        assertThat(ScheduleMode.day("2026-09-23", heute)).isNull();
        assertThat(ScheduleMode.day("2026-09-27", heute)).isNull();
        assertThat(ScheduleMode.day("2026-03-01", heute)).isNull();
        // Kein Raten: nur das ISO-Datum.
        assertThat(ScheduleMode.day("gestern", heute)).isNull();
        assertThat(ScheduleMode.day("24.09.2026", heute)).isNull();
        assertThat(ScheduleMode.day("", heute)).isNull();
        assertThat(ScheduleMode.day(null, heute)).isNull();
        // Ueber den Jahreswechsel.
        assertThat(ScheduleMode.day("2026-12-31", LocalDate.of(2027, 1, 1)))
                .isEqualTo(LocalDate.of(2026, 12, 31));
    }

    @Test
    @DisplayName("ein Tag endet an der naechsten Mitternacht in Berlin - auch mit 23 Stunden")
    void dayBoundsFollowTheBerlinCalendar() {
        ZoneId berlin = ZoneId.of("Europe/Berlin");
        LocalDate umstellung = LocalDate.of(2026, 3, 29);
        Instant von = ScheduleMode.dayStart(umstellung);
        Instant bis = ScheduleMode.dayStart(umstellung.plusDays(1));
        assertThat(von).isEqualTo(ZonedDateTime.of(2026, 3, 29, 0, 0, 0, 0, berlin).toInstant());
        assertThat(java.time.Duration.between(von, bis).toHours()).isEqualTo(23);
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
