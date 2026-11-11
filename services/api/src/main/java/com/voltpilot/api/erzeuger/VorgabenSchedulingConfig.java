package com.voltpilot.api.erzeuger;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für {@link VorgabenLaeufer} ein — an DENSELBEN Schalter gebunden
 * wie der Läufer (das Muster von {@code LueckenSchedulingConfig}): eine Umgebung, in der die Vorgaben aus sind,
 * bekommt auch keinen Scheduler-Thread-Pool.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.erzeuger.vorgaben.enabled", havingValue = "true", matchIfMissing = true)
public class VorgabenSchedulingConfig {
}
