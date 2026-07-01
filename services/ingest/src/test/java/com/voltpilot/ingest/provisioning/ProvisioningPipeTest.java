package com.voltpilot.ingest.provisioning;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * End-to-end proof of the zero-touch provisioning resolver against a REAL
 * broker and database (contract: docs/contracts/mqtt-provisioning.schema.json):
 *
 * <ul>
 *   <li><b>claimed ref</b> - a hello is answered with the retained
 *       {@code provision/{ref}/config} carrying the claimed identity;</li>
 *   <li><b>re-provision after restart</b> - a fresh subscriber receives the
 *       RETAINED config without a new hello;</li>
 *   <li><b>unclaimed ref</b> - a hello gets no answer (the device retries);</li>
 *   <li><b>claim-later</b> - once the ref is claimed (row inserted), the next
 *       hello converges.</li>
 * </ul>
 *
 * <p>Throwaway containers on random ports; auto-skips without Docker. Kafka is
 * pointed at a closed port - the telemetry pipe is not exercised here and the
 * producer never connects until a send.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ProvisioningPipeTest {

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
            .withExposedPorts(1883)
            .waitingFor(Wait.forLogMessage(".*is running now.*", 1).withStartupTimeout(Duration.ofMinutes(2)));

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("voltpilot.mqtt.broker-url",
                () -> "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883));
        registry.add("voltpilot.provisioning.db.jdbc-url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.provisioning.db.username", POSTGRES::getUsername);
        registry.add("voltpilot.provisioning.db.password", POSTGRES::getPassword);
        // No Kafka in this test: the telemetry producer never sends.
        registry.add("spring.kafka.bootstrap-servers", () -> "localhost:1");
    }

    private final ObjectMapper mapper = new ObjectMapper();
    private MqttClient client;

    @BeforeAll
    static void schema() throws Exception {
        // Minimal mirror of the api-owned `device` table (only what the resolver reads).
        exec("CREATE TABLE IF NOT EXISTS device ("
                + "id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "
                + "tenant_id uuid NOT NULL, site_id uuid NOT NULL, "
                + "external_ref text NOT NULL UNIQUE, kind text, status text)");
    }

    @AfterEach
    void disconnect() throws Exception {
        if (client != null && client.isConnected()) {
            client.disconnect();
        }
        client = null;
    }

    @Test
    void helloForClaimedRefYieldsRetainedConfigAndReprovisionWorks() throws Exception {
        String ref = "pipe-claimed-01";
        UUID deviceId = UUID.randomUUID();
        insertDevice(ref, deviceId);

        BlockingQueue<String> configs = connectAndSubscribe("provision/" + ref + "/config");
        publishHello(ref);

        String config = configs.poll(15, TimeUnit.SECONDS);
        assertThat(config).as("config for a claimed ref").isNotNull();
        JsonNode node = mapper.readTree(config);
        assertThat(node.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(node.get("ref").asText()).isEqualTo(ref);
        assertThat(node.get("tenant_id").asText()).isEqualTo(TENANT);
        assertThat(node.get("site_id").asText()).isEqualTo(SITE);
        assertThat(node.get("device_id").asText()).isEqualTo(deviceId.toString());

        // Re-provision after restart: a brand-new subscriber gets the RETAINED
        // config immediately, without publishing another hello.
        disconnect();
        BlockingQueue<String> retained = connectAndSubscribe("provision/" + ref + "/config");
        String replay = retained.poll(10, TimeUnit.SECONDS);
        assertThat(replay).as("retained config on re-subscribe").isNotNull();
        assertThat(mapper.readTree(replay).get("device_id").asText()).isEqualTo(deviceId.toString());
    }

    @Test
    void helloForUnclaimedRefGetsNoAnswerUntilClaimed() throws Exception {
        String ref = "pipe-later-01";
        BlockingQueue<String> configs = connectAndSubscribe("provision/" + ref + "/config");

        // Unclaimed: no answer (the real device just keeps retrying hello).
        publishHello(ref);
        assertThat(configs.poll(3, TimeUnit.SECONDS)).as("no config before the claim").isNull();

        // Claim-later: the ref is claimed, the device's next hello retry converges.
        UUID deviceId = UUID.randomUUID();
        insertDevice(ref, deviceId);
        publishHello(ref);
        String config = configs.poll(15, TimeUnit.SECONDS);
        assertThat(config).as("config after the claim").isNotNull();
        assertThat(mapper.readTree(config).get("device_id").asText()).isEqualTo(deviceId.toString());
    }

    // ---- helpers -------------------------------------------------------------

    private BlockingQueue<String> connectAndSubscribe(String topic) throws Exception {
        BlockingQueue<String> received = new ArrayBlockingQueue<>(10);
        client = new MqttClient("tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "pipe-test-" + UUID.randomUUID(), new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        client.connect(options);
        client.subscribe(topic, 1, (t, msg) -> received.add(new String(msg.getPayload())));
        return received;
    }

    private void publishHello(String ref) throws Exception {
        String hello = "{\"schema_version\":\"1.0\",\"ref\":\"" + ref + "\"}";
        client.publish("provision/" + ref + "/hello", new MqttMessage(hello.getBytes()));
    }

    private static void insertDevice(String ref, UUID deviceId) throws Exception {
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) VALUES ('"
                + deviceId + "', '" + TENANT + "', '" + SITE + "', '" + ref + "', 'inverter', 'claimed')");
    }

    private static void exec(String sql) throws Exception {
        try (Connection conn = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement stmt = conn.createStatement()) {
            stmt.execute(sql);
        }
    }
}
