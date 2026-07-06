package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
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
                        "SELECT tenant_id, site_id, device_id, power_kw, soc_pct, grid_limit_kw, "
                                + "time, received_at "
                                + "FROM telemetry WHERE device_id = '" + DEVICE + "'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("tenant_id")).isEqualTo(TENANT_A);
            assertThat(rs.getString("site_id")).isEqualTo(SITE);
            assertThat(rs.getString("device_id")).isEqualTo(DEVICE);
            assertThat(rs.getBigDecimal("power_kw")).isEqualByComparingTo("2.29");
            assertThat(rs.getBigDecimal("soc_pct")).isEqualByComparingTo("55.1");
            assertThat(rs.getBigDecimal("grid_limit_kw")).isEqualByComparingTo("50");
            // Liveness signal: `time` is the observation timestamp, but `received_at`
            // is the ARRIVAL time (the event's ingested_at) - the two are distinct, so
            // a device replaying buffered samples with old observation times still
            // reads as recently-seen. See DeviceRepository + api migration V20260703...
            assertThat(rs.getTimestamp("time").toInstant()).isEqualTo(Instant.parse(OBSERVED_AT));
            assertThat(rs.getTimestamp("received_at").toInstant())
                    .isEqualTo(Instant.parse("2026-07-01T08:58:46.000Z"));
        }

        // RLS: visible to the owning tenant, invisible to another (portal parity).
        assertThat(rlsVisibleCount(TENANT_A)).isEqualTo(1);
        assertThat(rlsVisibleCount(TENANT_B)).isEqualTo(0);
    }

    /**
     * Purge-watermark guard (api migration V20260706000000): after a device
     * data purge, a replayed sample observed AT or BEFORE
     * {@code device.data_purged_before} is refused - deleted history can never
     * be resurrected by a store-and-forward edge - while a sample observed
     * AFTER the watermark inserts normally.
     */
    @Test
    void purgeWatermarkRefusesReplayedOldSamplesButAcceptsNewOnes() throws Exception {
        createTopic();
        String purgedDevice = UUID.randomUUID().toString();
        String watermark = "2026-07-02T12:00:00.000Z";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device (id, tenant_id, data_purged_before) VALUES ('"
                    + purgedDevice + "', '" + TENANT_A + "', '" + watermark + "')");
        }

        String beforeTs = "2026-07-02T11:59:59.000Z"; // replayed pre-purge sample
        String atTs = watermark;                       // exactly the watermark: refused too
        String afterTs = "2026-07-02T12:00:01.000Z";   // new post-purge sample
        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE;
            for (String ts : new String[] {beforeTs, atTs, afterTs}) {
                producer.send(new ProducerRecord<>(RAW_TOPIC, key,
                        eventFor(TENANT_A, purgedDevice, ts))).get();
            }
            producer.flush();
        }

        // Per-site partition ordering: once the AFTER row is visible, the two
        // older events have already been processed (and refused).
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        while (System.nanoTime() < deadline && rowsForDevice(purgedDevice) < 1) {
            Thread.sleep(500);
        }
        assertThat(rowsForDevice(purgedDevice)).isEqualTo(1);
        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT time FROM telemetry WHERE device_id = '" + purgedDevice + "'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getTimestamp("time").toInstant()).isEqualTo(Instant.parse(afterTs));
        }
    }

    private static String eventFor(String tenant, String device, String observedAt) {
        return "{"
                + "\"schema_version\":\"1.0\","
                + "\"event_id\":\"" + UUID.randomUUID() + "\","
                + "\"tenant_id\":\"" + tenant + "\","
                + "\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + device + "\","
                + "\"observed_at\":\"" + observedAt + "\","
                + "\"ingested_at\":\"2026-07-02T13:00:00.000Z\","
                + "\"source_topic\":\"ems/" + tenant + "/" + SITE + "/" + device + "/telemetry\","
                + "\"measurements\":{\"power_kw\":1.0}"
                + "}";
    }

    private long rowsForDevice(String device) throws Exception {
        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT count(*) FROM telemetry WHERE device_id = '" + device + "'")) {
            rs.next();
            return rs.getLong(1);
        }
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
        // Scoped to this test's device so the two tests stay order-independent.
        return rowsForDevice(DEVICE);
    }

    private long rlsVisibleCount(String tenant) throws Exception {
        Properties p = new Properties();
        p.put("user", "voltpilot_app");
        p.put("password", APP_PW);
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), p);
                Statement st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id', '" + tenant + "', false)");
            try (ResultSet rs = st.executeQuery(
                    "SELECT count(*) FROM telemetry WHERE device_id = '" + DEVICE + "'")) {
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
