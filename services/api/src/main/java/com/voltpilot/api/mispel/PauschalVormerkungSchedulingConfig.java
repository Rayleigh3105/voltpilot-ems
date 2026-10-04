package com.voltpilot.api.mispel;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link PauschalVormerkungLaeufer} ein — an DEMSELBEN Schalter
 * wie der Läufer selbst. Mehrere aktive {@code @EnableScheduling} sind unbedenklich.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.mispel.pauschal-vormerkung.enabled", havingValue = "true",
        matchIfMissing = true)
public class PauschalVormerkungSchedulingConfig {
}
