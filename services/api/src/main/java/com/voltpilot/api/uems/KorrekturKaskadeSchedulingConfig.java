package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link KorrekturKaskadeLaeufer} ein — an DENSELBEN Schalter
 * gebunden wie der Läufer (das Muster von {@code ErsatzwertSchedulingConfig}): ist die Kaskade aus, gibt es auch keinen
 * Scheduler-Thread-Pool.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.kaskade.enabled", havingValue = "true", matchIfMissing = true)
public class KorrekturKaskadeSchedulingConfig {
}
