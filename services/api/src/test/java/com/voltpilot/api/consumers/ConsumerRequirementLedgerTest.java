package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.EnergyConfirmation;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Evidence;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Requirement;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Row;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.State;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The pure fulfilment-ledger rules (§9.4), Docker-free. Proves the D3
 * confirmation hierarchy, the DST-correct period boundaries in site time, the
 * "Frist gefährdet" derived warn (§17), the effective-state finalisation and the
 * idempotent per-period instance id.
 */
class ConsumerRequirementLedgerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final UUID ENTITY = UUID.fromString("00000000-0000-0000-0000-0000000000aa");

    private static Requirement dailyRuntime(String id, int minutes) {
        return new Requirement(id, "flexible_task", "required_by_deadline",
                java.util.Set.of(java.time.DayOfWeek.values()), java.time.LocalTime.MIDNIGHT,
                java.time.LocalTime.MIDNIGHT, true, minutes * 60, null);
    }

    private static Requirement fixedWindow(String id, int fromH, int toH) {
        return new Requirement(id, "fixed_window", "must_run",
                java.util.Set.of(java.time.DayOfWeek.values()),
                java.time.LocalTime.of(fromH, 0), java.time.LocalTime.of(toH, 0), false,
                (toH - fromH) * 3600, null);
    }

    private static Evidence ev(int runtime, String state, String reason, Boolean confirmed,
            EnergyConfirmation level, BigDecimal measured, BigDecimal rated) {
        return new Evidence(runtime, state, reason, confirmed, level, measured, rated);
    }

    @Test
    void relayReadbackConfirmsRuntimeButLabelsEnergyAssumed() {
        // A daily 60-min task, 90 min of confirmed relay runtime, only a relay
        // channel: fulfilled by runtime, energy = Nennleistung × Zeit = assumed.
        Instant now = Instant.parse("2026-08-10T20:00:00Z");
        List<Row> rows = ConsumerRequirementLedger.evaluate(ENTITY, List.of(dailyRuntime("t", 60)),
                ev(5400, "running_optimized", null, Boolean.TRUE, EnergyConfirmation.ASSUMED, null,
                        new BigDecimal("2.2")),
                now, BERLIN);
        assertThat(rows).hasSize(1);
        Row r = rows.get(0);
        assertThat(r.state()).isEqualTo(State.FULFILLED);
        assertThat(r.energyConfirmation()).isEqualTo(EnergyConfirmation.ASSUMED);
        // 5400 s × 2.2 kW / 3600 = 3.3 kWh
        assertThat(r.actualEnergyKwh()).isEqualByComparingTo("3.300");
    }

    @Test
    void noReadbackNeverReadsFulfilled() {
        // Runtime meets the goal but there is NO confirmation channel (NONE):
        // commanded runtime alone is never "erfüllt" (§9.4 stage 4).
        Instant now = Instant.parse("2026-08-10T20:00:00Z");
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(dailyRuntime("t", 60)),
                        ev(9000, "running_optimized", null, null, EnergyConfirmation.NONE, null,
                                new BigDecimal("2.2")),
                        now, BERLIN)
                .get(0);
        assertThat(r.state()).isNotEqualTo(State.FULFILLED);
        assertThat(r.energyConfirmation()).isNull();
        assertThat(r.actualEnergyKwh()).isNull();
    }

    @Test
    void aDisagreeingReadbackIsNotTrusted() {
        Instant now = Instant.parse("2026-08-10T20:00:00Z");
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(dailyRuntime("t", 60)),
                        ev(9000, "running_optimized", null, Boolean.FALSE,
                                EnergyConfirmation.ASSUMED, null, new BigDecimal("2.2")),
                        now, BERLIN)
                .get(0);
        assertThat(r.state()).isNotEqualTo(State.FULFILLED);
    }

    @Test
    void measuredEnergyGoalIsConfirmedFromTelemetry() {
        // A kWh goal + a measured energy channel value: measured, fulfilled.
        Instant now = Instant.parse("2026-08-10T20:00:00Z");
        Requirement r = new Requirement("charge", "flexible_task", "required_by_deadline",
                java.util.Set.of(java.time.DayOfWeek.values()), java.time.LocalTime.MIDNIGHT,
                java.time.LocalTime.MIDNIGHT, true, null, new BigDecimal("8.0"));
        Row row = ConsumerRequirementLedger.evaluate(ENTITY, List.of(r),
                        ev(0, "running_optimized", null, Boolean.TRUE, EnergyConfirmation.MEASURED,
                                new BigDecimal("8.4"), new BigDecimal("11.0")),
                        now, BERLIN)
                .get(0);
        assertThat(row.state()).isEqualTo(State.FULFILLED);
        assertThat(row.energyConfirmation()).isEqualTo(EnergyConfirmation.MEASURED);
        assertThat(row.actualEnergyKwh()).isEqualByComparingTo("8.4");
    }

    @Test
    void aFixedWindowIsMissedAfterItsDeadlineWithoutEnoughRuntime() {
        // Berlin 13:00-14:00 must_run, "now" is 14:30 Berlin (= 12:30 UTC in
        // summer), only 10 min of runtime -> missed.
        Instant now = Instant.parse("2026-08-10T12:30:00Z");
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(fixedWindow("heat", 13, 14)),
                        ev(600, "ready", null, Boolean.TRUE, EnergyConfirmation.ASSUMED, null,
                                new BigDecimal("3.0")),
                        now, BERLIN)
                .get(0);
        assertThat(r.state()).isEqualTo(State.MISSED);
    }

    @Test
    void aClampedMustRunReadsBlocked() {
        // In-window (13:30 Berlin = 11:30 UTC summer), clamped by a grid guard.
        Instant now = Instant.parse("2026-08-10T11:30:00Z");
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(fixedWindow("heat", 13, 14)),
                        ev(0, "clamped", "guard_grid_limit", Boolean.TRUE,
                                EnergyConfirmation.ASSUMED, null, new BigDecimal("3.0")),
                        now, BERLIN)
                .get(0);
        assertThat(r.state()).isEqualTo(State.BLOCKED);
        assertThat(r.reasonCode()).isEqualTo("guard_grid_limit");
    }

    @Test
    void fristGefaehrdetWhenTimeRunsShort() {
        // 60-min daily task, deadline is next Berlin midnight, "now" is 23:30
        // Berlin (21:30 UTC summer) with 0 runtime -> only 30 min left < 60.
        Instant now = Instant.parse("2026-08-10T21:30:00Z");
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(dailyRuntime("t", 60)),
                        ev(0, "waiting", null, Boolean.TRUE, EnergyConfirmation.ASSUMED, null,
                                new BigDecimal("2.2")),
                        now, BERLIN)
                .get(0);
        State effective = ConsumerRequirementLedger.effectiveState(r.state(), r.deadline(), now);
        assertThat(ConsumerRequirementLedger.atRisk(effective, r.deadline(),
                r.requiredRuntimeSeconds(), r.actualRuntimeSeconds(), now)).isTrue();
    }

    @Test
    void notAtRiskWhenPlentyOfTimeRemains() {
        Instant now = Instant.parse("2026-08-10T08:00:00Z"); // 10:00 Berlin summer
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(dailyRuntime("t", 60)),
                        ev(0, "waiting", null, Boolean.TRUE, EnergyConfirmation.ASSUMED, null,
                                new BigDecimal("2.2")),
                        now, BERLIN)
                .get(0);
        assertThat(ConsumerRequirementLedger.atRisk(r.state(), r.deadline(),
                r.requiredRuntimeSeconds(), r.actualRuntimeSeconds(), now)).isFalse();
    }

    @Test
    void effectiveStateFinalisesAMissedPeriodEvenIfStoredPending() {
        Instant deadline = Instant.parse("2026-08-10T22:00:00Z");
        Instant after = Instant.parse("2026-08-10T23:00:00Z");
        assertThat(ConsumerRequirementLedger.effectiveState(State.PENDING, deadline, after))
                .isEqualTo(State.MISSED);
        // A stored FULFILLED stays fulfilled past the deadline.
        assertThat(ConsumerRequirementLedger.effectiveState(State.FULFILLED, deadline, after))
                .isEqualTo(State.FULFILLED);
        // Before the deadline the stored state stands.
        Instant before = Instant.parse("2026-08-10T21:00:00Z");
        assertThat(ConsumerRequirementLedger.effectiveState(State.PENDING, deadline, before))
                .isEqualTo(State.PENDING);
    }

    @Test
    void instanceIdIsStablePerPeriodAndDiffersAcrossDays() {
        Instant day1Start = Instant.parse("2026-08-10T00:00:00Z");
        Instant day2Start = Instant.parse("2026-08-11T00:00:00Z");
        UUID a = ConsumerRequirementLedger.instanceId(ENTITY, "t", day1Start);
        UUID a2 = ConsumerRequirementLedger.instanceId(ENTITY, "t", day1Start);
        UUID b = ConsumerRequirementLedger.instanceId(ENTITY, "t", day2Start);
        assertThat(a).isEqualTo(a2); // idempotent -> upsert overwrites the same row
        assertThat(a).isNotEqualTo(b);
    }

    @Test
    void dstAutumnDayGivesA25HourAllDayWindow() {
        // 2026-10-25 is the Berlin autumn DST change (03:00 -> 02:00): the all-day
        // window is 25 hours long, and the deadline is the next Berlin midnight.
        Instant now = Instant.parse("2026-10-25T12:00:00Z");
        Row r = ConsumerRequirementLedger.evaluate(ENTITY, List.of(dailyRuntime("t", 60)),
                        ev(0, "waiting", null, Boolean.TRUE, EnergyConfirmation.ASSUMED, null,
                                new BigDecimal("2.2")),
                        now, BERLIN)
                .get(0);
        long hours = (r.deadline().getEpochSecond() - r.periodStart().getEpochSecond()) / 3600;
        assertThat(hours).isEqualTo(25);
    }

    @Test
    void weekendOnlyRecurrenceHasNoInstanceOnAWeekday() {
        Requirement weekend = new Requirement("w", "flexible_task", "required_by_deadline",
                java.util.Set.of(java.time.DayOfWeek.SATURDAY, java.time.DayOfWeek.SUNDAY),
                java.time.LocalTime.MIDNIGHT, java.time.LocalTime.MIDNIGHT, true, 3600, null);
        // 2026-08-10 is a Monday -> no instance.
        Instant monday = Instant.parse("2026-08-10T12:00:00Z");
        assertThat(ConsumerRequirementLedger.evaluate(ENTITY, List.of(weekend),
                ev(0, "waiting", null, null, EnergyConfirmation.NONE, null, null), monday, BERLIN))
                .isEmpty();
    }

    @Test
    void reactiveAndOpportunisticRequirementsProduceNoLedgerRow() throws Exception {
        JsonNode doc = MAPPER.readTree("{\"requirements\":["
                + "{\"id\":\"r1\",\"kind\":\"reactive\",\"enforcement\":\"must_run\","
                + "\"condition\":{\"signal\":\"consumer.vehicle_connected\",\"operator\":\"eq\","
                + "\"value\":1},\"target\":{\"kind\":\"percent\",\"value\":100}}]}");
        assertThat(ConsumerRequirementLedger.requirementsOf(doc, new BigDecimal("11"))).isEmpty();
    }

    @Test
    void confirmationLevelIsClassifiedFromTheConfirmationChannel() {
        assertThat(ConsumerRequirementLedgerWriter.levelFor("energy_kwh"))
                .isEqualTo(EnergyConfirmation.MEASURED);
        assertThat(ConsumerRequirementLedgerWriter.levelFor("power_kw"))
                .isEqualTo(EnergyConfirmation.INTEGRATED);
        assertThat(ConsumerRequirementLedgerWriter.levelFor("relay_state"))
                .isEqualTo(EnergyConfirmation.ASSUMED);
        assertThat(ConsumerRequirementLedgerWriter.levelFor(null))
                .isEqualTo(EnergyConfirmation.NONE);
        assertThat(ConsumerRequirementLedgerWriter.levelFor(""))
                .isEqualTo(EnergyConfirmation.NONE);
    }

    @Test
    void requirementsAreParsedFromAPolicyDocument() throws Exception {
        JsonNode doc = MAPPER.readTree("{\"requirements\":["
                + "{\"id\":\"noon\",\"kind\":\"fixed_window\",\"enforcement\":\"must_run\","
                + "\"recurrence\":{\"days\":\"daily\",\"from\":\"13:00\",\"to\":\"14:00\"},"
                + "\"target\":{\"kind\":\"on_off\",\"value\":true}},"
                + "{\"id\":\"pump\",\"kind\":\"flexible_task\",\"enforcement\":\"required_by_deadline\","
                + "\"recurrence\":{\"days\":\"daily\",\"from\":\"00:00\",\"to\":\"24:00\"},"
                + "\"demand\":{\"runtime_minutes\":60,\"contiguous\":true},"
                + "\"target\":{\"kind\":\"on_off\",\"value\":true}}]}");
        List<Requirement> reqs = ConsumerRequirementLedger.requirementsOf(doc, new BigDecimal("3"));
        assertThat(reqs).hasSize(2);
        assertThat(reqs.get(0).requiredRuntimeSeconds()).isEqualTo(3600); // 13-14 window
        assertThat(reqs.get(1).requiredRuntimeSeconds()).isEqualTo(3600); // 60 min demand
        assertThat(reqs.get(1).endOfDay()).isTrue();
    }
}
