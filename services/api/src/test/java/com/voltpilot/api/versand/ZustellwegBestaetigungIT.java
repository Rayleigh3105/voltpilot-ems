package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;
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
 * Der Bestätigungsfluss des E-Mail-Zustellwegs (§6.6): eine Adresse wird erst beliefert, wenn ihr
 * Inhaber sie über einen Link bestätigt - der Token ist einmalig und läuft ab. Testcontainers,
 * Docker nötig.
 */
@Testcontainers(disabledWithoutDocker = true)
class ZustellwegBestaetigungIT {

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
    private static JdbcTemplate adminJdbc;
    private static ZustellwegRepository zustellwege;
    private static VersandRepository ausgang;
    private static UUID tenant;

    @BeforeAll
    static void aufbauen() {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load().migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        JdbcTemplate appJdbc = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        zustellwege = new ZustellwegRepository(appJdbc, adminJdbc);
        ausgang = new VersandRepository(appJdbc, adminJdbc);
        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Bestaetigung-Test') RETURNING id", UUID.class);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        adminJdbc.update("DELETE FROM benachrichtigung WHERE tenant_id = ?", tenant);
        adminJdbc.update("DELETE FROM zustellweg WHERE tenant_id = ?", tenant);
    }

    @Test
    void unbestaetigtBleibtDieAdresseOhneWirkung() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-neu", "neu@example.test", "tok-unbestaetigt",
                Instant.now().plusSeconds(3600));

        Optional<String> ziel = zustellwege.bestaetigtesZiel(tenant, "sub-neu");

        assertThat(ziel).isEmpty();
        assertThat(zustellwege.eigener("sub-neu")).get().extracting(ZustellwegRepository.Zustellweg::bestaetigt)
                .isEqualTo(false);
    }

    @Test
    void bestaetigenMachtDieAdresseWirksamUndVerbrauchtDenToken() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-jonas", "jonas@example.test", "tok-einmalig",
                Instant.now().plusSeconds(3600));
        TenantContext.clear(); // der Bestätigungsendpunkt hat keine Anmeldung, also keinen Kundenbereich

        boolean ersterKlick = zustellwege.bestaetigen("tok-einmalig", Instant.now());
        boolean zweiterKlick = zustellwege.bestaetigen("tok-einmalig", Instant.now());

        assertThat(ersterKlick).isTrue();
        assertThat(zweiterKlick).as("der Token ist verbraucht - ein zweiter Klick findet nichts mehr").isFalse();
        assertThat(zustellwege.bestaetigtesZiel(tenant, "sub-jonas")).contains("jonas@example.test");
    }

    @Test
    void einAbgelaufenerTokenBestaetigtNichts() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-ines", "ines@example.test", "tok-abgelaufen",
                Instant.now().minusSeconds(10));
        TenantContext.clear();

        boolean ok = zustellwege.bestaetigen("tok-abgelaufen", Instant.now());

        assertThat(ok).isFalse();
        assertThat(zustellwege.bestaetigtesZiel(tenant, "sub-ines")).isEmpty();
    }

    @Test
    void eineGeaenderteAdresseVerliertIhreBestaetigung() {
        TenantContext.set(tenant);
        zustellwege.anlegenOderErneuern("sub-peter", "alt@example.test", "tok-alt", Instant.now().plusSeconds(3600));
        zustellwege.bestaetigen("tok-alt", Instant.now());
        assertThat(zustellwege.bestaetigtesZiel(tenant, "sub-peter")).contains("alt@example.test");

        // Eine geänderte Adresse ist wieder UNBESTÄTIGT (§6.6) - sonst könnte eine Person eine fremde
        // Adresse eintragen und sich auf die alte Bestätigung berufen.
        zustellwege.anlegenOderErneuern("sub-peter", "neu@example.test", "tok-neu", Instant.now().plusSeconds(3600));

        assertThat(zustellwege.bestaetigtesZiel(tenant, "sub-peter")).isEmpty();

        zustellwege.bestaetigen("tok-neu", Instant.now());
        assertThat(zustellwege.bestaetigtesZiel(tenant, "sub-peter")).contains("neu@example.test");
    }

    @Test
    void derZustellwegServiceReihtDieBestaetigungsMailMitDemAngeforderenZielEin() {
        TenantContext.set(tenant);
        ZustellwegService dienst = new ZustellwegService(zustellwege, ausgang, "http://localhost:5173");
        dienst.uhrStellen(Clock.fixed(Instant.parse("2026-10-15T12:00:00Z"), ZoneOffset.UTC));

        dienst.anfordern("sub-moritz", "moritz@example.test");

        String ziel = adminJdbc.queryForObject(
                "SELECT ziel FROM benachrichtigung WHERE tenant_id = ? AND empfaenger_sub = 'sub-moritz'",
                String.class, tenant);
        assertThat(ziel).isEqualTo("moritz@example.test");
        assertThat(dienst.eigener("sub-moritz")).get()
                .extracting(ZustellwegRepository.Zustellweg::bestaetigt).isEqualTo(false);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
