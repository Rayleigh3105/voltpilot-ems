package com.voltpilot.api.web;

import java.time.Clock;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Abuse guard for the public self-registration endpoint - what makes it safe to
 * leave {@code POST /api/v1/registration} unauthenticated (each accepted request
 * creates a tenant row and a Keycloak user, so unlimited anonymous volume must
 * be impossible). Mechanics and the X-Forwarded-For trust model are in
 * {@link SlidingWindowRateLimiter}; this bean only binds the
 * {@code voltpilot.registration.rate-limit.*} configuration.
 */
@Component
public class RegistrationRateLimiter extends SlidingWindowRateLimiter {

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
        super(enabled, perClientMax, globalMax, window, trustedProxies, clock);
    }
}
