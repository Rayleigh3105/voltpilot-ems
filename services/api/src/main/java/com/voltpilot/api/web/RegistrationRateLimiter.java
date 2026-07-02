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
 * <p>The client address comes from the proxy chain (the {@code X-Forwarded-For}
 * entries followed by the socket address): the last {@code trusted-proxies}
 * entries are our own proxies, and the entry right before them is the real
 * client. Every proxy on the way APPENDS to the header, so any earlier entries
 * are client-supplied and must never be trusted - trusting the first hop would
 * let an attacker rotate buckets or exhaust a victim's budget with a spoofed
 * header. With {@code trusted-proxies: 0} (the default, right for a
 * directly-reachable dev api) the header is ignored entirely and the socket
 * address is used; production (client -> external proxy -> frontend nginx ->
 * api) sets 2.
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
    private final int trustedProxies;
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
            @Value("${voltpilot.registration.rate-limit.window:PT1H}") Duration window,
            @Value("${voltpilot.registration.rate-limit.trusted-proxies:0}") int trustedProxies) {
        this(enabled, perClientMax, globalMax, window, trustedProxies, Clock.systemUTC());
    }

    RegistrationRateLimiter(boolean enabled, int perClientMax, int globalMax, Duration window,
            int trustedProxies, Clock clock) {
        this.enabled = enabled;
        this.perClientMax = perClientMax;
        this.globalMax = globalMax;
        this.window = window;
        this.trustedProxies = trustedProxies;
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

    /**
     * The bucket key for a request: the {@code trustedProxies}-from-the-right
     * entry of the proxy chain (X-Forwarded-For hops + the socket address). Only
     * the rightmost entries were appended by our own proxies; anything further
     * left is client-supplied. If the header carries fewer hops than expected
     * (a request that bypassed a proxy), the socket address is used.
     */
    public String clientKey(HttpServletRequest request) {
        if (trustedProxies <= 0) {
            return request.getRemoteAddr();
        }
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded == null || forwarded.isBlank()) {
            return request.getRemoteAddr();
        }
        String[] hops = forwarded.split(",");
        int clientIndex = hops.length - trustedProxies;
        if (clientIndex < 0) {
            return request.getRemoteAddr();
        }
        String hop = hops[clientIndex].trim();
        return hop.isEmpty() ? request.getRemoteAddr() : hop;
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
