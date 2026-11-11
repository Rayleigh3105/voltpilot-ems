package com.voltpilot.api.entities;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der Takt von {@link WechselrichterUntergrenzeAbgleich}: alle zwei Minuten, damit eine Lesung der Box (Takt 300 s)
 * sicher vor dem nächsten 15-Minuten-Plan übernommen ist.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}). Wer ihn prüft, ruft {@link WechselrichterUntergrenzeAbgleich#lauf}
 * selbst. Er wirft nie.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.wechselrichter-untergrenze.enabled", havingValue = "true",
        matchIfMissing = true)
public class WechselrichterUntergrenzeLaeufer {

    private static final Logger log = LoggerFactory.getLogger(WechselrichterUntergrenzeLaeufer.class);

    private final WechselrichterUntergrenzeAbgleich abgleich;

    public WechselrichterUntergrenzeLaeufer(WechselrichterUntergrenzeAbgleich abgleich) {
        this.abgleich = abgleich;
    }

    @Scheduled(fixedDelayString = "${voltpilot.wechselrichter-untergrenze.interval-ms:120000}",
            initialDelayString = "${voltpilot.wechselrichter-untergrenze.initial-delay-ms:90000}")
    public void takt() {
        try {
            abgleich.lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("Entladegrenze des Wechselrichters: Lauf übersprungen: {}", e.toString());
        }
    }
}
