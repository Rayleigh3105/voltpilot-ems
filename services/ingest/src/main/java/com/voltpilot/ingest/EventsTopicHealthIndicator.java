package com.voltpilot.ingest;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * Health-Beitrag {@code eventsTopic}: UP, sobald das Topic {@code events.raw} existiert
 * ({@link EventsTopicPruefung}). Er steht in der Readiness-Gruppe
 * ({@code management.endpoint.health.group.readiness.include} in application.yml, Wächter
 * {@code K8sReadinessConfigTest}): ein Deploy ohne das Topic wird nie bereit.
 */
@Component
public class EventsTopicHealthIndicator implements HealthIndicator {

    private final EventsTopicPruefung pruefung;

    public EventsTopicHealthIndicator(EventsTopicPruefung pruefung) {
        this.pruefung = pruefung;
    }

    @Override
    public Health health() {
        return (pruefung.vorhanden() ? Health.up() : Health.down()).build();
    }
}
