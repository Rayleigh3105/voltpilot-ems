package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
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
 * Alerting Scheibe 0 (Konzept §9): der eindeutige Schlüssel des Ausgangs {@code benachrichtigung}
 * (Meldung/Quelle, Empfänger, Weg, Anlass, Nummer) verhindert Doppelversand bei Wiederholung oder
 * zwei Pods. Testcontainers, Docker nötig.
 */
@Testcontainers(disabledWithoutDocker = true)
class VersandOutboxDedupIT {

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
    private static VersandRepository versand;
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
        versand = new VersandRepository(appJdbc, adminJdbc);
        tenant = root.queryForObject(
                "INSERT INTO tenant (name) VALUES ('Dedup-Test') RETURNING id", UUID.class);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        adminJdbc.update("DELETE FROM benachrichtigung WHERE tenant_id = ?", tenant);
    }

    @Test
    void zweimalEinreihenDerselbenMeldungErzeugtNurEineZeile() {
        TenantContext.set(tenant);
        UUID hinweisId = UUID.randomUUID();

        versand.email("unterstuetzung_hinweis", hinweisId, "sub-jonas", "notfall", "Betreff", "Inhalt");
        versand.email("unterstuetzung_hinweis", hinweisId, "sub-jonas", "notfall", "Betreff", "Inhalt (zweiter Versuch)");

        List<Map<String, Object>> zeilen = adminJdbc.queryForList(
                "SELECT inhalt FROM benachrichtigung WHERE tenant_id = ? AND quelle_id = ?", tenant, hinweisId);
        assertThat(zeilen).hasSize(1);
        // Der ERSTE Text gewinnt (ON CONFLICT DO NOTHING) - der zweite Einreih-Versuch ändert nichts.
        assertThat(zeilen.get(0).get("inhalt")).isEqualTo("Inhalt");
    }

    @Test
    void unterschiedlicheNummerErzeugtEigeneZeile() {
        TenantContext.set(tenant);
        UUID hinweisId = UUID.randomUUID();
        versand.email("unterstuetzung_hinweis", hinweisId, "sub-jonas", "erinnerung", "Betreff", "Inhalt");
        // Ein anderer Anlass ist ein anderer Schlüssel - das ist KEIN Doppelversand.
        versand.email("unterstuetzung_hinweis", hinweisId, "sub-jonas", "abgelaufen", "Betreff", "Inhalt");

        Integer anzahl = adminJdbc.queryForObject(
                "SELECT count(*) FROM benachrichtigung WHERE tenant_id = ? AND quelle_id = ?", Integer.class,
                tenant, hinweisId);
        assertThat(anzahl).isEqualTo(2);
    }

    @Test
    void faelligClaimtGenauEinmalUndMarkiertGesendet() {
        TenantContext.set(tenant);
        UUID hinweisId = UUID.randomUUID();
        versand.email("unterstuetzung_hinweis", hinweisId, "sub-jonas", "gewaehrt", "Betreff", "Inhalt");
        TenantContext.clear();

        Instant jetzt = Instant.now();
        List<VersandRepository.Zeile> erster = versand.faellig(jetzt, 10);
        assertThat(erster).hasSize(1);
        // Geclaimt (Pacht nach vorn verschoben) - ein zweiter Lauf im selben Augenblick findet nichts mehr.
        List<VersandRepository.Zeile> zweiter = versand.faellig(jetzt, 10);
        assertThat(zweiter).isEmpty();

        versand.gesendet(erster.get(0).id(), jetzt);
        String zustand = adminJdbc.queryForObject(
                "SELECT zustand FROM benachrichtigung WHERE id = ?", String.class, erster.get(0).id());
        assertThat(zustand).isEqualTo("gesendet");
    }

    @Test
    void loeschlaufFegtNurAeltereZeilen() {
        TenantContext.set(tenant);
        UUID frischId = UUID.randomUUID();
        UUID altId = UUID.randomUUID();
        versand.email("unterstuetzung_hinweis", frischId, "sub-jonas", "beendet", "Betreff", "Inhalt");
        versand.email("unterstuetzung_hinweis", altId, "sub-jonas", "beendet", "Betreff", "Inhalt alt");
        TenantContext.clear();
        adminJdbc.update("UPDATE benachrichtigung SET erstellt_am = now() - interval '91 days' "
                + "WHERE tenant_id = ? AND quelle_id = ?", tenant, altId);

        int geloescht = versand.loeschenAelterAls(Instant.now().minus(java.time.Duration.ofDays(90)));

        assertThat(geloescht).isEqualTo(1);
        Integer uebrig = adminJdbc.queryForObject(
                "SELECT count(*) FROM benachrichtigung WHERE tenant_id = ?", Integer.class, tenant);
        assertThat(uebrig).isEqualTo(1);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
