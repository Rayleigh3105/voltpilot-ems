package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * P3 "Ist-Last sichtbar" (report vp-netzbezug-nacht-s3 §6) - the pure window
 * arithmetic + bucket-to-slot assignment behind the measured-load line. Runs
 * always (no Docker): the SQL aggregation itself is covered by the
 * Testcontainers PortalApiTest.
 */
class MeasuredLoadTest {

    private static final Instant SLOT0 = Instant.parse("2026-07-30T19:00:00Z");
    private static final Instant SLOT1 = Instant.parse("2026-07-30T19:15:00Z");
    private static final Instant SLOT2 = Instant.parse("2026-07-30T19:30:00Z");

    private static List<Instant> starts() {
        return List.of(SLOT0, SLOT1, SLOT2);
    }

    @Test
    void windowEndsAtNowSoTheRunningSlotIsIncludedButTheFutureIsNot() {
        // The captain's live constellation: 21:22 MESZ, the 21:15 slot running.
        Instant now = Instant.parse("2026-07-30T19:22:48Z");

        MeasuredLoad.Window window = MeasuredLoad.window(starts(), 15, now);

        assertThat(window).isNotNull();
        assertThat(window.from()).isEqualTo(SLOT0);
        assertThat(window.to()).isEqualTo(now);
    }

    @Test
    void windowIsClippedAtThePlanEndForAStalePlan() {
        Instant now = Instant.parse("2026-07-31T08:00:00Z");

        MeasuredLoad.Window window = MeasuredLoad.window(starts(), 15, now);

        assertThat(window.to()).isEqualTo(Instant.parse("2026-07-30T19:45:00Z"));
    }

    @Test
    void aPlanEntirelyInTheFutureOrAnEmptyPlanYieldsNoWindow() {
        assertThat(MeasuredLoad.window(starts(), 15, SLOT0)).isNull();
        assertThat(MeasuredLoad.window(starts(), 15, SLOT0.minusSeconds(3600))).isNull();
        assertThat(MeasuredLoad.window(List.of(), 15, Instant.now())).isNull();
        assertThat(MeasuredLoad.window(null, 15, Instant.now())).isNull();
    }

    @Test
    void assignFillsMeasuredSlotsAndLeavesTheRestNullNeverAZero() {
        List<ScheduleSlotDto> slots = List.of(slot(SLOT0), slot(SLOT1), slot(SLOT2));

        List<ScheduleSlotDto> filled = MeasuredLoad.assign(
                slots,
                Map.of(SLOT0, new BigDecimal("5.851"), SLOT1, new BigDecimal("7.117")));

        assertThat(filled).extracting(ScheduleSlotDto::measuredLoadKw)
                .containsExactly(new BigDecimal("5.851"), new BigDecimal("7.117"), null);
        // The forecast input is untouched - the point of the line is the GAP
        // between the two (4,33 planned vs 7,12 measured).
        assertThat(filled.get(1).loadKw()).isEqualByComparingTo("4.33");
    }

    @Test
    void assignIsAnIdentityWithoutMeasurements() {
        List<ScheduleSlotDto> slots = List.of(slot(SLOT0));

        assertThat(MeasuredLoad.assign(slots, Map.of())).isSameAs(slots);
        assertThat(MeasuredLoad.assign(List.of(), Map.of(SLOT0, BigDecimal.ONE))).isEmpty();
    }

    private static ScheduleSlotDto slot(Instant start) {
        return new ScheduleSlotDto(start, new BigDecimal("-4.332"), new BigDecimal("2.8"),
                new BigDecimal("77"), new BigDecimal("21.2"), null, null, null, null,
                new BigDecimal("4.33"), "eigenverbrauch", List.of(), null, null, null,
                null, null, null, null);
    }
}
