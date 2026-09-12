package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link EndgueltigkeitLaeufer} ein.
 *
 * <p>An DENSELBEN Schalter gebunden wie der Läufer selbst (das Muster von
 * {@code ViertelstundeSchedulingConfig}): eine Umgebung, in der die Endgültigkeit aus ist, bekommt
 * dadurch auch keinen Scheduler-Thread-Pool.
 *
 * <p>Mehrere aktive {@code @EnableScheduling} sind unbedenklich — die Annotation registriert den
 * Nachbearbeiter idempotent.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.endgueltigkeit.enabled",
        havingValue = "true", matchIfMissing = true)
public class EndgueltigkeitSchedulingConfig {
}
