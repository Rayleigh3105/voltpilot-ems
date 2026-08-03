package com.voltpilot.api.ota;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung ein - <b>ausschließlich</b>
 * für {@link RolloutWatcher}, den ersten und bislang einzigen getakteten Job
 * dieser Anwendung.
 *
 * <p>Bewusst an DENSELBEN Schalter gebunden wie der Wächter selbst statt
 * global auf der Hauptklasse: eine Umgebung, in der die OTA-Verteilung aus ist
 * (Tests, ein Deployment ohne Broker), bekommt damit auch keinen
 * Scheduler-Thread-Pool und kein verändertes Startverhalten. Wer den zweiten
 * getakteten Job baut, entscheidet dann bewusst, ob er hierher gehört oder ob
 * die Anwendung Scheduling generell einschaltet.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.ota.mqtt-listener-enabled", havingValue = "true")
public class OtaSchedulingConfig {
}
