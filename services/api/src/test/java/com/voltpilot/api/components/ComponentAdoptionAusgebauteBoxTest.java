package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Die Live-Fläche der Komponenten-Übernahme (UEMS AP-07 IP-11): was eine ausgebaute Box zuletzt
 * gemeldet hat, bleibt gespeichert, macht eine Anlage aber nicht mehr zum Kandidaten für verwaiste
 * Pins — eine Anlage, deren Boxen nichts (mehr) melden, hat keine verwaisten, sondern unbekannte Pins.
 */
@Testcontainers(disabledWithoutDocker = true)
class ComponentAdoptionAusgebauteBoxTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate app;
    private static ComponentAdoptionRunner runner;

    @BeforeAll
    static void migrieren() {
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
        runner = new ComponentAdoptionRunner(new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW)), null, null, false, false);
    }

    @Test
    void eineAusgebauteBoxMachtKeinePinsMehrZuVerwaisten() {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES ('Pins') RETURNING id", UUID.class);
        UUID site = root.queryForObject("INSERT INTO site (tenant_id, name) VALUES (?, 'Halle 1') RETURNING id",
                UUID.class, t);
        UUID box = root.queryForObject("INSERT INTO device (tenant_id, site_id, external_ref, status) VALUES (?, ?, "
                + "'box-pins', 'claimed') RETURNING id", UUID.class, t, site);
        root.update("INSERT INTO measurement_point (tenant_id, site_id, device_id, role, label, entity_type, "
                + "edge_source_id) VALUES (?, ?, ?, 'grid-meter', 'Netzzähler', 'grid-meter', 'zaehler-alt')", t, site, box);
        root.update("INSERT INTO entity_observed_state (device_id, entity_id, tenant_id, site_id, source, entity_type) "
                + "VALUES (?, 'local:zaehler-neu', ?, ?, 'local', 'grid-meter')", box, t, site);

        assertThat(runner.withOrphanedPins()).as("die Probe: die Box meldet, der Pin fehlt")
                .extracting(ComponentAdoptionRunner.Candidate::siteId).contains(site);

        TenantContext.set(t);
        try {
            assertThat(new DeviceRepository(app).ausbauen(box)).isTrue();
        } finally {
            TenantContext.clear();
        }
        assertThat(runner.withOrphanedPins()).extracting(ComponentAdoptionRunner.Candidate::siteId)
                .doesNotContain(site);
        assertThat(root.queryForObject("SELECT count(*) FROM entity_observed_state WHERE device_id = ?", Long.class, box))
                .as("die Meldung bleibt gespeichert").isOne();
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
