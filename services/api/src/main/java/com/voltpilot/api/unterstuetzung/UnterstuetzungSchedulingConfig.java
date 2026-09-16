package com.voltpilot.api.unterstuetzung;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für den {@link AblaufLaeufer} ein (UEMS AP-03 IP-8).
 *
 * <p>An DENSELBEN Schalter gebunden wie der Läufer selbst (das Muster von {@code EndgueltigkeitSchedulingConfig}):
 * eine Umgebung, in der der Takt aus ist, bekommt dadurch auch keinen Scheduler-Thread-Pool.
 *
 * <p>Mehrere aktive {@code @EnableScheduling} sind unbedenklich — die Annotation registriert den Nachbearbeiter
 * idempotent.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.unterstuetzung.enabled", havingValue = "true", matchIfMissing = true)
public class UnterstuetzungSchedulingConfig {
}
