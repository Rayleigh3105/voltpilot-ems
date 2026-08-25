package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
    private static final String V2_RAW_TOPIC = "telemetry-v2.raw";
    private static final String MEASUREMENTS_RAW_TOPIC = "measurements.raw";
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
        registry.add("voltpilot.redpanda.measurements-topic", () -> MEASUREMENTS_RAW_TOPIC);
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
                        "SELECT tenant_id, site_id, device_id, power_kw, soc_pct, pv_power_kw, "
                                + "load_kw, grid_limit_kw, payload, time, received_at "
                                + "FROM telemetry WHERE device_id = '" + DEVICE + "'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("tenant_id")).isEqualTo(TENANT_A);
            assertThat(rs.getString("site_id")).isEqualTo(SITE);
            assertThat(rs.getString("device_id")).isEqualTo(DEVICE);
            assertThat(rs.getBigDecimal("power_kw")).isEqualByComparingTo("2.29");
            assertThat(rs.getBigDecimal("soc_pct")).isEqualByComparingTo("55.1");
            assertThat(rs.getBigDecimal("pv_power_kw")).isEqualByComparingTo("16.9");
            assertThat(rs.getBigDecimal("load_kw")).isEqualByComparingTo("9.58");
            assertThat(rs.getBigDecimal("grid_limit_kw")).isEqualByComparingTo("50");
            // Datenhaltung Phase 2 / E2: the raw JSON is no longer written - all
            // the structured columns above still land, payload stays NULL.
            assertThat(rs.getString("payload")).as("payload no longer written").isNull();
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

    /**
     * Audit B7: the guarded {@code WHERE NOT EXISTS} keeps sequential Kafka
     * redeliveries idempotent, but only the UNIQUE index on
     * {@code (device_id, time)} (api migration V20260712000000, mirrored in
     * writer-schema.sql) stops two CONCURRENT deliveries that both passed the
     * guard (zombie consumer during a rebalance). Prove the constraint is
     * real: a duplicate insert that bypasses the guard entirely is rejected
     * by the database itself.
     */
    @Test
    void uniqueIndexRefusesADuplicateThatBypassesTheGuard() throws Exception {
        String device = UUID.randomUUID().toString();
        String insert = "INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) "
                + "VALUES ('2026-07-03T10:00:00Z', '" + TENANT_A + "', '" + SITE + "', '"
                + device + "', 1.0)";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute(insert);
            assertThatThrownBy(() -> st.execute(insert))
                    .hasMessageContaining("uq_telemetry_device_time");
        }
        assertThat(rowsForDevice(device)).isEqualTo(1);
    }

    /**
     * The v2 leg (dual-consume next to the untouched v1 path): a
     * telemetry-v2.raw event explodes into generic (entity_id, channel, value)
     * rows - one per channel - with the v1 disciplines carried over: idempotent
     * per (entity, channel, time) on redelivery, per-entity ts override,
     * time-vs-received_at split, RLS tenant fencing, and the purge watermark
     * refusing replayed pre-purge samples.
     */
    @Test
    void v2EventExplodesIntoPerEntityChannelRowsWithV1Disciplines() throws Exception {
        createTopic(V2_RAW_TOPIC);
        String device = "20000000-0000-0000-0000-00000000000b";
        String battery = "5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f";
        String meter = "7b2f4e10-8d3c-4e5f-b0a1-2c3d4e5f6071";
        String meterTs = "2026-07-01T08:58:40.000Z";
        String v2Event = "{"
                + "\"schema_version\":\"1.0\","
                + "\"event_id\":\"" + UUID.randomUUID() + "\","
                + "\"tenant_id\":\"" + TENANT_A + "\","
                + "\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + device + "\","
                + "\"observed_at\":\"" + OBSERVED_AT + "\","
                + "\"ingested_at\":\"2026-07-01T08:58:46.000Z\","
                + "\"source_topic\":\"ems/" + TENANT_A + "/" + SITE + "/" + device + "/v2/telemetry\","
                + "\"entities\":{"
                + "\"" + battery + "\":{\"channels\":{\"soc_pct\":62.5,\"battery_power_kw\":12.4}},"
                + "\"" + meter + "\":{\"ts\":\"" + meterTs + "\",\"channels\":{\"power_kw\":-49.7}}"
                + "}}";

        // Duplicate delivery: the guarded insert makes the redelivery a no-op.
        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE;
            producer.send(new ProducerRecord<>(V2_RAW_TOPIC, key, v2Event)).get();
            producer.send(new ProducerRecord<>(V2_RAW_TOPIC, key, v2Event)).get();
            producer.flush();
        }
        awaitV2RowCount(device, 3); // 2 battery channels + 1 meter channel

        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT entity_id, channel, value, time, received_at FROM telemetry_v2 "
                                + "WHERE device_id = '" + device + "' ORDER BY entity_id, channel")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("entity_id")).isEqualTo(battery);
            assertThat(rs.getString("channel")).isEqualTo("battery_power_kw");
            assertThat(rs.getDouble("value")).isEqualTo(12.4);
            assertThat(rs.getTimestamp("time").toInstant()).isEqualTo(Instant.parse(OBSERVED_AT));
            assertThat(rs.getTimestamp("received_at").toInstant())
                    .isEqualTo(Instant.parse("2026-07-01T08:58:46.000Z"));
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("channel")).isEqualTo("soc_pct");
            assertThat(rs.getDouble("value")).isEqualTo(62.5);
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString("entity_id")).isEqualTo(meter);
            assertThat(rs.getString("channel")).isEqualTo("power_kw");
            assertThat(rs.getDouble("value")).isEqualTo(-49.7);
            // The meter carried its OWN observation time.
            assertThat(rs.getTimestamp("time").toInstant()).isEqualTo(Instant.parse(meterTs));
            assertThat(rs.next()).isFalse();
        }

        // RLS parity with v1: the owning tenant sees the rows, another does not.
        assertThat(rlsVisibleV2Count(TENANT_A, device)).isEqualTo(3);
        assertThat(rlsVisibleV2Count(TENANT_B, device)).isEqualTo(0);

        // Purge watermark: rows observed at/before device.data_purged_before are
        // refused (replayed pre-purge history never resurrects), later ones land.
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device (id, tenant_id, data_purged_before) VALUES ('"
                    + device + "', '" + TENANT_A + "', '2026-07-02T00:00:00Z')");
        }
        String preWatermark = v2EventAt(device, battery, "2026-07-01T23:59:59.000Z");
        String postWatermark = v2EventAt(device, battery, "2026-07-02T00:00:01.000Z");
        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE;
            producer.send(new ProducerRecord<>(V2_RAW_TOPIC, key, preWatermark)).get();
            producer.send(new ProducerRecord<>(V2_RAW_TOPIC, key, postWatermark)).get();
            producer.flush();
        }
        awaitV2RowCount(device, 4); // only the post-watermark sample joined
        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT count(*) FROM telemetry_v2 WHERE device_id = '" + device
                                + "' AND time = '2026-07-01T23:59:59Z'")) {
            rs.next();
            assertThat(rs.getLong(1)).as("pre-watermark sample refused").isEqualTo(0);
        }
    }

    private static String v2EventAt(String device, String entity, String observedAt) {
        return "{"
                + "\"schema_version\":\"1.0\","
                + "\"event_id\":\"" + UUID.randomUUID() + "\","
                + "\"tenant_id\":\"" + TENANT_A + "\","
                + "\"site_id\":\"" + SITE + "\","
                + "\"device_id\":\"" + device + "\","
                + "\"observed_at\":\"" + observedAt + "\","
                + "\"ingested_at\":\"2026-07-02T13:00:00.000Z\","
                + "\"entities\":{\"" + entity + "\":{\"channels\":{\"soc_pct\":50.0}}}"
                + "}";
    }

    private long rlsVisibleV2Count(String tenant, String device) throws Exception {
        Properties p = new Properties();
        p.put("user", "voltpilot_app");
        p.put("password", APP_PW);
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), p);
                Statement st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id', '" + tenant + "', false)");
            try (ResultSet rs = st.executeQuery(
                    "SELECT count(*) FROM telemetry_v2 WHERE device_id = '" + device + "'")) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    /**
     * MIG-B1 (report §3): for a site whose v2 entities were COMPOSED from its v1
     * master data, one v1 sample additionally lands as per-entity
     * {@code telemetry_v2} rows - so a migrated plant renders real values before
     * any edge speaks v2. A site with NO composed entities (every un-migrated
     * one) is byte-for-byte unaffected.
     */
    @Test
    void composedEntitiesAreFedFromTheV1SampleAndAnUnmigratedSiteIsUntouched() throws Exception {
        createTopic();
        String device = "30000000-0000-0000-0000-0000000000c1";
        String migratedSite = "30000000-0000-0000-0000-0000000000a1";
        String battery = UUID.randomUUID().toString();
        String meter = UUID.randomUUID().toString();
        String house = UUID.randomUUID().toString();
        try (Connection c = admin(); Statement st = c.createStatement()) {
            for (String[] row : new String[][] {
                    {battery, "battery-hybrid", "battery-hybrid"},
                    {meter, "grid-meter", "grid-meter"},
                    {house, "house-load", "house-load"}}) {
                st.execute("INSERT INTO measurement_point (id, tenant_id, site_id, role, "
                        + "device_id, entity_type) VALUES ('" + row[0] + "', '" + TENANT_A + "', '"
                        + migratedSite + "', '" + row[1] + "', '" + device + "', '" + row[2]
                        + "')");
            }
        }

        try (KafkaProducer<String, String> producer = producer()) {
            producer.send(new ProducerRecord<>(RAW_TOPIC, TENANT_A + ":" + migratedSite,
                    migratedEvent(device, migratedSite))).get();
            producer.flush();
        }
        // 2 battery channels with values + derived battery power + grid + house.
        awaitV2RowCount(device, 5);

        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT entity_id, channel, value, time, received_at FROM telemetry_v2 "
                                + "WHERE device_id = '" + device + "' ORDER BY channel")) {
            java.util.Map<String, Double> byChannel = new java.util.LinkedHashMap<>();
            java.util.Map<String, String> entityByChannel = new java.util.LinkedHashMap<>();
            while (rs.next()) {
                String key = rs.getString("entity_id").equals(battery)
                        ? rs.getString("channel") : rs.getString("entity_id") + ":"
                                + rs.getString("channel");
                byChannel.put(key, rs.getDouble("value"));
                entityByChannel.put(key, rs.getString("entity_id"));
                assertThat(rs.getTimestamp("time").toInstant())
                        .isEqualTo(Instant.parse(OBSERVED_AT));
                assertThat(rs.getTimestamp("received_at").toInstant())
                        .as("liveness = ARRIVAL time, like v1")
                        .isEqualTo(Instant.parse("2026-07-01T08:58:46.000Z"));
            }
            assertThat(byChannel.get("soc_pct")).isEqualTo(10.0);
            assertThat(byChannel.get("pv_power_kw")).isEqualTo(59.0);
            assertThat(byChannel.get("battery_power_kw")).isEqualTo(44.6 - 14.4 + 59.0);
            assertThat(byChannel.get(meter + ":power_kw")).isEqualTo(44.6);
            assertThat(byChannel.get(house + ":power_kw")).isEqualTo(14.4);
        }

        // RLS parity: the owning tenant sees them, another does not.
        assertThat(rlsVisibleV2Count(TENANT_A, device)).isEqualTo(5);
        assertThat(rlsVisibleV2Count(TENANT_B, device)).isEqualTo(0);

        // An UN-migrated site (no composed entities) gets no v2 rows at all.
        String plainDevice = "30000000-0000-0000-0000-0000000000c2";
        try (KafkaProducer<String, String> producer = producer()) {
            producer.send(new ProducerRecord<>(RAW_TOPIC, TENANT_A + ":" + SITE,
                    migratedEvent(plainDevice, SITE))).get();
            producer.flush();
        }
        awaitRowsForDevice(plainDevice, 1);
        Thread.sleep(1500); // give the (deliberately absent) fan-out time to NOT happen
        assertThat(v2RowsForDevice(plainDevice)).isZero();
    }

    @Test
    void additionalMeasurementsAreNoBackfillIdempotentAndTenantFenced() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "30000000-0000-0000-0000-000000000003";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device(id,tenant_id,site_id,data_purged_before) VALUES ('"
                    + device + "','" + TENANT_A + "','" + SITE
                    + "','2026-08-25T11:30:00Z')");
            st.execute("INSERT INTO measurement_catalog_point_metadata VALUES "
                    + "('2026.08.25.1','deye.hybrid_1p.battery.battery-temperature','gauge',900),"
                    + "('2026.08.25.1','deye.hybrid_1p.battery.battery-voltage','gauge',900)");
            st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,"
                    + "point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,"
                    + "changed_by,apply_status,applied_at,retention_class,raw_retention_days,"
                    + "long_term_cadence_s,long_term_strategy) VALUES "
                    + "('" + TENANT_A + "','" + SITE + "','" + device
                    + "','deye.hybrid_1p.battery.battery-temperature',true,60,1,"
                    + "'2026-08-25T11:00:00Z','2026.08.25.1','test','applied',"
                    + "'2026-08-25T11:00:01Z','thermal_bms',90,900,'fifteen_minute'),"
                    + "('" + TENANT_A + "','" + SITE + "','" + device
                    + "','deye.hybrid_1p.battery.battery-voltage',true,60,1,"
                    + "'2026-08-25T11:00:00Z','2026.08.25.1','test','applied',"
                    + "'2026-08-25T11:00:01Z','thermal_bms',90,900,'fifteen_minute')");
            for (String[] point : new String[][] {
                    {"test.energy", "counter"}, {"test.state", "state"},
                    {"test.text", "text"}, {"test.flags", "bitfield"}}) {
                st.execute("INSERT INTO measurement_catalog_point_metadata VALUES "
                        + "('2026.08.25.1','" + point[0] + "','" + point[1] + "',900)");
                st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,"
                        + "point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,"
                        + "changed_by,apply_status,applied_at,retention_class,raw_retention_days,"
                        + "long_term_cadence_s,long_term_strategy) VALUES ('" + TENANT_A + "','"
                        + SITE + "','" + device + "','" + point[0] + "',true,60,1,"
                        + "'2026-08-25T11:00:00Z','2026.08.25.1','test','applied',"
                        + "'2026-08-25T11:00:01Z','state_event',90,900,'event_history')");
            }
        }
        String event = "{\"schema_version\":\"1.0\",\"event_id\":\"" + UUID.randomUUID()
                + "\",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + device
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":41,"
                + "\"observed_at\":\"2026-08-25T12:00:00Z\","
                + "\"ingested_at\":\"2026-08-25T12:00:01Z\","
                + "\"source_topic\":\"ems/" + TENANT_A + "/" + SITE + "/" + device
                + "/v2/measurement-samples\",\"gap\":true,\"dropped_samples\":2,"
                + "\"samples\":[{\"point_key\":\"deye.hybrid_1p.battery.battery-temperature\","
                + "\"raw\":250,\"decoded\":25,\"quality\":\"good\"},{\"point_key\":"
                + "\"deye.hybrid_1p.battery.battery-voltage\",\"observed_at\":"
                + "\"2026-08-25T11:15:00Z\",\"raw\":5200,\"decoded\":52,"
                + "\"quality\":\"good\"},{\"point_key\":\"test.energy\",\"raw\":1000,"
                + "\"decoded\":100,\"quality\":\"good\"},{\"point_key\":\"test.state\","
                + "\"raw\":1,\"decoded\":1,\"quality\":\"good\"},{\"point_key\":"
                + "\"test.text\",\"raw\":\"A\",\"decoded\":\"A\",\"quality\":\"good\"},"
                + "{\"point_key\":\"test.flags\",\"raw\":3,\"decoded\":3,"
                + "\"quality\":\"good\"}]}";
        String transitionEvent = event.replaceFirst("\\\"event_id\\\":\\\"[^\\\"]+",
                        "\\\"event_id\\\":\\\"" + UUID.randomUUID())
                .replace("\"sequence\":41", "\"sequence\":42")
                .replace("2026-08-25T12:00:00Z", "2026-08-25T12:01:00Z")
                .replace("\"raw\":250,\"decoded\":25,\"quality\":\"good\"",
                        "\"raw\":300,\"decoded\":30,\"quality\":\"device_error\"")
                .replace("\"raw\":1000,\"decoded\":100", "\"raw\":50,\"decoded\":5")
                .replace("\"raw\":1,\"decoded\":1", "\"raw\":2,\"decoded\":2")
                .replace("\"raw\":\"A\",\"decoded\":\"A\"",
                        "\"raw\":\"B\",\"decoded\":\"B\"")
                .replace("\"raw\":3,\"decoded\":3", "\"raw\":5,\"decoded\":5")
                .replace("\"gap\":true,\"dropped_samples\":2",
                        "\"gap\":false,\"dropped_samples\":0");
        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE + ":" + device;
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, event)).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, event)).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, transitionEvent)).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, transitionEvent)).get();
            producer.flush();
        }

        awaitMeasurementRows(device, 10);
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT raw_numeric,decoded_numeric,catalog_version,"
                        + "edge_sequence FROM device_measurement_sample WHERE device_id='" + device
                        + "' AND point_key='deye.hybrid_1p.battery.battery-temperature' "
                        + "AND edge_sequence=41")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getDouble(1)).isEqualTo(250.0);
            assertThat(rs.getDouble(2)).isEqualTo(25.0);
            assertThat(rs.getString(3)).isEqualTo("2026.08.25.1");
            assertThat(rs.getLong(4)).isEqualTo(41L);
        }
        assertThat(measurementRowsVisible(TENANT_A, device)).isEqualTo(10L);
        assertThat(measurementRowsVisible(TENANT_B, device)).isZero();
        // The second selected sample is newer than enabled_at, but remains
        // absent because replay may never resurrect pre-purge history.
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT event_kind,details::text "
                        + "FROM device_measurement_event WHERE device_id='" + device + "'")) {
            java.util.Map<String, String> events = new java.util.HashMap<>();
            while (rs.next()) events.put(rs.getString(1), rs.getString(2));
            assertThat(events.keySet()).contains("data_gap", "error_change", "counter_reset",
                    "state_change", "text_change", "bitfield_change");
            assertThat(events.get("bitfield_change")).contains("set_bits", "cleared_bits");
        }
    }

    @Test
    void concreteOcppSelectionPreservesLargeRawAndRecordsQualityRecovery() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "30000000-0000-0000-0000-0000000000f3";
        String template = "ocpp.1_6.metervalues.voltage.context[*].format[*].phase[*].location[*].unit[*]";
        String concrete = "ocpp.1_6.metervalues.voltage.context[sample-periodic].format[raw].phase[l1-n].location[outlet].unit[v]";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + device + "','"
                    + TENANT_A + "','" + SITE + "')");
            st.execute("INSERT INTO measurement_catalog_point_metadata VALUES ('2026.08.25.1','"
                    + template + "','gauge',900)");
            st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,"
                    + "point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,"
                    + "changed_by,apply_status,applied_at,retention_class,raw_retention_days,"
                    + "long_term_cadence_s,long_term_strategy) VALUES ('" + TENANT_A + "','"
                    + SITE + "','" + device + "','" + template + "',true,60,1,"
                    + "'2026-08-25T11:00:00Z','2026.08.25.1','test','applied',"
                    + "'2026-08-25T11:00:01Z','state_event',90,900,'fifteen_minute')");
        }
        try (KafkaProducer<String, String> producer = producer()) {
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, TENANT_A + ":" + SITE
                    + ":" + device, measurementEvent(device, concrete, 50,
                            "2026-08-25T12:00:00Z", "good"))).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, TENANT_A + ":" + SITE
                    + ":" + device, measurementEvent(device, concrete, 51,
                            "2026-08-25T12:01:00Z", "device_error"))).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, TENANT_A + ":" + SITE
                    + ":" + device, measurementEvent(device, concrete, 52,
                            "2026-08-25T12:02:00Z", "good"))).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, TENANT_A + ":" + SITE
                    + ":" + device, measurementStringEvent(device, concrete, 53,
                            "2026-08-25T12:03:00Z", "9007199254740993"))).get();
            producer.flush();
        }
        awaitMeasurementRows(device, 4);
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT raw_numeric::text FROM device_measurement_sample "
                        + "WHERE device_id='" + device + "' ORDER BY edge_sequence LIMIT 1")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString(1)).isEqualTo("9007199254740993");
        }
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT raw_text FROM device_measurement_sample "
                        + "WHERE device_id='" + device + "' AND edge_sequence=53")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString(1)).isEqualTo("9007199254740993");
        }
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT count(*) FROM device_measurement_event "
                        + "WHERE device_id='" + device + "' AND event_kind='error_change'")) {
            rs.next();
            assertThat(rs.getLong(1)).as("error transition and good recovery").isEqualTo(2);
        }
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT apply_status FROM device_measurement_selection "
                        + "WHERE device_id='" + device + "' AND point_key='" + template + "'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString(1)).isEqualTo("first_sample");
        }
    }

    private static String measurementEvent(String device, String point, long sequence,
            String observedAt, String quality) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + UUID.randomUUID()
                + "\",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + device
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":" + sequence
                + ",\"observed_at\":\"" + observedAt + "\",\"ingested_at\":\""
                + observedAt + "\",\"source_topic\":\"ems/" + TENANT_A + "/" + SITE + "/"
                + device + "/v2/measurement-samples\",\"gap\":false,\"dropped_samples\":0,"
                + "\"samples\":[{\"point_key\":\"" + point
                + "\",\"raw\":9007199254740993,\"quality\":\"" + quality + "\"}]}";
    }

    private static String measurementStringEvent(String device, String point, long sequence,
            String observedAt, String raw) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + UUID.randomUUID()
                + "\",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + device
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":" + sequence
                + ",\"observed_at\":\"" + observedAt + "\",\"ingested_at\":\""
                + observedAt + "\",\"source_topic\":\"ems/" + TENANT_A + "/" + SITE + "/"
                + device + "/v2/measurement-samples\",\"gap\":false,\"dropped_samples\":0,"
                + "\"samples\":[{\"point_key\":\"" + point
                + "\",\"raw\":\"" + raw + "\",\"quality\":\"good\"}]}";
    }

    private static String migratedEvent(String device, String site) {
        return "{"
                + "\"schema_version\":\"1.0\","
                + "\"event_id\":\"" + UUID.randomUUID() + "\","
                + "\"tenant_id\":\"" + TENANT_A + "\","
                + "\"site_id\":\"" + site + "\","
                + "\"device_id\":\"" + device + "\","
                + "\"observed_at\":\"" + OBSERVED_AT + "\","
                + "\"ingested_at\":\"2026-07-01T08:58:46.000Z\","
                + "\"source_topic\":\"ems/" + TENANT_A + "/" + site + "/" + device + "/telemetry\","
                + "\"measurements\":{\"power_kw\":44.6,\"load_kw\":14.4,\"pv_power_kw\":59.0,"
                + "\"soc_pct\":10.0}"
                + "}";
    }

    private long v2RowsForDevice(String device) throws Exception {
        try (Connection c = admin();
                Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(
                        "SELECT count(*) FROM telemetry_v2 WHERE device_id = '" + device + "'")) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private void awaitMeasurementRows(String device, int expected) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long count = -1;
        while (System.nanoTime() < deadline) {
            try (Connection c = admin(); Statement st = c.createStatement();
                    ResultSet rs = st.executeQuery("SELECT count(*) FROM device_measurement_sample "
                            + "WHERE device_id='" + device + "'")) {
                rs.next();
                count = rs.getLong(1);
            }
            if (count == expected) return;
            Thread.sleep(500);
        }
        throw new AssertionError("expected " + expected + " measurement row(s), saw " + count);
    }

    private long measurementRowsVisible(String tenant, String device) throws Exception {
        Properties p = new Properties();
        p.put("user", "voltpilot_app");
        p.put("password", APP_PW);
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), p);
                Statement st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','" + tenant + "',false)");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM device_measurement_sample "
                    + "WHERE device_id='" + device + "'")) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private void awaitRowsForDevice(String device, int expected) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long count = -1;
        while (System.nanoTime() < deadline) {
            count = rowsForDevice(device);
            if (count == expected) {
                return;
            }
            Thread.sleep(500);
        }
        throw new AssertionError("expected " + expected + " telemetry row(s), saw " + count);
    }

    private void awaitV2RowCount(String device, int expected) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long count = -1;
        while (System.nanoTime() < deadline) {
            try (Connection c = admin();
                    Statement st = c.createStatement();
                    ResultSet rs = st.executeQuery(
                            "SELECT count(*) FROM telemetry_v2 WHERE device_id = '" + device + "'")) {
                rs.next();
                count = rs.getLong(1);
            }
            if (count == expected) {
                return;
            }
            Thread.sleep(500);
        }
        throw new AssertionError("expected " + expected + " telemetry_v2 row(s), saw " + count);
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
        createTopic(RAW_TOPIC);
    }

    private void createTopic(String name) throws Exception {
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", REDPANDA.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(name, 3, (short) 1))).all().get();
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
