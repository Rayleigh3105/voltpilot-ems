package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** A10: actual core writer, actual RLS and nested rollback; no edge release needed. */
@Testcontainers
class KernSpiegelTest {
    @Container
    static final PostgreSQLContainer<?> DB = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("test")
            .withInitScript("writer-schema.sql");
    static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    static final Instant TIME = Instant.parse("2026-10-20T08:00:00Z");
    static final String POINT = "kostal_plenticore.grid-power";
    static final ObjectMapper JSON = new ObjectMapper();
    static final SimpleMeterRegistry METERS = new SimpleMeterRegistry();
    static JdbcTemplate root;
    static JdbcTemplate app;
    static TelemetryV2WriteRepository writer;
    static TransactionTemplate tx;
    record Fixture(UUID box, UUID entity) {}

    @BeforeAll
    static void connect() throws Exception {
        root = new JdbcTemplate(new DriverManagerDataSource(DB.getJdbcUrl(), DB.getUsername(), DB.getPassword()));
        var ds = new DriverManagerDataSource(DB.getJdbcUrl(), "voltpilot_app", "voltpilot_app_test_pw");
        app = new JdbcTemplate(ds);
        var manager = new DataSourceTransactionManager(ds);
        tx = new TransactionTemplate(manager);
        writer = new TelemetryV2WriteRepository(app, new KernSpiegelNachschlag(app, manager, METERS, JSON));
    }

    @Test
    void a10NativeAndFanoutAnnotateOnlyTheCoreAndKeepItsValue() {
        Fixture f = fixture();
        var entities = JSON.createObjectNode();
        entities.putObject(f.entity().toString()).putObject("channels").put("power_kw", -1.25);
        var event = new TelemetryV2RawEvent("1.0", UUID.randomUUID(), TENANT, SITE, f.box(), TIME,
                TIME.plusSeconds(10), "test", entities);
        assertThat(tx.<Integer>execute(s -> writer.insert(event))).isEqualTo(1);
        assertThat(tx.<Integer>execute(s -> writer.insert(event))).isZero();
        assertThat(root.queryForMap("SELECT role, spiegel_point_key, value FROM telemetry_v2 WHERE entity_id=?",
                f.entity().toString())).containsEntry("role", "spiegel").containsEntry("spiegel_point_key", POINT)
                .containsEntry("value", -1.25d);
        write(f, TIME.plusSeconds(60), "power_kw");
        assertThat(root.queryForObject("SELECT count(*) FROM telemetry_v2 WHERE entity_id=? AND role='spiegel'",
                Long.class, f.entity().toString())).isEqualTo(2L);
        assertThat(root.queryForObject("SELECT count(*) FROM telemetry_v2 WHERE entity_id=? "
                + "AND role IS DISTINCT FROM 'spiegel'", Long.class, f.entity().toString())).isZero();
    }

    @Test
    void observationTimeControlsSelectionIncludingDelayedDataAndEndBoundary() {
        Fixture f = fixture();
        root.update("INSERT INTO device_measurement_selection_event(tenant_id,site_id,device_id,entity_id,"
                + "point_key,desired_revision,event_kind,requested_at,requested_enabled,enabled_at,catalog_version,"
                + "actor,apply_status,applied_at,retention_class,raw_retention_days,long_term_strategy) "
                + "SELECT tenant_id,site_id,device_id,entity_id,point_key,desired_revision,'applied',enabled_at,"
                + "enabled,enabled_at,catalog_version,'test',apply_status,applied_at,retention_class,"
                + "raw_retention_days,long_term_strategy FROM device_measurement_selection WHERE entity_id=?",
                f.entity());
        root.update("UPDATE device_measurement_selection SET enabled=false, disabled_at=?, applied_at=? "
                + "WHERE entity_id=?", java.sql.Timestamp.from(TIME.plusSeconds(60)),
                java.sql.Timestamp.from(TIME.plusSeconds(120)), f.entity());
        write(f, TIME.minusSeconds(1), "power_kw");
        write(f, TIME, "power_kw");
        write(f, TIME.plusSeconds(60), "power_kw");
        assertThat(root.queryForList("SELECT role FROM telemetry_v2 WHERE entity_id=? ORDER BY time",
                String.class, f.entity().toString())).containsExactly(null, "spiegel", null);
    }

