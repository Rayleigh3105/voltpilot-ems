package com.voltpilot.api.entities;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Schaltet Springs {@code @Scheduled}-Unterstützung für
 * {@link V2SiteBackfillRunner#reconcile()} ein - den getakteten Abgleich, der
 * das Anlagen-Modell einer BESTANDSanlage ohne Deploy und ohne Klick nachzieht.
 *
 * <p>Bewusst ein EIGENER Schalter statt des Feature-Flags
 * {@code voltpilot.entities.backfill.enabled}: dessen Vorgabe ist AN (auch im
 * Testlauf, wo die Testklassen den Lauf ausdrücklich selbst anstoßen), und ein
 * getakteter Job im Testlauf ist die dokumentierte Falle - Spring CACHET
 * Testkontexte, während Testcontainers seine Container nach der Klasse STOPPT,
 * also liefe der Takt danach in jedem zwischengespeicherten Kontext gegen eine
 * tote Datenbank. Deshalb setzt die surefire-Konfiguration
 * {@code voltpilot.entities.backfill.reconcile-enabled=false}, während die
 * AUSGELIEFERTE Vorgabe AN ist ({@code matchIfMissing}) - festgenagelt von
 * {@code V2SiteBackfillReconcileWiringTest} an der echten {@code application.yml}.
 *
 * <p>Mehrere aktive {@code @EnableScheduling} sind unbedenklich (siehe
 * {@code OtaSchedulingConfig}): die Annotation registriert einen
 * idempotenten Post-Prozessor.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "voltpilot.entities.backfill.reconcile-enabled",
        havingValue = "true", matchIfMissing = true)
public class EntitiesSchedulingConfig {
}
