package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.repo.AdminFleetRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.OverviewRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Meldung;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

@Testcontainers(disabledWithoutDocker = true)
class DataSourceStatusMigrationTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Instant REPORTED = Instant.parse("2026-11-03T14:02:15Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static JdbcTemplate admin;
    private static DeviceDataSourceStatusRepository repository;
    private static UUID tenant;
    private static UUID fremd;
    private static UUID device;
    private static UUID site;
    private static UUID quelle;
    private static UUID fremdeQuelle;

    @BeforeAll
    static void setUp() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        admin = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        repository = new DeviceDataSourceStatusRepository(app);

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Status A') RETURNING id", UUID.class);
        fremd = root.queryForObject("INSERT INTO tenant (name) VALUES ('Status B') RETURNING id", UUID.class);
        site = root.queryForObject(
                "INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 2') RETURNING id", UUID.class, tenant);
        UUID fremderSite = root.queryForObject(
                "INSERT INTO site (tenant_id, name) VALUES (?, 'Fremd') RETURNING id", UUID.class, fremd);
        device = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-STATUS-A') RETURNING id", UUID.class, tenant, site);
        UUID fremdesDevice = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref) "
                + "VALUES (?, ?, 'VP-STATUS-B') RETURNING id", UUID.class, fremd, fremderSite);
        quelle = quelle(tenant, site, "DQ-4", "192.168.20.10:502");
        fremdeQuelle = quelle(fremd, fremderSite, "DQ-4", "192.168.30.10:502");
        zuweisen(tenant, quelle, device, "192.168.20.10:502");
        zuweisen(fremd, fremdeQuelle, fremdesDevice, "192.168.30.10:502");
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void senkeIstJeBoxUndQuelleGezaeuntUndOffboardingSicher() {
        assertThat(root.queryForObject("SELECT relrowsecurity AND relforcerowsecurity "
                + "FROM pg_class WHERE relname = 'device_data_source_status'", Boolean.class)).isTrue();
        assertThat(root.queryForObject("SELECT count(*) FROM pg_policies "
                + "WHERE tablename = 'device_data_source_status'", Integer.class)).isOne();

        // IP-15: a valid heartbeat writes the cloud arrival on the RLS-fenced
        // device row. The read-only box has NO telemetry and nevertheless has
        // exactly the same connected aggregate in customer and admin reads.
        assertThat(root.queryForObject("SELECT device_status_seen_at IS NULL FROM device WHERE id = ?",
                Boolean.class, device)).isTrue();
        TenantContext.set(tenant);
        DeviceRepository devices = new DeviceRepository(app);
        assertThat(devices.markStatusSeen(device)).isTrue();
        OverviewRepository.DeviceStats customerStats =
                new OverviewRepository(app).deviceStatsPerSite().get(site);
        AdminFleetRepository.DeviceStats adminStats =
                new AdminFleetRepository(admin).deviceStatsPerSite().get(site);
        assertThat(customerStats).isEqualTo(new OverviewRepository.DeviceStats(1, 1, 0,
                customerStats.lastSeenAt()));
        assertThat(adminStats).isEqualTo(new AdminFleetRepository.DeviceStats(1, 1, 0,
                adminStats.lastSeenAt()));
        assertThat(customerStats.lastSeenAt()).isNotNull();
        assertThat(adminStats.lastSeenAt()).isEqualTo(customerStats.lastSeenAt());

        TenantContext.set(fremd);
        assertThat(devices.markStatusSeen(device)).as("RLS schützt den Herzschlag-Anker").isFalse();

        TenantContext.set(tenant);
        repository.replaceForDevice(device, tenant, REPORTED, List.of(
                new Meldung("DQ-4", "stale", "unreachable",
                        Instant.parse("2026-11-03T14:02:10Z"),
                        Instant.parse("2026-11-03T14:01:50Z"), 1.0, 0.0),
                new Meldung("DQ-999", "ok", null, null, REPORTED, 1.0, 1.0)));
        assertThat(repository.find(device, quelle)).isNotNull();
        assertThat(root.queryForObject("SELECT count(*) FROM device_data_source_status", Integer.class)).isOne();

        // An older retained message cannot erase the newer fact.
        repository.replaceForDevice(device, tenant, REPORTED.minusSeconds(1), List.of());
        assertThat(repository.find(device, quelle)).isNotNull();

        TenantContext.set(fremd);
        assertThat(repository.find(device, quelle)).isNull();
        assertThatThrownBy(() -> app.update("INSERT INTO device_data_source_status "
                + "(device_id, data_source_id, tenant_id, site_id, health, reported_at) "
                + "VALUES (?, ?, ?, (SELECT site_id FROM data_source WHERE id = ?), 'ok', ?)",
                device, quelle, tenant, quelle, Timestamp.from(REPORTED)))
                .isInstanceOf(DataAccessException.class);

        new TenantRepository(admin).offboard(tenant);
        assertThat(root.queryForObject("SELECT count(*) FROM device_data_source_status "
                + "WHERE tenant_id = ?", Integer.class, tenant)).isZero();
        assertThat(root.queryForObject("SELECT count(*) FROM data_source WHERE tenant_id = ?",
                Integer.class, tenant)).isZero();
    }

    private static UUID quelle(UUID tenantId, UUID siteId, String kennzeichen, String adresse) {
        return root.queryForObject("INSERT INTO data_source (tenant_id, site_id, kennzeichen, "
                + "protokoll, adresse, geraete_ids, kadenz_s) "
                + "VALUES (?, ?, ?, 'modbus_tcp', ?, '{1}', 60) RETURNING id",
                UUID.class, tenantId, siteId, kennzeichen, adresse);
    }

    private static void zuweisen(UUID tenantId, UUID source, UUID box, String adresse) {
        root.update("INSERT INTO data_source_assignment (tenant_id, data_source_id, device_id, "
                + "protokoll, adresse, effective_from) "
                + "VALUES (?, ?, ?, 'modbus_tcp', ?, '2026-01-01T00:00:00Z')",
                tenantId, source, box, adresse);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource dataSource = new PGSimpleDataSource();
        dataSource.setUrl(POSTGRES.getJdbcUrl());
        dataSource.setUser(user);
        dataSource.setPassword(password);
        return dataSource;
    }
}
