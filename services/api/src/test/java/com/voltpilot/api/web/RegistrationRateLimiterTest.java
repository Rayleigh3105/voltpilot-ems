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
                Duration.ofHours(1), clock);
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
    void disabledLimiterAllowsEverything() {
        RegistrationRateLimiter limiter = new RegistrationRateLimiter(false, 1, 1,
                Duration.ofHours(1), clock);
        for (int i = 0; i < 10; i++) {
            assertThat(limiter.tryAcquire("anyone")).isTrue();
        }
    }

    @Test
    void clientKeyPrefersFirstForwardedHopOverSocketAddress() {
        MockHttpServletRequest direct = new MockHttpServletRequest();
        direct.setRemoteAddr("192.0.2.10");
        assertThat(RegistrationRateLimiter.clientKey(direct)).isEqualTo("192.0.2.10");

        MockHttpServletRequest proxied = new MockHttpServletRequest();
        proxied.setRemoteAddr("172.18.0.5"); // the nginx container, same for everyone
        proxied.addHeader("X-Forwarded-For", "198.51.100.23, 172.18.0.5");
        assertThat(RegistrationRateLimiter.clientKey(proxied)).isEqualTo("198.51.100.23");
    }
}
