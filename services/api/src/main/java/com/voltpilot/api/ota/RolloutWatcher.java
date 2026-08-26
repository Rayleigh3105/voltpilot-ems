package com.voltpilot.api.ota;

import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Der Takt hinter {@link RolloutService#reconcile(Instant)}: Zustände
 * fortschreiben, bei einem harten Fehlerzustand automatisch anhalten (D4), und
 * Zuweisungen nach-veröffentlichen, deren retained Nachricht offenbar nicht
 * (mehr) wirkt.
 *
 * <p><b>Replica-Hinweis (bekannte Grenze, §10):</b> wie die fünf
 * MQTT-Listener ist auch dieser Wächter ein REPLICA-Singleton - heute läuft
 * genau eine api-Replica. Bei mehreren Replicas liefe er mehrfach; das wäre
 * fachlich nicht falsch (jeder Schritt ist idempotent: gleicher Zustand →
 * kein Schreiben, gleiche Zuweisung → dieselbe retained Nachricht), würde aber
 * doppelte Journal-Einträge erzeugen. Die Lösung ist dieselbe wie dort
 * (Shared Subscriptions bzw. ein Leader) und gehört nicht in diese Stufe.
 *
 * <p>An denselben Schalter gebunden wie der Status-Ingest der Stufe 0: ohne
 * ihn gibt es kein gemeldetes IST, gegen das ein Wächter überhaupt urteilen
 * könnte.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.ota.mqtt-listener-enabled", havingValue = "true")
public class RolloutWatcher {

    private static final Logger log = LoggerFactory.getLogger(RolloutWatcher.class);

    private final RolloutService rollouts;

    public RolloutWatcher(RolloutService rollouts) {
        this.rollouts = rollouts;
    }

    /**
     * Alle 60 s. Die Kadenz muss deutlich unter dem Offline-Fenster
     * ({@link RolloutStates#OFFLINE_AFTER}, 5 min) liegen, damit ein Gerät
     * nicht länger als nötig in einem überholten Zustand steht.
     */
    @Scheduled(fixedDelayString = "${voltpilot.ota.watcher-interval-ms:60000}",
            initialDelayString = "${voltpilot.ota.watcher-initial-delay-ms:30000}")
    public void tick() {
        try {
            rollouts.reconcile(Instant.now());
        } catch (Exception e) {
            // Ein Wächter, der an einem Durchlauf stirbt, hört auf zu wachen.
            log.warn("OTA rollout watcher tick failed: {}", e.getMessage());
        }
    }
}
