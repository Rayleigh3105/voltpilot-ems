package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link StrukturAenderungLaeufer} ein — an DIESELBEN Schalter
 * gebunden wie der Läufer (das Muster von {@link KorrekturKaskadeSchedulingConfig}): ist er aus, gibt es auch keinen
 * Scheduler-Thread-Pool seinetwegen.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = {StrukturAenderungLaeufer.SCHALTER, BerichtKaskade.SCHALTER}, havingValue = "true",
        matchIfMissing = true)
public class StrukturAenderungSchedulingConfig {
}
