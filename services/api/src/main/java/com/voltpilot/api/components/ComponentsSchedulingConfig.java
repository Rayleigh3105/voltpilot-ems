package com.voltpilot.api.components;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für
 * {@link ComponentAdoptionRunner#reconcile()} ein - den getakteten Abgleich, der
 * eine BESTANDSanlage übernimmt, sobald ihre Box ihre Verbindungen meldet.
 *
 * <p>Bewusst ein EIGENER Schalter statt des Feature-Flags
 * {@code voltpilot.components.adoption.enabled}: dessen Vorgabe ist AN (auch im
 * Testlauf, wo die Testklassen den Lauf ausdrücklich selbst anstoßen), und ein
 * getakteter Job im Testlauf ist die dokumentierte Falle - Spring CACHET
 * Testkontexte, während Testcontainers seine Container nach der Klasse STOPPT.
 * Die surefire-Konfiguration setzt deshalb
 * {@code voltpilot.components.adoption.reconcile-enabled=false}, während die
 * AUSGELIEFERTE Vorgabe AN ist ({@code matchIfMissing}) - festgenagelt von
 * {@code ComponentAdoptionWiringTest} an der echten {@code application.yml}.
 *
 * <p>Mehrere aktive {@code @EnableScheduling} sind unbedenklich (siehe
 * {@code EntitiesSchedulingConfig}/{@code OtaSchedulingConfig}): die Annotation
 * registriert einen idempotenten Post-Prozessor.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.components.adoption.reconcile-enabled",
        havingValue = "true", matchIfMissing = true)
public class ComponentsSchedulingConfig {
}
