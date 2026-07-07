package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Regression guard for the production outage where the api crash-looped on a VM
 * running {@code SPRING_PROFILES_ACTIVE=local}: the dev fleet/earnings seeds
 * (V20260706020000 / V20260706030000) referenced the demo tenant
 * {@code 00000000-...-0001} unconditionally, and on a DB where that tenant row
 * is absent (offboarded, or never seeded) the site insert violated
 * {@code site_tenant_id_fkey} (SQLSTATE 23503) and Flyway aborted startup.
 *
 * <p>Reproduces that exact state - dev migration chain applied through
 * V20260706010000, demo tenant then deleted - and asserts the later dev seeds
 * now migrate cleanly as no-ops while an untouched tenant keeps its data.
 * The happy path (fresh DB gets the full demo fleet) stays covered by
 * {@link RlsIsolationTest} and {@code PortalApiTest}.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class DevSeedGuardTest {

    private static final String DEMO_TENANT = "00000000-0000-0000-0000-000000000001";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void devSeedsNoOpCleanlyWhenTheDemoTenantIsAbsent() throws Exception {
        // 1. Apply everything up to (and including) V20260706010000 - V100 has
        //    seeded the demo tenants at this point, the fleet seed is pending.
        flyway().target("20260706010000").load().migrate();

        // 2. The VM's state: the demo tenant row is gone (site/device/asset
        //    cascade with it) before the fleet seed ever ran.
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute("DELETE FROM tenant WHERE id = '" + DEMO_TENANT + "'");
        }

        // 3. The rest of the chain (fleet seed, earnings seed, later core
        //    migrations) must apply cleanly - this exact call failed with
        //    SQLSTATE 23503 on site_tenant_id_fkey before the guards.
        flyway().load().migrate();

        // 4. The guarded seeds no-oped: no fleet rows for the absent tenant
        //    (rollup rows from V100's Berlin telemetry pre-date the delete and
        //    stay - hypertables have no FK - so scope to the seeded site ids),
        //    no dev-seed prices, while tenant B's V100 data is untouched.
        String fleetSites = "('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000022')";
        assertThat(count("SELECT count(*) FROM site WHERE tenant_id = '" + DEMO_TENANT + "'")).isZero();
        assertThat(count("SELECT count(*) FROM telemetry_rollup_15m WHERE site_id IN " + fleetSites)).isZero();
        assertThat(count("SELECT count(*) FROM schedule WHERE site_id IN " + fleetSites)).isZero();
        assertThat(count("SELECT count(*) FROM day_ahead_prices WHERE source = 'dev-seed'")).isZero();
        assertThat(count("SELECT count(*) FROM site WHERE name = 'Nordwind Hamburg'")).isEqualTo(1L);
    }

    private FluentConfiguration flyway() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(java.util.Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private long count(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }
}
