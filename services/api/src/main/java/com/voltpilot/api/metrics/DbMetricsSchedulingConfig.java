package com.voltpilot.api.metrics;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstuetzung fuer
 * {@link DbHealthMetricsCollector} ein.
 *
 * <p>Ein eigener Schalter neben {@link MetricsSchedulingConfig}, damit der
 * Datenhaltungs-Sammler unabhaengig vom Flotten-Sammler abschaltbar ist
 * ({@code voltpilot.metrics.db.enabled} vs. {@code voltpilot.metrics.fleet.enabled}).
 * Waeren beide an denselben Schalter gehaengt, koennte man den einen nicht ohne
 * den anderen stilllegen; und waere hier kein eigenes {@code @EnableScheduling},
 * liefe der Job nicht, sobald jemand den Flotten-Sammler ausschaltet, aber
 * diesen anlaesst.
 *
 * <p>Mehrere aktive {@code @EnableScheduling} sind unbedenklich: die Annotation
 * importiert dieselbe {@code SchedulingConfiguration}, und Spring verarbeitet
 * den Import genau einmal (in {@code FleetMetricsWiringTest} belegt).
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.metrics.db.enabled", havingValue = "true",
        matchIfMissing = true)
public class DbMetricsSchedulingConfig {
}
