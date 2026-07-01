package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
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
import org.springframework.boot.test.context.SpringBootTest;
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
    }

    private final ObjectMapper mapper = new ObjectMapper();

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

    private void createTopic() throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(RAW_TOPIC, 3, (short) 1))).all().get();
        } catch (ExecutionException e) {
            // Redpanda may auto-create the topic under the producer; that's fine.
            if (!(e.getCause() instanceof TopicExistsException)) {
                throw e;
            }
        }
    }

    private ConsumerRecord<String, String> publishUntilReceived(
            String payload, KafkaConsumer<String, String> consumer) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        while (System.nanoTime() < deadline) {
            publish(payload);
            ConsumerRecords<String, String> records = consumer.poll(Duration.ofSeconds(2));
            if (!records.isEmpty()) {
                return records.iterator().next();
            }
        }
        throw new AssertionError("telemetry.raw event never arrived within timeout");
    }

    private void publish(String payload) throws Exception {
        String url = "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
        MqttClient client = new MqttClient(url, "it-pub-" + UUID.randomUUID(), new MemoryPersistence());
        try {
            MqttConnectOptions opts = new MqttConnectOptions();
            opts.setCleanSession(true);
            client.connect(opts);
            MqttMessage msg = new MqttMessage(payload.getBytes());
            msg.setQos(1);
            client.publish(TOPIC, msg);
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
