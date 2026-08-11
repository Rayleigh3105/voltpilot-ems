package com.voltpilot.api.probe;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/** The correlation, without a broker: it must never hand an answer to the wrong waiter. */
class ProbeRegistryTest {

    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    private static ProbeResult result(String requestId) {
        return new ProbeResult(requestId, null, null, List.of());
    }

    @Test
    void anAnswerReachesItsOwnWaiter() {
        ProbeRegistry registry = new ProbeRegistry();
        CompletableFuture<ProbeResult> f = registry.register("aaaa", DEVICE);
        registry.complete(DEVICE, "aaaa", result("aaaa"));
        assertThat(registry.await(f, Duration.ofMillis(100)).requestId()).isEqualTo("aaaa");
    }

    /**
     * ⚠ The device is part of the key, not decoration: a box that answered for
     * another one would put a foreign plant's register values in front of this
     * customer.
     */
    @Test
    void anAnswerFromAnotherDeviceIsNeverDelivered() {
        ProbeRegistry registry = new ProbeRegistry();
        CompletableFuture<ProbeResult> f = registry.register("aaaa", DEVICE);
        registry.complete(UUID.randomUUID(), "aaaa", result("aaaa"));
        assertThat(registry.await(f, Duration.ofMillis(50)))
                .as("a foreign device must not complete our request").isNull();
        // ...and the request is still open for its OWN device's answer.
        registry.complete(DEVICE, "aaaa", result("aaaa"));
        assertThat(registry.await(f, Duration.ofMillis(100))).isNotNull();
    }

    @Test
    void anAnswerToAnUnknownOrForgottenRequestIsDropped() {
        ProbeRegistry registry = new ProbeRegistry();
        CompletableFuture<ProbeResult> f = registry.register("aaaa", DEVICE);
        registry.complete(DEVICE, "bbbb", result("bbbb"));
        assertThat(registry.await(f, Duration.ofMillis(50))).isNull();

        registry.forget("aaaa");
        registry.complete(DEVICE, "aaaa", result("aaaa"));
        assertThat(registry.await(f, Duration.ofMillis(50)))
                .as("a forgotten request cannot be completed").isNull();
    }

    /**
     * A timeout is an OUTCOME, not an exception: the service turns it into the
     * honest "die Anlage hat nicht rechtzeitig geantwortet".
     */
    @Test
    void aTimeoutReturnsEmptyRatherThanThrowing() {
        ProbeRegistry registry = new ProbeRegistry();
        CompletableFuture<ProbeResult> f = registry.register("aaaa", DEVICE);
        assertThat(registry.await(f, Duration.ofMillis(20))).isNull();
    }

    /** The same answer twice completes once - a late duplicate changes nothing. */
    @Test
    void aDuplicateAnswerIsHarmless() {
        ProbeRegistry registry = new ProbeRegistry();
        CompletableFuture<ProbeResult> f = registry.register("aaaa", DEVICE);
        registry.complete(DEVICE, "aaaa", result("aaaa"));
        registry.complete(DEVICE, "aaaa", result("aaaa"));
        assertThat(registry.await(f, Duration.ofMillis(50))).isNotNull();
    }
}
