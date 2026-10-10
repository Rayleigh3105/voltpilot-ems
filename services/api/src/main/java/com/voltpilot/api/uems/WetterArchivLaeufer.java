package com.voltpilot.api.uems;

import com.voltpilot.api.metrics.UemsLaeuferMelder;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der TAKT des Wetter-Archivs (UEMS AP-17 IP-12b, Schnitt Z2): einmal täglich {@link WetterArchivAbruf#lauf}, danach
 * holt jeder Takt fehlende Archiv-Tage der letzten 60 Tage nach. {@code voltpilot.uems.wetter-archiv.enabled} ist der
 * Not-Aus — Vorgabe AN, im Testlauf AUS (surefire); wer ihn prüft, ruft den Abruf selbst.
 *
 * <p>Er wirft nie: ein gescheiterter Takt wird gemeldet und beim nächsten nachgeholt.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.wetter-archiv.enabled", havingValue = "true", matchIfMissing = true)
public class WetterArchivLaeufer {

    private static final Logger log = LoggerFactory.getLogger(WetterArchivLaeufer.class);

    private final WetterArchivAbruf abruf;
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    public WetterArchivLaeufer(WetterArchivAbruf abruf) {
        this.abruf = abruf;
    }

    /** Täglich 06:10 Europe/Berlin — das Archiv hat gestern dann abgeschlossen. */
    @Scheduled(cron = "${voltpilot.uems.wetter-archiv.cron:0 10 6 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            WetterArchivAbruf.Lauf l = abruf.lauf(Instant.now());
            if (l.fehler() > 0) {
                melder.fehler(UemsLaeuferMelder.WETTER_ARCHIV);
            } else {
                melder.gelaufen(UemsLaeuferMelder.WETTER_ARCHIV);
            }
            log.info("UEMS Wetter-Archiv: {}", l);
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.WETTER_ARCHIV);
            log.warn("UEMS Wetter-Archiv: Takt übersprungen: {}", e.toString());
        }
    }
}
