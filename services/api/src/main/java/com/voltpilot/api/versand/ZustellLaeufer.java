package com.voltpilot.api.versand;

import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT des zentralen Versands (Alerting Scheibe 0): holt fällige Zeilen über alle
 * Kundenbereiche hinweg und sendet (Muster {@code AblaufLaeufer}/{@code ComponentActivationOutboxService}),
 * dann fegt der Löschlauf Zeilen, die älter als die Aufbewahrung sind (Entscheid 13A, 90 Tage).
 *
 * <p>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS (surefire-Systemeigenschaft) und in
 * PRODUKTION AN ({@code application.yml}, {@code matchIfMissing}) - dieselbe Form wie Lücken,
 * Endgültigkeit und die Unterstützung. Wer ihn prüft, ruft {@link Zusteller#lauf} bzw.
 * {@link #loeschlauf} selbst.
 *
 * <p>Er wirft nie: ein Fehlschlag wird protokolliert, der nächste Takt versucht es erneut - jede
 * Zustellung ist wiederholbar (eindeutiger Schlüssel, §9).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.versand.enabled", havingValue = "true", matchIfMissing = true)
public class ZustellLaeufer {

    private static final Logger log = LoggerFactory.getLogger(ZustellLaeufer.class);

    /** Aufbewahrung der Ausgangszeilen (Entscheid 13A): 90 Tage. */
    static final Duration AUFBEWAHRUNG = Duration.ofDays(90);

    private final Zusteller zusteller;
    private final VersandRepository ausgang;

    public ZustellLaeufer(Zusteller zusteller, VersandRepository ausgang) {
        this.zusteller = zusteller;
        this.ausgang = ausgang;
    }

    @Scheduled(fixedDelayString = "${voltpilot.versand.interval-ms:15000}",
            initialDelayString = "${voltpilot.versand.initial-delay-ms:20000}")
    public void takt() {
        try {
            int gesendet = zusteller.lauf(Instant.now());
            if (gesendet > 0) {
                log.info("Versand: {} Zustellung(en) gesendet", gesendet);
            }
        } catch (RuntimeException e) {
            log.warn("Versand: Takt übersprungen: {}", e.toString());
        }
    }

    /** Täglich reicht: die Zeilen stehen 90 Tage, ein verspäteter Lauf lässt nichts liegen. */
    @Scheduled(fixedDelayString = "${voltpilot.versand.loeschlauf-interval-ms:86400000}",
            initialDelayString = "${voltpilot.versand.loeschlauf-initial-delay-ms:60000}")
    public void loeschlauf() {
        try {
            int geloescht = ausgang.loeschenAelterAls(Instant.now().minus(AUFBEWAHRUNG));
            if (geloescht > 0) {
                log.info("Versand: {} Ausgangszeile(n) über {} gelöscht", geloescht, AUFBEWAHRUNG);
            }
        } catch (RuntimeException e) {
            log.warn("Versand: Löschlauf übersprungen: {}", e.toString());
        }
    }
}
