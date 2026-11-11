package com.voltpilot.api.web;

import java.time.Clock;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Rate-Limit für {@code POST /api/v1/werkstatt/einloesen} (offen, ohne Konto):
 * je Absender und gesamt, eng geschnitten - eine Werkstatt löst ein paar Boxen
 * in der Stunde ein. Vor jeder Arbeit, damit Raten teuer bleibt. Die Zahl der
 * vertrauten Proxys folgt der des Enrollments, wenn sie nicht eigens gesetzt ist.
 */
@Component
public class WerkstattEinloesenRateLimiter extends SlidingWindowRateLimiter {

    @Autowired
    public WerkstattEinloesenRateLimiter(
            @Value("${voltpilot.werkstatt.einloesen.rate-limit.enabled:true}") boolean enabled,
            @Value("${voltpilot.werkstatt.einloesen.rate-limit.per-client-max:30}") int perClientMax,
            @Value("${voltpilot.werkstatt.einloesen.rate-limit.global-max:600}") int globalMax,
            @Value("${voltpilot.werkstatt.einloesen.rate-limit.window:PT1H}") Duration window,
            @Value("${voltpilot.werkstatt.einloesen.rate-limit.trusted-proxies:${voltpilot.enrollment.rate-limit.trusted-proxies:0}}")
            int trustedProxies) {
        super(enabled, perClientMax, globalMax, window, trustedProxies, Clock.systemUTC());
    }
}
