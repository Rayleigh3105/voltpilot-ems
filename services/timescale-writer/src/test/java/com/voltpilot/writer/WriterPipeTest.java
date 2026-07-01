package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.errors.TopicExistsException;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.redpanda.RedpandaContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * End-to-end proof of the SECOND half of the live pipe against real infra:
 * produce a contract-shaped {@code telemetry.raw} event to Redpanda and assert
 * the writer inserts exactly the expected row into the TimescaleDB
 * {@code telemetry} hypertable under the right tenant, and that the row is
 * visible to that tenant through RLS (and hidden from another tenant).
 *
 * <p>Paired with {@code IngestPipeTest} in services/ingest (MQTT -> telemetry.raw),
 * this closes the full MQTT -> Redpanda -> Timescale path across the frozen
 * event contract.
 *
 * <p>Throwaway containers on random ports (never the shared dev stack).
 * Auto-skips where Docker is unavailable.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
class WriterPipeTest {

    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String OBSERVED_AT = "2026-07-01T08:58:45.827Z";
    private static final String RAW_TOPIC = "telemetry.raw";
    private static final String APP_PW = "voltpilot_app_test_pw";

    @Container
    static final RedpandaContainer REDPANDA =
            new RedpandaContainer(DockerImageName.parse("redpandadata/redpanda:v24.2.7"));

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withInitScript("writer-schema.sql");

    @DynamicPropertySource
    static void wire(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", REDPANDA::getBootstrapServers);
        registry.add("voltpilot.redpanda.telemetry-topic", () -> RAW_TOPIC);
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> "voltpilot_app");
        registry.add("spring.datasource.password", () -> APP_PW);
    }

    private static String event(String tenant) {
        return "{"
                + "\"schema_version\":\"1.0\","
                + "\"event_id\":\"" + UUID.randomUUID() + "\","
                + "\"tenant_id\":\"" + tenant + "\","
                + "\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + DEVICE + "\","
                + "\"observed_at\":\"" + OBSERVED_AT + "\","
                + "\"ingested_at\":\"2026-07-01T08:58:46.000Z\","
                + "\"source_topic\":\"ems/" + tenant + "/" + SITE + "/" + DEVICE + "/telemetry\","
                + "\"measurements\":{\"power_kw\":2.29,\"soc_pct\":55.1,\"pv_power_kw\":16.9,"
                + "\"load_kw\":9.58,\"grid_limit_kw\":50}"
                + "}";
    }

    @Test
    void rawEventLandsInHypertableUnderTheRightTenant() throws Exception {
        createTopic();

        // A duplicate delivery of the same (device_id, ts) must not double-write.
        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE;
            producer.send(new ProducerRecord<>(RAW_TOPIC, key, event(TENANT_A))).get();
            producer.send(new ProducerRecord<>(RAW_TOPIC, key, event(TENANT_A))).get();
            producer.flush();
        }

        awaitRowCount(1);

        // The row carries the right identity + measurements (read as superuser).
        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT tenant_id, site_id, device_id, power_kw, soc_pct, grid_limit_kw "
                                + "FROM telemetry WHERE device_id = '" + DEVICE + "'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("tenant_id")).isEqualTo(TENANT_A);
            assertThat(rs.getString("site_id")).isEqualTo(SITE);
            assertThat(rs.getString("device_id")).isEqualTo(DEVICE);
            assertThat(rs.getBigDecimal("power_kw")).isEqualByComparingTo("2.29");
            assertThat(rs.getBigDecimal("soc_pct")).isEqualByComparingTo("55.1");
            assertThat(rs.getBigDecimal("grid_limit_kw")).isEqualByComparingTo("50");
        }

        // RLS: visible to the owning tenant, invisible to another (portal parity).
        assertThat(rlsVisibleCount(TENANT_A)).isEqualTo(1);
        assertThat(rlsVisibleCount(TENANT_B)).isEqualTo(0);
    }

    private void createTopic() throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(RAW_TOPIC, 3, (short) 1))).all().get();
        } catch (ExecutionException e) {
            // Redpanda may auto-create the topic when the writer's consumer
            // subscribes first; an already-existing topic is fine.
            if (!(e.getCause() instanceof TopicExistsException)) {
                throw e;
            }
        }
    }

    private KafkaProducer<String, String> producer() {
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, REDPANDA.getBootstrapServers());
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        return new KafkaProducer<>(props);
    }

    private void awaitRowCount(int expected) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long count = -1;
        while (System.nanoTime() < deadline) {
            count = totalRows();
            if (count == expected) {
                return;
            }
            Thread.sleep(500);
        }
        throw new AssertionError("expected " + expected + " telemetry row(s), saw " + count);
    }

    private long totalRows() throws Exception {
        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT count(*) FROM telemetry")) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private long rlsVisibleCount(String tenant) throws Exception {
        Properties p = new Properties();
        p.put("user", "voltpilot_app");
        p.put("password", APP_PW);
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), p);
                Statement st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id', '" + tenant + "', false)");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM telemetry")) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private Connection admin() throws Exception {
        return DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }
}
