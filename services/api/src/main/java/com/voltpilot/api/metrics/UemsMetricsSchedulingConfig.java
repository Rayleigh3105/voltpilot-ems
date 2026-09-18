package com.voltpilot.api.metrics;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstuetzung fuer {@link UemsMetricsCollector} ein.
 *
 * <p>Ein eigener Schalter neben {@link DbMetricsSchedulingConfig} und {@link MetricsSchedulingConfig},
 * aus demselben Grund: waere der UEMS-Sammler an den Datenhaltungs-Schalter gehaengt, liesse sich der
 * eine nicht ohne den anderen stilllegen; und ohne eigenes {@code @EnableScheduling} liefe er nicht
 * mehr, sobald jemand einen der anderen Sammler ausschaltet, diesen aber anlaesst.
 *
 * <p>Mehrere aktive {@code @EnableScheduling} sind unbedenklich: die Annotation importiert dieselbe
 * {@code SchedulingConfiguration}, und Spring verarbeitet den Import genau einmal (in
 * {@code FleetMetricsWiringTest} belegt).
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.metrics.uems.enabled", havingValue = "true",
        matchIfMissing = true)
public class UemsMetricsSchedulingConfig {
}
