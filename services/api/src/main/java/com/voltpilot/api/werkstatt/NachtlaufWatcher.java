package com.voltpilot.api.werkstatt;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der Takt hinter {@link NachtlaufService#takt()} (Konzept vp-update-vor-zuordnung, §11.2, S4): einmal je Minute,
 * am Tag eine Abfrage, in der Nacht höchstens ein Auftrag je Durchlauf.
 *
 * <p>Im Muster des {@code ota.RolloutWatcher} und an denselben Schalter gebunden (dort schaltet
 * {@code OtaSchedulingConfig} das Takten ein). Anders als dort führt bei mehreren Replikaten nur eins: der Takt
 * hält eine Sperre der Datenbank ({@link FernlaufRepository#alsEinziger}), so legt nie ein zweites Replikat im
 * selben Augenblick einen zweiten Auftrag an.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.ota.mqtt-listener-enabled", havingValue = "true")
public class NachtlaufWatcher {

    private static final Logger log = LoggerFactory.getLogger(NachtlaufWatcher.class);

    private final NachtlaufService nachtlauf;

    public NachtlaufWatcher(NachtlaufService nachtlauf) {
        this.nachtlauf = nachtlauf;
    }

    @Scheduled(fixedDelayString = "${voltpilot.werkstatt.nachtlauf-interval-ms:60000}",
            initialDelayString = "${voltpilot.werkstatt.nachtlauf-initial-delay-ms:45000}")
    public void tick() {
        try {
            nachtlauf.takt();
        } catch (Exception e) {
            // Ein Takt, der an einem Durchlauf stirbt, hört auf zu takten.
            log.warn("Nachtlauf tick failed: {}", e.getMessage());
        }
    }
}