    @Test
    void unknownModelAndDerivedChannelRemainUnchanged() {
        Fixture f = fixture();
        write(f, TIME, "battery_power_kw");
        root.update("UPDATE measurement_point SET family='custom' WHERE id=?", f.entity());
        write(f, TIME, "power_kw");
        root.update("UPDATE measurement_point SET family='kostal_plenticore', source_kind='custom' WHERE id=?",
                f.entity());
        write(f, TIME.plusSeconds(60), "power_kw");
        assertThat(root.queryForObject("SELECT count(*) FROM telemetry_v2 WHERE entity_id=? AND role IS NULL",
                Long.class, f.entity().toString())).isEqualTo(3L);
    }

    @Test
    void requestedButUnappliedCatalogPathIsNotAMirror() {
        Fixture f = fixture();
        root.update("UPDATE device_measurement_selection SET applied_at=NULL, apply_status='pending_edge' "
                + "WHERE entity_id=?", f.entity());
        write(f, TIME, "power_kw");
        assertThat(root.queryForObject("SELECT role FROM telemetry_v2 WHERE entity_id=?",
                String.class, f.entity().toString())).isNull();
    }

    @Test
    void anotherComponentOrTenantDoesNotProveTheSameRegister() {
        Fixture f = fixture();
        root.update("UPDATE device_measurement_selection SET entity_id=? WHERE entity_id=?",
                UUID.randomUUID(), f.entity());
        write(f, TIME, "power_kw");
        root.update("UPDATE device_measurement_selection SET entity_id=?,tenant_id=? WHERE device_id=?",
                f.entity(), TENANT, f.box());
        root.update("UPDATE measurement_point SET tenant_id=? WHERE id=?", UUID.randomUUID(), f.entity());
        write(f, TIME.plusSeconds(60), "power_kw");
        assertThat(root.queryForObject("SELECT count(*) FROM telemetry_v2 WHERE entity_id=? AND role IS NULL",
                Long.class, f.entity().toString())).isEqualTo(2L);
    }

    @Test
    void failedLookupRollsBackOnlyTheAnnotation() {
        Fixture f = fixture();
        root.execute("REVOKE SELECT ON device_measurement_selection FROM voltpilot_app");
        try {
            write(f, TIME, "power_kw");
        } finally {
            root.execute("GRANT SELECT ON device_measurement_selection TO voltpilot_app");
        }
        assertThat(root.queryForObject("SELECT value FROM telemetry_v2 WHERE entity_id=? AND role IS NULL",
                Double.class, f.entity().toString())).isEqualTo(1.25d);
        assertThat(METERS.counter("voltpilot.writer.kern.spiegel", "ergebnis", "fehler").count()).isEqualTo(1d);
    }

    @Test
    void twoPossibleMeterRegistersAreNotAnUnambiguousMatch() {
        Fixture f = fixture();
        root.update("UPDATE measurement_point SET family='sunspec_live' WHERE id=?", f.entity());
        root.update("UPDATE device_measurement_selection SET point_key='sunspec.model_211.w' WHERE entity_id=?",
                f.entity());
        selection(f, "sunspec.model_212.w");
        write(f, TIME, "power_kw");
        assertThat(root.queryForObject("SELECT role FROM telemetry_v2 WHERE entity_id=?",
                String.class, f.entity().toString())).isNull();
    }

    static void write(Fixture f, Instant time, String channel) {
        assertThat(tx.<Integer>execute(s -> writer.insertChannels(TENANT, SITE, f.box(),
                List.of(new TelemetryV2WriteRepository.ChannelRow(f.entity().toString(), channel, 1.25)),
                time, TIME.plusSeconds(3600)))).isEqualTo(1);
    }

    static Fixture fixture() {
        Fixture f = new Fixture(UUID.randomUUID(), UUID.randomUUID());
        root.update("INSERT INTO device(id,tenant_id,site_id) VALUES (?,?,?)", f.box(), TENANT, SITE);
        root.update("INSERT INTO measurement_point(id,tenant_id,site_id,role,device_id,entity_type,family) "
                + "VALUES (?,?,?,'grid-meter',?,'grid-meter','kostal_plenticore')", f.entity(), TENANT, SITE, f.box());
        selection(f, POINT);
        return f;
    }

    static void selection(Fixture f, String point) {
        root.update("INSERT INTO device_measurement_selection(tenant_id,site_id,device_id,entity_id,point_key,"
                + "enabled,cadence_s,desired_revision,enabled_at,catalog_version,changed_by,apply_status,"
                + "retention_class,raw_retention_days,long_term_strategy,applied_at) "
                + "VALUES (?,?,?,?,?,true,60,1,?,'2026.08.26.3','test','applied','live_power',90,'fifteen_minute',?)",
                TENANT, SITE, f.box(), f.entity(), point, java.sql.Timestamp.from(TIME), java.sql.Timestamp.from(TIME));
    }
}
