package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.topology.RollenZuordnungService;
import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.ueberwachung.AnlagenflussWerteLeser;
import com.voltpilot.api.ueberwachung.WerteKatalog;
import com.voltpilot.api.web.dto.WertverweisDto;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * "Was lässt sich hier überwachen?" (Alerting Scheibe 2, §6.3, §7 Scheibe 2 Punkt 2): die Antwort
 * trägt sowohl die festen {@code anlagenfluss}-Werte als auch - neu - EINEN Eintrag je gemessenem
 * Kanal jeder Komponente ("jeder gemessene Kanal im Aufbau"), aus derselben Topologie wie
 * {@link AnlagenflussWerteLeserIT}.
 */
@Testcontainers(disabledWithoutDocker = true)
class WerteControllerIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "werte_controller_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate seed;
    private static WerteController controller;

    @BeforeAll
    static void migrateUndAufbauen() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP, "appDbPassword", PW, "adminDbUser", ADMIN,
                        "adminDbPassword", PW))
                .load()
                .migrate();
        app = new JdbcTemplate(new TenantAwareDataSource(ds(APP, PW)));
        seed = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        EntityRegistryRepository registry = new EntityRegistryRepository(app);
        TopologyRepository topologyRepo = new TopologyRepository(app);
        EntityTypeCatalog catalog = new EntityTypeCatalog(new ObjectMapper());
        DeviceChargerStatusRepository ladepunkte = new DeviceChargerStatusRepository(app);
        TopologyService topologyService = new TopologyService(registry, topologyRepo, catalog,
                new ObjectMapper(), ladepunkte, mock(EntityRegistryService.class), mock(RollenZuordnungService.class));
        AnlagenflussWerteLeser leser = new AnlagenflussWerteLeser(topologyService, ladepunkte,
                new PriceRepository(app), app);
        controller = new WerteController(new WerteKatalog(), leser, topologyService,
                new com.voltpilot.api.zugriff.Geltungsbereich(app));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private record Welt(UUID tenant, UUID site, UUID device) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        seed.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        seed.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')", site, tenant,
                name);
        seed.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'claimed')", device, tenant, site, "ref-" + device);
        return new Welt(tenant, site, device);
    }

    private static UUID gridEntity(Welt w, double powerKw) {
        UUID id = UUID.randomUUID();
        seed.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                        + "device_id, control, communication, capabilities, created_at) VALUES (?, ?, ?, "
                        + "'grid-meter', 'Netz', 'grid-meter', ?, false, 'modbus_tcp', "
                        + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb, now())",
                id, w.tenant(), w.site(), w.device());
        telemetrie(w, id, "power_kw", powerKw);
        return id;
    }

    private static void telemetrie(Welt w, UUID entityId, String channel, double value) {
        Instant jetzt = Instant.now();
        seed.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                Timestamp.from(jetzt), Timestamp.from(jetzt), w.tenant(), w.site(), w.device(),
                entityId.toString(), channel, value);
    }

    @Test
    void dieAntwortTraegtDenAnlagenflussWertUndEinenMessreiheEintragJeKanal() {
        Welt w = welt("Werte-Controller GmbH");
        UUID grid = gridEntity(w, 8.5);

        TenantContext.set(w.tenant());
        try {
            WertverweisDto.Liste liste = controller.werte("anlage:" + w.site());

            WertverweisDto netz = liste.werte().stream()
                    .filter(v -> "anlage.netz.leistung".equals(v.wertart())).findFirst().orElseThrow();
            assertThat(netz.bekannt()).isTrue();
            assertThat(netz.zahlenwert()).isEqualTo(8.5);

            WertverweisDto kanal = liste.werte().stream()
                    .filter(v -> "geraet.messwert".equals(v.wertart())
                            && v.bezugJson().contains(grid.toString()) && v.bezugJson().contains("power_kw"))
                    .findFirst().orElseThrow();
            assertThat(kanal.bekannt()).isTrue();
            assertThat(kanal.zahlenwert()).isEqualTo(8.5);
            assertThat(kanal.einheit()).isEqualTo("kW");
            assertThat(kanal.name()).contains("Netz").contains("power_kw");
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void eineAnlageOhneKomponentenLiefertNurDieAnlagenflussEintraegeOhneAbsturz() {
        Welt w = welt("Leere Anlage GmbH");
        TenantContext.set(w.tenant());
        try {
            WertverweisDto.Liste liste = controller.werte("anlage:" + w.site());

            assertThat(liste.werte()).isNotEmpty();
            assertThat(liste.werte()).noneMatch(v -> "geraet.messwert".equals(v.wertart()));
        } finally {
            TenantContext.clear();
        }
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
