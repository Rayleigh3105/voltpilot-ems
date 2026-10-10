package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * {@code device_battery_control} gegen eine echte TimescaleDB (Migration
 * V20261007120000): die App-Rolle schreibt mandantengebunden, RLS + FORCE
 * trennen die Mandanten, {@code state_since} bleibt bei gleichem Wort stehen,
 * und die Tabelle nimmt nur die drei Vertragswörter an.
 *
 * <p>Überspringt sich ohne Docker ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class BatteryControlRepositoryTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @BeforeAll
    static void migrate() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load()
                .migrate();
    }

    /** Die App-Rolle mit dem Mandanten in app.tenant_id - wie der Listener. */
    private static JdbcTemplate asTenant(String tenant) throws Exception {
        Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(), APP_USER, APP_PW);
        try (Statement s = c.createStatement()) {
            s.execute("SELECT set_config('app.tenant_id', '" + tenant + "', false)");
        }
        return new JdbcTemplate(new SingleConnectionDataSource(c, true));
    }

    @Test
    void theAppRoleWritesTenantBoundAndTheSinceStaysForTheSameWord() throws Exception {
        UUID device = UUID.randomUUID();
        JdbcTemplate a = asTenant(TENANT_A);
        BatteryControlRepository repo = new BatteryControlRepository(a);

        repo.upsert(device, SITE, new BatteryControlRepository.State("beobachtet", false, false));
        Timestamp since = a.queryForObject(
                "SELECT state_since FROM device_battery_control WHERE device_id = ?", Timestamp.class, device);
        Thread.sleep(20);
        repo.upsert(device, SITE, new BatteryControlRepository.State("beobachtet", false, false));
        Map<String, Object> row = a.queryForMap(
                "SELECT tenant_id::text AS tenant, state, state_since, reported_at "
                        + "FROM device_battery_control WHERE device_id = ?", device);
        assertThat(row.get("tenant")).isEqualTo(TENANT_A);
        assertThat(row.get("state_since")).isEqualTo(since);
        assertThat(((Timestamp) row.get("reported_at")).after(since)).isTrue();

        Thread.sleep(20);
        repo.upsert(device, SITE, new BatteryControlRepository.State("gesteuert", true, true));
        Map<String, Object> switched = a.queryForMap(
                "SELECT state, control_enabled, certified, state_since FROM device_battery_control "
                        + "WHERE device_id = ?", device);
        assertThat(switched.get("state")).isEqualTo("gesteuert");
        assertThat(switched.get("control_enabled")).isEqualTo(true);
        assertThat(((Timestamp) switched.get("state_since")).after(since)).isTrue();

        // Ein anderer Mandant sieht die Zeile nicht.
        assertThat(asTenant(TENANT_B).queryForObject(
                "SELECT count(*) FROM device_battery_control WHERE device_id = ?", Long.class, device))
                .isZero();
    }

    @Test
    void theTableIsForceRlsAndTakesOnlyTheContractWords() throws Exception {
        try (Connection c = DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()); Statement s = c.createStatement()) {
            var rs = s.executeQuery("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class "
                    + "WHERE relname = 'device_battery_control'");
            assertThat(rs.next()).isTrue();
            assertThat(rs.getBoolean(1)).isTrue();
        }
        JdbcTemplate a = asTenant(TENANT_A);
        assertThatThrownBy(() -> a.update(
                "INSERT INTO device_battery_control (device_id, tenant_id, site_id, state, "
                        + "control_enabled, certified, state_since, reported_at) "
                        + "VALUES (?, ?::uuid, ?, 'halb', false, false, now(), now())",
                UUID.randomUUID(), TENANT_A, SITE))
                .rootCause().hasMessageContaining("device_battery_control_state_check");
        // WITH CHECK: kein Schreiben in einen fremden Mandanten.
        assertThatThrownBy(() -> a.update(
                "INSERT INTO device_battery_control (device_id, tenant_id, site_id, state, "
                        + "control_enabled, certified, state_since, reported_at) "
                        + "VALUES (?, ?::uuid, ?, 'beobachtet', false, false, now(), now())",
                UUID.randomUUID(), TENANT_B, SITE))
                .rootCause().hasMessageContaining("row-level security");
    }
}
