package com.voltpilot.ingest;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.config.SaslConfigs;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.AdditionalAnswers;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Datenannahme legt {@code events.raw} selbst an (seit 15.09.2026) — gegen ein echtes Redpanda:
 * fehlt es, wird es mit 3 Partitionen und 1 Replikat angelegt und sie wird bereit; ist es da, bleibt
 * es unverändert und wird kein zweites Mal angelegt; weicht es ab, wird es NICHT angepasst, sondern
 * gemeldet; darf sie nicht anlegen oder ist der Broker weg, bleibt sie nicht bereit und nennt den
 * Grund; abgeschaltet prüft sie nur, wie vorher. Jeder Fall hat sein eigenes Topic. Die Aufrufe des
 * Admin-Clients werden über eine durchreichende Attrappe mitgezählt.
 */
@Testcontainers(disabledWithoutDocker = true)
@ExtendWith(OutputCaptureExtension.class)
class EventsTopicAnlageTest {

    private static final DockerImageName BILD = DockerImageName.parse("redpandadata/redpanda:v24.2.7");
    private static final EventsTopicPruefung.Anlage DREI_EINS =
            new EventsTopicPruefung.Anlage(true, 3, (short) 1);

    @Container
    static final RedpandaContainer REDPANDA = new RedpandaContainer(BILD);

    private final List<Admin> gefragt = new ArrayList<>();

