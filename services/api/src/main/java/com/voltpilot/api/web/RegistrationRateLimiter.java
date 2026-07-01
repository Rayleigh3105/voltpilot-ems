package com.voltpilot.api.web;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Sliding-window rate limiter for the public self-registration endpoint - the
 * abuse guard that makes it safe to leave {@code POST /api/v1/registration}
 * unauthenticated (each accepted request creates a tenant row and a Keycloak
 * user, so unlimited anonymous volume must be impossible).
 *
 * <p>Two windows apply to every attempt:
 * <ul>
 *   <li><b>per client address</b> - a single household/NAT can only open a few
 *       accounts per window, and</li>
 *   <li><b>global</b> - total registration volume stays bounded even when an
 *       attacker rotates addresses (or spoofs {@code X-Forwarded-For}).</li>
 * </ul>
 *
 * <p>The client address is the first {@code X-Forwarded-For} hop when present,
 * else the socket address. In production the api is reachable only through the
 * frontend nginx (which appends the real client to {@code X-Forwarded-For}), so
 * the header is trustworthy there; a spoofed header from a directly-reachable
 * api merely segregates the attacker's own buckets while the global cap still
 * bounds the total.
 *
 * <p>Refused attempts consume no budget: the client's allowance recovers as its
 * oldest accepted attempts age out of the window. State is in-memory and
 * per-instance, which matches the single-VPS deployment; a multi-replica api
 * would multiply the caps by the replica count, still bounded.
 */
@Component
public class RegistrationRateLimiter {

    private final boolean enabled;
    private final int perClientMax;
    private final int globalMax;
    private final Duration window;
    private final Clock clock;

    /** Accepted-attempt timestamps per client key, oldest first. */
    private final Map<String, Deque<Instant>> perClient = new HashMap<>();
    /** All accepted-attempt timestamps, oldest first. */
    private final Deque<Instant> global = new ArrayDeque<>();

    @Autowired
    public RegistrationRateLimiter(
            @Value("${voltpilot.registration.rate-limit.enabled:true}") boolean enabled,
            @Value("${voltpilot.registration.rate-limit.per-client-max:10}") int perClientMax,
            @Value("${voltpilot.registration.rate-limit.global-max:100}") int globalMax,
            @Value("${voltpilot.registration.rate-limit.window:PT1H}") Duration window) {
        this(enabled, perClientMax, globalMax, window, Clock.systemUTC());
    }

    RegistrationRateLimiter(boolean enabled, int perClientMax, int globalMax, Duration window,
            Clock clock) {
        this.enabled = enabled;
        this.perClientMax = perClientMax;
        this.globalMax = globalMax;
        this.window = window;
        this.clock = clock;
    }

    /**
     * Records one registration attempt for {@code clientKey} and reports whether
     * it is within both budgets. Registration volume is tiny, so a single lock
     * keeps the two windows trivially consistent.
     */
    public synchronized boolean tryAcquire(String clientKey) {
        if (!enabled) {
            return true;
        }
        Instant now = clock.instant();
        Instant cutoff = now.minus(window);
        prune(global, cutoff);
        Deque<Instant> client = perClient.computeIfAbsent(clientKey, k -> new ArrayDeque<>());
        prune(client, cutoff);
        if (client.size() >= perClientMax || global.size() >= globalMax) {
            sweepEmpty();
            return false;
        }
        client.add(now);
        global.add(now);
        sweepEmpty();
        return true;
    }

    /** The bucket key for a request: first X-Forwarded-For hop, else the socket. */
    public static String clientKey(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    private static void prune(Deque<Instant> attempts, Instant cutoff) {
        while (!attempts.isEmpty() && attempts.peekFirst().isBefore(cutoff)) {
            attempts.removeFirst();
        }
    }

    /**
     * Address rotation would otherwise grow the map without bound (every probed
     * key creates a bucket, even when refused); entries themselves are already
     * bounded by the global cap.
     */
    private void sweepEmpty() {
        if (perClient.size() > 10_000) {
            perClient.values().removeIf(Deque::isEmpty);
        }
    }
}
