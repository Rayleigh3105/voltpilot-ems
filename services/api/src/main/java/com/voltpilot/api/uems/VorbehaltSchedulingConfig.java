package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link VorbehaltLaeufer} ein — an DENSELBEN Schalter gebunden
 * wie der Läufer (das Muster von {@link VerbundBilanzSchedulingConfig}).
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.vorbehalt.enabled", havingValue = "true", matchIfMissing = true)
public class VorbehaltSchedulingConfig {
}
