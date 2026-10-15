package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
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
import java.sql.Timestamp;
import java.time.Instant;
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
 * Alerting Scheibe 2 (vp-alerting-konzept-m1 §7 "Testcontainers-IT je Leserart"): der
 * {@code anlagenfluss}-Leser gegen eine ECHTE Datenbank, über den VOLLEN
 * {@link TopologyService#topology(UUID)}-Pfad (echte {@code measurement_point}-/{@code telemetry_v2}-Zeilen,
 * echte {@link com.voltpilot.api.topology.TopologyDeriver}-Rollen-Ableitung über
 * {@link EntityTypeCatalog}) - NIE {@code TopologyRepository.liveValues} direkt, weil das die
 * Rollen-Ableitung umginge, die der Leser tatsächlich nutzt.
 *
 * <p>Die drei Entitäten je Anlage spiegeln den echten timescale-writer-Fanout
 * ({@code ComposedEntityFanout}, vgl. {@code TopologyAnzeigeMittelTest}): ein
 * {@code battery-hybrid} meldet {@code pv_power_kw} (-&gt; Rolle {@code pv}) UND
 * {@code battery_power_kw}/{@code soc_pct} (-&gt; Rolle {@code storage}), ein {@code grid-meter}
 * meldet {@code power_kw} (-&gt; Rolle {@code grid} über die Kategorie {@code meter}), ein
 * {@code house-load} meldet {@code power_kw} (-&gt; Rolle {@code consumer} über die Kategorie
 * {@code consumer}).
 */
