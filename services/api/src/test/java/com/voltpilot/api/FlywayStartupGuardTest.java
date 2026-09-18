package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.voltpilot.api.config.FlywayConfig;
import com.voltpilot.api.config.SelfHealingFlywayMigrationStrategy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.FlywayException;
import org.flywaydb.core.api.MigrationState;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.postgresql.ds.PGSimpleDataSource;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/** Real PostgreSQL history, including the exact production -> new -> old -> new sequence. */
@Testcontainers
class FlywayStartupGuardTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("test")
            .withCommand("postgres", "-c", "timescaledb.max_background_workers=0");

    @TempDir Path scripts;
    PGSimpleDataSource source;
    JdbcTemplate db;
    final SelfHealingFlywayMigrationStrategy strategy = new SelfHealingFlywayMigrationStrategy();

    @BeforeEach
    void freshDatabase() {
        source = new PGSimpleDataSource();
        source.setURL(POSTGRES.getJdbcUrl());
        source.setUser(POSTGRES.getUsername());
        source.setPassword(POSTGRES.getPassword());
        String name = "guard_" + UUID.randomUUID().toString().replace("-", "");
        new JdbcTemplate(source).execute("CREATE DATABASE " + name);
        source.setURL(POSTGRES.getJdbcUrl().replace("/voltpilot", "/" + name));
        db = new JdbcTemplate(source);
    }

    @Test
    void mainThenFullThenOldRefusesWithoutAnyWriteAndFullStillStarts() throws Exception {
        List<String> main;
        try (var input = getClass().getResourceAsStream("/migration/main-migrations.txt")) {
            assertThat(input).isNotNull();
            main = new String(input.readAllBytes(), StandardCharsets.UTF_8).lines()
                    .filter(s -> !s.isBlank() && !s.startsWith("#")).toList();
        }
        for (String name : main) {
            try (var input = getClass().getResourceAsStream("/db/migration/" + name)) {
                assertThat(input).isNotNull();
                Files.copy(input, scripts.resolve(name));
            }
        }
        Flyway old = synthetic().load();
        strategy.migrate(old);
        assertThat(old.info().applied()).hasSize(main.size());
        Flyway full = core().load();
        int additions = full.info().pending().length;
        assertThat(additions).isGreaterThanOrEqualTo(67);
        strategy.migrate(full);
        assertThat(full.info().applied()).hasSize(main.size() + additions);
        assertThat(Arrays.stream(old.info().all()).map(m -> m.getState()).toList())
                .contains(MigrationState.MISSING_SUCCESS, MigrationState.FUTURE_SUCCESS);
        String before = historyFingerprint();
        Flyway oldStart = spy(synthetic().load());
        assertThatThrownBy(() -> strategy.migrate(oldStart))
                .isInstanceOf(FlywayException.class)
                .hasMessageContaining("neuer als dieser Build")
                .hasMessageContaining("MISSING_SUCCESS").hasMessageContaining("FUTURE_SUCCESS")
                .hasMessageContaining("20260918110000");
        verify(oldStart, never()).migrate(); // Boot's initializer fails before readiness.
        verify(oldStart, never()).repair();
        assertThat(historyFingerprint()).isEqualTo(before);
        Flyway next = spy(core().load());
        assertThatCode(() -> strategy.migrate(next)).doesNotThrowAnyException();
        verify(next, never()).repair();
        assertThat(next.info().pending()).isEmpty();
        assertThat(historyFingerprint()).isEqualTo(before);
    }

    @ParameterizedTest
    @ValueSource(strings = {"V1__unknown_core.sql", "V100__pretends_to_be_dev.sql"})
    void lowerUnknownCoreIsRejectedEvenWhenMissingIsIgnored(String unknown) throws Exception {
        script(unknown);
        script("V999__known.sql");
        synthetic().load().migrate();
        Files.delete(scripts.resolve(unknown));
        assertRefusedUnchanged(spy(synthetic().load()), "MISSING_SUCCESS");
    }

    @ParameterizedTest
    @ValueSource(strings = {"1", "1000"})
    void unknownFailedCoreIsAlsoRejected(String version) throws Exception {
        script("V999__known.sql");
        synthetic().load().migrate();
        db.update("""
                INSERT INTO flyway_schema_history
                SELECT installed_rank+1, ?, 'unknown failed core', 'SQL', ?, checksum,
                       installed_by, installed_on, 0, false FROM flyway_schema_history
                """, version, "V" + version + "__unknown_failed_core.sql");
        assertRefusedUnchanged(spy(synthetic().load()),
                version.equals("1") ? "MISSING_FAILED" : "FUTURE_FAILED");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void deletedCoreRefusesEvenAfterItWasReapplied(boolean reapplied) throws Exception {
        script("V1__core.sql");
        synthetic().load().migrate();
        Files.delete(scripts.resolve("V1__core.sql"));
        // Reproduce Flyway's actual repair marker, not a mocked MigrationInfo.
        synthetic().ignoreMigrationPatterns(new String[0]).load().repair();
        assertThat(db.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE type='DELETE'", Long.class))
                .isEqualTo(1);
        script("V1__core.sql");
        if (reapplied) {
            synthetic().load().migrate();
        }
        assertRefusedUnchanged(spy(synthetic().load()), "DELETE");
    }

    @Test
    void currentAndHistoricalMissingDevSeedsRemainAllowed() throws Exception {
        core().locations("classpath:db/migration", "classpath:db/dev").load().migrate();
        // Original seed from commit 8766260c, before the current provisioned-devices version.
        db.update("""
                INSERT INTO flyway_schema_history
                  (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)
                SELECT max(installed_rank)+1, '20260702000100', 'dev provisioned devices', 'SQL',
                  'V20260702000100__dev_provisioned_devices.sql', 123, current_user, 0, true
                FROM flyway_schema_history
                """);
        String before = historyFingerprint();
        Flyway prod = spy(core().load());
        strategy.migrate(prod);
        verify(prod, never()).repair();
        assertThat(historyFingerprint()).isEqualTo(before);
    }

    @Test
    void knownDevSeedCanStillBeMarkedDeletedByRepair() throws Exception {
        script("V100__dev_seed.sql");
        synthetic().load().migrate();
        Files.delete(scripts.resolve("V100__dev_seed.sql"));
        Flyway prod = spy(synthetic().ignoreMigrationPatterns(new String[0]).load());
        strategy.migrate(prod);
        verify(prod).repair();
        assertThat(db.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE type='DELETE'", Long.class))
                .isEqualTo(1);
        strategy.migrate(synthetic().load());
    }

    @Test
    void unreadableInfoFailsBeforeFirstMigrate() {
        Flyway flyway = spy(synthetic().load());
        doThrow(new FlywayException("diagnosis failed")).when(flyway).info();
        assertThatThrownBy(() -> strategy.migrate(flyway)).hasMessageContaining("nicht sicher lesbar");
        verify(flyway, never()).migrate();
        verify(flyway, never()).repair();
    }

    @Test
    void unreadablePhysicalHistoryFailsBeforeFirstMigrate() throws Exception {
        script("V1__core.sql");
        synthetic().load().migrate();
        // The physical-marker query cannot be skipped even when info itself is readable.
        Flyway flyway = spy(synthetic().load());
        var info = flyway.info();
        org.mockito.Mockito.doReturn(info).when(flyway).info();
        db.execute("ALTER TABLE flyway_schema_history RENAME COLUMN type TO broken_type");
        assertRefusedUnchanged(flyway, "nicht sicher lesbar", false);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unreadableDiagnosisAfterValidationFailureNeverRepairs(boolean validation) throws Exception {
        script("V1__core.sql");
        synthetic().load().migrate();
        db.update("UPDATE flyway_schema_history SET checksum=42");
        Flyway flyway = spy(synthetic().load());
        if (validation) {
            doThrow(new FlywayException("diagnosis failed")).when(flyway).validateWithResult();
        } else {
            org.mockito.Mockito.doCallRealMethod().doThrow(new FlywayException("diagnosis failed"))
                    .when(flyway).info();
        }
        String before = historyFingerprint();
        assertThatThrownBy(() -> strategy.migrate(flyway)).hasMessageContaining("nicht");
        verify(flyway, never()).repair();
        assertThat(historyFingerprint()).isEqualTo(before);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unknownCoreAppearingDuringStartupCannotReachRepairOrReadiness(boolean duringValidation) throws Exception {
        script("V1__core.sql");
        synthetic().load().migrate();
        if (duringValidation) db.update("UPDATE flyway_schema_history SET checksum=42");
        Flyway flyway = spy(synthetic().load());
        String[] afterConcurrentChange = new String[1];
        org.mockito.stubbing.Answer<Object> concurrentMigration = call -> {
            Object result = call.callRealMethod();
            db.update("""
                    INSERT INTO flyway_schema_history
                    SELECT installed_rank+1, '2', 'new core', 'SQL', 'V2__new_core.sql',
                           checksum, installed_by, installed_on, 0, true
                    FROM flyway_schema_history WHERE version='1'
                    """);
            afterConcurrentChange[0] = historyFingerprint();
            return result;
        };
        if (duringValidation) {
            org.mockito.Mockito.doAnswer(concurrentMigration).when(flyway).validateWithResult();
        } else {
            org.mockito.Mockito.doAnswer(concurrentMigration).when(flyway).migrate();
        }
        assertThatThrownBy(() -> strategy.migrate(flyway)).hasMessageContaining("FUTURE_SUCCESS");
        verify(flyway, never()).repair();
        verify(flyway).migrate();
        assertThat(historyFingerprint()).isEqualTo(afterConcurrentChange[0]);
    }

    @Test
    void twoGuardedBuildsCannotMigrateBetweenDiagnosisAndRepair(@TempDir Path newerScripts) throws Exception {
        script("V1__core.sql");
        synthetic().load().migrate();
        Files.copy(scripts.resolve("V1__core.sql"), newerScripts.resolve("V1__core.sql"));
        Files.writeString(newerScripts.resolve("V2__new_core.sql"), "SELECT 2;\n");
        Flyway newer = spy(core().locations("filesystem:" + newerScripts.toAbsolutePath()).load());
        Flyway older = spy(synthetic().load());
        CountDownLatch migrated = new CountDownLatch(1);
        CountDownLatch finishNewStartup = new CountDownLatch(1);
        org.mockito.Mockito.doAnswer(call -> {
            Object result = call.callRealMethod();
            migrated.countDown();
            assertThat(finishNewStartup.await(10, TimeUnit.SECONDS)).isTrue();
            return result;
        }).when(newer).migrate();
        try (var starts = Executors.newVirtualThreadPerTaskExecutor()) {
            var newStart = starts.submit(() -> strategy.migrate(newer));
            assertThat(migrated.await(10, TimeUnit.SECONDS)).isTrue();
            String before = historyFingerprint();
            var oldStart = starts.submit(() -> strategy.migrate(older));
            try {
                // Observe the actual blocked PostgreSQL lock, not a sleep/timing guess.
                org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(5)).until(() ->
                        db.queryForObject("""
                                SELECT count(*) FROM pg_locks WHERE locktype='advisory'
                                AND classid=1448101453 AND objid=1179408727 AND NOT granted
                                """, Long.class) == 1);
                verify(older, never()).info();
                verify(older, never()).repair();
            } finally {
                finishNewStartup.countDown();
            }
            newStart.get(10, TimeUnit.SECONDS);
            assertThatThrownBy(() -> oldStart.get(10, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(FlywayException.class)
                    .hasStackTraceContaining("FUTURE_SUCCESS");
            verify(older, never()).migrate();
            verify(older, never()).repair();
            assertThat(historyFingerprint()).isEqualTo(before);
        } finally {
            finishNewStartup.countDown();
        }
        // Both the successful and refused startup released their transaction locks.
        assertThat(db.queryForObject("""
                SELECT count(*) FROM pg_locks WHERE locktype='advisory'
                AND classid=1448101453 AND objid=1179408727
                """, Long.class)).isZero();
    }

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "           |             | false",
            "           | nur-warnen  | false",
            "local      |             | true",
            "local      | nur-warnen  | true",
            "local      | streng      | false",
            "prod       | nur-warnen  | false",
            "local,prod | nur-warnen  | false"
    })
    void branchSwitchRequiresBothExplicitLocalProfileAndWarningMode(
            String profiles, String mode, boolean allowed) throws Exception {
        script("V1__other_branch.sql");
        script("V999__common.sql");
        synthetic().load().migrate();
        Files.delete(scripts.resolve("V1__other_branch.sql"));
        String before = historyFingerprint();
        Flyway flyway = spy(synthetic().load());
        var logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(SelfHealingFlywayMigrationStrategy.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            configuredMode(profiles, mode).run(context -> {
                assertThat(context).hasNotFailed();
                FlywayMigrationStrategy configured = context.getBean(FlywayMigrationStrategy.class);
                if (allowed) {
                    assertThatCode(() -> configured.migrate(flyway)).doesNotThrowAnyException();
                    verify(flyway).migrate();
                    assertThat(logs.list).anySatisfy(event -> {
                        assertThat(event.getLevel()).isEqualTo(Level.WARN);
                        assertThat(event.getFormattedMessage()).contains("ENTWICKLERMODUS", "1 (MISSING_SUCCESS)");
                    });
                } else {
                    assertThatThrownBy(() -> configured.migrate(flyway))
                            .isInstanceOf(FlywayException.class).hasMessageContaining("MISSING_SUCCESS");
                    verify(flyway, never()).migrate();
                    assertThat(logs.list).noneMatch(event -> event.getFormattedMessage().contains("ENTWICKLERMODUS"));
                }
                verify(flyway, never()).repair();
            });
        } finally {
            logger.detachAppender(logs);
            logs.stop();
        }
        assertThat(historyFingerprint()).isEqualTo(before);
    }

    @Test
    void defaultLocalProfileDoesNotOpenAnEmptyActiveProfile() throws Exception {
        script("V1__other_branch.sql");
        synthetic().load().migrate();
        Files.delete(scripts.resolve("V1__other_branch.sql"));
        Flyway flyway = spy(synthetic().load());
        configuredMode(null, "nur-warnen").withPropertyValues("spring.profiles.default=local").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getEnvironment().getActiveProfiles()).isEmpty();
            assertThatThrownBy(() -> context.getBean(FlywayMigrationStrategy.class).migrate(flyway))
                    .isInstanceOf(FlywayException.class).hasMessageContaining("FUTURE_SUCCESS");
        });
        verify(flyway, never()).migrate();
        verify(flyway, never()).repair();
    }

    @Test
    void localFutureAndDeletedCoreAreLoudWarningsWithThePreviousRepairBehaviour() throws Exception {
        script("V1__common.sql");
        script("V2__other_branch.sql");
        synthetic().load().migrate();
        Files.delete(scripts.resolve("V2__other_branch.sql"));
        var logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(SelfHealingFlywayMigrationStrategy.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            configuredMode("local", "nur-warnen").run(context -> {
                assertThat(context).hasNotFailed();
                FlywayMigrationStrategy configured = context.getBean(FlywayMigrationStrategy.class);
                Flyway first = spy(synthetic().load());
                assertThatCode(() -> configured.migrate(first)).doesNotThrowAnyException();
                verify(first).repair();
                verify(first, times(2)).migrate();
                assertThat(logs.list).anySatisfy(event -> {
                    assertThat(event.getLevel()).isEqualTo(Level.WARN);
                    assertThat(event.getFormattedMessage()).contains("ENTWICKLERMODUS", "2 (FUTURE_SUCCESS)");
                });
                assertThat(db.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE type='DELETE'", Long.class))
                        .isEqualTo(1);
                String afterRepair = historyFingerprint();
                logs.list.clear();
                Flyway second = spy(synthetic().load());
                assertThatCode(() -> configured.migrate(second)).doesNotThrowAnyException();
                verify(second, never()).repair();
                assertThat(logs.list).anySatisfy(event -> {
                    assertThat(event.getLevel()).isEqualTo(Level.WARN);
                    assertThat(event.getFormattedMessage()).contains("ENTWICKLERMODUS", "2 (DELETE)");
                });
                assertThat(historyFingerprint()).isEqualTo(afterRepair);
            });
        } finally {
            logger.detachAppender(logs);
            logs.stop();
        }
    }

    @Test
    void localWarningModeStillFailsClosedOnUnreadableDiagnosis() {
        Flyway flyway = spy(synthetic().load());
        doThrow(new FlywayException("diagnosis failed")).when(flyway).info();
        configuredMode("local", "nur-warnen").run(context -> {
            assertThat(context).hasNotFailed();
            assertThatThrownBy(() -> context.getBean(FlywayMigrationStrategy.class).migrate(flyway))
                    .hasMessageContaining("nicht sicher lesbar");
        });
        verify(flyway, never()).migrate();
        verify(flyway, never()).repair();
    }

    /** Real Spring bean and shipped application/profile YAML; no app services or schedulers. */
    private ApplicationContextRunner configuredMode(String profiles, String mode) {
        ApplicationContextRunner runner = new ApplicationContextRunner()
                .withInitializer(new ConfigDataApplicationContextInitializer())
                .withUserConfiguration(FlywayConfig.class)
                .withPropertyValues("spring.profiles.active=" + (profiles == null ? "" : profiles));
        return mode == null ? runner : runner.withPropertyValues("voltpilot.flyway.startwaechter=" + mode);
    }

    private void assertRefusedUnchanged(Flyway flyway, String message) throws Exception {
        assertRefusedUnchanged(flyway, message, true);
    }

    private void assertRefusedUnchanged(Flyway flyway, String message, boolean readable) throws Exception {
        String before = readable ? historyFingerprint() : null;
        assertThatThrownBy(() -> strategy.migrate(flyway))
                .isInstanceOf(FlywayException.class).hasMessageContaining(message);
        verify(flyway, never()).migrate();
        verify(flyway, never()).repair();
        if (readable) assertThat(historyFingerprint()).isEqualTo(before);
    }

    private String historyFingerprint() throws Exception {
        List<String> rows = db.queryForList("""
                SELECT jsonb_build_array(installed_rank, version, type, checksum, success, description, script)::text
                FROM flyway_schema_history ORDER BY installed_rank
                """, String.class);
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(String.join("\n", rows).getBytes(StandardCharsets.UTF_8)));
    }

    private void script(String name) throws Exception {
        Files.writeString(scripts.resolve(name), "SELECT 1;\n");
    }

    private FluentConfiguration synthetic() {
        return core().locations("filesystem:" + scripts.toAbsolutePath());
    }

    private FluentConfiguration core() {
        return Flyway.configure().dataSource(source).locations("classpath:db/migration")
                .outOfOrder(true).ignoreMigrationPatterns("*:missing")
                .placeholders(Map.of("appDbUser", "voltpilot_app", "appDbPassword", "test",
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "test"));
    }
}
