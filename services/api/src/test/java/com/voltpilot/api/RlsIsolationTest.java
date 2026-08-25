package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Proves Row-Level-Security isolation directly at the JDBC layer against a real
 * TimescaleDB: connecting as the non-privileged app role and setting
 * {@code app.tenant_id} scopes every table to that tenant. This is the headline
 * tenant-isolation guarantee (architecture §9/§14.1).
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class RlsIsolationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrate() {
        // Flyway as the superuser creates the app role, schema, RLS + dev seed.
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load()
                .migrate();
    }

    private DataSource appDataSource() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(APP_USER);
        ds.setPassword(APP_PW);
        return ds;
    }

    @Test
    void tenantSeesOnlyItsOwnSites() throws Exception {
        // Tenant A is the dev-seeded multi-site fleet (V100 + V20260706020000).
        assertThat(sitesForTenant(TENANT_A)).containsExactlyInAnyOrder(
                "Demo Site Berlin", "Solarpark Dachau", "Hof Lindenberg");
        assertThat(sitesForTenant(TENANT_B)).containsExactly("Nordwind Hamburg");
    }

    @Test
    void tenantSeesOnlyItsOwnDevicesAndTelemetry() throws Exception {
        assertThat(scalar(TENANT_A, "SELECT count(*) FROM device")).isEqualTo(3L);
        assertThat(scalar(TENANT_A, "SELECT count(DISTINCT tenant_id) FROM telemetry")).isEqualTo(1L);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device")).isEqualTo(1L);
        assertThat(scalar(TENANT_B, "SELECT count(DISTINCT tenant_id) FROM telemetry")).isEqualTo(1L);
        // And each tenant's telemetry is genuinely its own, never the other's.
        assertThat(scalar(TENANT_A,
                "SELECT count(*) FROM telemetry WHERE tenant_id = '" + TENANT_B + "'")).isEqualTo(0L);
    }

    @Test
    void withoutTenantContextNothingIsVisible() throws Exception {
        try (Connection c = appDataSource().getConnection();
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT count(*) FROM site")) {
            rs.next();
            // Default-deny: no app.tenant_id set => zero rows.
            assertThat(rs.getLong(1)).isZero();
        }
    }

    @Test
    void everyOcppTableIsForceRlsAndRejectsCrossTenantWrites() throws Exception {
        String[] tables = {
                "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
                "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
                "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
                "ocpp_configuration_unknown_key", "ocpp_station_capability"
        };
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            s.executeUpdate("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, "
                    + "last_seen, updated_at) VALUES "
                    + "('00000000-0000-0000-0000-000000000003','RLS-A','" + TENANT_A
                    + "','00000000-0000-0000-0000-000000000002',now(),now()),"
                    + "('10000000-0000-0000-0000-000000000003','RLS-B','" + TENANT_B
                    + "','10000000-0000-0000-0000-000000000002',now(),now()) "
                    + "ON CONFLICT DO NOTHING");
            try (ResultSet rs = s.executeQuery("SELECT count(*) FROM pg_class WHERE relname IN ('"
                    + String.join("','", tables) + "') AND relrowsecurity AND relforcerowsecurity")) {
                rs.next();
                assertThat(rs.getInt(1)).isEqualTo(tables.length);
            }
        }

        assertThat(scalar(TENANT_A, "SELECT count(*) FROM ocpp_station WHERE charge_point_id LIKE 'RLS-%'"))
                .isEqualTo(1);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM ocpp_station WHERE charge_point_id LIKE 'RLS-%'"))
                .isEqualTo(1);
        assertThat(scalar(TENANT_A, "SELECT count(*) FROM ocpp_station WHERE tenant_id='" + TENANT_B + "'"))
                .isZero();
        for (String table : tables) {
            assertThat(scalarWithoutTenant("SELECT count(*) FROM " + table))
                    .as(table + " default-deny").isZero();
        }

        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, TENANT_A);
            assertThatThrownBy(() -> {
                try (Statement s = c.createStatement()) {
                    s.executeUpdate("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, "
                            + "updated_at) VALUES ('10000000-0000-0000-0000-000000000003',"
                            + "'FORGED','" + TENANT_B + "','10000000-0000-0000-0000-000000000002',now())");
                }
            }).hasMessageContaining("row-level security");
        }

        // Even the schema owner cannot manufacture a mixed tenant/site/device
        // tuple or bypass the free-text secret boundary. These constraints are
        // independent backstops beneath RLS and the repository redactor.
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            assertThatThrownBy(() -> s.executeUpdate(
                    "INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, updated_at) "
                            + "VALUES ('10000000-0000-0000-0000-000000000003','MIXED','" + TENANT_A
                            + "','00000000-0000-0000-0000-000000000002',now())"))
                    .hasMessageContaining("ocpp_station_device_scope_fk");
            assertThatThrownBy(() -> s.executeUpdate(
                    "INSERT INTO ocpp_protocol_event (occurred_at,event_id,tenant_id,site_id,device_id,"
                            + "charge_point_id,direction,message_type,action,error_description,payload) VALUES ("
                            + "now(),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','" + TENANT_A + "',"
                            + "'00000000-0000-0000-0000-000000000002',"
                            + "'00000000-0000-0000-0000-000000000003','CP-SECRET','internal','Event',"
                            + "'SecretProbe','AuthorizationKey=must-not-land','{}')"))
                    .hasMessageContaining("ocpp_protocol_error_description_redacted_chk");
        }
    }

    @Test
    void measurementSelectionsAndImmutableEventsAreTenantFenced() throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, TENANT_A);
            try (Statement s = c.createStatement()) {
                s.executeUpdate("INSERT INTO device_measurement_selection (tenant_id, site_id, "
                        + "device_id, point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, apply_reason, "
                        + "retention_class, raw_retention_days, long_term_cadence_s, "
                        + "long_term_strategy) VALUES ('" + TENANT_A + "', "
                        + "'00000000-0000-0000-0000-000000000002', "
                        + "'00000000-0000-0000-0000-000000000003', 'test.rls.point', TRUE, 60, "
                        + "1, now(), '2026.08.25.1', 'test', 'pending_edge', 'wartet', "
                        + "'thermal_bms', 90, 900, 'fifteen_minute')");
                s.executeUpdate("INSERT INTO device_measurement_selection_event (tenant_id, "
                        + "site_id, device_id, point_key, desired_revision, idempotency_key, "
                        + "requested_enabled, requested_cadence_s, enabled_at, catalog_version, actor, "
                        + "apply_status, apply_reason, retention_class, raw_retention_days, "
                        + "long_term_cadence_s, long_term_strategy) VALUES ('" + TENANT_A + "', "
                        + "'00000000-0000-0000-0000-000000000002', "
                        + "'00000000-0000-0000-0000-000000000003', 'test.rls.point', 1, "
                        + "'00000000-0000-0000-0000-000000000099', TRUE, 60, now(), '2026.08.25.1', "
                        + "'test', 'pending_edge', 'wartet', 'thermal_bms', 90, 900, "
                        + "'fifteen_minute')");
            }
        }

        assertThat(scalar(TENANT_A, "SELECT count(*) FROM device_measurement_selection "
                + "WHERE point_key = 'test.rls.point'")).isEqualTo(1L);
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device_measurement_selection "
                + "WHERE point_key = 'test.rls.point'")).isZero();
        assertThat(scalar(TENANT_B, "SELECT count(*) FROM device_measurement_selection_event "
                + "WHERE point_key = 'test.rls.point'")).isZero();

        // Even a direct app-role attacker cannot pair its tenant with a foreign
        // site/device UUID: the composite FK binds all three identities.
        assertThatThrownBy(() -> execute(TENANT_A,
                "INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "point_key, enabled, cadence_s, desired_revision, enabled_at, "
                        + "catalog_version, changed_by, apply_status, retention_class, "
                        + "raw_retention_days, long_term_strategy) VALUES ('" + TENANT_A + "', "
                        + "'10000000-0000-0000-0000-000000000002', "
                        + "'10000000-0000-0000-0000-000000000003', 'attack', TRUE, 60, 2, now(), "
                        + "'2026.08.25.1', 'attacker', 'pending_edge', 'unclassified', 90, 'none')"))
                .hasMessageContaining("device_measurement_selection_device_fk");

        // The application role has no UPDATE/DELETE privilege on audit rows.
        assertThatThrownBy(() -> execute(TENANT_A,
                "UPDATE device_measurement_selection_event SET apply_reason = 'rewritten' "
                        + "WHERE point_key = 'test.rls.point'"))
                .hasMessageContaining("permission denied");
        assertThatThrownBy(() -> execute(TENANT_A,
                "DELETE FROM device_measurement_selection_event "
                        + "WHERE point_key = 'test.rls.point'"))
                .hasMessageContaining("permission denied");
    }

    private List<String> sitesForTenant(String tenantId) throws Exception {
        List<String> names = new ArrayList<>();
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, tenantId);
            try (Statement s = c.createStatement();
                    ResultSet rs = s.executeQuery("SELECT name FROM site ORDER BY name")) {
                while (rs.next()) {
                    names.add(rs.getString(1));
                }
            }
        }
        return names;
    }

    private long scalar(String tenantId, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, tenantId);
            try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
                rs.next();
                return rs.getLong(1);
            }
        }
    }

    private long scalarWithoutTenant(String sql) throws Exception {
        try (Connection c = appDataSource().getConnection();
                Statement s = c.createStatement(); ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private void execute(String tenantId, String sql) throws Exception {
        try (Connection c = appDataSource().getConnection()) {
            setTenant(c, tenantId);
            try (Statement s = c.createStatement()) {
                s.executeUpdate(sql);
            }
        }
    }

    private void setTenant(Connection c, String tenantId) throws Exception {
        try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenantId);
            ps.execute();
        }
    }
}
