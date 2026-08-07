package com.voltpilot.api.metrics;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für
 * {@link FleetMetricsCollector} ein.
 *
 * <p>Der zweite getaktete Job dieser Anwendung, und damit die Entscheidung, die
 * {@code OtaSchedulingConfig} ausdrücklich offen gelassen hat („wer den zweiten
 * getakteten Job baut, entscheidet dann bewusst, ob er hierher gehört oder ob
 * die Anwendung Scheduling generell einschaltet"). Entschieden: <b>weiterhin je
 * Job ein eigener Schalter</b>, nicht global auf der Hauptklasse. Beide Jobs
 * sind unabhängig abschaltbar (der eine hängt am OTA-Status-Ingest, dieser an
 * der Metrik-Sammlung), und eine Umgebung, die beide aus hat, bekommt weiterhin
 * gar keinen Scheduler-Thread-Pool und kein verändertes Startverhalten.
 *
 * <p>Zwei aktive {@code @EnableScheduling} sind unbedenklich: die Annotation
 * importiert {@code SchedulingConfiguration}, und Spring verarbeitet denselben
 * Import genau einmal.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.metrics.fleet.enabled", havingValue = "true",
        matchIfMissing = true)
public class MetricsSchedulingConfig {
}
