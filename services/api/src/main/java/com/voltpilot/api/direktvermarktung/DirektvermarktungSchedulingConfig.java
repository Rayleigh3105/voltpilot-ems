package com.voltpilot.api.direktvermarktung;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für den {@link DirektvermarktungNachtlauf} ein (Muster
 * {@code UnterstuetzungSchedulingConfig}): an denselben Schalter gebunden wie der Läufer selbst, damit eine
 * Umgebung, in der der Takt aus ist, dadurch auch keinen Scheduler-Thread-Pool bekommt.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.direktvermarktung.nachtlauf.enabled", havingValue = "true",
        matchIfMissing = true)
public class DirektvermarktungSchedulingConfig {
}
