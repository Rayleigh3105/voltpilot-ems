package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link ErsatzwertLaeufer} ein — an DENSELBEN Schalter
 * gebunden wie der Läufer (das Muster von {@code LueckenSchedulingConfig}): ist der Lauf aus, gibt es auch
 * keinen Scheduler-Thread-Pool.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.ersatzwert.enabled", havingValue = "true", matchIfMissing = true)
public class ErsatzwertSchedulingConfig {
}
