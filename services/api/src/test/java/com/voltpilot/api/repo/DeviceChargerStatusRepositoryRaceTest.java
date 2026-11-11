package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.DeviceChargerStatusRepository.BudgetRow;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.ChargePointRow;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.ConnectorRow;
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
 * Das Rennen im Ladepunkt-Status-Empfang (Geschwister von entity_observed_state, PR 1685): zwei
 * Herzschläge derselben Box schreiben ihren Stand gleichzeitig. Vorher löschte jeder zuerst alle
 * Zeilen der Box und fügte dann ein; was die andere Transaktion noch nicht eingecheckt hatte, sah
 * das DELETE nicht, und das INSERT scheiterte nach deren Commit am Primärschlüssel.
 *
 * <p>Der Test stellt das Rennen deterministisch nach, mit echten Transaktionen auf einer echten
 * Datenbank: Transaktion A hat geschrieben und committet noch nicht, B schreibt denselben Stand und
 * muss auf A warten.
 */
@Testcontainers(disabledWithoutDocker = true)
class DeviceChargerStatusRepositoryRaceTest {

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
    private static DeviceChargerStatusRepository repo;
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
        repo = new DeviceChargerStatusRepository(app);
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('RennenL') RETURNING id", UUID.class);
        site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle') RETURNING id",
                UUID.class, tenant);
        device = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-RENNEN-L') RETURNING id", UUID.class, tenant, site);
        pool = Executors.newFixedThreadPool(2);
    }

    @AfterAll
    static void tearDown() {
        pool.shutdownNow();
    }

    @AfterEach
    void clear() {
        for (String table : List.of("device_charge_connector", "device_charge_point", "device_charging_budget")) {
            root.update("DELETE FROM " + table + " WHERE device_id = ?", device);
        }
    }

    private static BudgetRow budget(double limit) {
        return new BudgetRow(true, true, null, limit, null, null, null, null, null, null, null, null,
                "normal", null, false, null, null, null, null, null, null, 1, null, null, false, null,
                null, null, false, null, null, null, null, null, null);
    }

    private static ConnectorRow connector(int id, String status) {
        return new ConnectorRow(id, status, false, null, null, null, null, null, null, null, null, null,
                null, null, null, null, false, null, null, null);
    }

    private static ChargePointRow point(String id, String label, ConnectorRow... connectors) {
        return new ChargePointRow(id, label, false, true, null, null, null, true, null, null, null, null,
                List.of(connectors));
    }

    private void write(Instant at, BudgetRow budget, ChargePointRow... points) {
        repo.replaceForDevice(device, tenant, site, at, budget, List.of(points));
    }

    private List<String> connectors() {
        return root.queryForList("SELECT charge_point_id || '/' || connector_id || '=' || status "
                + "FROM device_charge_connector WHERE device_id = ? ORDER BY 1", String.class, device);
    }

    private List<String> points() {
        return root.queryForList("SELECT charge_point_id || '=' || label FROM device_charge_point "
                + "WHERE device_id = ? ORDER BY 1", String.class, device);
    }

    private Double limit() {
        return root.queryForObject("SELECT grid_limit_kw FROM device_charging_budget WHERE device_id = ?",
                Double.class, device);
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
                    write(T1, budget(10.0), point("p1", "A", connector(1, "Available"),
                            connector(2, "Available")), point("p2", "A"));
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
                tx.executeWithoutResult(s -> write(T2, budget(20.0),
                        point("p1", "B", connector(1, "Charging")), point("p3", "B")));
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
        b.get(30, TimeUnit.SECONDS); // vorher: DuplicateKeyException device_charging_budget_pkey

        // Der jüngste Bericht gewinnt, ganz: B's Menge, nichts von A bleibt als Rest.
        assertThat(limit()).isEqualTo(20.0);
        assertThat(points()).containsExactly("p1=B", "p3=B");
        assertThat(connectors()).containsExactly("p1/1=Charging");
    }

    /** Ein verspäteter älterer Bericht überschreibt den jüngeren nicht - auch nicht Säulen und Stecker. */
    @Test
    void einVerspaeteterAelterBerichtUeberschreibtDenJuengerenNicht() {
        TenantContext.set(tenant);
        try {
            tx.executeWithoutResult(s -> write(T2, budget(20.0),
                    point("p1", "B", connector(1, "Charging"))));
            tx.executeWithoutResult(s -> write(T1, budget(10.0),
                    point("p1", "A", connector(1, "Available"), connector(2, "Available")),
                    point("p2", "A")));
        } finally {
            TenantContext.clear();
        }
        assertThat(limit()).isEqualTo(20.0);
        assertThat(points()).containsExactly("p1=B");
        assertThat(connectors()).containsExactly("p1/1=Charging");
    }

    /** Wie bisher: der Bericht ist vollständig, was fehlt, verschwindet; die Bindung bleibt. */
    @Test
    void wasImBerichtFehltVerschwindetUndDieBindungDerKomponenteBleibt() {
        UUID entity = UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            tx.executeWithoutResult(s -> write(T1, budget(10.0),
                    point("p1", "A", connector(1, "Available"), connector(2, "Available")),
                    point("p2", "A", connector(1, "Available"))));
            tx.executeWithoutResult(s -> repo.bindEntity(device, "p1", entity));
            tx.executeWithoutResult(s -> repo.replaceOcppControlStatus(device, "{\"a\":1}"));
            tx.executeWithoutResult(s -> write(T2, budget(20.0),
                    point("p1", "B", connector(2, "Charging"))));
        } finally {
            TenantContext.clear();
        }
        assertThat(points()).containsExactly("p1=B");
        assertThat(connectors()).containsExactly("p1/2=Charging");
        assertThat(root.queryForObject("SELECT entity_id FROM device_charge_point WHERE device_id = ?",
                UUID.class, device)).isEqualTo(entity);
        // wie das frühere DELETE+INSERT: der OCPP-Steuerstand ist nach einem Herzschlag leer
        assertThat(root.queryForObject("SELECT ocpp_control_status::text FROM device_charging_budget "
                + "WHERE device_id = ?", String.class, device)).isNull();
    }

    /**
     * Das Upsert schreibt nur die Spalten, die es nennt: eine neue Spalte ohne Eintrag dort würde
     * ihren alten Wert behalten, wo das frühere DELETE+INSERT sie zurücksetzte.
     */
    @Test
    void keineSpalteDerDreiTabellenFehltImUpsert() {
        Map<String, List<String>> bekannt = Map.of(
                "device_charging_budget", List.of("device_id", "tenant_id", "site_id", "enabled",
                        "control_enabled", "control_note", "grid_limit_kw", "margin_pct", "min_power_kw",
                        "budget_kw", "allocated_kw", "reserved_kw", "measured_kw", "site_load_kw",
                        "site_grid_kw", "budget_mode", "budget_note", "budget_blind", "eff_limit_kw",
                        "safe_default_kw", "safe_default_note", "safe_default_holds",
                        "safe_worst_case_kw", "max_house_load_kw", "connector_count", "surplus_policy",
                        "storage_priority", "surplus_active", "surplus_kw", "surplus_mode", "surplus_note",
                        "surplus_blind", "surplus_total_kw", "surplus_battery_kw", "source_allocated_kw",
                        "ocpp_port", "ocpp_url_path", "reported_at", "storage_release_active",
                        "storage_release_kw", "storage_release_floor_soc_pct", "storage_release_soc_pct",
                        "storage_release_mode", "storage_release_note", "ocpp_control_status"),
                "device_charge_point", List.of("device_id", "charge_point_id", "tenant_id", "site_id",
                        "label", "priority", "connected", "vendor", "model", "firmware", "ready", "note",
                        "last_seen", "connection", "entity_id", "reported_at", "applied_source",
                        "applied_min_kw", "applied_storage_release"),
                "device_charge_connector", List.of("device_id", "charge_point_id", "connector_id",
                        "tenant_id", "site_id", "status", "charging", "allocated_kw", "reason",
                        "reason_text", "next_turn", "power_kw", "energy_kwh", "soc_pct", "command_status",
                        "readback", "readback_note", "session_since", "session_kwh", "metered_at", "boost",
                        "tag_ref", "reported_at"));
        bekannt.forEach((table, spalten) -> assertThat(root.queryForList(
                "SELECT column_name FROM information_schema.columns WHERE table_name = ?", String.class,
                table)).as(table).containsExactlyInAnyOrderElementsOf(spalten));
    }

    private boolean wartetAufSperre() {
        Integer n = root.queryForObject("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' "
                + "AND query ILIKE '%device_charging_budget%'", Integer.class);
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
