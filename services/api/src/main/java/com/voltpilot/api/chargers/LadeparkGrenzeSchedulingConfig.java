package com.voltpilot.api.chargers;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link LadeparkGrenzeLaeufer} ein — an DEMSELBEN Schalter wie
 * der Läufer selbst. Mehrere aktive {@code @EnableScheduling} sind unbedenklich.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.ladepark-grenze.enabled", havingValue = "true", matchIfMissing = true)
public class LadeparkGrenzeSchedulingConfig {
}
