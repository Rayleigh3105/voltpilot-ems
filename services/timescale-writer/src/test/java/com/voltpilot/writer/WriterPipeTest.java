package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
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
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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

    @Autowired
    MeterRegistry meters;

    /** The REAL messreihe_ereignis migration, before the context (and its listeners) start. */
    @BeforeAll
    static void ereignisTabelle() throws Exception {
        EreignisTabelleImTest.anlegen(POSTGRES, TENANT_A, TENANT_B);
    }

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
     * UEMS AP-07 IP-11: an ausgebaut box keeps every value measured BEFORE its Ausbau - also one
     * still in flight - but no value measured at or after it is written, on the v1 telemetry path
     * and on the measurement pipeline. Sent newest first, so the one accepted value is the marker
     * that the two refused ones were processed.
     */
    @Test
    void eineAusgebauteBoxNimmtNurWerteVorIhremAusbauAn() throws Exception {
        createTopic();
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-00000000001b";
        String entity = "71000000-0000-0000-0000-00000000001b";
        String ausbau = "2026-11-04T09:38:00Z";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device (id, tenant_id, site_id, ausgebaut_am) VALUES ('" + device + "', '"
                    + TENANT_A + "', '" + SITE + "', '" + ausbau + "')");
            st.execute("INSERT INTO measurement_catalog_point_metadata VALUES ('" + UEMS_CATALOG
                    + "','" + PUNKT + "','counter',900) ON CONFLICT DO NOTHING");
            st.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,device_id) VALUES ('" + entity
                    + "','" + TENANT_A + "','" + SITE + "','grid','" + device + "')");
            auswahl(st, device, entity, PUNKT, "counter", "2026-11-01T00:00:00Z", "2026-11-01T00:00:30Z", 1);
        }

        String nach = "2026-11-04T09:39:00Z";
        String vor = "2026-11-04T09:37:00Z";
        senden(device, wert(device, 600, nach, "2026-11-04T09:39:05Z", PUNKT, "91", "9.1"),
                wert(device, 601, ausbau, "2026-11-04T09:39:06Z", PUNKT, "90", "9.0"),
                wert(device, 602, vor, "2026-11-04T09:39:07Z", PUNKT, "89", "8.9"));
        awaitMeasurementRows(device, 1);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "' AND time = '" + vor + "'")).as("der Wert vor dem Ausbau bleibt nicht draußen").isOne();

        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE;
            for (String ts : new String[] {"2026-11-04T09:39:00.000Z", "2026-11-04T09:38:00.000Z",
                    "2026-11-04T09:37:00.000Z"}) {
                producer.send(new ProducerRecord<>(RAW_TOPIC, key, eventFor(TENANT_A, device, ts))).get();
            }
            producer.flush();
        }
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        while (System.nanoTime() < deadline && rowsForDevice(device) < 1) {
            Thread.sleep(500);
        }
        assertThat(rowsForDevice(device)).isEqualTo(1);
        assertThat(zaehle("SELECT count(*) FROM telemetry WHERE device_id='" + device + "' AND time = '"
                + vor + "'")).isOne();
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
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT first_read_at,last_read_at,edge_sequence,"
                        + "decoded_numeric,quality FROM device_measurement_point_state WHERE device_id='"
                        + device + "' AND point_key='deye.hybrid_1p.battery.battery-temperature'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getTimestamp("first_read_at").toInstant())
                    .isEqualTo(Instant.parse("2026-08-25T12:00:00Z"));
            assertThat(rs.getTimestamp("last_read_at").toInstant())
                    .isEqualTo(Instant.parse("2026-08-25T12:01:00Z"));
            assertThat(rs.getLong("edge_sequence")).isEqualTo(42L);
            assertThat(rs.getDouble("decoded_numeric")).isEqualTo(30.0);
            assertThat(rs.getString("quality")).isEqualTo("device_error");
        }
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

        // UEMS AP-07 IP-8: each Bestand event ALSO lands in messreihe_ereignis - once, in the
        // same transaction, as the contract's event (box + point; no component; the gap is the
        // box's displacement without a time span). The Bestand rows above stay as they were.
        Thread.sleep(1500); // the duplicate deliveries had their chance to double something
        assertThat(zaehle("SELECT count(*) FROM device_measurement_event WHERE device_id='"
                + device + "'")).as("Bestand rows").isEqualTo(6);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device
                + "'")).as("mirrored 1:1, a redelivery doubles nothing").isEqualTo(6);
        String gemeinsam = " AND aus_bestand AND device_id='" + device + "' AND kennungen = "
                + "jsonb_build_object('box','" + device + "') AND site_id='" + SITE
                + "' AND entity_id IS NULL AND data_source_id IS NULL AND von IS NULL AND bis IS NULL"
                + " AND eingang='2026-08-25T12:00:01Z'";
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art='data_gap' "
                + "AND urheber='box' AND messkanal IS NULL AND zeit='2026-08-25T12:00:00Z' AND "
                + "nutzlast='{\"erkannt_aus\":\"verdraengung\",\"erwartet_fehlend\":2}'::jsonb"
                + gemeinsam)).as("data_gap").isOne();
        for (String[] e : new String[][] {
                {"error_change", "deye.hybrid_1p.battery.battery-temperature",
                        "{\"alt\":\"good\",\"neu\":\"device_error\"}"},
                {"counter_reset", "test.energy", "{\"stand_alt\":100,\"stand_neu\":5}"},
                {"state_change", "test.state", "{\"alt\":1,\"neu\":2}"},
                {"text_change", "test.text", "{\"alt\":\"A\",\"neu\":\"B\"}"},
                {"bitfield_change", "test.flags", "{\"alt\":3,\"neu\":5}"}}) {
            assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art='" + e[0]
                    + "' AND urheber='writer' AND messkanal='" + e[1] + "' AND nutzlast='" + e[2]
                    + "'::jsonb AND zeit='2026-08-25T12:01:00Z'" + gemeinsam)).as(e[0]).isOne();
        }
        assertThat(ereignisseVisible(TENANT_A, device)).isEqualTo(6L);
        assertThat(ereignisseVisible(TENANT_B, device)).isZero();
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
                ResultSet rs = st.executeQuery("SELECT raw_text,decoded_numeric,decoded_text "
                        + "FROM device_measurement_sample "
                        + "WHERE device_id='" + device + "' AND edge_sequence=53")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString(1)).isEqualTo("9007199254740993");
            assertThat(rs.getBigDecimal(2)).as("rounded decoded must stay absent").isNull();
            assertThat(rs.getString(3)).as("decoded string was not emitted by the edge").isNull();
        }
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT count(*) FROM device_measurement_event "
                        + "WHERE device_id='" + device + "' AND event_kind='error_change'")) {
            rs.next();
            assertThat(rs.getLong(1)).as("error transition and good recovery").isEqualTo(2);
        }
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device
                + "' AND art='error_change' AND aus_bestand AND messkanal='" + concrete + "' AND ("
                + "nutzlast='{\"alt\":\"good\",\"neu\":\"device_error\"}'::jsonb OR "
                + "nutzlast='{\"alt\":\"device_error\",\"neu\":\"good\"}'::jsonb)"))
                .as("both transitions mirrored").isEqualTo(2);
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT apply_status FROM device_measurement_selection "
                        + "WHERE device_id='" + device + "' AND point_key='" + template + "'")) {
            assertThat(rs.next()).isTrue();
            assertThat(rs.getString(1)).isEqualTo("first_sample");
        }
    }

    /**
     * UEMS AP-07 IP-8: the mirror can never break the Bestand path - it runs in its own savepoint.
     * Forced here with a tenant that has no row in {@code tenant}: the mirror's FK refuses (in
     * prod every device's tenant exists; this stands in for any mirror failure - a CHECK, a
     * vocabulary drift). The samples, the Bestand events and the offset still commit, nothing is
     * thrown out of the consumer, and the counter names the refusing constraint.
     */
    @Test
    void aFailingMirrorIsRolledBackAloneAndTheBestandWriteCommits() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String tenant = "20000000-0000-0000-0000-000000000001"; // deliberately NOT in `tenant`
        String device = "30000000-0000-0000-0000-0000000000e7";
        String point = "test.mirror.state";
        double vorher = spiegel("fehler", "messreihe_ereignis_tenant_fk");
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + device + "','" + tenant
                    + "','" + SITE + "')");
            st.execute("INSERT INTO measurement_catalog_point_metadata VALUES "
                    + "('2026.08.25.1','" + point + "','state',900)");
            st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,"
                    + "point_key,enabled,cadence_s,desired_revision,enabled_at,catalog_version,"
                    + "changed_by,apply_status,applied_at,retention_class,raw_retention_days,"
                    + "long_term_cadence_s,long_term_strategy) VALUES ('" + tenant + "','" + SITE
                    + "','" + device + "','" + point + "',true,60,1,'2026-08-25T11:00:00Z',"
                    + "'2026.08.25.1','test','applied','2026-08-25T11:00:01Z','state_event',90,900,"
                    + "'event_history')");
        }
        String topic = "ems/" + tenant + "/" + SITE + "/" + device + "/v2/measurement-samples";
        String luecke = "{\"schema_version\":\"1.0\",\"event_id\":\"" + UUID.randomUUID()
                + "\",\"tenant_id\":\"" + tenant + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\""
                + device + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":1,"
                + "\"observed_at\":\"2026-08-25T12:10:00Z\",\"ingested_at\":\"2026-08-25T12:10:01Z\","
                + "\"source_topic\":\"" + topic + "\",\"gap\":true,\"dropped_samples\":3,"
                + "\"samples\":[{\"point_key\":\"" + point + "\",\"raw\":1,\"decoded\":1,"
                + "\"quality\":\"good\"}]}";
        String wechsel = luecke.replaceFirst("\\\"event_id\\\":\\\"[^\\\"]+",
                        "\\\"event_id\\\":\\\"" + UUID.randomUUID())
                .replace("\"sequence\":1", "\"sequence\":2")
                .replace("2026-08-25T12:10:00Z", "2026-08-25T12:11:00Z")
                .replace("\"gap\":true,\"dropped_samples\":3", "\"gap\":false,\"dropped_samples\":0")
                .replace("\"raw\":1,\"decoded\":1", "\"raw\":2,\"decoded\":2");
        try (KafkaProducer<String, String> producer = producer()) {
            String key = tenant + ":" + SITE + ":" + device;
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, luecke)).get();
            producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, wechsel)).get();
            producer.flush();
        }

        awaitMeasurementRows(device, 2);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_event WHERE device_id='" + device
                + "' AND event_kind IN ('data_gap','state_change')"))
                .as("the Bestand events committed").isEqualTo(2);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device + "'"))
                .as("the refused mirrors rolled back alone").isZero();
        assertThat(spiegel("fehler", "messreihe_ereignis_tenant_fk") - vorher)
                .as("each refused mirror counted with its constraint").isEqualTo(2.0);
    }

    // ======================================================================================
    // UEMS AP-07 IP-7: die Herkunft je Messwert ZUR MESSZEIT
    // ======================================================================================

    private static final String UEMS_CATALOG = "2026.09.12.1";
    private static final String PUNKT = "ahr.zaehler.energie-bezug";

    /**
     * A12 + Nachlieferung: ein gespeicherter Wert trägt seine sieben Herkunftsspalten, und JEDE
     * ist die ZUR MESSZEIT gültige — nicht die von jetzt. Der Beweis ist der zweite Wert: er kommt
     * in derselben Sekunde an wie der erste, wurde aber 13 Tage früher gemessen, als noch Fassung 1
     * galt; er bekommt Fassung 1 und die Zustellart {@code nachgeliefert}, der erste Fassung 2 und
     * {@code direkt}.
     */
    @Test
    void dieHerkunftEinesWertsIstDieZurMesszeitGueltige() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000001";
        String entity = "71000000-0000-0000-0000-000000000001";
        String quelle = "72000000-0000-0000-0000-000000000001";
        String geraet = "73000000-0000-0000-0000-000000000001";
        String messstelle = "74000000-0000-0000-0000-000000000001";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, quelle, "DQ-1", geraet, "Z-5a",
                    "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z");
            bindung(st, messstelle, entity, geraet, "fuehrend", "2026-11-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-11-01T00:00:00Z",
                    "2026-11-01T00:00:30Z", 1);
            // Die ZWEITE Fassung der Zustellung, angewendet am 10.11. - sie gilt NICHT rückwirkend.
            st.execute("INSERT INTO device_measurement_selection_event(tenant_id,site_id,device_id,"
                    + "point_key,desired_revision,event_kind,requested_at,requested_enabled,"
                    + "catalog_version,actor,apply_status,applied_at,retention_class,"
                    + "raw_retention_days,long_term_strategy,entity_id) VALUES ('" + TENANT_A + "','"
                    + SITE + "','" + device + "','" + PUNKT + "',2,'selection_requested',"
                    + "'2026-11-10T00:00:00Z',"
                    + "true,'" + UEMS_CATALOG + "','test','applied','2026-11-10T00:00:00Z',"
                    + "'energy_counter',90,'fifteen_minute','" + entity + "')");
        }
        senden(device,
                wert(device, 48213, "2026-11-18T09:39:00Z", "2026-11-18T09:39:07Z", PUNKT,
                        "10834152", "1083415.2"),
                // Ein gepufferter Wert vom 05.11., eingegangen JETZT.
                wert(device, 48214, "2026-11-05T08:00:00Z", "2026-11-18T09:39:08Z", PUNKT,
                        "10800000", "1080000.0"));
        awaitMeasurementRows(device, 2);

        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "' AND time='2026-11-18T09:39:00Z' AND entity_id='" + entity
                + "' AND device_install_id='" + geraet + "' AND applied_revision=2 "
                + "AND value_kind='counter' AND role='fuehrend' AND delivery='direkt' AND delay_s=7"))
                .as("der frische Wert: Fassung 2, führend, direkt, 7 s").isOne();
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "' AND time='2026-11-05T08:00:00Z' AND entity_id='" + entity
                + "' AND applied_revision=1 AND role='fuehrend' AND delivery='nachgeliefert' "
                + "AND delay_s=1129148"))
                .as("der Nachzügler sieht die Fassung, die zu SEINER Messzeit galt").isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device + "'"))
                .as("ein sauberer Umschlag meldet nichts — auch keinen clock_jump (der gehört "
                        + "der Datenannahme)").isZero();
        assertThat(writerEreignis("fremder_urheber"))
                .as("der Zeitsprung der beiden Umschläge ist gesehen und gezählt, nicht gemeldet")
                .isGreaterThanOrEqualTo(1.0);
        assertThat(measurementRowsVisible(TENANT_B, device))
                .as("der Mandantenzaun steht auch über den neuen Spalten").isZero();
        assertThat(measurementRowsVisible(TENANT_A, device)).isEqualTo(2);
    }

    /**
     * A1 und A11 (E3): dasselbe Paket zweimal ist EIN Wert, gezählt und ohne Ereignis. Ein
     * ABWEICHENDER Wert zur selben Messzeit wird abgewiesen, der erste bleibt stehen, und die
     * Abweisung steht als {@code duplicate_conflict} in der Ereignis-Tabelle.
     */
    @Test
    void dasselbePaketZweimalIstEinWertEinWiderspruchIstEinEreignis() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000002";
        String entity = "71000000-0000-0000-0000-000000000002";
        String quelle = "72000000-0000-0000-0000-000000000002";
        String geraet = "73000000-0000-0000-0000-000000000002";
        String messstelle = "74000000-0000-0000-0000-000000000002";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, quelle, "DQ-2", geraet, "Z-6a",
                    "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z");
            bindung(st, messstelle, entity, geraet, "fuehrend", "2026-11-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-11-01T00:00:00Z",
                    "2026-11-01T00:00:30Z", 1);
        }
        String paket = wert(device, 48213, "2026-11-18T09:39:00Z", "2026-11-18T09:39:07Z", PUNKT,
                "10834152", "1083415.2");
        senden(device, paket, paket);
        awaitMeasurementRows(device, 1);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device + "'"))
                .as("A1: eine Wiederholung ist kein Ereignis").isZero();

        senden(device, wert(device, 48214, "2026-11-18T09:39:00Z", "2026-11-18T09:39:12Z", PUNKT,
                "10834153", "1083415.3"));
        warte("der Widerspruch ist festgehalten",
                () -> zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device
                        + "' AND art='duplicate_conflict'"), 1);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "'")).as("A11: der zweite Wert wird NICHT gespeichert").isOne();
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "' AND raw_numeric=10834152 AND edge_sequence=48213"))
                .as("A11: der ERSTE bleibt, nie still überschrieben").isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device
                + "' AND art='duplicate_conflict' AND urheber='writer' AND entity_id='" + entity
                + "' AND messstelle_id='" + messstelle + "' AND messkanal='" + PUNKT + "' "
                + "AND nutzlast->'sequenzen'='[48213,48214]'::jsonb "
                + "AND nutzlast->>'messzeit'='2026-11-18T09:39:00Z' "
                + "AND (nutzlast->'gespeicherter_wert'->>'raw')='10834152' "
                + "AND (nutzlast->'abgewiesener_wert'->>'raw')='10834153'"))
                .as("beide Werte und beide Sequenzen reisen mit").isOne();
        assertThat(ereignisseVisible(TENANT_B, device))
                .as("die Meldung liegt hinter dem Mandantenzaun").isZero();
    }

    /**
     * A6 + A9 + der Zeitstrahl 07:31:40 des Konzepts (AP-07 §5): nach der Übergabe von DQ-3 am
     * 10.04.2027 07:30 liefert die alte Box drei gepufferte Werte mit Messzeit 07:29:30–07:29:50 —
     * sie war ZUR MESSZEIT zuständig, also sind sie FÜHREND (W8). Ein Wert derselben Box mit
     * Messzeit 07:32 ist ein SPIEGEL: gespeichert, nie führend, mit HÖCHSTENS EINEM
     * {@code unassigned_reader}. Und A9: derselbe Zeitpunkt aus der zuständigen Box verdrängt den
     * Spiegel nicht und wird von ihm nicht verdrängt.
     */
    @Test
    void derNachzueglerIstFuehrendUndDerSpaetereEinSpiegel() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String alt = "70000000-0000-0000-0000-000000000003";     // E-1
        String neu = "70000000-0000-0000-0000-000000000004";     // E-2′
        String entity = "71000000-0000-0000-0000-000000000003";  // K-5
        String quelle = "72000000-0000-0000-0000-000000000003";  // DQ-3
        String geraet = "73000000-0000-0000-0000-000000000003";
        String messstelle = "74000000-0000-0000-0000-000000000003";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, alt, entity, quelle, "DQ-3", geraet, "Z-7a",
                    "2027-04-01T00:00:00Z", "2027-04-01T00:00:00Z");
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + neu + "','" + TENANT_A
                    + "','" + SITE + "')");
            // Die Übergabe: bis 07:30 liest E-1, danach E-2′.
            st.execute("UPDATE data_source_assignment SET effective_to='2027-04-10T07:30:00Z' "
                    + "WHERE data_source_id='" + quelle + "'");
            st.execute("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,"
                    + "effective_from) VALUES ('" + TENANT_A + "','" + quelle + "','" + neu
                    + "','2027-04-10T07:30:00Z')");
            bindung(st, messstelle, entity, geraet, "fuehrend", "2027-04-01T00:00:00Z");
            auswahl(st, alt, entity, PUNKT, "counter", "2027-04-01T00:00:00Z",
                    "2027-04-01T00:00:30Z", 1);
            auswahl(st, neu, entity, PUNKT, "counter", "2027-04-01T00:00:00Z",
                    "2027-04-01T00:00:30Z", 1);
        }
        senden(alt,
                wert(alt, 100, "2027-04-10T07:29:30Z", "2027-04-10T07:31:40Z", PUNKT, "500", "50.0"),
                wert(alt, 101, "2027-04-10T07:29:40Z", "2027-04-10T07:31:40Z", PUNKT, "501", "50.1"),
                wert(alt, 102, "2027-04-10T07:29:50Z", "2027-04-10T07:31:40Z", PUNKT, "502", "50.2"));
        awaitMeasurementRows(alt, 3);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + alt
                + "' AND role='fuehrend' AND entity_id='" + entity + "'"))
                .as("A6/W8: zuständig ZUR MESSZEIT — also führend, nicht verworfen").isEqualTo(3);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + alt + "'"))
                .as("ein Nachzügler ist kein Ereignis").isZero();

        senden(alt,
                wert(alt, 103, "2027-04-10T07:32:00Z", "2027-04-10T07:32:05Z", PUNKT, "510", "51.0"),
                wert(alt, 104, "2027-04-10T07:33:00Z", "2027-04-10T07:33:05Z", PUNKT, "511", "51.1"));
        awaitMeasurementRows(alt, 5);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + alt
                + "' AND role='spiegel'"))
                .as("nie verworfen: der Wert der nicht zuständigen Box wird GESPEICHERT")
                .isEqualTo(2);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + alt
                + "' AND art='unassigned_reader'"))
                .as("höchstens EINES je Stunde je Box und Datenquelle").isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + alt
                + "' AND art='unassigned_reader' AND data_source_id='" + quelle + "' "
                + "AND entity_id='" + entity + "' AND von='2027-04-10T07:32:00Z' "
                + "AND bis='2027-04-10T07:32:00Z' AND (nutzlast->>'anzahl')='1' "
                + "AND nutzlast->>'zustaendige_box'='" + neu + "'"))
                .as("die Meldung nennt die Box, die wirklich zuständig war").isOne();

        // A9: die ZUSTÄNDIGE Box schickt denselben Zeitpunkt mit einem anderen Wert.
        senden(neu, wert(neu, 1, "2027-04-10T07:32:00Z", "2027-04-10T07:32:09Z", PUNKT, "999",
                "99.9"));
        awaitMeasurementRows(neu, 1);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE entity_id='" + entity
                + "' AND time='2027-04-10T07:32:00Z'"))
                .as("A9: beide Spuren stehen nebeneinander").isEqualTo(2);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE entity_id='" + entity
                + "' AND time='2027-04-10T07:32:00Z' AND role='fuehrend' AND device_id='" + neu
                + "'")).as("die zuständige Spur trägt die Reihe").isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE art='duplicate_conflict' "
                + "AND entity_id='" + entity + "'"))
                .as("A9: ein Spiegel ist weder Wiederholung noch Widerspruch").isZero();
    }

    /**
     * W8: die Nachlieferungs-Sperre über eine ÜBERGABE hinweg ist aufgelöst. Ein Wert, der GENAU
     * 90 Tage alt ist und aus einer Box kommt, die HEUTE nicht mehr zuständig ist, wird
     * gespeichert und ist FÜHREND — weil seine Box ZUR MESSZEIT zuständig war. Zugleich der
     * Bestandsschutz der anderen Kante: der {@code enabled_at}-Riegel („war der Punkt damals
     * überhaupt gewählt?") steht unverändert, für beide Spuren.
     */
    @Test
    void nachlieferungBis90TageIstWillkommenUeberEineUebergabeHinweg() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String uems = "70000000-0000-0000-0000-000000000005";
        String bestand = "70000000-0000-0000-0000-000000000006";
        String entity = "71000000-0000-0000-0000-000000000005";
        String quelle = "72000000-0000-0000-0000-000000000005";
        String geraet = "73000000-0000-0000-0000-000000000005";
        String heute = "70000000-0000-0000-0000-00000000000c";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            // Die Quelle las bis zum 10.01. über `uems`, seitdem über `heute`.
            uemsKomponente(st, uems, entity, quelle, "DQ-5", geraet, "Z-8a",
                    "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + heute + "','"
                    + TENANT_A + "','" + SITE + "')");
            st.execute("UPDATE data_source_assignment SET effective_to='2027-01-10T00:00:00Z' "
                    + "WHERE data_source_id='" + quelle + "'");
            st.execute("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,"
                    + "effective_from) VALUES ('" + TENANT_A + "','" + quelle + "','" + heute
                    + "','2027-01-10T00:00:00Z')");
            auswahl(st, uems, entity, PUNKT, "counter", "2026-09-01T00:00:00Z",
                    "2026-09-01T00:00:30Z", 1);
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + bestand + "','"
                    + TENANT_A + "','" + SITE + "')");
            auswahl(st, bestand, null, PUNKT, "counter", "2027-01-10T00:00:00Z",
                    "2027-01-10T00:00:30Z", 1);
        }
        senden(uems,
                // GENAU 90 Tage alt (die angenommene Kante des Vertrags) und aus einer Box, die
                // HEUTE nicht mehr zuständig ist - zur Messzeit war sie es.
                wert(uems, 7, "2026-10-17T12:00:00Z", "2027-01-15T12:00:00Z", PUNKT, "42", "4.2"),
                // Und die andere Kante: vor `enabled_at` gewählt wurde der Punkt damals nicht.
                wert(uems, 8, "2026-08-20T12:00:00Z", "2027-01-15T12:00:01Z", PUNKT, "41", "4.1"));
        // Dieselbe Reise für einen Bestandswert - und hinterher eine Kontroll-Zustellung, deren
        // Messzeit NACH dem Einschalten liegt: sie beweist, dass die Partition den ersten
        // Umschlag wirklich gesehen und ihn VERWORFEN hat (gleicher Schlüssel, gleiche Folge).
        senden(bestand,
                wert(bestand, 7, "2027-01-05T12:00:00Z", "2027-01-15T12:00:00Z", PUNKT, "42", "4.2"),
                wert(bestand, 8, "2027-01-15T12:00:00Z", "2027-01-15T12:00:05Z", PUNKT, "43",
                        "4.3"));
        awaitMeasurementRows(uems, 1);
        awaitMeasurementRows(bestand, 1);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + uems
                + "' AND time='2026-10-17T12:00:00Z' AND delivery='nachgeliefert' "
                + "AND delay_s=7776000 AND role='beobachtung' AND entity_id='" + entity + "'"))
                .as("90 Tage Nachlieferung über eine Übergabe hinweg: gespeichert, nicht "
                        + "verworfen; ohne Quellenbindung ist die Rolle Beobachtung").isOne();
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + uems
                + "' AND art='unassigned_reader'"))
                .as("zur Messzeit zuständig - kein Spiegel, keine Meldung").isZero();
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + uems
                + "' AND time='2026-08-20T12:00:00Z'"))
                .as("der enabled_at-Riegel steht auch für eine UEMS-Komponente").isZero();
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='"
                + bestand + "' AND time='2027-01-05T12:00:00Z'"))
                .as("kein Backfill für einen Bestandswert - die alte Regel steht").isZero();
    }

    /**
     * Die Zahl der Abfragen wächst NICHT mit der Zahl der Werte: die Zeitleisten liegen im
     * Speicher, aufgelöst wird die Messzeit dort. 20 Umschläge derselben Komponente kosten je
     * Nachschlag GENAU EINE Abfrage.
     */
    @Test
    void dieZahlDerAbfragenWaechstNichtMitDerZahlDerWerte() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000007";
        String entity = "71000000-0000-0000-0000-000000000007";
        String quelle = "72000000-0000-0000-0000-000000000007";
        String geraet = "73000000-0000-0000-0000-000000000007";
        String messstelle = "74000000-0000-0000-0000-000000000007";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, quelle, "DQ-7", geraet, "Z-9a",
                    "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z");
            bindung(st, messstelle, entity, geraet, "fuehrend", "2026-11-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-11-01T00:00:00Z",
                    "2026-11-01T00:00:30Z", 1);
        }
        // Dieselbe Last EINMAL ohne Herkunft (Bestandsweg = der Stand vor IP-7) und einmal mit.
        String bestand = "70000000-0000-0000-0000-00000000000d";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + bestand + "','"
                    + TENANT_A + "','" + SITE + "')");
            auswahl(st, bestand, null, PUNKT, "counter", "2026-11-01T00:00:00Z",
                    "2026-11-01T00:00:30Z", 1);
        }
        long ohneMs = durchsatz(bestand);

        double[] vorher = {abfragen("reihe"), abfragen("einbau"), abfragen("zustaendigkeit"),
                abfragen("bindung"), abfragen("fassung")};
        double konfliktVorher = abfragen("konflikt");
        long dauerMs = durchsatz(device);

        double[] nachher = {abfragen("reihe"), abfragen("einbau"), abfragen("zustaendigkeit"),
                abfragen("bindung"), abfragen("fassung")};
        for (int i = 0; i < vorher.length; i++) {
            assertThat(nachher[i] - vorher[i])
                    .as("20 Werte, eine Abfrage je Nachschlag (Zeitleiste im Speicher)")
                    .isEqualTo(1.0);
        }
        assertThat(abfragen("konflikt") - konfliktVorher)
                .as("ohne Doppelwert fragt niemand nach schon Gespeichertem").isZero();
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "' AND role='fuehrend'")).isEqualTo(20);
        System.out.println("[IP-7] 20 Umschläge: Bestandsweg " + ohneMs + " ms, "
                + "UEMS-Weg " + dauerMs + " ms (5 Nachschlag-Abfragen, nicht 100)");
    }

    /**
     * ⚠ Ein Fehler im Nachschlag kostet NIE einen Messwert. Wird dem Writer das Lesen der
     * Gerät-Historie entzogen, rollt nur sein Savepoint zurück: der Wert wird als BESTANDSWERT
     * gespeichert (alle sieben Herkunftsspalten leer), und die Schreib-Transaktion committet.
     */
    @Test
    void einFehlerImNachschlagKostetKeinenMesswert() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000008";
        String entity = "71000000-0000-0000-0000-000000000008";
        String quelle = "72000000-0000-0000-0000-000000000008";
        String geraet = "73000000-0000-0000-0000-000000000008";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, quelle, "DQ-8", geraet, "Z-10a",
                    "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-11-01T00:00:00Z",
                    "2026-11-01T00:00:30Z", 1);
            st.execute("REVOKE SELECT ON geraet_komponente FROM voltpilot_app");
        }
        try {
            senden(device, wert(device, 300, "2026-11-20T10:00:00Z", "2026-11-20T10:00:05Z", PUNKT,
                    "77", "7.7"));
            awaitMeasurementRows(device, 1);
            assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='"
                    + device + "' AND entity_id IS NULL AND device_install_id IS NULL "
                    + "AND applied_revision IS NULL AND value_kind IS NULL AND role IS NULL "
                    + "AND delivery IS NULL AND delay_s IS NULL"))
                    .as("der Wert ist da — ohne nachgeschlagene Herkunft, nie verloren").isOne();
        } finally {
            try (Connection c = admin(); Statement st = c.createStatement()) {
                st.execute("GRANT SELECT ON geraet_komponente TO voltpilot_app");
            }
        }
    }

    /**
     * AP-08 IP-4, Z6/E4 (Referenzfall F7): mit deklariertem Wertebereich 65 536 und Höchstzuwachs
     * 1 667 je 60 s meldet der Writer den Sprung 64 954 → 185 als {@code counter_overflow} mit der
     * Rechnung — 65 536 − 64 954 + 185 = 767 ≤ 1 667. Der Sprung 12 457 → 100 (53 179) bleibt eine
     * Rücksetzung. Der Bestand schreibt für BEIDE Sprünge weiter {@code counter_reset} (unverändert).
     */
    @Test
    void einDeklarierterUeberlaufWirdGemeldetEinSprungUeberDemHoechstzuwachsNicht() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000011";
        String entity = "71000000-0000-0000-0000-000000000011";
        String quelle = "72000000-0000-0000-0000-000000000011";
        String geraet = "73000000-0000-0000-0000-000000000011";
        String messstelle = "74000000-0000-0000-0000-000000000011";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, quelle, "DQ-11", geraet, "K-6a",
                    "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
            bindung(st, messstelle, entity, geraet, "fuehrend", "2026-10-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-10-01T00:00:00Z",
                    "2026-10-01T00:00:30Z", 1);
            deklaration(st, "SELECT 65536::numeric, 1667::numeric, 60, NULL::integer WHERE p_entity = '"
                    + entity + "'");
        }
        double ueberlaeufe = ueberlaufErkennung("ueberlauf");
        try {
            senden(device,
                    wert(device, 1, "2026-10-20T08:02:00Z", "2026-10-20T08:02:05Z", PUNKT, "64954", "64954"),
                    wert(device, 2, "2026-10-20T08:03:00Z", "2026-10-20T08:03:05Z", PUNKT, "185", "185"),
                    wert(device, 3, "2026-10-20T08:04:00Z", "2026-10-20T08:04:05Z", PUNKT, "12457", "12457"),
                    wert(device, 4, "2026-10-20T08:05:00Z", "2026-10-20T08:05:05Z", PUNKT, "100", "100"));
            awaitMeasurementRows(device, 4);
            warte("der Überlauf ist gemeldet",
                    () -> zaehle("SELECT count(*) FROM messreihe_ereignis WHERE entity_id='" + entity
                            + "' AND art='counter_overflow'"), 1);
            assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE entity_id='" + entity
                    + "' AND art='counter_overflow' AND urheber='writer' AND NOT aus_bestand"
                    + " AND zeit='2026-10-20T08:03:00Z' AND messkanal='" + PUNKT + "'"
                    + " AND messstelle_id='" + messstelle + "' AND device_id='" + device + "'"
                    + " AND nutzlast = '{\"stand_alt\":64954,\"stand_neu\":185,"
                    + "\"messzeit_alt\":\"2026-10-20T08:02:00Z\",\"wertebereich_modul\":65536,"
                    + "\"hoechstzuwachs_je_kadenz\":1667,\"kadenz_s\":60}'::jsonb"))
                    .as("die Rechnung steht in der Meldung").isOne();
            assertThat(zaehle("SELECT count(*) FROM device_measurement_event WHERE device_id='" + device
                    + "' AND event_kind='counter_reset'"))
                    .as("der Bestand ist unverändert: beide Sprünge sind dort counter_reset").isEqualTo(2);
            assertThat(ueberlaufErkennung("ueberlauf") - ueberlaeufe).isEqualTo(1.0);
        } finally {
            try (Connection c = admin(); Statement st = c.createStatement()) {
                deklaration(st, "SELECT NULL::numeric, NULL::numeric, NULL::integer, NULL::integer WHERE false");
            }
        }
    }

    /** AP-08 IP-4, E4: ohne Deklaration wird kein Höchstwert geraten — kein Überlauf, nur die Rücksetzung. */
    @Test
    void ohneDeklarationBleibtJederFallendeStandEineRuecksetzung() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000012";
        String entity = "71000000-0000-0000-0000-000000000012";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, "72000000-0000-0000-0000-000000000012", "DQ-12",
                    "73000000-0000-0000-0000-000000000012", "K-7a", "2026-10-01T00:00:00Z",
                    "2026-10-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-10-01T00:00:00Z",
                    "2026-10-01T00:00:30Z", 1);
        }
        double nichtDeklariert = ueberlaufErkennung("nicht_deklariert");
        senden(device,
                wert(device, 1, "2026-10-20T08:02:00Z", "2026-10-20T08:02:05Z", PUNKT, "64954", "64954"),
                wert(device, 2, "2026-10-20T08:03:00Z", "2026-10-20T08:03:05Z", PUNKT, "185", "185"));
        awaitMeasurementRows(device, 2);
        warte("der Bestand hat den Sprung", () -> zaehle("SELECT count(*) FROM device_measurement_event "
                + "WHERE device_id='" + device + "' AND event_kind='counter_reset'"), 1);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE entity_id='" + entity
                + "' AND art='counter_overflow'")).isZero();
        assertThat(ueberlaufErkennung("nicht_deklariert") - nichtDeklariert).isGreaterThanOrEqualTo(2.0);
    }

    /**
     * ⚠ AP-08 IP-4: ein Fehler in der Überlauf-Erkennung kostet NIE einen Messwert. Wirft die
     * Deklaration, rollt nur der Savepoint der Erkennung zurück: beide Werte sind gespeichert, der
     * Bestand meldet den Sprung wie immer als {@code counter_reset}, es entsteht KEINE
     * Überlauf-Meldung, und der Fehler ist gezählt.
     */
    @Test
    void einFehlerInDerUeberlaufErkennungKostetKeinenMesswert() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000013";
        String entity = "71000000-0000-0000-0000-000000000013";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            uemsKomponente(st, device, entity, "72000000-0000-0000-0000-000000000013", "DQ-13",
                    "73000000-0000-0000-0000-000000000013", "K-8a", "2026-10-01T00:00:00Z",
                    "2026-10-01T00:00:00Z");
            auswahl(st, device, entity, PUNKT, "counter", "2026-10-01T00:00:00Z",
                    "2026-10-01T00:00:30Z", 1);
            st.execute("CREATE OR REPLACE FUNCTION messreihe_zaehler_deklaration(p_tenant UUID, p_entity UUID, "
                    + "p_messkanal TEXT, p_zeit TIMESTAMPTZ) RETURNS TABLE (wertebereich_modul NUMERIC, "
                    + "hoechstzuwachs_je_kadenz NUMERIC, kadenz_s INTEGER, neustart_verlust_s INTEGER) "
                    + "LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'Deklaration kaputt'; END $$");
        }
        double fehler = ueberlaufErkennungFehler();
        try {
            senden(device,
                    wert(device, 1, "2026-10-20T08:02:00Z", "2026-10-20T08:02:05Z", PUNKT, "64954", "64954"),
                    wert(device, 2, "2026-10-20T08:03:00Z", "2026-10-20T08:03:05Z", PUNKT, "185", "185"));
            awaitMeasurementRows(device, 2);
            warte("der Bestand hat den Sprung", () -> zaehle("SELECT count(*) FROM device_measurement_event "
                    + "WHERE device_id='" + device + "' AND event_kind='counter_reset'"), 1);
            assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                    + "' AND entity_id='" + entity + "' AND role IS NOT NULL"))
                    .as("beide Werte sind da, mit ihrer Herkunft — nie verloren").isEqualTo(2);
            assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE entity_id='" + entity
                    + "' AND art='counter_overflow'")).isZero();
            assertThat(ueberlaufErkennungFehler() - fehler).as("jeder Fehler gezählt").isGreaterThanOrEqualTo(2.0);
        } finally {
            try (Connection c = admin(); Statement st = c.createStatement()) {
                st.execute("DROP FUNCTION messreihe_zaehler_deklaration(UUID, UUID, TEXT, TIMESTAMPTZ)");
                deklaration(st, "SELECT NULL::numeric, NULL::numeric, NULL::integer, NULL::integer WHERE false");
            }
        }
    }

    /**
     * Bestandsschutz: ein Wert ohne eindeutige Komponente oder ohne Datenquelle geht Zeichen für
     * Zeichen den alten Weg. Der Fingerabdruck seiner Bestandsspalten ist nach einer erneuten
     * Zustellung derselbe, die sieben neuen Spalten bleiben leer, und der ALTE Schlüssel fängt die
     * Wiederholung weiter — er ist für diese Zeilen der einzige, den es gibt.
     */
    @Test
    void einBestandswertGehtWeiterDenAltenWeg() throws Exception {
        createTopic(MEASUREMENTS_RAW_TOPIC);
        String device = "70000000-0000-0000-0000-000000000009";
        String a = "71000000-0000-0000-0000-00000000000a";
        String b = "71000000-0000-0000-0000-00000000000b";
        String quelle = "72000000-0000-0000-0000-000000000009";
        try (Connection c = admin(); Statement st = c.createStatement()) {
            st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + device + "','"
                    + TENANT_A + "','" + SITE + "')");
            st.execute("INSERT INTO measurement_catalog_point_metadata VALUES ('" + UEMS_CATALOG
                    + "','" + PUNKT + "','counter',900) ON CONFLICT DO NOTHING");
            st.execute("INSERT INTO data_source(id,tenant_id,kennzeichen,kadenz_s) VALUES ('"
                    + quelle + "','" + TENANT_A + "','DQ-9',60)");
            // Zwei baugleiche Geräte hinter EINER Box: die Komponente folgt NICHT eindeutig.
            for (String e : new String[] {a, b}) {
                st.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,device_id,"
                        + "data_source_id) VALUES ('" + e + "','" + TENANT_A + "','" + SITE
                        + "','grid','" + device + "','" + quelle + "')");
                auswahl(st, device, e, PUNKT, "counter", "2026-11-01T00:00:00Z",
                        "2026-11-01T00:00:30Z", 1);
            }
        }
        String paket = wert(device, 400, "2026-11-21T10:00:00Z", "2026-11-21T10:00:05Z", PUNKT,
                "88", "8.8");
        senden(device, paket);
        awaitMeasurementRows(device, 1);
        String fingerabdruck = fingerabdruck(device, "2026-11-21T10:00:00Z");
        // Dasselbe Paket noch einmal - und danach eine Kontroll-Zustellung, an der das Warten
        // sieht, dass die Wiederholung wirklich durch war.
        senden(device, paket,
                wert(device, 401, "2026-11-21T10:01:00Z", "2026-11-21T10:01:05Z", PUNKT, "89",
                        "8.9"));
        awaitMeasurementRows(device, 2);
        assertThat(fingerabdruck(device, "2026-11-21T10:00:00Z"))
                .as("derselbe Fingerabdruck der Bestandsspalten").isEqualTo(fingerabdruck);
        assertThat(zaehle("SELECT count(*) FROM device_measurement_sample WHERE device_id='" + device
                + "' AND entity_id IS NULL AND role IS NULL AND delivery IS NULL"))
                .as("keine geratene Komponente, keine geratene Rolle").isEqualTo(2);
        assertThat(zaehle("SELECT count(*) FROM messreihe_ereignis WHERE device_id='" + device + "'"))
                .as("ein Bestandswert löst kein UEMS-Ereignis aus").isZero();
    }

    // ---- Werkzeug für die UEMS-Fälle ----------------------------------------------------

    /** Box, Datenquelle mit ihrer Zuständigkeit, Komponente an der Quelle und ihr Gerät-Einbau. */
    private void uemsKomponente(Statement st, String device, String entity, String quelle,
            String kennzeichen, String geraet, String einbau, String zustaendigAb, String einbauAb)
            throws Exception {
        st.execute("INSERT INTO device(id,tenant_id,site_id) VALUES ('" + device + "','" + TENANT_A
                + "','" + SITE + "') ON CONFLICT DO NOTHING");
        st.execute("INSERT INTO measurement_catalog_point_metadata VALUES ('" + UEMS_CATALOG + "','"
                + PUNKT + "','counter',900) ON CONFLICT DO NOTHING");
        st.execute("INSERT INTO data_source(id,tenant_id,kennzeichen,kadenz_s) VALUES ('" + quelle
                + "','" + TENANT_A + "','" + kennzeichen + "',60)");
        st.execute("INSERT INTO data_source_assignment(tenant_id,data_source_id,device_id,"
                + "effective_from) VALUES ('" + TENANT_A + "','" + quelle + "','" + device + "','"
                + zustaendigAb + "')");
        st.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,device_id,"
                + "data_source_id) VALUES ('" + entity + "','" + TENANT_A + "','" + SITE
                + "','grid','" + device + "','" + quelle + "')");
        st.execute("INSERT INTO geraet(id,tenant_id,site_id,kennzeichen,einbau_kennzeichen,"
                + "seriennummer,eingebaut_am) VALUES ('" + geraet + "','" + TENANT_A + "','" + SITE
                + "','" + einbau.substring(0, einbau.length() - 1) + "','" + einbau + "','SN-"
                + einbau + "','" + einbauAb + "')");
        st.execute("INSERT INTO geraet_komponente(tenant_id,geraet_id,entity_id,gueltig_ab) VALUES ('"
                + TENANT_A + "','" + geraet + "','" + entity + "','" + einbauAb + "')");
    }

    private void bindung(Statement st, String messstelle, String entity, String geraet,
            String rolle, String ab) throws Exception {
        st.execute("INSERT INTO messstelle_quelle(tenant_id,messstelle_id,entity_id,geraet_id,"
                + "kanal,rolle,gueltig_ab) VALUES ('" + TENANT_A + "','" + messstelle + "','"
                + entity + "','" + geraet + "','" + PUNKT + "','" + rolle + "','" + ab + "')");
    }

    private void auswahl(Statement st, String device, String entity, String punkt, String art,
            String enabledAt, String appliedAt, long revision) throws Exception {
        st.execute("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,point_key,"
                + "enabled,cadence_s,desired_revision,enabled_at,catalog_version,changed_by,"
                + "apply_status,applied_at,retention_class,raw_retention_days,long_term_cadence_s,"
                + "long_term_strategy,entity_id) VALUES ('" + TENANT_A + "','" + SITE + "','"
                + device + "','" + punkt + "',true,60," + revision + ",'" + enabledAt + "','"
                + UEMS_CATALOG + "','test','applied','" + appliedAt + "','energy_counter',90,900,"
                + "'fifteen_minute'," + (entity == null ? "NULL" : "'" + entity + "'") + ")");
    }

    /** Ein Umschlag mit EINEM Wert. */
    private static String wert(String device, long sequence, String observedAt, String ingestedAt,
            String punkt, String raw, String decoded) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + UUID.randomUUID()
                + "\",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + device + "\",\"catalog_version\":\"" + UEMS_CATALOG
                + "\",\"sequence\":" + sequence + ",\"observed_at\":\"" + observedAt
                + "\",\"ingested_at\":\"" + ingestedAt + "\",\"source_topic\":\"ems/" + TENANT_A
                + "/" + SITE + "/" + device + "/v2/measurement-samples\",\"gap\":false,"
                + "\"dropped_samples\":0,\"samples\":[{\"point_key\":\"" + punkt + "\",\"raw\":"
                + raw + ",\"decoded\":" + decoded + ",\"quality\":\"good\"}]}";
    }

    private void senden(String device, String... pakete) throws Exception {
        try (KafkaProducer<String, String> producer = producer()) {
            String key = TENANT_A + ":" + SITE + ":" + device;
            for (String paket : pakete) {
                producer.send(new ProducerRecord<>(MEASUREMENTS_RAW_TOPIC, key, paket)).get();
            }
            producer.flush();
        }
    }

    /** 20 Umschläge einer Box senden und warten, bis alle 20 Werte liegen; Dauer in ms. */
    private long durchsatz(String device) throws Exception {
        String[] pakete = new String[20];
        for (int i = 0; i < pakete.length; i++) {
            pakete[i] = wert(device, 200 + i, "2026-11-19T10:" + (i < 10 ? "0" + i : i) + ":00Z",
                    "2026-11-19T10:" + (i < 10 ? "0" + i : i) + ":05Z", PUNKT,
                    Integer.toString(1000 + i), Integer.toString(100 + i) + ".0");
        }
        long start = System.nanoTime();
        senden(device, pakete);
        awaitMeasurementRows(device, 20);
        return Duration.ofNanos(System.nanoTime() - start).toMillis();
    }

    /** md5 über die BESTANDSSPALTEN einer Box — die Spalten, die es vor IP-7 schon gab. */
    private String fingerabdruck(String device, String zeit) throws Exception {
        try (Connection c = admin(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery("SELECT md5(string_agg(z,'|' ORDER BY z)) FROM ("
                        + "SELECT concat_ws('~',time,received_at,tenant_id,site_id,device_id,"
                        + "point_key,raw_numeric,raw_text,decoded_numeric,decoded_text,quality,"
                        + "catalog_version,edge_sequence,aggregation_kind,long_term_cadence_s,gap,"
                        + "dropped_samples,signed_data,signed_data_format) AS z "
                        + "FROM device_measurement_sample WHERE device_id='" + device
                        + "' AND time='" + zeit + "') s")) {
            rs.next();
            return rs.getString(1);
        }
    }

    private double writerEreignis(String ergebnis) {
        Counter c = meters.find(MessreiheEreignisRepository.WRITER_METRIK)
                .tag("ergebnis", ergebnis).tag("grund", "").counter();
        return c == null ? 0 : c.count();
    }

    /** Ersetzt den Rumpf der Deklaration (V20260912220000) — die Tür, die AP-08 IP-7 füllt. */
    private static void deklaration(Statement st, String rumpf) throws Exception {
        st.execute("CREATE OR REPLACE FUNCTION messreihe_zaehler_deklaration(p_tenant UUID, p_entity UUID, "
                + "p_messkanal TEXT, p_zeit TIMESTAMPTZ) RETURNS TABLE (wertebereich_modul NUMERIC, "
                + "hoechstzuwachs_je_kadenz NUMERIC, kadenz_s INTEGER, neustart_verlust_s INTEGER) "
                + "LANGUAGE sql STABLE PARALLEL SAFE AS $$ " + rumpf + " $$");
    }

    private double ueberlaufErkennung(String ergebnis) {
        Counter c = meters.find(UeberlaufErkennung.METRIK).tag("ergebnis", ergebnis).tag("grund", "").counter();
        return c == null ? 0 : c.count();
    }

    private double ueberlaufErkennungFehler() {
        return meters.find(UeberlaufErkennung.METRIK).tag("ergebnis", "fehler").counters().stream()
                .mapToDouble(Counter::count).sum();
    }

    private double abfragen(String nachschlag) {
        Counter c = meters.find(HerkunftNachschlag.METRIK).tag("nachschlag", nachschlag)
                .tag("ergebnis", "abfrage").counter();
        return c == null ? 0 : c.count();
    }

    /** Wartet, bis eine Zählung ihren Wert erreicht (der Listener arbeitet nebenläufig). */
    private void warte(String was, Zaehlung zaehlung, long erwartet) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(45).toNanos();
        long ist = -1;
        while (System.nanoTime() < deadline) {
            ist = zaehlung.zaehle();
            if (ist == erwartet) {
                return;
            }
            Thread.sleep(250);
        }
        throw new AssertionError(was + ": " + ist + " statt " + erwartet);
    }

    private interface Zaehlung {
        long zaehle() throws Exception;
    }

    private double spiegel(String ergebnis, String grund) {
        Counter c = meters.find(MessreiheEreignisRepository.SPIEGEL_METRIK).tag("ergebnis", ergebnis)
                .tag("grund", grund).counter();
        return c == null ? 0 : c.count();
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

    private long zaehle(String sql) throws Exception {
        try (Connection c = admin(); Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    /** messreihe_ereignis rows of the device as the app role sees them under the tenant. */
    private long ereignisseVisible(String tenant, String device) throws Exception {
        Properties p = new Properties();
        p.put("user", "voltpilot_app");
        p.put("password", APP_PW);
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), p);
                Statement st = c.createStatement()) {
            st.execute("SELECT set_config('app.tenant_id','" + tenant + "',false)");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM messreihe_ereignis "
                    + "WHERE device_id='" + device + "'")) {
                rs.next();
                return rs.getLong(1);
            }
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
