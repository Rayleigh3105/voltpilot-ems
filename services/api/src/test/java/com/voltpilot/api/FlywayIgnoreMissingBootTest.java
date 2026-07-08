package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Regression guard for the recurring production-deploy Flyway footgun: a VM that
 * ran {@code SPRING_PROFILES_ACTIVE=local} applied the DEV-ONLY {@code db/dev}
 * seed migrations, then - on the next deploy that moves it to the blank
 * production profile (or that carries an EDITED {@code db/dev} hotfix) - the api
 * refused to start because Flyway validation flagged the now-off-classpath dev
 * migrations as "detected applied migration not resolved locally".
 *
 * <p>The api's {@code application.yml} now sets
 * {@code spring.flyway.ignore-migration-patterns: "*:missing"}. This test
 * exercises that exact Flyway configuration at the DB level (the same thing that
 * runs at api startup - see {@code DevSeedGuardTest} for the precedent of
 * asserting boot-time Flyway behaviour without a full Spring context):
 *
 * <ul>
 *   <li>the production config (db/migration ONLY + ignore {@code *:missing})
 *       boots cleanly over a DB that has the dev migrations recorded, while
 *       the SAME config WITHOUT the ignore pattern fails - proving the fix;</li>
 *   <li>a genuine checksum MISMATCH on a migration that is still on the classpath
 *       STILL fails even with {@code *:missing} set - proving validation is not
 *       over-loosened (dev + CI keep catching accidental edits).</li>
 * </ul>
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
class FlywayIgnoreMissingBootTest {

    // NON-static on purpose: a fresh container per test method, so the
    // checksum-tampering test can never leak a corrupted history into the
    // boot test (order-independent isolation).
    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void prodProfileBootsOverADbThatAlreadyAppliedTheDevMigrations() throws Exception {
        // 1. The VM's history: it ran with the `local` profile, so BOTH the core
        //    and the DEV-ONLY seed migrations are recorded in flyway_schema_history.
        withDevSeeds().load().migrate();
        assertThat(count("SELECT count(*) FROM flyway_schema_history "
                + "WHERE version = '20260706020000'")).isEqualTo(1L);

        // 2. The next deploy moves the instance to the blank PRODUCTION profile:
        //    only db/migration is on the classpath, so the db/dev entries are now
        //    "missing". WITHOUT the ignore pattern this is exactly the startup
        //    failure the captain hit ("detected applied migration not resolved
        //    locally").
        assertThatThrownBy(() -> prodCore(false).load().validate())
                .isInstanceOf(FlywayValidateException.class)
                .hasMessageContaining("not resolved locally");

        // 3. With spring.flyway.ignore-migration-patterns "*:missing" (what the
        //    api now ships), the same production config validates AND migrates
        //    cleanly - the api boots. migrate() runs validateOnMigrate, so a
        //    passing no-op migrate here is a faithful proxy for a clean startup.
        prodCore(true).load().migrate();
        // The core schema is intact and no db/dev rows were re-run or removed.
        assertThat(count("SELECT count(*) FROM tenant")).isGreaterThanOrEqualTo(0L);
        assertThat(count("SELECT count(*) FROM flyway_schema_history "
                + "WHERE version = '20260706020000'")).isEqualTo(1L);
    }

    @Test
    void genuineChecksumMismatchStillFailsEvenWithIgnoreMissing() throws Exception {
        // A DB with the full production core applied.
        prodCore(true).load().migrate();

        // Simulate an accidental edit of an ALREADY-APPLIED, still-on-classpath
        // core migration: its recorded checksum no longer matches the resolved
        // one. This is a MISMATCH, not a MISSING - "*:missing" must not hide it.
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute("UPDATE flyway_schema_history SET checksum = checksum + 1 "
                    + "WHERE version = '1'");
        }

        assertThatThrownBy(() -> prodCore(true).load().validate())
                .isInstanceOf(FlywayValidateException.class)
                .hasMessageContaining("checksum mismatch");
    }

    /** Production config: db/migration ONLY, optionally ignoring "*:missing" (the api's setting). */
    private FluentConfiguration prodCore(boolean ignoreMissing) {
        FluentConfiguration cfg = base().locations("classpath:db/migration");
        if (ignoreMissing) {
            cfg.ignoreMigrationPatterns("*:missing");
        }
        return cfg;
    }

    /** The `local`-profile config: core + the DEV-ONLY seed migrations. */
    private FluentConfiguration withDevSeeds() {
        return base().locations("classpath:db/migration", "classpath:db/dev");
    }

    private FluentConfiguration base() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
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
