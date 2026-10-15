package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.topology.TopologyRepository;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
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
import javax.sql.DataSource;

/**
 * Der {@code messreihe}-Leser gegen echte Zeilen (Alerting Scheibe 2, Konzept vp-alerting-konzept-m1
 * §7 "Testcontainers-IT je neuer Leserart"): liest {@code telemetry_v2} über {@link TopologyRepository}
 * genau wie "Anlage › Aufbau" (§6.1 Nr. 3), und der Mandanten-Zaun über RLS auf {@code measurement_point}.
 */
@Testcontainers(disabledWithoutDocker = true)
class MessreiheWerteLeserIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "messreihe_it_pw";
    private static final WerteKatalog.Eintrag GERAET_MESSWERT = new WerteKatalog().eintrag("geraet.messwert");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;

    @BeforeAll
    static void migrate() {
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
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private record Welt(UUID tenant, UUID site, UUID komponente) {}

    private static Welt welt(String name, String kanal) {
        UUID tenant = UUID.randomUUID();
        UUID site = UUID.randomUUID();
        UUID device = UUID.randomUUID();
        UUID komponente = UUID.randomUUID();
        try (Connection c = superuser().getConnection()) {
            exec(c, "INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
            exec(c, "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')", site, tenant,
                    name + "-Anlage");
            exec(c, "INSERT INTO device (id, tenant_id, site_id, external_ref, kind) "
                    + "VALUES (?, ?, ?, ?, 'inverter')", device, tenant, site, "ref-" + device);
            exec(c, "INSERT INTO measurement_point (id, tenant_id, site_id, role, label) "
                    + "VALUES (?, ?, ?, 'pv-generation', 'Testkanal')", komponente, tenant, site);
            Instant t0 = Instant.now().minusSeconds(20);
            v2(c, tenant, site, device, komponente.toString(), kanal, t0, 10.0);
            v2(c, tenant, site, device, komponente.toString(), kanal, t0.plusSeconds(10), 12.0);
            v2(c, tenant, site, device, komponente.toString(), kanal, t0.plusSeconds(20), 14.0);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        return new Welt(tenant, site, komponente);
    }

    private static MessreiheWerteLeser leser() {
        return new MessreiheWerteLeser(new TopologyRepository(app), new UeberwachungRepository(app));
    }

    @Test
    void liestDenDreissigSekundenMittelwertWieDieAufbauSpalteWert() {
        Welt w = welt("Messreihe GmbH", "temperatur_c");
        TenantContext.set(w.tenant());
        WerteLeser.Lesung lesung = leser().lese(GERAET_MESSWERT,
                WerteLeser.Bezug.komponente(w.komponente(), "temperatur_c"), Instant.now());

        assertThat(lesung.bekannt()).isTrue();
        assertThat(lesung.zahlenwert()).isCloseTo(12.0, within(0.01)); // Mittel aus 10/12/14
    }

    @Test
    void eineUnbekannteKomponenteIstUnbekanntNieEineErfundeneNull() {
        TenantContext.set(UUID.randomUUID()); // ein frischer, leerer Mandant
        WerteLeser.Lesung lesung = leser().lese(GERAET_MESSWERT,
                WerteLeser.Bezug.komponente(UUID.randomUUID(), "temperatur_c"), Instant.now());

        assertThat(lesung.bekannt()).isFalse();
    }

    @Test
    void mandantenZaunEineKomponenteDesAnderenKundenbereichsIstUnbekannt() {
        Welt a = welt("Mandant A", "druck_bar");
        Welt b = welt("Mandant B", "druck_bar");

        // Unter dem Kontext von B nach der Komponente von A fragen: RLS auf measurement_point
        // (tenant-scoped wie "asset") lässt die Zeile verschwinden, bevor der Leser überhaupt
        // telemetry_v2 anfasst - UNBEKANNT, nie die Zahl des fremden Mandanten.
        TenantContext.set(b.tenant());
        WerteLeser.Lesung lesung = leser().lese(GERAET_MESSWERT,
                WerteLeser.Bezug.komponente(a.komponente(), "druck_bar"), Instant.now());

        assertThat(lesung.bekannt()).isFalse();

        // Zum Vergleich: unter dem eigenen Kontext liefert dieselbe Komponente ihren Wert.
        TenantContext.set(a.tenant());
        WerteLeser.Lesung eigene = leser().lese(GERAET_MESSWERT,
                WerteLeser.Bezug.komponente(a.komponente(), "druck_bar"), Instant.now());
        assertThat(eigene.bekannt()).isTrue();
    }

    // ---- helpers --------------------------------------------------------------

    private static DataSource superuser() {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(POSTGRES.getUsername());
        ds.setPassword(POSTGRES.getPassword());
        return ds;
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }

    private static void exec(Connection c, String sql, Object... args) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(sql)) {
            for (int i = 0; i < args.length; i++) {
                ps.setObject(i + 1, args[i]);
            }
            ps.execute();
        }
    }

    private static void v2(Connection c, UUID tenant, UUID site, UUID device, String entityId, String channel,
            Instant time, double value) throws Exception {
        try (PreparedStatement ps = c.prepareStatement(
                "INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, entity_id, channel, "
                        + "value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")) {
            ps.setTimestamp(1, Timestamp.from(time));
            ps.setTimestamp(2, Timestamp.from(time));
            ps.setObject(3, tenant);
            ps.setObject(4, site);
            ps.setObject(5, device);
            ps.setString(6, entityId);
            ps.setString(7, channel);
            ps.setDouble(8, value);
            ps.execute();
        }
    }
}
