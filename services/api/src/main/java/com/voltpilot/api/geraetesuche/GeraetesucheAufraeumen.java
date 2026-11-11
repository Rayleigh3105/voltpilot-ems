package com.voltpilot.api.geraetesuche;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der Läufer der Gerätesuche (DP-3 A): Suchen und ihre Funde gehen 30 Tage nach dem Auslösen, das Protokoll bleibt.
 * Stündlich, zum ersten Mal eine Stunde nach dem Start - ein Testlauf erreicht ihn nie; abschaltbar über
 * {@code voltpilot.geraetesuche.aufraeumen.enabled}.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.geraetesuche.aufraeumen.enabled", havingValue = "true",
        matchIfMissing = true)
public class GeraetesucheAufraeumen {

    private static final Logger log = LoggerFactory.getLogger(GeraetesucheAufraeumen.class);

    private final GeraetesucheDienst dienst;

    public GeraetesucheAufraeumen(GeraetesucheDienst dienst) {
        this.dienst = dienst;
    }

    @Scheduled(fixedDelayString = "${voltpilot.geraetesuche.aufraeumen.takt-ms:3600000}",
            initialDelayString = "${voltpilot.geraetesuche.aufraeumen.takt-ms:3600000}")
    public void laufen() {
        try {
            int n = dienst.aufraeumen();
            if (n > 0) {
                log.info("geraetesuche: {} Suchen älter als 30 Tage gelöscht", n);
            }
        } catch (RuntimeException e) {
            log.warn("geraetesuche aufräumen fehlgeschlagen: {}", e.getMessage());
        }
    }
}
