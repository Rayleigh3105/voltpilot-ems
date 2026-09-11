package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.errors.TopicExistsException;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * End-to-end proof of the FIRST half of the live pipe against real brokers:
 * publish an edge-shaped MQTT telemetry message to EMQX and assert the ingest
 * service validates it and produces a contract-shaped {@code telemetry.raw}
 * event to Redpanda, keyed by {@code {tenant_id}:{site_id}}.
 *
 * <p>The SECOND half (telemetry.raw -> TimescaleDB hypertable) is proven by
 * {@code WriterPipeTest} in services/timescale-writer against the same frozen
 * event contract. Together they cover MQTT -> Redpanda -> Timescale.
 *
 * <p>Throwaway containers on random ports (never the shared dev stack).
 * Auto-skips where Docker is unavailable.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
// Close the context after the class so the MQTT adapter disconnects (stopping
// Paho's non-daemon client threads) before the fork exits - otherwise surefire
// waits out its 30s force-kill timeout on a lingering thread.
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class IngestPipeTest {

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry";
    private static final String RAW_TOPIC = "telemetry.raw";
    private static final String V2_TOPIC =
            "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/telemetry";
    private static final String V2_RAW_TOPIC = "telemetry-v2.raw";
    private static final String MEASUREMENT_TOPIC =
            "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/measurement-samples";
    private static final String MEASUREMENTS_RAW_TOPIC = "measurements.raw";
    private static final String EVENTS_RAW_TOPIC = "events.raw";

    /**
     * The fixtures carry fixed measurement times (2026-07-18 / 2026-08-25): a FIXED arrival clock
     * keeps them inside the E13 window (UEMS AP-07 IP-5) forever, instead of turning into too_old
     * 90 days after they were written.
     */
    @TestConfiguration
    static class FesteEingangsuhr {
        @Bean
        @Primary
        Clock pipeClock() {
            return Clock.fixed(Instant.parse("2026-08-25T12:00:30Z"), ZoneOffset.UTC);
        }
    }

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
            .withExposedPorts(1883)
            .waitingFor(Wait.forLogMessage(".*is running now.*", 1).withStartupTimeout(Duration.ofMinutes(2)));

    @Container
    static final RedpandaContainer REDPANDA =
            new RedpandaContainer(DockerImageName.parse("redpandadata/redpanda:v24.2.7"));

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("voltpilot.mqtt.broker-url",
                () -> "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883));
        registry.add("spring.kafka.bootstrap-servers", REDPANDA::getBootstrapServers);
        registry.add("voltpilot.redpanda.telemetry-topic", () -> RAW_TOPIC);
        registry.add("voltpilot.redpanda.measurements-topic", () -> MEASUREMENTS_RAW_TOPIC);
        registry.add("voltpilot.redpanda.events-topic", () -> EVENTS_RAW_TOPIC);
    }

    private final ObjectMapper mapper = new ObjectMapper();

    @Autowired EventsTopicPruefung eventsTopic;
    @Autowired KafkaAdmin kafkaAdmin;

    @Test
    void mqttTelemetryFlowsToRedpandaRawTopic() throws Exception {
        createTopic();

        String payload = "{"
                + "\"schema_version\":\"1.0\","
                + "\"tenant_id\":\"" + TENANT + "\","
                + "\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\","
                + "\"ts\":\"2026-07-01T08:58:45.827Z\","
                + "\"seq\":24,"
                + "\"measurements\":{\"power_kw\":2.29,\"soc_pct\":55.1,\"pv_power_kw\":16.9,"
                + "\"load_kw\":9.58,\"grid_limit_kw\":50}"
                + "}";

        try (KafkaConsumer<String, String> consumer = consumer()) {
            consumer.subscribe(List.of(RAW_TOPIC));

            // Publish repeatedly until the event is observed: the ingest adapter
            // must be connected/subscribed to the broker before a non-retained
            // QoS1 message is delivered, and that happens asynchronously at boot.
            ConsumerRecord<String, String> record = publishUntilReceived(payload, consumer);

            assertThat(record.key()).isEqualTo(TENANT + ":" + SITE);
            JsonNode event = mapper.readTree(record.value());
            assertThat(event.get("schema_version").asText()).isEqualTo("1.0");
            assertThat(event.get("tenant_id").asText()).isEqualTo(TENANT);
            assertThat(event.get("site_id").asText()).isEqualTo(SITE);
            assertThat(event.get("device_id").asText()).isEqualTo(DEVICE);
            assertThat(event.get("observed_at").asText()).startsWith("2026-07-01T08:58:45");
            assertThat(event.get("ingested_at").asText()).isNotBlank();
            assertThat(event.get("event_id").asText()).isNotBlank();
            assertThat(event.get("source_topic").asText()).isEqualTo(TOPIC);
            assertThat(event.get("measurements").get("grid_limit_kw").asDouble()).isEqualTo(50.0);
            assertThat(event.get("measurements").get("soc_pct").asDouble()).isEqualTo(55.1);
        }
    }

    /**
     * The v2 leg (dual-consume): the CONTRACT FIXTURE
     * mqtt-telemetry-2.0.valid.three-entities.json - which carries the same
     * tenant/site/device identity as this test - published verbatim on the v2
     * topic lands as a telemetry-v2.raw event on its OWN Kafka topic, entities
     * carried through unchanged. The v1 flow above is byte-identical untouched
     * (the v1 single-level wildcard never matches the 6-segment v2 topic).
     */
    @Test
    void mqttV2TelemetryFlowsToItsOwnRawTopic() throws Exception {
        createTopic(V2_RAW_TOPIC);
        String payload = java.nio.file.Files.readString(java.nio.file.Path.of(
                "../../docs/contracts/v2/examples/mqtt-telemetry-2.0.valid.three-entities.json"));

        try (KafkaConsumer<String, String> consumer = consumer()) {
            consumer.subscribe(List.of(V2_RAW_TOPIC));
            ConsumerRecord<String, String> record =
                    publishUntilReceived(V2_TOPIC, payload, consumer, V2_RAW_TOPIC);

            assertThat(record.key()).isEqualTo(TENANT + ":" + SITE);
            JsonNode event = mapper.readTree(record.value());
            assertThat(event.get("schema_version").asText()).isEqualTo("1.0");
            assertThat(event.get("tenant_id").asText()).isEqualTo(TENANT);
            assertThat(event.get("site_id").asText()).isEqualTo(SITE);
            assertThat(event.get("device_id").asText()).isEqualTo(DEVICE);
            assertThat(event.get("source_topic").asText()).isEqualTo(V2_TOPIC);
            // UEMS AP-07 IP-5: the box's seq is forwarded unchanged.
            assertThat(event.get("seq").asLong()).isEqualTo(4711L);
            JsonNode entities = event.get("entities");
            assertThat(entities.size()).isEqualTo(3);
            assertThat(entities.get("5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f")
                    .get("channels").get("soc_pct").asDouble()).isEqualTo(62.5);
            assertThat(entities.get("7b2f4e10-8d3c-4e5f-b0a1-2c3d4e5f6071")
                    .get("channels").get("power_kw").asDouble()).isEqualTo(-49.7);
        }
    }

    @Test
    void additionalMeasurementFixtureFlowsToItsOwnRawTopic() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String payload = java.nio.file.Files.readString(java.nio.file.Path.of(
                "../../docs/contracts/v2/examples/mqtt-measurement-samples.valid.json"));

        try (KafkaConsumer<String, String> consumer = consumer()) {
            consumer.subscribe(List.of(MEASUREMENTS_RAW_TOPIC));
            ConsumerRecord<String, String> record = publishUntilReceived(
                    MEASUREMENT_TOPIC, payload, consumer, MEASUREMENTS_RAW_TOPIC);

            assertThat(record.key()).isEqualTo(TENANT + ":" + SITE + ":" + DEVICE);
            JsonNode event = mapper.readTree(record.value());
            assertThat(event.get("schema_version").asText()).isEqualTo("1.0");
            assertThat(event.get("catalog_version").asText()).isEqualTo("2026.08.25.1");
            assertThat(event.get("sequence").asLong()).isEqualTo(42L);
            assertThat(event.get("source_topic").asText()).isEqualTo(MEASUREMENT_TOPIC);
            assertThat(event.get("samples").get(0).get("raw").asLong()).isEqualTo(537L);
            assertThat(event.get("samples").get(0).get("decoded").asDouble()).isEqualTo(53.7);
        }
    }

    /**
     * UEMS AP-07 IP-5, both paths into events.raw: the box envelope fixture on v2/events lands as
     * one urheber-box record per entry (the box adapter connects only once events.raw exists), and
     * a measurement envelope with one bad sample leaves its good sample on measurements.raw plus
     * ONE urheber-datenannahme rejected on events.raw.
     */
    @Test
    void boxEventsAndRefusalsLandOnEventsRaw() throws Exception {
        // The readiness gate against a real Redpanda: a missing topic is "not there", events.raw is.
        assertThat(new EventsTopicPruefung(kafkaAdmin, "gibt-es-nicht.raw").vorhanden()).isFalse();
        createTopic(EVENTS_RAW_TOPIC);
        // The check asks Redpanda at most every 10 s; the box adapter connects once it has seen the topic.
        long bis = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (!eventsTopic.vorhanden() && System.nanoTime() < bis) {
            Thread.sleep(500);
        }
        assertThat(eventsTopic.vorhanden()).isTrue();
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String envelope = java.nio.file.Files.readString(java.nio.file.Path.of(
                "../../docs/contracts/v2/examples/mqtt-events-2.1.valid.restart.json"));
        JsonNode u = mapper.readTree(envelope);
        String eventsTopic = "ems/" + u.get("tenant_id").asText() + "/" + u.get("site_id").asText()
                + "/" + u.get("device_id").asText() + "/v2/events";
        // The fixture was formed 2027-02-01T07:01:30Z; this box clock matches the pipe clock.
        String now = ((ObjectNode) u).put("observed_at", "2026-08-25T12:00:25Z").toString();

        try (KafkaConsumer<String, String> consumer = consumer()) {
            consumer.subscribe(List.of(EVENTS_RAW_TOPIC));
            ConsumerRecord<String, String> record =
                    publishUntilReceived(eventsTopic, now, consumer, EVENTS_RAW_TOPIC);
            assertThat(record.key()).isEqualTo(u.get("tenant_id").asText() + ":" + u.get("site_id").asText());
            JsonNode event = mapper.readTree(record.value());
            assertThat(event.get("urheber").asText()).isEqualTo("box");
            assertThat(event.get("source_topic").asText()).isEqualTo(eventsTopic);
            assertThat(event.get("ereignis").get("box").asText()).isEqualTo(u.get("device_id").asText());
        }

        String bad = java.nio.file.Files.readString(java.nio.file.Path.of(
                "../../docs/contracts/v2/examples/mqtt-measurement-samples.valid.json"))
                .replace("\"samples\":[", "\"samples\":[{\"point_key\":\"goe.api_v2.car\",\"quality\":\"good\"},");
        try (KafkaConsumer<String, String> consumer = consumer()) {
            consumer.subscribe(List.of(EVENTS_RAW_TOPIC));
            ConsumerRecord<String, String> record = null;
            long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
            while (record == null && System.nanoTime() < deadline) {
                publish(MEASUREMENT_TOPIC, bad);
                for (ConsumerRecord<String, String> r : consumer.poll(Duration.ofSeconds(2))) {
                    if ("datenannahme".equals(mapper.readTree(r.value()).path("urheber").asText())) {
                        record = r;
                    }
                }
            }
            assertThat(record).as("rejected on events.raw").isNotNull();
            JsonNode ereignis = mapper.readTree(record.value()).get("ereignis");
            assertThat(ereignis.get("art").asText()).isEqualTo("rejected");
            assertThat(ereignis.get("grund").asText()).isEqualTo("schema_verletzt");
            assertThat(ereignis.get("anzahl").asLong()).isEqualTo(1L);
            assertThat(ereignis.get("sequenz").asLong()).isEqualTo(42L);
            assertThat(ereignis.get("box").asText()).isEqualTo(DEVICE);
        }
    }

    private void createTopic() throws Exception {
        createTopic(RAW_TOPIC);
    }

    private void createTopic(String name) throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(name, 3, (short) 1))).all().get();
        } catch (ExecutionException e) {
            // Redpanda may auto-create the topic under the producer; that's fine.
            if (!(e.getCause() instanceof TopicExistsException)) {
                throw e;
            }
        }
    }

    private ConsumerRecord<String, String> publishUntilReceived(
            String payload, KafkaConsumer<String, String> consumer) throws Exception {
        return publishUntilReceived(TOPIC, payload, consumer, RAW_TOPIC);
    }

    private ConsumerRecord<String, String> publishUntilReceived(String mqttTopic,
            String payload, KafkaConsumer<String, String> consumer, String rawTopic)
            throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        while (System.nanoTime() < deadline) {
            publish(mqttTopic, payload);
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(2));
            if (!records.isEmpty()) {
                return records.iterator().next();
            }
        }
        throw new AssertionError(rawTopic + " event never arrived within timeout");
    }

    private void publish(String mqttTopic, String payload) throws Exception {
        String url = "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
        MqttClient client = new MqttClient(url, "it-pub-" + UUID.randomUUID(), new MemoryPersistence());
        try {
            MqttConnectOptions opts = new MqttConnectOptions();
            opts.setCleanSession(true);
            client.connect(opts);
            MqttMessage msg = new MqttMessage(payload.getBytes());
            msg.setQos(1);
            client.publish(mqttTopic, msg);
        } finally {
            if (client.isConnected()) {
                client.disconnect();
            }
            client.close();
        }
    }

    private KafkaConsumer<String, String> consumer() {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "it-verify-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        return new KafkaConsumer<>(props);
    }
}
