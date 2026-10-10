package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link LueckenLaeufer} ein — an DENSELBEN
 * Schalter gebunden wie der Läufer (das Muster von {@code EndgueltigkeitSchedulingConfig}): eine
 * Umgebung, in der der Melder aus ist, bekommt auch keinen Scheduler-Thread-Pool.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.uems.luecken.enabled", havingValue = "true", matchIfMissing = true)
public class LueckenSchedulingConfig {
}
