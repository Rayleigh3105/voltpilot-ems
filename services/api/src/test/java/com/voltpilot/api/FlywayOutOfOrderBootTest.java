package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Regression guard for the production incident of 2026-08-26: the api stopped
 * booting with
 * {@code Validate failed: Detected resolved migration not applied to database: 20260846010000}.
 *
 * <p><b>The cause is structural, not a one-off.</b> A migration's version number
 * is the moment it was AUTHORED, but the order it reaches a long-lived database
 * is the order its PR was MERGED - and parallel branches make those diverge.
 * Two real pairs from that week: {@code V20260846010000} (#509) merged AFTER
 * {@code V20260847000000} (#516), and {@code V20260842000000} (#512) merged
 * AFTER {@code V20260844000000} (#507). Production had already applied the
 * higher versions, so Flyway's default ({@code out-of-order = false}) parked the
 * newcomers in state {@code IGNORED} and aborted the boot. Twelve migrations
 * stayed unapplied, the optimizer wrote into columns that did not exist
 * ({@code schedule.unplanned_load_discharge}) and the fleet went a night without
 * a Fahrplan.
 *
 * <p>The fix is {@code spring.flyway.out-of-order: true} in
 * {@code application.yml}. This test proves the two halves that matter:
 *
 * <ul>
 *   <li>the MECHANISM - a lower version arriving after a higher one is refused
 *       by the Flyway default and APPLIED with the setting, both migrations
 *       ending up in the history and the late one applied LAST;</li>
 *   <li>the INCIDENT SHAPE over the REAL migration chain - a database carrying
 *       the full shipped {@code db/migration} history accepts a newly arriving
 *       lower version, with the exact production error text reproduced on the
 *       "without" side so the guard cannot pass vacuously.</li>
 * </ul>
 *
 * <p>That {@code application.yml} really ships the setting is pinned separately
 * and WITHOUT Docker by {@code MigrationHygieneTest}, so the gate keeps that
 * half even on a machine with no container runtime.
 *
 * <p>Fresh container per test method (non-static) for order-independent
 * isolation; auto-skips without Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class FlywayOutOfOrderBootTest {

    /**
     * A version far below every shipped migration, so it is guaranteed to be an
     * out-of-order arrival over the real chain - and guaranteed never to collide
     * with a real one (the shipped versions are 2026-07 and later).
     */
    private static final String LATE_ARRIVAL = "20260101000000";

    @Container
    final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    /**
     * The mechanism, in isolation: two synthetic migrations, the LOWER one added
     * only after the higher one is already applied - the merge-order-vs-version-
     * order divergence reduced to its smallest form.
     */
    @Test
    void aLowerVersionArrivingAfterAHigherOneIsRefusedByDefaultAndAppliedWithOutOfOrder(
            @TempDir Path migrations) throws Exception {
        // 1. The branch that merged FIRST, although it was authored LATER.
        write(migrations, "V20260201000000__higher_merged_first.sql",
                "CREATE TABLE fm_higher (id int PRIMARY KEY);");
        synthetic(migrations, false).load().migrate();
        assertThat(appliedRank("20260201000000")).isNotNull();
        assertThat(appliedRank(LATE_ARRIVAL)).isNull();

        // 2. The branch that was authored EARLIER now merges: its version is
        //    below what the database already carries. This is the production
        //    failure, verbatim - and nothing is applied, so the DB is untouched.
        write(migrations, "V" + LATE_ARRIVAL + "__lower_merged_second.sql",
                "CREATE TABLE fm_lower (id int PRIMARY KEY);");
        assertThatThrownBy(() -> synthetic(migrations, false).load().migrate())
                .isInstanceOf(FlywayValidateException.class)
                .hasMessageContaining("not applied to database")
                .hasMessageContaining(LATE_ARRIVAL);
        assertThat(appliedRank(LATE_ARRIVAL)).as("refused, so nothing was applied").isNull();

        // 3. With out-of-order (what the api now ships) the same deploy goes
        //    through: BOTH migrations are applied, and the late arrival really
        //    ran LAST - a higher installed_rank than the version above it, which
        //    is what "out of order" means and what a mere "both present" check
        //    would miss.
        assertThatCode(() -> synthetic(migrations, true).load().migrate()).doesNotThrowAnyException();
        assertThat(appliedRank(LATE_ARRIVAL)).isNotNull();
        assertThat(appliedRank(LATE_ARRIVAL)).isGreaterThan(appliedRank("20260201000000"));
        assertThat(tableExists("fm_higher")).isTrue();
        assertThat(tableExists("fm_lower")).isTrue();
    }

    /**
     * The same thing over the REAL shipped chain, with the real production
     * Flyway settings: a database that already applied every {@code db/migration}
     * file must accept a migration that arrives below its high-water mark. This
     * is the incident's actual shape - prod was not a toy schema.
     */
    @Test
    void theRealMigrationChainAcceptsALateLowerVersionLikeTheProductionIncident(
            @TempDir Path lateArrival) throws Exception {
        // 1. Production as it stood: the full shipped core chain is applied.
        prodCore(lateArrival, true).load().migrate();
        Integer highWaterMark = maxAppliedRank();
        assertThat(highWaterMark).as("the real chain applied").isNotNull();

        // 2. The next deploy carries a migration authored earlier but merged
        //    later. WITHOUT out-of-order this is the exact production abort.
        write(lateArrival, "V" + LATE_ARRIVAL + "__fm_late_arrival_probe.sql",
                "CREATE TABLE fm_late_arrival_probe (id int PRIMARY KEY);");
        assertThatThrownBy(() -> prodCore(lateArrival, false).load().migrate())
                .isInstanceOf(FlywayValidateException.class)
                .hasMessageContaining("Detected resolved migration not applied to database")
                .hasMessageContaining(LATE_ARRIVAL);

        // 3. With the shipped setting the api boots and the migration lands -
        //    after everything else, on top of the real schema.
        assertThatCode(() -> prodCore(lateArrival, true).load().migrate()).doesNotThrowAnyException();
        assertThat(appliedRank(LATE_ARRIVAL)).isGreaterThan(highWaterMark);
        assertThat(tableExists("fm_late_arrival_probe")).isTrue();

        // 4. And nothing was loosened by the way: an edited ALREADY-APPLIED
        //    migration still aborts the boot, so out-of-order did not turn into
        //    "validation off".
        exec("UPDATE flyway_schema_history SET checksum = checksum + 1 WHERE version = '1'");
        assertThatThrownBy(() -> prodCore(lateArrival, true).load().validate())
                .isInstanceOf(FlywayValidateException.class)
                .hasMessageContaining("checksum mismatch");
    }

    /** Synthetic migrations only - the mechanism without the real schema. */
    private FluentConfiguration synthetic(Path dir, boolean outOfOrder) {
        return base().locations("filesystem:" + dir.toAbsolutePath()).outOfOrder(outOfOrder);
    }

    /**
     * The production Flyway configuration of {@code application.yml}: the shipped
     * core migrations plus the "*:missing" tolerance, with the late arrival's
     * directory appended so step 1 (empty dir) and step 2 (one file) use the
     * SAME config object shape.
     */
    private FluentConfiguration prodCore(Path lateArrival, boolean outOfOrder) {
        return base()
                .locations("classpath:db/migration", "filesystem:" + lateArrival.toAbsolutePath())
                .ignoreMigrationPatterns("*:missing")
                .outOfOrder(outOfOrder);
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

    private static void write(Path dir, String name, String sql) throws Exception {
        Files.writeString(dir.resolve(name), sql + "\n");
    }

    /** The migration's installed_rank, or null when it was never applied. */
    private Integer appliedRank(String version) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(
                        "SELECT installed_rank FROM flyway_schema_history "
                                + "WHERE version = '" + version + "' AND success")) {
            return rs.next() ? rs.getInt(1) : null;
        }
    }

    private Integer maxAppliedRank() throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery(
                        "SELECT max(installed_rank) FROM flyway_schema_history WHERE success")) {
            rs.next();
            int rank = rs.getInt(1);
            return rs.wasNull() ? null : rank;
        }
    }

    private boolean tableExists(String table) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT to_regclass('public." + table + "') IS NOT NULL")) {
            rs.next();
            return rs.getBoolean(1);
        }
    }

    private void exec(String sql) throws Exception {
        try (Connection c = POSTGRES.createConnection("");
                Statement s = c.createStatement()) {
            s.execute(sql);
        }
    }
}