@Testcontainers(disabledWithoutDocker = true)
class AnlagenflussWerteLeserIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "anlagenfluss_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate seed;
    private static AnlagenflussWerteLeser leser;
    private static WerteKatalog katalog;

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
        // Die Rohdaten schreibt eine Superuser-Verbindung (umgeht RLS absichtlich, wie
        // TopologyAnzeigeMittelTest) - der eigentliche Zaun wird über die app-Rolle GELESEN.
        seed = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));

        EntityRegistryRepository registry = new EntityRegistryRepository(app);
        TopologyRepository topologyRepo = new TopologyRepository(app);
        EntityTypeCatalog catalog = new EntityTypeCatalog(new ObjectMapper());
        DeviceChargerStatusRepository ladepunkte = new DeviceChargerStatusRepository(app);
        EntityRegistryService push = mock(EntityRegistryService.class);
        RollenZuordnungService rollen = mock(RollenZuordnungService.class);
        TopologyService topologyService = new TopologyService(registry, topologyRepo, catalog,
                new ObjectMapper(), ladepunkte, push, rollen);
        PriceRepository preise = new PriceRepository(app);
        leser = new AnlagenflussWerteLeser(topologyService, ladepunkte, preise, app);
        katalog = new WerteKatalog();
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    // =========================================================== Aufbau: eine Anlage + ihre v2-Entitäten

    private record Welt(UUID tenant, UUID site, UUID device) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        seed.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        seed.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')",
                site, tenant, name);
        seed.update("INSERT INTO device (id, tenant_id, site_id, external_ref, kind, status) "
                + "VALUES (?, ?, ?, ?, 'inverter', 'claimed')", device, tenant, site, "ref-" + device);
        return new Welt(tenant, site, device);
    }

    /** Ein grid-meter mit EINEM power_kw-Kanal (Rolle {@code grid} über Kategorie {@code meter}). */
    private static UUID gridEntity(Welt w, Double powerKw) {
        UUID id = UUID.randomUUID();
        seed.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                        + "device_id, control, communication, capabilities, created_at) VALUES (?, ?, ?, "
                        + "'grid-meter', 'Netz', 'grid-meter', ?, false, 'modbus_tcp', "
                        + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb, now())",
                id, w.tenant(), w.site(), w.device());
        if (powerKw != null) {
            telemetrie(w, id, "power_kw", powerKw);
        }
        return id;
    }

    /**
     * Ein battery-hybrid mit den drei Standard-Kanälen aus dem Typkatalog: {@code pv_power_kw}
     * (-&gt; Rolle {@code pv}), {@code battery_power_kw}/{@code soc_pct} (-&gt; Rolle {@code storage}).
     * Jeder Kanal ohne mitgegebenen Wert bleibt einfach unbeprobt (keine Telemetrie-Zeile).
     */
    private static UUID batteryEntity(Welt w, Double pvKw, Double batteryKw, Double socPct) {
        UUID id = UUID.randomUUID();
        seed.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                        + "device_id, control, communication, capabilities, created_at) VALUES (?, ?, ?, "
                        + "'battery-hybrid', 'Speicher', 'battery-hybrid', ?, false, 'modbus_tcp', "
                        + "'{\"measure\":[{\"channel\":\"soc_pct\",\"unit\":\"%\"},"
                        + "{\"channel\":\"battery_power_kw\",\"unit\":\"kW\"},"
                        + "{\"channel\":\"pv_power_kw\",\"unit\":\"kW\"}]}'::jsonb, now())",
                id, w.tenant(), w.site(), w.device());
        if (pvKw != null) {
            telemetrie(w, id, "pv_power_kw", pvKw);
        }
        if (batteryKw != null) {
            telemetrie(w, id, "battery_power_kw", batteryKw);
        }
        if (socPct != null) {
            telemetrie(w, id, "soc_pct", socPct);
        }
        return id;
    }

    /** Ein house-load mit EINEM power_kw-Kanal (Rolle {@code consumer} über Kategorie {@code consumer}). */
    private static UUID houseEntity(Welt w, Double powerKw) {
        UUID id = UUID.randomUUID();
        seed.update("INSERT INTO measurement_point (id, tenant_id, site_id, role, label, entity_type, "
                        + "device_id, control, communication, capabilities, created_at) VALUES (?, ?, ?, "
                        + "'house-load', 'Haus', 'house-load', ?, false, 'modbus_tcp', "
                        + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb, now())",
                id, w.tenant(), w.site(), w.device());
        if (powerKw != null) {
            telemetrie(w, id, "power_kw", powerKw);
        }
        return id;
    }

    private static void telemetrie(Welt w, UUID entityId, String channel, double value) {
        Instant jetzt = Instant.now();
        seed.update("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                        + "entity_id, channel, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                Timestamp.from(jetzt), Timestamp.from(jetzt), w.tenant(), w.site(), w.device(),
                entityId.toString(), channel, value);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }

    // =========================================================== Netz (§6.3, Vorzeichen)

    @Test
    void netzBezugIstPositiv() {
        Welt w = welt("Netz-Bezug GmbH");
        gridEntity(w, 5.2);
        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("anlage.netz.leistung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zahlenwert()).isCloseTo(5.2, within(0.01));
            assertThat(l.einheit()).isEqualTo("kW");
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void netzEinspeisungIstNegativ() {
        Welt w = welt("Netz-Einspeisung GmbH");
        gridEntity(w, -3.1);
        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("anlage.netz.leistung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zahlenwert()).isCloseTo(-3.1, within(0.01));
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== PV (§6.3, Betrag)

    @Test
    void pvIstDiePositiveSumme() {
        Welt w = welt("PV GmbH");
        batteryEntity(w, 7.0, null, null);
        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("anlage.pv.leistung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zahlenwert()).isCloseTo(7.0, within(0.01));
            assertThat(l.einheit()).isEqualTo("kW");
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Speicher (§6.3, Vorzeichen + Ladestand)

    @Test
    void speicherLadenIstPositivUndDerLadestandIstSeparatLesbar() {
        Welt w = welt("Speicher-Laden GmbH");
        batteryEntity(w, null, 4.0, 62.5);
        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung leistung = leser.lese(katalog.eintrag("anlage.speicher.leistung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(leistung.bekannt()).isTrue();
            assertThat(leistung.zahlenwert()).isCloseTo(4.0, within(0.01));

            WerteLeser.Lesung ladestand = leser.lese(katalog.eintrag("anlage.speicher.ladestand"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(ladestand.bekannt()).isTrue();
            assertThat(ladestand.zahlenwert()).isCloseTo(62.5, within(0.01));
            assertThat(ladestand.einheit()).isEqualTo("%");
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void speicherEntladenIstNegativ() {
        Welt w = welt("Speicher-Entladen GmbH");
        batteryEntity(w, null, -2.5, null);
        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("anlage.speicher.leistung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zahlenwert()).isCloseTo(-2.5, within(0.01));
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Verbrauch (§6.3, Betrag)

    @Test
    void verbrauchIstDiePositiveSumme() {
        Welt w = welt("Verbrauch GmbH");
        houseEntity(w, 9.3);
        TenantContext.set(w.tenant());
        try {
            WerteLeser.Lesung l = leser.lese(katalog.eintrag("anlage.verbrauch.leistung"),
                    WerteLeser.Bezug.anlage(w.site()), Instant.now());
            assertThat(l.bekannt()).isTrue();
            assertThat(l.zahlenwert()).isCloseTo(9.3, within(0.01));
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== UNBEKANNT IST KEINE NULL (§6.1 Nr. 4)

    @Test
    void ohneTopologieDatenIstJedesFeldUnbekanntNieEineErfundeneNull() {
        Welt w = welt("Ohne Topologie GmbH");
        // Keine measurement_point-Zeile angelegt: entitiesForSite liefert leer, topology() hat
        // keine Knoten - jedes Feld muss unbekannt sein, nie eine erfundene 0.
        Instant jetzt = Instant.now();
        TenantContext.set(w.tenant());
        try {
            for (String wertart : new String[] {"anlage.netz.leistung", "anlage.pv.leistung",
                    "anlage.speicher.leistung", "anlage.speicher.ladestand", "anlage.verbrauch.leistung"}) {
                WerteLeser.Lesung l = leser.lese(katalog.eintrag(wertart),
                        WerteLeser.Bezug.anlage(w.site()), jetzt);
                assertThat(l.bekannt()).as(wertart).isFalse();
            }
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Mandanten- und Standort-Zaun (§6.6)

    @Test
    void fremdeAnlageUnterEigenemMandantLiefertUnbekanntNieDieDatenDesAnderenMandanten() {
        Welt eigen = welt("Eigener Mandant GmbH");
        Welt fremd = welt("Fremder Mandant GmbH");
        gridEntity(eigen, 6.0);
        gridEntity(fremd, 99.0);

        TenantContext.set(eigen.tenant());
        try {
            // Die eigene Anlage liefert ganz normal ihren echten Wert.
            WerteLeser.Lesung eigenes = leser.lese(katalog.eintrag("anlage.netz.leistung"),
                    WerteLeser.Bezug.anlage(eigen.site()), Instant.now());
            assertThat(eigenes.bekannt()).isTrue();
            assertThat(eigenes.zahlenwert()).isCloseTo(6.0, within(0.01));

            // Die FREMDE site_id unter dem EIGENEN TenantContext: RLS verweigert die Zeilen des
            // anderen Mandanten vollständig -> unbekannt, NIEMALS der Wert 99.0 des Fremden.
            WerteLeser.Lesung fremdes = leser.lese(katalog.eintrag("anlage.netz.leistung"),
                    WerteLeser.Bezug.anlage(fremd.site()), Instant.now());
            assertThat(fremdes.bekannt()).isFalse();
        } finally {
            TenantContext.clear();
        }
    }
}
