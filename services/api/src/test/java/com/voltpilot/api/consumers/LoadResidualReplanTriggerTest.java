package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class LoadResidualReplanTriggerTest {
    private static final UUID SITE = UUID.randomUUID();
    private static final UUID DEVICE = UUID.randomUUID();
    private static final Instant T0 = Instant.parse("2026-08-25T10:00:00Z");

    private static LoadResidualReplanTrigger trigger() {
        return new LoadResidualReplanTrigger(3, .20, Duration.ofSeconds(20),
                Duration.ofSeconds(120), Duration.ofSeconds(5));
    }

    private static boolean observe(LoadResidualReplanTrigger trigger, UUID site,
            double actualKw, double plannedKw, Instant observedAt) {
        return trigger.observe(site, DEVICE, observedAt.getEpochSecond(),
                actualKw, plannedKw, observedAt);
    }

    @Test void sustainedTwentyKilowattResidualIsDueWithinThirtySeconds() {
        var trigger = trigger();
        assertThat(observe(trigger, SITE, 36.8, 16.8, T0)).isFalse();
        assertThat(observe(trigger, SITE, 36.8, 16.8, T0.plusSeconds(10))).isFalse();
        assertThat(trigger.due(T0.plusSeconds(19))).isEmpty();
        assertThat(observe(trigger, SITE, 36.8, 16.8, T0.plusSeconds(20))).isTrue();
        assertThat(trigger.due(T0.plusSeconds(20))).containsExactly(SITE);
    }

    @Test void shortImpulseDoesNotSolveAndRelativeThresholdAlsoBinds() {
        var trigger = trigger();
        observe(trigger, SITE, 36.8, 16.8, T0);
        observe(trigger, SITE, 16.8, 16.8, T0.plusSeconds(9));
        assertThat(trigger.due(T0.plusSeconds(40))).isEmpty();
        observe(trigger, SITE, 104, 100, T0.plusSeconds(41)); // >3, but only 4%
        assertThat(trigger.due(T0.plusSeconds(90))).isEmpty();
    }

    @Test void allAttemptsAreRateLimitedWhileFailureKeepsTheRequestPending() {
        var trigger = trigger();
        observe(trigger, SITE, 30, 10, T0);
        observe(trigger, SITE, 30, 10, T0.plusSeconds(10));
        observe(trigger, SITE, 30, 10, T0.plusSeconds(20));
        assertThat(trigger.due(T0.plusSeconds(20))).containsExactly(SITE);
        trigger.complete(SITE, false, T0.plusSeconds(21));
        assertThat(trigger.due(T0.plusSeconds(139))).isEmpty();
        assertThat(trigger.due(T0.plusSeconds(140))).containsExactly(SITE);
        trigger.complete(SITE, true, T0.plusSeconds(141));
        observe(trigger, SITE, 30, 10, T0.plusSeconds(142));
        observe(trigger, SITE, 30, 10, T0.plusSeconds(152));
        observe(trigger, SITE, 30, 10, T0.plusSeconds(162));
        assertThat(trigger.due(T0.plusSeconds(259))).isEmpty();
        assertThat(trigger.due(T0.plusSeconds(260))).containsExactly(SITE);
    }

    @Test void aTelemetryGapIsNotClaimedAsSustainedDeviation() {
        var trigger = trigger();
        observe(trigger, SITE, 30, 10, T0);
        observe(trigger, SITE, 30, 10, T0.plusSeconds(20));
        assertThat(trigger.due(T0.plusSeconds(20))).isEmpty();
    }

    @Test void continuityBreakBeforeDispatchCancelsThePendingAttempt() {
        var trigger = trigger();
        observe(trigger, SITE, 30, 10, T0);
        observe(trigger, SITE, 30, 10, T0.plusSeconds(10));
        assertThat(observe(trigger, SITE, 30, 10, T0.plusSeconds(20))).isTrue();

        // The deviation ended before the scheduler dispatched the pending
        // request. That old episode is no longer a truthful reason to solve.
        observe(trigger, SITE, 10, 10, T0.plusSeconds(21));
        assertThat(trigger.due(T0.plusSeconds(21))).isEmpty();
    }

    @Test void duplicateAndOutOfOrderQos1DeliveryCannotManufactureSustainedEvidence() {
        var trigger = trigger();
        assertThat(trigger.observe(SITE, DEVICE, 7L, 30, 10, T0)).isFalse();

        // Same observation delivered three times at QoS 1: neither its broker
        // arrival time nor repetition may extend the observation timeline.
        assertThat(trigger.observe(SITE, DEVICE, 7L, 30, 10, T0)).isFalse();
        assertThat(trigger.observe(SITE, DEVICE, 7L, 30, 10, T0)).isFalse();
        // A sequence that moves backwards is equally inadmissible, even with a
        // later-looking timestamp.
        assertThat(trigger.observe(SITE, DEVICE, 6L, 30, 10, T0.plusSeconds(20))).isFalse();
        assertThat(trigger.due(T0.plusSeconds(30))).isEmpty();
    }

    @Test void observationsFromDifferentDevicesCannotBeSplicedIntoOneEpisode() {
        var trigger = trigger();
        UUID otherDevice = UUID.randomUUID();
        assertThat(trigger.observe(SITE, DEVICE, 1L, 30, 10, T0)).isFalse();
        assertThat(trigger.observe(SITE, otherDevice, 1L,
                30, 10, T0.plusSeconds(10))).isFalse();
        assertThat(trigger.observe(SITE, otherDevice, 2L,
                30, 10, T0.plusSeconds(20))).isFalse();
        assertThat(trigger.due(T0.plusSeconds(20))).isEmpty();
    }

    @Test void sustainedResidualDetectionP95StaysBelowThirtySeconds() {
        var trigger = trigger();
        var latencies = new ArrayList<Long>();
        for (int i = 0; i < 100; i++) {
            UUID site = UUID.randomUUID();
            observe(trigger, site, 30, 10, T0);
            observe(trigger, site, 30, 10, T0.plusSeconds(10));
            observe(trigger, site, 30, 10, T0.plusSeconds(20));
            if (trigger.due(T0.plusSeconds(20)).contains(site)) latencies.add(20L);
        }
        Collections.sort(latencies);
        assertThat(latencies).hasSize(100);
        assertThat(latencies.get(94)).isLessThan(30L);
    }
}
