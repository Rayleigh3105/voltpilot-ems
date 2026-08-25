package com.voltpilot.api.interventions;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für
 * {@link DeviceOverrideRenewalRunner#renew()} ein (Steuerung Stufe 4, B6).
 *
 * <p>Eigener Schalter aus demselben Grund wie {@code EntitiesSchedulingConfig}:
 * die AUSGELIEFERTE Vorgabe ist AN, im Testlauf setzt surefire ihn auf
 * {@code false} - ein getakteter Job im Testlauf ist die dokumentierte Falle
 * (zwischengespeicherte Spring-Kontexte gegen gestoppte Testcontainer). Mehrere
 * aktive {@code @EnableScheduling} sind unbedenklich (die Annotation
 * registriert einen idempotenten Post-Prozessor).
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.interventions.renewal-enabled",
        havingValue = "true", matchIfMissing = true)
public class InterventionSchedulingConfig {
}
