package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
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
        assertThat(sitesForTenant(TENANT_A)).containsExactly("Demo Site Berlin");
        assertThat(sitesForTenant(TENANT_B)).containsExactly("Nordwind Hamburg");
    }

    @Test
    void tenantSeesOnlyItsOwnDevicesAndTelemetry() throws Exception {
        assertThat(scalar(TENANT_A, "SELECT count(*) FROM device")).isEqualTo(1L);
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

    private void setTenant(Connection c, String tenantId) throws Exception {
        try (PreparedStatement ps = c.prepareStatement("SELECT set_config('app.tenant_id', ?, false)")) {
            ps.setString(1, tenantId);
            ps.execute();
        }
    }
}
