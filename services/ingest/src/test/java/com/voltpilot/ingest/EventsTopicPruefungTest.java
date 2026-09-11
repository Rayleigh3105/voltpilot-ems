package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.ListTopicsResult;
import org.apache.kafka.common.KafkaFuture;
import org.junit.jupiter.api.Test;
import org.springframework.boot.actuate.health.Status;

/**
 * Der Deploy-Schutz der Datenannahme (UEMS AP-07 IP-5): Topic {@code events.raw} fehlt → nicht
 * bereit; Topic da → bereit, und das bleibt so (zwischengespeichert, Redpanda wird nicht mehr
 * gefragt). Rein — der Admin-Client ist eine Attrappe.
 */
class EventsTopicPruefungTest {

    private final List<Admin> erzeugt = new ArrayList<>();

    private Admin admin(Set<String> topics) {
        Admin a = mock(Admin.class);
        ListTopicsResult r = mock(ListTopicsResult.class);
        when(r.names()).thenReturn(KafkaFuture.completedFuture(topics));
        when(a.listTopics()).thenReturn(r);
        erzeugt.add(a);
        return a;
    }

    @Test
    void topicFehltNichtBereitTopicDaBereitUndDasBleibtSo() {
        List<Set<String>> antworten = new ArrayList<>(List.of(
                Set.of("telemetry.raw", "measurements.raw"), Set.of("measurements.raw", "events.raw")));
        EventsTopicPruefung p = new EventsTopicPruefung(() -> admin(antworten.remove(0)), "events.raw");
        EventsTopicHealthIndicator bereitschaft = new EventsTopicHealthIndicator(p);

        assertThat(bereitschaft.health().getStatus()).isEqualTo(Status.DOWN);
        assertThat(erzeugt).hasSize(1);
        // Die Probe fragt häufiger, Redpanda wird aber höchstens alle ERNEUT_NACH gefragt.
        assertThat(p.vorhanden()).isFalse();
        assertThat(erzeugt).hasSize(1);

        EventsTopicPruefung frisch = new EventsTopicPruefung(() -> admin(antworten.remove(0)), "events.raw");
        assertThat(new EventsTopicHealthIndicator(frisch).health().getStatus()).isEqualTo(Status.UP);
        assertThat(frisch.vorhanden()).isTrue();
        assertThat(erzeugt).as("einmal gesehen, nie wieder gefragt").hasSize(2);
    }

    @Test
    void istRedpandaNichtErreichbarBleibtSieNichtBereit() {
        EventsTopicPruefung p = new EventsTopicPruefung(() -> {
            throw new IllegalStateException("redpanda unavailable");
        }, "events.raw");
        assertThat(new EventsTopicHealthIndicator(p).health().getStatus()).isEqualTo(Status.DOWN);
    }
}
