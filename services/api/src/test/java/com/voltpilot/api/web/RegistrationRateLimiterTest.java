package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

/** Pure-clock unit proof of the registration abuse guard (no Spring, no Docker). */
class RegistrationRateLimiterTest {

    /** A clock the test advances by hand. */
    private static final class MutableClock extends Clock {
        private Instant now = Instant.parse("2026-07-02T12:00:00Z");

        void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public Instant instant() {
            return now;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }
    }

    private final MutableClock clock = new MutableClock();

    private RegistrationRateLimiter limiter(int perClientMax, int globalMax) {
        return new RegistrationRateLimiter(true, perClientMax, globalMax,
                Duration.ofHours(1), 0, clock);
    }

    @Test
    void perClientBudgetIsEnforcedAndOtherClientsAreUnaffected() {
        RegistrationRateLimiter limiter = limiter(3, 100);
        for (int i = 0; i < 3; i++) {
            assertThat(limiter.tryAcquire("203.0.113.7")).isTrue();
        }
        assertThat(limiter.tryAcquire("203.0.113.7")).isFalse();
        // A neighbour on a different address still registers fine.
        assertThat(limiter.tryAcquire("203.0.113.8")).isTrue();
    }

    @Test
    void budgetRecoversAsAttemptsAgeOutOfTheWindow() {
        RegistrationRateLimiter limiter = limiter(2, 100);
        assertThat(limiter.tryAcquire("home")).isTrue();
        clock.advance(Duration.ofMinutes(40));
        assertThat(limiter.tryAcquire("home")).isTrue();
        assertThat(limiter.tryAcquire("home")).isFalse();
        // 21 more minutes: the first attempt (now 61 min old) has aged out.
        clock.advance(Duration.ofMinutes(21));
        assertThat(limiter.tryAcquire("home")).isTrue();
        assertThat(limiter.tryAcquire("home")).isFalse();
    }

    @Test
    void globalCapBoundsRotatingAddresses() {
        RegistrationRateLimiter limiter = limiter(10, 4);
        for (int i = 0; i < 4; i++) {
            assertThat(limiter.tryAcquire("bot-" + i)).isTrue();
        }
        // A fresh address with untouched per-client budget is still refused.
        assertThat(limiter.tryAcquire("bot-fresh")).isFalse();
    }

    @Test
    void refusedAttemptsConsumeNoBudget() {
        RegistrationRateLimiter limiter = limiter(1, 100);
        assertThat(limiter.tryAcquire("retry")).isTrue();
        for (int i = 0; i < 5; i++) {
            assertThat(limiter.tryAcquire("retry")).isFalse();
        }
        // Hammering while refused must not push recovery further out.
        clock.advance(Duration.ofMinutes(61));
        assertThat(limiter.tryAcquire("retry")).isTrue();
    }

    @Test
    void staleClientBucketsAreReclaimedEvenWhenTheirKeyIsNeverSeenAgain() {
        // The memory-leak regression (audit S1): a client that made ONE accepted
        // attempt and never returns must not keep its bucket forever - the lazy
        // per-key prune never runs for it, so the periodic sweep has to prune
        // each deque BEFORE the emptiness test.
        RegistrationRateLimiter limiter = limiter(3, 1_000);
        for (int i = 0; i < 50; i++) {
            assertThat(limiter.tryAcquire("visitor-" + i)).isTrue();
        }
        assertThat(limiter.trackedClientCount()).isEqualTo(50);
        // All 50 attempts age out of the window; the next request (a new
        // client) triggers the scheduled sweep and reclaims every stale bucket.
        clock.advance(Duration.ofMinutes(61));
        assertThat(limiter.tryAcquire("fresh")).isTrue();
        assertThat(limiter.trackedClientCount()).isEqualTo(1);
    }

    @Test
    void disabledLimiterAllowsEverything() {
        RegistrationRateLimiter limiter = new RegistrationRateLimiter(false, 1, 1,
                Duration.ofHours(1), 0, clock);
        for (int i = 0; i < 10; i++) {
            assertThat(limiter.tryAcquire("anyone")).isTrue();
        }
    }

    private RegistrationRateLimiter limiterWithTrustedProxies(int trustedProxies) {
        return new RegistrationRateLimiter(true, 10, 100, Duration.ofHours(1),
                trustedProxies, clock);
    }

    @Test
    void clientKeyIgnoresForwardedHeaderWithoutTrustedProxies() {
        RegistrationRateLimiter limiter = limiterWithTrustedProxies(0);
        MockHttpServletRequest direct = new MockHttpServletRequest();
        direct.setRemoteAddr("192.0.2.10");
        assertThat(limiter.clientKey(direct)).isEqualTo("192.0.2.10");

        // A spoofed header on a directly-reachable api must not pick the bucket.
        MockHttpServletRequest spoofed = new MockHttpServletRequest();
        spoofed.setRemoteAddr("192.0.2.10");
        spoofed.addHeader("X-Forwarded-For", "203.0.113.99");
        assertThat(limiter.clientKey(spoofed)).isEqualTo("192.0.2.10");
    }

    @Test
    void clientKeyTakesTheTrustedProxiesFromTheRightHop() {
        // Prod topology: client -> external proxy -> frontend nginx -> api.
        // nginx is the socket peer; the header carries [.., real client, proxy].
        RegistrationRateLimiter limiter = limiterWithTrustedProxies(2);
        MockHttpServletRequest proxied = new MockHttpServletRequest();
        proxied.setRemoteAddr("172.18.0.5");
        proxied.addHeader("X-Forwarded-For", "198.51.100.23, 203.0.113.4");
        assertThat(limiter.clientKey(proxied)).isEqualTo("198.51.100.23");

        // Every proxy APPENDS, so attacker-supplied leading entries are ignored.
        MockHttpServletRequest crafted = new MockHttpServletRequest();
        crafted.setRemoteAddr("172.18.0.5");
        crafted.addHeader("X-Forwarded-For", "10.0.0.1, 1.2.3.4, 198.51.100.23, 203.0.113.4");
        assertThat(limiter.clientKey(crafted)).isEqualTo("198.51.100.23");
    }

    @Test
    void clientKeyFallsBackToSocketOnShortOrMissingChains() {
        RegistrationRateLimiter limiter = limiterWithTrustedProxies(2);

        MockHttpServletRequest noHeader = new MockHttpServletRequest();
        noHeader.setRemoteAddr("192.0.2.10");
        assertThat(limiter.clientKey(noHeader)).isEqualTo("192.0.2.10");

        // Fewer hops than trusted proxies: the request bypassed a proxy layer.
        MockHttpServletRequest shortChain = new MockHttpServletRequest();
        shortChain.setRemoteAddr("192.0.2.10");
        shortChain.addHeader("X-Forwarded-For", "203.0.113.4");
        assertThat(limiter.clientKey(shortChain)).isEqualTo("192.0.2.10");
    }
}
