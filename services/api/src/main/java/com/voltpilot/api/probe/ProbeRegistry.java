package com.voltpilot.api.probe;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.stereotype.Component;

/**
 * Correlates an in-flight probe (Einheitsmodell Stufe 0b) with the request
 * thread waiting for it: the route publishes with a {@code request_id} and
 * blocks here; the MQTT listener completes it when the answer lands.
 *
 * <p><b>In memory on purpose</b> - the {@code SimulationJobRegistry} reasoning,
 * only shorter-lived: a probe answers a question that is being asked RIGHT NOW
 * and is worthless a minute later. An api restart forgets the mapping, the
 * request times out, and the customer clicks again. There is deliberately no
 * table: nothing about a preview is worth persisting, and a persisted
 * correlation would outlive the only caller that could still make sense of it.
 *
 * <p><b>The device is part of the key, not just the id.</b> A result is only
 * accepted from the device the request was addressed to
 * ({@link #complete(UUID, String, ProbeResult)}), so a compromised or merely
 * mis-addressed box can never answer for another one - the same posture the
 * listener already enforces via topic==payload identity, applied a second time
 * where the answer actually reaches a customer.
 */
@Component
public class ProbeRegistry {

    /** Nothing waits longer than this, so an abandoned entry cannot leak. */
    private static final Duration TTL = Duration.ofMinutes(2);

    private record Pending(UUID deviceId, Instant created,
            CompletableFuture<ProbeResult> future) {
    }

    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();

    /** Register a request and get the handle to wait on. */
    public CompletableFuture<ProbeResult> register(String requestId, UUID deviceId) {
        purge();
        CompletableFuture<ProbeResult> future = new CompletableFuture<>();
        pending.put(requestId, new Pending(deviceId, Instant.now(), future));
        return future;
    }

    /** Give up on a request (always called, so a timeout leaves nothing behind). */
    public void forget(String requestId) {
        pending.remove(requestId);
    }

    /**
     * Deliver an answer. Ignored when the id is unknown (already timed out) or
     * when it comes from a DIFFERENT device than the one asked - an answer that
     * cannot be attributed is not an answer.
     */
    public void complete(UUID deviceId, String requestId, ProbeResult result) {
        Pending p = pending.get(requestId);
        if (p == null || !p.deviceId().equals(deviceId)) {
            return;
        }
        pending.remove(requestId);
        p.future().complete(result);
    }

    /**
     * Wait for the answer, or return empty on timeout. Never throws on a
     * timeout: "the device did not answer in time" is an honest OUTCOME the
     * assistant renders, not an error.
     */
    public ProbeResult await(CompletableFuture<ProbeResult> future, Duration timeout) {
        try {
            return future.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        pending.entrySet().removeIf(e -> e.getValue().created().isBefore(cutoff));
    }
}
