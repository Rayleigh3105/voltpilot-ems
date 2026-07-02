package com.voltpilot.api.web;

import java.time.Clock;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Abuse guard for the public first-boot enrollment endpoints (CSR upload +
 * certificate poll). Mechanics and the X-Forwarded-For trust model are in
 * {@link SlidingWindowRateLimiter}; this bean only binds the
 * {@code voltpilot.enrollment.rate-limit.*} configuration.
 *
 * <p>The defaults are sized for legitimate device polling (the documented
 * etiquette is a 30-60 s poll interval with backoff, see
 * docs/contracts/openapi.yaml): 240 requests per client-address-hour keeps a
 * single well-behaved device comfortably inside the budget while still choking
 * a hammering client; the global cap bounds platform-wide anonymous volume.
 */
@Component
public class EnrollmentRateLimiter extends SlidingWindowRateLimiter {

    @Autowired
    public EnrollmentRateLimiter(
            @Value("${voltpilot.enrollment.rate-limit.enabled:true}") boolean enabled,
            @Value("${voltpilot.enrollment.rate-limit.per-client-max:240}") int perClientMax,
            @Value("${voltpilot.enrollment.rate-limit.global-max:5000}") int globalMax,
            @Value("${voltpilot.enrollment.rate-limit.window:PT1H}") Duration window,
            @Value("${voltpilot.enrollment.rate-limit.trusted-proxies:0}") int trustedProxies) {
        this(enabled, perClientMax, globalMax, window, trustedProxies, Clock.systemUTC());
    }

    EnrollmentRateLimiter(boolean enabled, int perClientMax, int globalMax, Duration window,
            int trustedProxies, Clock clock) {
        super(enabled, perClientMax, globalMax, window, trustedProxies, clock);
    }
}