    private static Map<String, Object> verbindung(String bootstrap) {
        Map<String, Object> k = new HashMap<>();
        k.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap);
        k.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, 3000);
        k.put(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG, 3000);
        return k;
    }

    /** Echte Admin-Clients, deren Aufrufe mitgezählt werden. */
    private Supplier<Admin> beobachtet(Map<String, Object> konfiguration) {
        return () -> {
            Admin a = mock(Admin.class, AdditionalAnswers.delegatesTo(Admin.create(konfiguration)));
            gefragt.add(a);
            return a;
        };
    }

    private void nieAngelegtOderAngepasst() {
        assertThat(gefragt).isNotEmpty();
        for (Admin a : gefragt) {
            verify(a, never()).createTopics(anyCollection());
            verify(a, never()).createPartitions(anyMap());
            verify(a, never()).incrementalAlterConfigs(anyMap());
        }
    }

    /** Der Betrieb, der von außen nachsieht. */
    private static Admin betrieb() {
        return Admin.create(verbindung(REDPANDA.getBootstrapServers()));
    }

    private static void betriebLegtAn(String topic, int partitionen) throws Exception {
        try (Admin a = betrieb()) {
            a.createTopics(List.of(new NewTopic(topic, partitionen, (short) 1))).all().get(10, SECONDS);
        }
    }

    private static Set<String> topics() throws Exception {
        try (Admin a = betrieb()) {
            return a.listTopics().names().get(10, SECONDS);
        }
    }

    private static TopicDescription beschreibe(String topic) throws Exception {
        try (Admin a = betrieb()) {
            return a.describeTopics(List.of(topic)).allTopicNames().get(10, SECONDS).get(topic);
        }
    }

    /** Summe der End-Offsets über alle Partitionen = so viele Datensätze liegen im Topic. */
    private static long datensaetze(String topic) throws Exception {
        try (Admin a = betrieb()) {
            Map<TopicPartition, OffsetSpec> ende = new HashMap<>();
            for (var p : a.describeTopics(List.of(topic)).allTopicNames().get(10, SECONDS).get(topic).partitions()) {
                ende.put(new TopicPartition(topic, p.partition()), OffsetSpec.latest());
            }
            return a.listOffsets(ende).all().get(10, SECONDS).values().stream().mapToLong(o -> o.offset()).sum();
        }
    }

    @Test
    void fehltEsWirdEsMitDreiPartitionenAngelegtUndDieDatenannahmeWirdBereit(CapturedOutput log) throws Exception {
        String topic = "events.fehlt";
        assertThat(topics()).doesNotContain(topic);
        EventsTopicPruefung p = new EventsTopicPruefung(
                beobachtet(verbindung(REDPANDA.getBootstrapServers())), topic, DREI_EINS);

        Health h = new EventsTopicHealthIndicator(p).health();

        assertThat(h.getStatus()).isEqualTo(Status.UP);
        assertThat(h.getDetails()).doesNotContainKey("abweichung");
        TopicDescription d = beschreibe(topic);
        assertThat(d.partitions()).hasSize(3);
        assertThat(d.partitions()).allSatisfy(t -> assertThat(t.replicas()).hasSize(1));
        assertThat(log).contains(topic + " fehlte - von der Datenannahme angelegt mit 3 Partitionen und 1 Replikat(en)",
                topic + " vorhanden - die Datenannahme ist bereit");
        assertThat(gefragt).hasSize(1);
        verify(gefragt.get(0)).createTopics(anyCollection());
    }

    @Test
    void istEsSchonDaBleibtEsUnveraendertOhneZweiteAnlage(CapturedOutput log) throws Exception {
        String topic = "events.vorhanden";
        betriebLegtAn(topic, 3);
        try (KafkaProducer<String, String> producer = new KafkaProducer<>(Map.of(
                ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers(),
                ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class))) {
            producer.send(new ProducerRecord<>(topic, "t:s", "{\"schon\":\"da\"}")).get(10, SECONDS);
        }
        EventsTopicPruefung p = new EventsTopicPruefung(
                beobachtet(verbindung(REDPANDA.getBootstrapServers())), topic, DREI_EINS);

        Health h = new EventsTopicHealthIndicator(p).health();

        assertThat(h.getStatus()).isEqualTo(Status.UP);
        assertThat(h.getDetails()).doesNotContainKey("abweichung");
        nieAngelegtOderAngepasst();
        assertThat(beschreibe(topic).partitions()).hasSize(3);
        assertThat(datensaetze(topic)).as("nichts überschrieben").isEqualTo(1L);
        assertThat(log).doesNotContain("angelegt mit").doesNotContain("weicht ab");
    }

    @Test
    void weichtEsAbWirdEsNichtAngepasstSondernGemeldet(CapturedOutput log) throws Exception {
        String topic = "events.abweichend";
        betriebLegtAn(topic, 1);
        EventsTopicPruefung p = new EventsTopicPruefung(
                beobachtet(verbindung(REDPANDA.getBootstrapServers())), topic, DREI_EINS);

        Health h = new EventsTopicHealthIndicator(p).health();

        assertThat(h.getStatus()).as("das Topic funktioniert").isEqualTo(Status.UP);
        assertThat(h.getDetails()).containsEntry("abweichung", "1 Partitionen und 1 Replikat(e), erwartet 3 und 1");
        assertThat(log).contains(topic + " weicht ab: 1 Partitionen und 1 Replikat(e), erwartet 3 und 1",
                "es wird NICHT angepasst");
        nieAngelegtOderAngepasst();
        assertThat(beschreibe(topic).partitions()).as("unverändert").hasSize(1);
    }

    @Test
    void istDerBrokerWegBleibtSieNichtBereitUndNenntDenGrund(CapturedOutput log) throws Exception {
        int frei;
        try (ServerSocket s = new ServerSocket(0)) {
            frei = s.getLocalPort();
        }
        EventsTopicPruefung p = new EventsTopicPruefung(
                beobachtet(verbindung("127.0.0.1:" + frei)), "events.raw", DREI_EINS);

        assertThat(new EventsTopicHealthIndicator(p).health().getStatus()).isEqualTo(Status.DOWN);
        assertThat(log).contains("Redpanda-Topic events.raw nicht prüfbar (", "Timeout",
                "die Datenannahme bleibt NICHT bereit (readiness DOWN)");
        nieAngelegtOderAngepasst();
    }

    /**
     * Ein Redpanda mit Anmeldung und Rechteprüfung: das Konto der Datenannahme hat keine Rechte, der
     * Betrieb ist Superuser. Anlegen verweigert → nicht bereit, der Grund steht im Log, und es ist
     * auch kein Topic entstanden.
     */
    @Test
    void darfSieNichtAnlegenBleibtSieNichtBereitUndNenntDenGrund(CapturedOutput log) throws Exception {
        try (RedpandaContainer gesichert = new RedpandaContainer(BILD)
                .enableAuthorization().enableSasl().withSuperuser("betrieb")) {
            gesichert.start();
            kontoAnlegen(gesichert, "betrieb");
            kontoAnlegen(gesichert, "datenannahme");
            EventsTopicPruefung p = new EventsTopicPruefung(
                    () -> Admin.create(sasl(gesichert, "datenannahme")), "events.raw", DREI_EINS);

            assertThat(new EventsTopicHealthIndicator(p).health().getStatus()).isEqualTo(Status.DOWN);
            assertThat(log).contains("Redpanda-Topic events.raw FEHLT und konnte nicht angelegt werden (",
                    "AuthorizationException", "die Datenannahme bleibt NICHT bereit (readiness DOWN)",
                    "rpk topic create events.raw --partitions 3 --replicas 1");
            try (Admin betrieb = Admin.create(sasl(gesichert, "betrieb"))) {
                assertThat(betrieb.listTopics().names().get(10, SECONDS))
                        .as("nichts ist durchgerutscht").doesNotContain("events.raw");
            }
        }
    }

    @Test
    void abgeschaltetVerhaeltSieSichWieVorher(CapturedOutput log) throws Exception {
        String topic = "events.abgeschaltet";
        EventsTopicPruefung p = new EventsTopicPruefung(beobachtet(verbindung(REDPANDA.getBootstrapServers())),
                topic, new EventsTopicPruefung.Anlage(false, 3, (short) 1));

        assertThat(new EventsTopicHealthIndicator(p).health().getStatus()).isEqualTo(Status.DOWN);
        assertThat(log).contains("Redpanda-Topic " + topic + " FEHLT - die Datenannahme bleibt NICHT bereit");
        assertThat(topics()).doesNotContain(topic);
        nieAngelegtOderAngepasst();
        for (Admin a : gefragt) {
            verify(a, never()).describeTopics(anyCollection());
        }

        betriebLegtAn(topic, 3);
        EventsTopicPruefung frisch = new EventsTopicPruefung(beobachtet(verbindung(REDPANDA.getBootstrapServers())),
                topic, new EventsTopicPruefung.Anlage(false, 3, (short) 1));
        assertThat(new EventsTopicHealthIndicator(frisch).health().getStatus())
                .as("legt der Betrieb es an, wird sie bereit").isEqualTo(Status.UP);
    }

    private static void kontoAnlegen(RedpandaContainer broker, String name) throws Exception {
        HttpResponse<String> antwort = HttpClient.newHttpClient().send(HttpRequest
                .newBuilder(URI.create(broker.getAdminAddress() + "/v1/security/users"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"username\":\"" + name
                        + "\",\"password\":\"geheim-" + name + "\",\"algorithm\":\"SCRAM-SHA-256\"}"))
                .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(antwort.statusCode()).as(antwort.body()).isEqualTo(200);
    }

    private static Map<String, Object> sasl(RedpandaContainer broker, String name) {
        Map<String, Object> k = verbindung(broker.getBootstrapServers());
        k.put(AdminClientConfig.SECURITY_PROTOCOL_CONFIG, "SASL_PLAINTEXT");
        k.put(SaslConfigs.SASL_MECHANISM, "SCRAM-SHA-256");
        k.put(SaslConfigs.SASL_JAAS_CONFIG, "org.apache.kafka.common.security.scram.ScramLoginModule required "
                + "username=\"" + name + "\" password=\"geheim-" + name + "\";");
        return k;
    }
}
