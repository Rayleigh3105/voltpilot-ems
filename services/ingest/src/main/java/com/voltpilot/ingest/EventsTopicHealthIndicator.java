package com.voltpilot.ingest;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * Health-Beitrag {@code eventsTopic}: UP, sobald das Topic {@code events.raw} existiert
 * ({@link EventsTopicPruefung}). Er steht in der Readiness-Gruppe
 * ({@code management.endpoint.health.group.readiness.include} in application.yml, Wächter
 * {@code K8sReadinessConfigTest}): ein Deploy, dessen Topic weder da ist noch angelegt werden
 * kann, wird nie bereit. Weicht ein vorhandenes Topic von der Anlage ab, bleibt er UP und trägt
 * das Detail {@code abweichung} — das Topic funktioniert, angepasst wird es nur vom Betrieb.
 */
@Component
public class EventsTopicHealthIndicator implements HealthIndicator {

    private final EventsTopicPruefung pruefung;

    public EventsTopicHealthIndicator(EventsTopicPruefung pruefung) {
        this.pruefung = pruefung;
    }

    @Override
    public Health health() {
        Health.Builder b = pruefung.vorhanden() ? Health.up() : Health.down();
        pruefung.abweichung().ifPresent(text -> b.withDetail("abweichung", text));
        return b.build();
    }
}
