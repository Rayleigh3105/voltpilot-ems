package com.voltpilot.api.consumers;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The pure §13.4 trigger rules: transitions, debounce, rate limit - no Docker. */
class ConsumerReplanTriggerTest {

    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID WALLBOX = UUID.fromString("6f1d2c3b-4a59-4687-9abc-def012345678");
    private static final UUID ROD = UUID.fromString("7a2e3d4c-5b6a-4798-8abc-def012345679");
    private static final Instant T0 = Instant.parse("2026-08-10T10:00:00Z");

    private ConsumerReplanTrigger trigger() {
        return new ConsumerReplanTrigger(Duration.ofSeconds(8), Duration.ofSeconds(120), 3);
    }

    @Test
    void onlyTheParagraph134TransitionsTrigger() {
        ConsumerReplanTrigger t = trigger();
        // First observation: no transition known -> never a trigger (an api
        // restart must not replan the fleet).
        assertThat(t.observe(SITE, WALLBOX, "ready", true, T0)).isFalse();
        // Pflichtregel aktiv (vehicle plugged -> running_forced).
        assertThat(t.observe(SITE, WALLBOX, "running_forced", true, T0.plusSeconds(1))).isTrue();
        // Unchanged state: no re-trigger.
        assertThat(t.observe(SITE, WALLBOX, "running_forced", true, T0.plusSeconds(2))).isFalse();
        // Pflichtregel inaktiv (unplugged).
        assertThat(t.observe(SITE, WALLBOX, "ready", true, T0.plusSeconds(3))).isTrue();
        // An ordinary optimized start is NOT a §13.4 event.
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", true, T0.plusSeconds(4))).isFalse();
        // Verbraucher nicht verfügbar.
        assertThat(t.observe(SITE, WALLBOX, "offline", null, T0.plusSeconds(5))).isTrue();
        // Aufgabe vorzeitig erfüllt.
        assertThat(t.observe(SITE, ROD, "running_optimized", true, T0)).isFalse();
        assertThat(t.observe(SITE, ROD, "fulfilled", true, T0.plusSeconds(6))).isTrue();
    }

    @Test
    void aPersistentlyDeviatingReadbackTriggersOnceUntilItConfirmsAgain() {
        ConsumerReplanTrigger t = trigger();
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0)).isFalse();
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0.plusSeconds(15)))
                .isFalse();
        // The THIRD consecutive mismatch is "dauerhaft abweichend".
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0.plusSeconds(30)))
                .isTrue();
        // Still deviating: fired already, no storm.
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0.plusSeconds(45)))
                .isFalse();
        // A confirming readback re-arms the rule.
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", true, T0.plusSeconds(60)))
                .isFalse();
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0.plusSeconds(75)))
                .isFalse();
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0.plusSeconds(90)))
                .isFalse();
        assertThat(t.observe(SITE, WALLBOX, "running_optimized", false, T0.plusSeconds(105)))
                .isTrue();
    }

    @Test
    void aBurstDebouncesIntoOneSiteRequest() {
        ConsumerReplanTrigger t = trigger();
        t.observe(SITE, WALLBOX, "ready", true, T0);
        t.observe(SITE, ROD, "ready", true, T0);
        t.observe(SITE, WALLBOX, "running_forced", true, T0.plusSeconds(1));
        t.observe(SITE, ROD, "fulfilled", true, T0.plusSeconds(3));

        // Inside the debounce window: nothing due yet.
        assertThat(t.due(T0.plusSeconds(5))).isEmpty();
        // 8 s after the FIRST event the burst fires as ONE request.
        assertThat(t.due(T0.plusSeconds(10))).containsExactly(SITE);
        // Fired = cleared.
        assertThat(t.due(T0.plusSeconds(11))).isEmpty();
    }

    @Test
    void theRateLimitHoldsAFollowUpTriggerUntilTheWindowOpens() {
        ConsumerReplanTrigger t = trigger();
        t.observe(SITE, WALLBOX, "ready", true, T0);
        t.observe(SITE, WALLBOX, "running_forced", true, T0.plusSeconds(1));
        assertThat(t.due(T0.plusSeconds(10))).containsExactly(SITE);

        // A new trigger 20 s later: debounce elapses, but the 120-s rate
        // limit holds it - pending, not dropped.
        t.observe(SITE, WALLBOX, "ready", true, T0.plusSeconds(30));
        assertThat(t.due(T0.plusSeconds(45))).isEmpty();
        // The window opens -> the held request fires.
        assertThat(t.due(T0.plusSeconds(131))).containsExactly(SITE);
        assertThat(t.due(T0.plusSeconds(132))).isEmpty();
    }
}
