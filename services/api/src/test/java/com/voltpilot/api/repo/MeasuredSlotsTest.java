package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.MeasuredSlots.Measured;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * "Ist-Werte sichtbar" (P3 Ist-Last, report vp-netzbezug-nacht-s3 §6, plus its
 * Ist-PV mirror) - the pure window arithmetic + bucket-to-slot assignment behind
 * the two measured lines. Runs always (no Docker): the SQL aggregation itself is
 * covered by the Testcontainers PortalApiTest.
 */
class MeasuredSlotsTest {

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

        MeasuredSlots.Window window = MeasuredSlots.window(starts(), 15, now);

        assertThat(window).isNotNull();
        assertThat(window.from()).isEqualTo(SLOT0);
        assertThat(window.to()).isEqualTo(now);
    }

    @Test
    void windowIsClippedAtThePlanEndForAStalePlan() {
        Instant now = Instant.parse("2026-07-31T08:00:00Z");

        MeasuredSlots.Window window = MeasuredSlots.window(starts(), 15, now);

        assertThat(window.to()).isEqualTo(Instant.parse("2026-07-30T19:45:00Z"));
    }

    @Test
    void aPlanEntirelyInTheFutureOrAnEmptyPlanYieldsNoWindow() {
        assertThat(MeasuredSlots.window(starts(), 15, SLOT0)).isNull();
        assertThat(MeasuredSlots.window(starts(), 15, SLOT0.minusSeconds(3600))).isNull();
        assertThat(MeasuredSlots.window(List.of(), 15, Instant.now())).isNull();
        assertThat(MeasuredSlots.window(null, 15, Instant.now())).isNull();
    }

    @Test
    void assignFillsBothMeasuredChannelsAndLeavesTheRestNullNeverAZero() {
        List<ScheduleSlotDto> slots = List.of(slot(SLOT0), slot(SLOT1), slot(SLOT2));

        List<ScheduleSlotDto> filled = MeasuredSlots.assign(
                slots,
                Map.of(
                        SLOT0, new Measured(new BigDecimal("5.851"), new BigDecimal("15.300")),
                        SLOT1, new Measured(new BigDecimal("7.117"), new BigDecimal("11.020"))));

        assertThat(filled).extracting(ScheduleSlotDto::measuredLoadKw)
                .containsExactly(new BigDecimal("5.851"), new BigDecimal("7.117"), null);
        assertThat(filled).extracting(ScheduleSlotDto::measuredPvKw)
                .containsExactly(new BigDecimal("15.300"), new BigDecimal("11.020"), null);
        // The forecast inputs are untouched - the point of the lines is the GAP
        // between plan and measurement (4,33 planned load vs 7,12 measured;
        // 12,0 planned PV vs 15,3 measured).
        assertThat(filled.get(1).loadKw()).isEqualByComparingTo("4.33");
        assertThat(filled.get(1).pvKw()).isEqualByComparingTo("12.0");
    }

    @Test
    void oneChannelWithoutTheOtherFillsOnlyThatChannel() {
        // A generation-less site reports load but no pv_power_kw (and the other
        // way round for a device without a load channel) - neither may
        // fabricate a 0 for the missing side.
        List<ScheduleSlotDto> filled = MeasuredSlots.assign(
                List.of(slot(SLOT0), slot(SLOT1)),
                Map.of(
                        SLOT0, new Measured(new BigDecimal("5.851"), null),
                        SLOT1, new Measured(null, new BigDecimal("15.300"))));

        assertThat(filled.get(0).measuredLoadKw()).isEqualByComparingTo("5.851");
        assertThat(filled.get(0).measuredPvKw()).isNull();
        assertThat(filled.get(1).measuredLoadKw()).isNull();
        assertThat(filled.get(1).measuredPvKw()).isEqualByComparingTo("15.300");
    }

    @Test
    void assignIsAnIdentityWithoutMeasurements() {
        List<ScheduleSlotDto> slots = List.of(slot(SLOT0));

        assertThat(MeasuredSlots.assign(slots, Map.of())).isSameAs(slots);
        assertThat(MeasuredSlots.assign(
                List.of(), Map.of(SLOT0, new Measured(BigDecimal.ONE, null)))).isEmpty();
        // An all-null bucket is the same as no bucket at all.
        assertThat(MeasuredSlots.assign(slots, Map.of(SLOT0, new Measured(null, null))).get(0))
                .isEqualTo(slots.get(0));
    }

    private static ScheduleSlotDto slot(Instant start) {
        return new ScheduleSlotDto(start, new BigDecimal("-4.332"), new BigDecimal("2.8"),
                new BigDecimal("77"), new BigDecimal("21.2"), null, null, null,
                new BigDecimal("12.0"), new BigDecimal("4.33"), "eigenverbrauch", List.of(),
                null, null, null, null, null, null, null, null);
    }
}
