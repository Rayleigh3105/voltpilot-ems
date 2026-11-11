package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.versand.VersandRepository;
import com.voltpilot.api.zugriff.RechtFehlt;
import com.voltpilot.api.zugriff.ZugriffRepository;
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
 * Freie externe E-Mail-Empfänger je Überwachung (Alerting Scheibe 6, Konzept §7 Scheibe 6,
 * Entscheid 11B) gegen echte Zeilen: NUR mit Bestätigung, Rechte-Prüfung
 * ({@code ueberwachung.verwalten} IMMER), knapper Inhalt (keine Messwerte) mit Abbestellen-Link,
 * und ein bestätigter, aber abbestellter Empfänger bekommt keine weitere Mail.
 */
@Testcontainers(disabledWithoutDocker = true)
class ExterneEmpfaengerServiceIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "extern_empf_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate adminJdbc;

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
        adminJdbc = new JdbcTemplate(ds(ADMIN, PW));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private record Welt(UUID tenant, UUID standort, UUID ueberwachung) {}

    private static Welt welt(String name) {
        UUID tenant = UUID.randomUUID();
        UUID unternehmen = UUID.randomUUID();
        UUID standort = UUID.randomUUID();
        UUID anlage = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        adminJdbc.update("INSERT INTO unternehmen (id, tenant_id, name) VALUES (?, ?, ?)", unternehmen, tenant, name);
        adminJdbc.update("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                + "VALUES (?, ?, ?, 'Werk Ahrenberg', 'ST-1', 'Europe/Berlin', 'aktiv')", standort, tenant,
                unternehmen);
        adminJdbc.update("INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, 'Halle 1', 'DE-LU')",
                anlage, tenant);
        adminJdbc.update("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) "
                + "VALUES (?, ?, ?, '2026-01-01')", tenant, anlage, standort);
        UUID ueberwachung = UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            app.update("""
                    INSERT INTO ueberwachung (id, tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                           empfaenger, herkunft, aktiv, angelegt_von)
                    VALUES (?, ?, ?, 'Netzbezug Halle 1', 'anlage.netz.leistung', ?::jsonb, ?::jsonb, 'warnung',
                           '[]'::jsonb, 'eigen', true, 'sub-anlegerin')
                    """, ueberwachung, tenant, standort, "{\"anlage\":\"" + anlage + "\"}",
                    "{\"art\":\"ueber\",\"schwelle\":120}");
        } finally {
            TenantContext.clear();
        }
        return new Welt(tenant, standort, ueberwachung);
    }

    /** Kundenadministrator/Energiemanager sind unternehmensweit (kein Standort), Leser/Bearbeiter je Standort
     * (Captains-Entscheid "Kundenadministrator und Energiemanager unternehmensweit, Bearbeiter je Standort",
     * `zugriff_geltungsbereich_chk`) - {@code standort} wird für die unternehmensweiten Rollen ignoriert. */
    private static Benutzer benutzerMitRolle(UUID tenant, String sub, String rolle, UUID standort) {
        boolean unternehmensweit = "kundenadministrator".equals(rolle) || "energiemanager".equals(rolle);
        TenantContext.set(tenant);
        try {
            app.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                    + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, sub);
            app.update("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (?, ?, ?, ?, now() - interval '1 day', 'Europe/Berlin')", tenant, sub, rolle,
                    unternehmensweit ? null : standort);
            ZugriffRepository zugriffe = new ZugriffRepository(app);
            ZugriffRepository.BenutzerSpiegel spiegel = zugriffe.spiegel(sub).orElseThrow();
            return new Benutzer(sub, spiegel.anzeigename(), spiegel.konto(), spiegel.zustand(),
                    zugriffe.wirksam(sub, Instant.now()).stream().map(ZugriffRepository.Zeile::alsZuweisung).toList());
        } finally {
            TenantContext.clear();
        }
    }

    private static ExterneEmpfaengerService dienst() {
        VersandRepository ausgang = new VersandRepository(app, adminJdbc);
        return new ExterneEmpfaengerService(new ExterneEmpfaengerRepository(app, adminJdbc),
                new UeberwachungRepository(app), new ZugriffRepository(app), ausgang, "https://portal.example.test");
    }

    @Test
    void einLeserOhneVerwaltenDarfKeinenExternenEmpfaengerEintragen() {
        Welt w = welt("Externe-Ablehnung GmbH");
        Benutzer leser = benutzerMitRolle(w.tenant(), "sub-leser", "leser", w.standort());
        TenantContext.set(w.tenant());
        try {
            assertThatThrownBy(() -> dienst().hinzufuegen(w.ueberwachung(), "aussen@example.test", leser, Instant.now()))
                    .isInstanceOf(RechtFehlt.class);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void verwaltenDarfEintragenUndDieBestaetigungsAnfrageGehtKnappAnDieNochUnbestaetigteAdresse() {
        Welt w = welt("Externe-Anlegen GmbH");
        Benutzer admin = benutzerMitRolle(w.tenant(), "sub-admin", "kundenadministrator", w.standort());
        TenantContext.set(w.tenant());
        try {
            var neu = dienst().hinzufuegen(w.ueberwachung(), "aussen@example.test", admin, Instant.now());

            assertThat(neu.bestaetigt()).isFalse();
            Map<String, Object> zeile = adminJdbc.queryForMap(
                    "SELECT ziel, betreff, inhalt FROM benachrichtigung WHERE quelle_id = ?::uuid", neu.id());
            assertThat(zeile.get("ziel")).isEqualTo("aussen@example.test");
            assertThat((String) zeile.get("inhalt")).contains("bestaetigen");
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void bestaetigenOhneAnmeldungMachtDenEmpfaengerVersandfaehig() {
        Welt w = welt("Externe-Bestaetigen GmbH");
        Benutzer admin = benutzerMitRolle(w.tenant(), "sub-admin2", "kundenadministrator", w.standort());
        ExterneEmpfaengerService dienst = dienst();
        TenantContext.set(w.tenant());
        String token;
        try {
            dienst.hinzufuegen(w.ueberwachung(), "aussen2@example.test", admin, Instant.now());
            token = app.queryForObject(
                    "SELECT bestaetigung_token FROM ueberwachung_externer_empfaenger WHERE email = ?",
                    String.class, "aussen2@example.test");
        } finally {
            TenantContext.clear();
        }

        boolean ok = dienst.bestaetigen(token);
        assertThat(ok).isTrue();
        // Ein zweiter Aufruf desselben Links findet nichts mehr (verbraucht, derselbe Vertrag wie zustellweg).
        assertThat(dienst.bestaetigen(token)).isFalse();
    }

    @Test
    void benachrichtigenGehtKnappNurAnBestaetigteUndAktiveMitAbbestellenLinkUndKeineMesswerte() {
        Welt w = welt("Externe-Benachrichtigen GmbH");
        Benutzer admin = benutzerMitRolle(w.tenant(), "sub-admin3", "kundenadministrator", w.standort());
        ExterneEmpfaengerService dienst = dienst();
        String token;
        TenantContext.set(w.tenant());
        try {
            dienst.hinzufuegen(w.ueberwachung(), "aussen3@example.test", admin, Instant.now());
            token = app.queryForObject(
                    "SELECT bestaetigung_token FROM ueberwachung_externer_empfaenger WHERE email = ?",
                    String.class, "aussen3@example.test");
        } finally {
            TenantContext.clear();
        }
        dienst.bestaetigen(token);

        UUID alarmId = UUID.randomUUID();
        TenantContext.set(w.tenant());
        try {
            dienst.benachrichtigen(w.ueberwachung(), alarmId, "Netzbezug Halle 1", "warnung", Instant.now());

            Map<String, Object> zeile = adminJdbc.queryForMap(
                    "SELECT ziel, betreff, inhalt, quelle FROM benachrichtigung "
                            + "WHERE quelle_id = ?::uuid AND anlass = 'ausgeloest'", alarmId);
            assertThat(zeile.get("ziel")).isEqualTo("aussen3@example.test");
            assertThat(zeile.get("quelle")).isEqualTo("alarm_extern");
            String inhalt = (String) zeile.get("inhalt");
            // Entscheid 11B: keine Messwerte/Detaildaten (die Schwelle 120 der Regel taucht nicht auf).
            assertThat(inhalt).doesNotContain("120").contains("abbestellen").contains("portal.example.test");
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void abbestelltIstIdempotentUndStopptWeitereBenachrichtigung() {
        Welt w = welt("Externe-Abbestellen GmbH");
        Benutzer admin = benutzerMitRolle(w.tenant(), "sub-admin4", "kundenadministrator", w.standort());
        ExterneEmpfaengerService dienst = dienst();
        String bestaetigungToken;
        String abbestellenToken;
        TenantContext.set(w.tenant());
        try {
            dienst.hinzufuegen(w.ueberwachung(), "aussen4@example.test", admin, Instant.now());
            bestaetigungToken = app.queryForObject(
                    "SELECT bestaetigung_token FROM ueberwachung_externer_empfaenger WHERE email = ?",
                    String.class, "aussen4@example.test");
            abbestellenToken = app.queryForObject(
                    "SELECT abbestellen_token FROM ueberwachung_externer_empfaenger WHERE email = ?",
                    String.class, "aussen4@example.test");
        } finally {
            TenantContext.clear();
        }
        dienst.bestaetigen(bestaetigungToken);

        assertThat(dienst.abbestellen(abbestellenToken)).isTrue();
        // idempotent - ein zweiter Aufruf bleibt ohne Fehler.
        assertThat(dienst.abbestellen(abbestellenToken)).isTrue();

        TenantContext.set(w.tenant());
        try {
            dienst.benachrichtigen(w.ueberwachung(), UUID.randomUUID(), "Netzbezug Halle 1", "warnung", Instant.now());
            Long anzahl = adminJdbc.queryForObject(
                    "SELECT count(*) FROM benachrichtigung WHERE ziel = 'aussen4@example.test' AND anlass = 'ausgeloest'",
                    Long.class);
            assertThat(anzahl).isZero();
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
