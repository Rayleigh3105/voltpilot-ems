package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.DeviceSourceStatusRepository.SourceRow;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Das Rennen im Status-Empfang (Geschwister von entity_observed_state, PR 1685): zwei Herzschläge
 * derselben Box schreiben ihren Stand gleichzeitig. Vorher löschte jeder zuerst alle Zeilen der Box und fügte dann ein; was die
 * andere Transaktion noch nicht eingecheckt hatte, sah das DELETE nicht, und das INSERT scheiterte
 * nach deren Commit an {@code device_source_status_pkey}.
 *
 * <p>Der Test stellt das Rennen deterministisch nach, mit echten Transaktionen auf einer echten
 * Datenbank: Transaktion A hat geschrieben und committet noch nicht, B schreibt denselben Stand und
 * muss auf A warten.
 */
@Testcontainers(disabledWithoutDocker = true)
class DeviceSourceStatusRepositoryRaceTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final Instant T1 = Instant.parse("2026-11-05T10:00:00Z");
    private static final Instant T2 = T1.plusSeconds(5);

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static TransactionTemplate tx;
    private static DeviceSourceStatusRepository repo;
    private static UUID tenant;
    private static UUID site;
    private static UUID device;
    private static ExecutorService pool;

    @BeforeAll
    static void setUp() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", "voltpilot_admin", "adminDbPassword", "voltpilot_admin_test_pw"))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        DataSource appSource = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        app = new JdbcTemplate(appSource);
        tx = new TransactionTemplate(new DataSourceTransactionManager(appSource));
        repo = new DeviceSourceStatusRepository(app);
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('RennenQ') RETURNING id", UUID.class);
        site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle') RETURNING id",
                UUID.class, tenant);
        device = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-RENNEN-Q') RETURNING id", UUID.class, tenant, site);
        pool = Executors.newFixedThreadPool(2);
    }

    @AfterAll
    static void tearDown() {
        pool.shutdownNow();
    }

    @AfterEach
    void clear() {
        root.update("DELETE FROM device_source_status WHERE device_id = ?", device);
    }

    private static SourceRow row(String id, String health, Instant reportedAt) {
        return new SourceRow(id, "source", "pv-generation", "PV", null, null, 1.0, null, null, health,
                reportedAt, null);
    }

    /** Der Befund: B schreibt denselben Stand, während A noch nicht committet hat. */
    @Test
    void zweiGleichzeitigeHerzschlaegeDerselbenBoxScheiternNichtAmPrimaerschluessel() throws Exception {
        CountDownLatch aGeschrieben = new CountDownLatch(1);
        CountDownLatch aFreigeben = new CountDownLatch(1);
        Future<?> a = pool.submit(() -> {
            TenantContext.set(tenant);
            try {
                tx.executeWithoutResult(s -> {
                    repo.replaceForDevice(device, tenant, site, T1,
                            List.of(row("e1", "ok", T1), row("e2", "ok", T1)));
                    aGeschrieben.countDown();
                    await(aFreigeben);
                });
            } finally {
                TenantContext.clear();
            }
        });
        assertThat(aGeschrieben.await(30, TimeUnit.SECONDS)).as("A hat geschrieben").isTrue();

        Future<?> b = pool.submit(() -> {
            TenantContext.set(tenant);
            try {
                tx.executeWithoutResult(s -> repo.replaceForDevice(device, tenant, site, T2,
                        List.of(row("e1", "degraded", T2), row("e3", "ok", T2))));
            } finally {
                TenantContext.clear();
            }
        });
        // B ist an A's nicht eingechecktem Schlüssel hängen geblieben (oder fertig, wenn es dort nichts gibt).
        long bis = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < bis && !b.isDone() && !wartetAufSperre()) {
            Thread.sleep(50);
        }
        aFreigeben.countDown();
        a.get(30, TimeUnit.SECONDS);
        b.get(30, TimeUnit.SECONDS); // vorher: DuplicateKeyException device_source_status_pkey

        // Der jüngste Bericht gewinnt, ganz: B's Menge, nichts von A bleibt als Rest.
        List<Map<String, Object>> rows = root.queryForList(
                "SELECT source_id, health, reported_at FROM device_source_status "
                        + "WHERE device_id = ? ORDER BY source_id", device);
        assertThat(rows).extracting(r -> r.get("source_id")).containsExactly("e1", "e3");
        assertThat(rows).extracting(r -> r.get("health")).containsExactly("degraded", "ok");
    }

    /** Ein verspäteter älterer Bericht überschreibt den jüngeren nicht. */
    @Test
    void einVerspaeteterAelterBerichtUeberschreibtDenJuengerenNicht() {
        TenantContext.set(tenant);
        try {
            tx.executeWithoutResult(s -> repo.replaceForDevice(device, tenant, site, T2,
                    List.of(row("e1", "degraded", T2))));
            tx.executeWithoutResult(s -> repo.replaceForDevice(device, tenant, site, T1,
                    List.of(row("e1", "ok", T1), row("e2", "ok", T1))));
        } finally {
            TenantContext.clear();
        }
        List<Map<String, Object>> rows = root.queryForList(
                "SELECT source_id, health FROM device_source_status WHERE device_id = ? ORDER BY source_id",
                device);
        assertThat(rows).singleElement().satisfies(r -> {
            assertThat(r.get("source_id")).isEqualTo("e1");
            assertThat(r.get("health")).isEqualTo("degraded");
        });
    }

    /** Wie bisher: der Bericht ist vollständig, was fehlt, verschwindet. */
    @Test
    void wasImBerichtFehltVerschwindetUndDerStandWirdErsetzt() {
        TenantContext.set(tenant);
        try {
            tx.executeWithoutResult(s -> repo.replaceForDevice(device, tenant, site, T1,
                    List.of(row("e1", "ok", T1), row("e2", "ok", T1))));
            tx.executeWithoutResult(s -> repo.replaceForDevice(device, tenant, site, T2,
                    List.of(row("e2", "degraded", T2))));
        } finally {
            TenantContext.clear();
        }
        List<Map<String, Object>> rows = root.queryForList(
                "SELECT source_id, health FROM device_source_status WHERE device_id = ?", device);
        assertThat(rows).singleElement().satisfies(r -> {
            assertThat(r.get("source_id")).isEqualTo("e2");
            assertThat(r.get("health")).isEqualTo("degraded");
        });
    }

    private boolean wartetAufSperre() {
        Integer n = root.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                + "AND query ILIKE '%device_source_status%'", Integer.class);
        return n != null && n > 0;
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(60, TimeUnit.SECONDS)) {
                throw new IllegalStateException("nicht freigegeben");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource dataSource = new PGSimpleDataSource();
        dataSource.setUrl(POSTGRES.getJdbcUrl());
        dataSource.setUser(user);
        dataSource.setPassword(password);
        return dataSource;
    }
}
