package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.voltpilot.api.config.SelfHealingFlywayMigrationStrategy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.flywaydb.core.api.exception.FlywayValidateException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Proves the {@link SelfHealingFlywayMigrationStrategy} that guards the captain's
 * production deploys: a VM whose {@code flyway_schema_history} carries an already
 * applied dev-seed migration with a STALE checksum (an edited {@code db/dev}
 * hotfix) must boot without any manual DB step, while a healthy database still
 * does a plain strict migrate.
 *
 * <p>Fresh container per test method (non-static) for order-independent
 * isolation; auto-skips without Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class SelfHealingFlywayMigrationStrategyTest {

    private static final String DRIFTED_DEV_VERSION = "20260706020000";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Test
    void driftedDevSeedChecksumSelfHealsViaRepairAndRetryWithALoudWarn() throws Exception {
        // 1. The captain's VM: it ran with the `local` profile, so the dev seeds
        //    are recorded. Apply the full local chain, then simulate the edited
        //    dev-seed hotfix by corrupting the RECORDED checksum of a dev
        //    migration - exactly the "checksum mismatch" that aborts the boot.
        localProfile().load().migrate();
        long tampered = 42_424_242L;
        exec("UPDATE flyway_schema_history SET checksum = " + tampered
                + " WHERE version = '" + DRIFTED_DEV_VERSION + "'");

        ListAppender<ILoggingEvent> logs = attachAppender();

        // 2. Deploy the new image: Spring Boot would call the strategy in place of
        //    the default migrate(). A spy lets us prove repair() actually fired.
        Flyway flyway = spy(localProfile().load());
        assertThatCode(() -> new SelfHealingFlywayMigrationStrategy().migrate(flyway))
                .doesNotThrowAnyException();

        // 3. It self-healed: repair() ran exactly once, the recorded checksum is
        //    no longer the tampered value, and a fresh strict validate() passes.
        verify(flyway, times(1)).repair();
        assertThat(count("SELECT count(*) FROM flyway_schema_history WHERE version = '"
                + DRIFTED_DEV_VERSION + "' AND checksum = " + tampered)).isZero();
        assertThatCode(() -> localProfile().load().validate()).doesNotThrowAnyException();

        // 4. The drift was loudly surfaced (not silently swallowed) and names the
        //    drifted version, so an UNEXPECTED core drift would be visible too.
        assertThat(logs.list)
                .anySatisfy(e -> {
                    assertThat(e.getLevel()).isEqualTo(Level.WARN);
                    assertThat(e.getFormattedMessage())
                            .contains("self-healing")
                            .contains(DRIFTED_DEV_VERSION);
                });
    }

    /**
     * The drift class {@code repair()} CANNOT fix: a migration whose version sits
     * below the already-applied high-water mark (the 2026-08-26 production
     * incident). The old code logged "self-healing ... retrying", ran a repair
     * that by construction touches only APPLIED migrations, and then died with
     * the identical exception - so the deploy log actively pointed away from the
     * cause. It must now name the migration, the reason and the fix, and it must
     * NOT pretend to heal.
     */
    @Test
    void anOutOfOrderArrivalIsNamedWithItsFixInsteadOfAFakeSelfHeal(@TempDir Path migrations) throws Exception {
        // A database that already applied the higher version...
        Files.writeString(migrations.resolve("V20260201000000__higher_merged_first.sql"),
                "CREATE TABLE fm_selfheal_higher (id int PRIMARY KEY);\n");
        synthetic(migrations, false).load().migrate();
        // ...and a deploy that brings the lower one, merged later.
        Files.writeString(migrations.resolve("V20260101000000__lower_merged_second.sql"),
                "CREATE TABLE fm_selfheal_lower (id int PRIMARY KEY);\n");

        ListAppender<ILoggingEvent> logs = attachAppender();
        Flyway flyway = spy(synthetic(migrations, false).load());

        assertThatThrownBy(() -> new SelfHealingFlywayMigrationStrategy().migrate(flyway))
                .isInstanceOf(FlywayValidateException.class);

        // No pointless repair, and above all no "self-healing" claim.
        verify(flyway, never()).repair();
        assertThat(logs.list).noneSatisfy(e ->
                assertThat(e.getFormattedMessage()).contains("self-healing"));
        // Instead: an ERROR that names the migration, the cause and the lever.
        assertThat(logs.list).anySatisfy(e -> {
            assertThat(e.getLevel()).isEqualTo(Level.ERROR);
            assertThat(e.getFormattedMessage())
                    .contains("20260101000000")
                    .contains("repair() CANNOT fix")
                    .contains("spring.flyway.out-of-order=true");
        });
    }

    /**
     * The counterpart: with out-of-order allowed - what the api ships - the very
     * same late arrival is a plain migrate. No exception, no repair, no drift
     * log at all.
     */
    @Test
    void theSameLateArrivalIsAPlainMigrateOnceOutOfOrderIsAllowed(@TempDir Path migrations) throws Exception {
        Files.writeString(migrations.resolve("V20260201000000__higher_merged_first.sql"),
                "CREATE TABLE fm_selfheal_higher (id int PRIMARY KEY);\n");
        synthetic(migrations, true).load().migrate();
        Files.writeString(migrations.resolve("V20260101000000__lower_merged_second.sql"),
                "CREATE TABLE fm_selfheal_lower (id int PRIMARY KEY);\n");

        ListAppender<ILoggingEvent> logs = attachAppender();
        Flyway flyway = spy(synthetic(migrations, true).load());

        assertThatCode(() -> new SelfHealingFlywayMigrationStrategy().migrate(flyway))
                .doesNotThrowAnyException();

        verify(flyway, never()).repair();
        assertThat(count("SELECT count(*) FROM flyway_schema_history "
                + "WHERE version = '20260101000000' AND success")).isEqualTo(1L);
        assertThat(logs.list).isEmpty();
    }

    @Test
    void healthyDatabaseDoesAPlainStrictMigrateWithNoRepair() throws Exception {
        ListAppender<ILoggingEvent> logs = attachAppender();

        // Fresh DB, no drift: the strategy must behave like the default migrate.
        Flyway flyway = spy(localProfile().load());
        assertThatCode(() -> new SelfHealingFlywayMigrationStrategy().migrate(flyway))
                .doesNotThrowAnyException();

        verify(flyway, never()).repair();
        // Migrations actually applied and no self-heal WARN was emitted.
        assertThat(count("SELECT count(*) FROM flyway_schema_history WHERE version = '"
                + DRIFTED_DEV_VERSION + "'")).isEqualTo(1L);
        assertThat(logs.list).noneSatisfy(e ->
                assertThat(e.getFormattedMessage()).contains("self-healing"));
    }

    /** Synthetic migrations in a temp directory - the out-of-order mechanism alone. */
    private FluentConfiguration synthetic(Path dir, boolean outOfOrder) {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("filesystem:" + dir.toAbsolutePath())
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .outOfOrder(outOfOrder);
    }

    /** The `local`-profile Flyway config: prod-safe core + the DEV-ONLY seeds. */
    private FluentConfiguration localProfile() {
        return Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration", "classpath:db/dev")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of(
                        "appDbUser", "voltpilot_app", "appDbPassword", "voltpilot_app_test_pw",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"));
    }

    private ListAppender<ILoggingEvent> attachAppender() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(SelfHealingFlywayMigrationStrategy.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        return appender;
    }

    private void exec(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
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
