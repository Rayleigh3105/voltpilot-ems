package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.IntStream;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.CreateTopicsResult;
import org.apache.kafka.clients.admin.DescribeTopicsResult;
import org.apache.kafka.clients.admin.ListTopicsResult;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.common.KafkaFuture;
import org.apache.kafka.common.Node;
import org.apache.kafka.common.TopicPartitionInfo;
import org.apache.kafka.common.errors.TopicAuthorizationException;
import org.apache.kafka.common.internals.KafkaFutureImpl;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.yaml.snakeyaml.Yaml;

/**
 * Der Deploy-Schutz der Datenannahme (UEMS AP-07 IP-5): Topic {@code events.raw} fehlt → nicht
 * bereit; Topic da → bereit, und das bleibt so (zwischengespeichert, Redpanda wird nicht mehr
 * gefragt). Seit 15.09.2026 legt sie ein fehlendes Topic selbst an: erst anlegen, dann
 * zurücklesen, dann bereit; ein vorhandenes wird nie angepasst. Rein — der Admin-Client ist eine
 * Attrappe; gegen ein echtes Redpanda: {@code EventsTopicAnlageTest}.
 */
@ExtendWith(OutputCaptureExtension.class)
class EventsTopicPruefungTest {

    private static final EventsTopicPruefung.Anlage DREI_EINS =
            new EventsTopicPruefung.Anlage(true, 3, (short) 1);

    private final List<Admin> erzeugt = new ArrayList<>();

    private Admin admin(Set<String> topics) {
        Admin a = mock(Admin.class);
        ListTopicsResult r = mock(ListTopicsResult.class);
        when(r.names()).thenReturn(KafkaFuture.completedFuture(topics));
        when(a.listTopics()).thenReturn(r);
        erzeugt.add(a);
        return a;
    }

    /** Ein Admin, der das Topic mit {@code partitionen} × {@code replikate} beschreibt. */
    private static void beschreibt(Admin a, int partitionen, int replikate) {
        Node knoten = new Node(0, "localhost", 9092);
        List<Node> replikatKnoten = IntStream.range(0, replikate).mapToObj(i -> knoten).toList();
        TopicDescription d = new TopicDescription("events.raw", false, IntStream.range(0, partitionen)
                .mapToObj(i -> new TopicPartitionInfo(i, knoten, replikatKnoten, replikatKnoten)).toList());
        DescribeTopicsResult r = mock(DescribeTopicsResult.class);
        when(r.allTopicNames()).thenReturn(KafkaFuture.completedFuture(Map.of("events.raw", d)));
        when(a.describeTopics(anyCollection())).thenReturn(r);
    }

    private static void legtAn(Admin a, KafkaFuture<Void> ergebnis) {
        CreateTopicsResult r = mock(CreateTopicsResult.class);
        when(r.all()).thenReturn(ergebnis);
        when(a.createTopics(anyCollection())).thenReturn(r);
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

    @Test
    void fehltEsWirdEsMitDerAnlageAngelegtZurueckgelesenUndErstDannBereit() {
        Admin a = admin(Set.of("telemetry.raw"));
        legtAn(a, KafkaFuture.completedFuture(null));
        beschreibt(a, 3, 1);
        EventsTopicPruefung p = new EventsTopicPruefung(() -> a, "events.raw", DREI_EINS);

        Health h = new EventsTopicHealthIndicator(p).health();

        assertThat(h.getStatus()).isEqualTo(Status.UP);
        assertThat(h.getDetails()).doesNotContainKey("abweichung");
        InOrder reihenfolge = inOrder(a);
        reihenfolge.verify(a).listTopics();
        reihenfolge.verify(a).createTopics(argThat(neu -> neu.size() == 1 && neu.stream().allMatch(t ->
                t.name().equals("events.raw") && t.numPartitions() == 3 && t.replicationFactor() == 1)));
        reihenfolge.verify(a).describeTopics(anyCollection());
    }

    @Test
    void istDasAnlegenNichtErlaubtBleibtSieNichtBereitUndNenntDenGrund(CapturedOutput log) {
        Admin a = admin(Set.of());
        KafkaFutureImpl<Void> verweigert = new KafkaFutureImpl<>();
        verweigert.completeExceptionally(new TopicAuthorizationException("Not authorized to create topic"));
        legtAn(a, verweigert);
        EventsTopicPruefung p = new EventsTopicPruefung(() -> a, "events.raw", DREI_EINS);

        assertThat(new EventsTopicHealthIndicator(p).health().getStatus()).isEqualTo(Status.DOWN);
        assertThat(p.vorhanden()).as("gedrosselt, und nichts rutscht durch").isFalse();
        assertThat(log).contains("events.raw FEHLT und konnte nicht angelegt werden",
                "TopicAuthorizationException", "readiness DOWN",
                "rpk topic create events.raw --partitions 3 --replicas 1");
        verify(a, never()).describeTopics(anyCollection());
    }

    @Test
    void einVorhandenesTopicMitAbweichungWirdNichtAngepasstSondernGemeldet(CapturedOutput log) {
        Admin a = admin(Set.of("events.raw"));
        beschreibt(a, 1, 1);
        EventsTopicPruefung p = new EventsTopicPruefung(() -> a, "events.raw", DREI_EINS);

        Health h = new EventsTopicHealthIndicator(p).health();

        assertThat(h.getStatus()).as("das Topic funktioniert").isEqualTo(Status.UP);
        assertThat(h.getDetails()).containsEntry("abweichung",
                "1 Partitionen und 1 Replikat(e), erwartet 3 und 1");
        assertThat(log).contains("events.raw weicht ab", "NICHT angepasst");
        verify(a, never()).createTopics(anyCollection());
        verify(a, never()).createPartitions(anyMap());
        verify(a, never()).incrementalAlterConfigs(anyMap());
    }

    @Test
    void abgeschaltetFragtSieNurWieVorher(CapturedOutput log) {
        Admin a = admin(Set.of("telemetry.raw"));
        EventsTopicPruefung p = new EventsTopicPruefung(() -> a, "events.raw",
                new EventsTopicPruefung.Anlage(false, 3, (short) 1));

        assertThat(new EventsTopicHealthIndicator(p).health().getStatus()).isEqualTo(Status.DOWN);
        assertThat(log).contains("events.raw FEHLT - die Datenannahme bleibt NICHT bereit");
        verify(a, never()).createTopics(anyCollection());
        verify(a, never()).describeTopics(anyCollection());
    }

    /** Die Vorgabe der ausgelieferten application.yml: an, mit den Werten von redpanda-init. */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeLegtMitDreiPartitionenUndEinemReplikatAn() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Map<String, Object> redpanda =
                (Map<String, Object>) ((Map<String, Object>) yml.get("voltpilot")).get("redpanda");
        assertThat((Map<String, Object>) redpanda.get("events-topic-anlegen")).containsExactlyInAnyOrderEntriesOf(Map.of(
                "enabled", "${REDPANDA_EVENTS_TOPIC_ANLEGEN:true}",
                "partitionen", "${REDPANDA_EVENTS_TOPIC_PARTITIONEN:3}",
                "replikate", "${REDPANDA_EVENTS_TOPIC_REPLIKATE:1}"));
    }
}
