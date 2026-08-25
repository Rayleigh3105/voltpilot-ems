package com.voltpilot.api.web;

import java.time.Clock;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Der Deckel der KUNDEN-Vorschau (Steuerung Stufe 7, Konzept
 * `vp-steuerung-konzept-b3` §3.8 G1).
 *
 * <p><b>Warum sie überhaupt einen braucht, obwohl sie authentifiziert ist:</b>
 * eine Vorschau ist ein ECHTER MILP-Lauf im Anfrage-Thread des Rechendienstes -
 * sie ist teuer, und der Dienst teilt seine CPU mit den Jahres-Simulationen und
 * dem 15-Minuten-Takt der ganzen Flotte. Der Semaphor DORT ist die harte
 * Grenze; dieser Deckel hier ist die freundliche davor: er hält einen Kunden
 * davon ab, mit einem hängenden Schalter die Rechenzeit aller anderen zu
 * verbrauchen, und er antwortet mit einem deutschen Satz statt eines
 * anonymen 429 aus der Tiefe.
 *
 * <p>Mechanik und das X-Forwarded-For-Vertrauensmodell stehen in
 * {@link SlidingWindowRateLimiter}; diese Bohne bindet nur die
 * {@code voltpilot.vorschau.rate-limit.*}-Konfiguration.
 */
@Component
public class VorschauRateLimiter extends SlidingWindowRateLimiter {

    @Autowired
    public VorschauRateLimiter(
            @Value("${voltpilot.vorschau.rate-limit.enabled:true}") boolean enabled,
            @Value("${voltpilot.vorschau.rate-limit.per-client-max:30}") int perClientMax,
            @Value("${voltpilot.vorschau.rate-limit.global-max:300}") int globalMax,
            @Value("${voltpilot.vorschau.rate-limit.window:PT5M}") Duration window,
            @Value("${voltpilot.vorschau.rate-limit.trusted-proxies:0}") int trustedProxies) {
        this(enabled, perClientMax, globalMax, window, trustedProxies, Clock.systemUTC());
    }

    VorschauRateLimiter(boolean enabled, int perClientMax, int globalMax, Duration window,
            int trustedProxies, Clock clock) {
        super(enabled, perClientMax, globalMax, window, trustedProxies, clock);
    }
}
