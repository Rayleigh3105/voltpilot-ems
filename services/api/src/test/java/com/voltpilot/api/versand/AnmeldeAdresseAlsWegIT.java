package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;

import com.icegreen.greenmail.util.GreenMail;
import com.icegreen.greenmail.util.ServerSetupTest;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.webhook.WebhookVersandAdapter;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.javamail.JavaMailSenderImpl;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Kunden-Alarmierung P2, KA-1 A: die Anmelde-Adresse gilt sofort als E-Mail-Weg - gegen eine echte Datenbank
 * (Trigger an {@code benutzer}, RLS über die Laufzeitrolle) und einen echten SMTP-Fänger (GreenMail), weil genau der
 * Text der Mail („Abmelden“) und die Zeilen im Ausgang die Eigenschaften sind, die ein Mock nicht prüfen kann.
 *
 * <p>Geprüft: ein neues Konto hat den Weg sofort; jede Mail trägt den Abmelde-Link, der den Weg ohne Anmeldung
 * abschaltet; eine Meldung von VOR dem Weg geht nicht über ihn hinaus; ein selbst eingerichteter Weg kennt diese
 * Grenze nicht und folgt keiner geänderten Konto-Adresse. Docker nötig.
 */
@Testcontainers(disabledWithoutDocker = true)
class AnmeldeAdresseAlsWegIT {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String PORTAL = "https://portal.example.test";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate appJdbc;
    private static JdbcTemplate adminJdbc;
    private static VersandRepository ausgang;
    private static ZustellwegRepository zustellwege;
    private static ZustellwegService dienst;
    private static Zusteller zusteller;
    private static GreenMail greenMail;
    private static UUID tenant;
    private static UUID regel;

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
        appJdbc = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        ausgang = new VersandRepository(appJdbc, adminJdbc);
        zustellwege = new ZustellwegRepository(appJdbc, adminJdbc);

        greenMail = new GreenMail(ServerSetupTest.SMTP);
        greenMail.start();
        JavaMailSenderImpl mailSender = new JavaMailSenderImpl();
        mailSender.setHost("localhost");
        mailSender.setPort(ServerSetupTest.SMTP.getPort());
        EmailVersandAdapter email = new EmailVersandAdapter(mailSender, "meldungen@voltpilot.de");
        byte[] privatPlatzhalter = new byte[32];
        privatPlatzhalter[31] = 1;
        WebPushAdapter push = new WebPushAdapter(Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[65]),
                Base64.getUrlEncoder().withoutPadding().encodeToString(privatPlatzhalter), "mailto:test@voltpilot.de");
        WebhookVersandAdapter webhook = new WebhookVersandAdapter();
        TelegramAdapter telegram = (chatId, text) -> { };
        zusteller = new Zusteller(ausgang, zustellwege, email, push, webhook, telegram, appJdbc);
        zusteller.setBasisUrl(PORTAL + "/");
        dienst = new ZustellwegService(zustellwege, ausgang, telegram, email, push, webhook, PORTAL, "", "");

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Anmelde-Adresse') RETURNING id", UUID.class);
        regel = UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            appJdbc.update("INSERT INTO ueberwachung (id, tenant_id, wertart, bezug, bedingung, schwere, empfaenger, "
                    + "herkunft, angelegt_von) VALUES (?, ?, 'box.erreichbar', '{}'::jsonb, '{\"art\":\"zustand\"}'::jsonb, "
                    + "'warnung', '[]'::jsonb, 'ab_werk', 'system')", regel, tenant);
        } finally {
            TenantContext.clear();
        }
    }

    @AfterAll
    static void beenden() {
        greenMail.stop();
    }

    @BeforeEach
    void leeren() throws Exception {
        greenMail.purgeEmailFromAllMailboxes();
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        adminJdbc.update("DELETE FROM benachrichtigung WHERE tenant_id = ?", tenant);
        adminJdbc.update("DELETE FROM zustellweg WHERE tenant_id = ?", tenant);
    }

    @Test
    void einNeuesKontoHatDenWegSofortUndJedeMailTraegtAbmelden() throws Exception {
        String sub = "sub-" + UUID.randomUUID();
        konto(sub, "benutzer", "aktiv", "familie.sommer@example.test");

        Map<String, Object> weg = adminJdbc.queryForMap("SELECT ziel, herkunft, aktiv, ab_schwere, "
                + "bestaetigt_am IS NOT NULL AS bestaetigt, abmelde_token FROM zustellweg "
                + "WHERE tenant_id = ? AND benutzer_sub = ? AND weg = 'email'", tenant, sub);
        assertThat(weg).containsEntry("ziel", "familie.sommer@example.test").containsEntry("herkunft", "anmeldung")
                .containsEntry("aktiv", true).containsEntry("ab_schwere", "warnung").containsEntry("bestaetigt", true);
        String token = (String) weg.get("abmelde_token");
        assertThat(token).hasSizeGreaterThanOrEqualTo(64);

        meldungEinreihen(sub, alarm(Instant.now().plusSeconds(5)));
        assertThat(zusteller.lauf(Instant.now().plusSeconds(2))).isEqualTo(1);

        var mails = greenMail.getReceivedMessages();
        assertThat(mails).hasSize(1);
        assertThat(mails[0].getAllRecipients()[0].toString()).isEqualTo("familie.sommer@example.test");
        assertThat((String) mails[0].getContent()).contains("Inhalt der Meldung")
                .contains(Zusteller.ABMELDEN + PORTAL + "/#/zustellweg/abmelden?token=" + token);

        // „Abmelden“ ohne Anmeldung: der Weg ist aus, die Zeile bleibt - die nächste Meldung geht nicht hinaus.
        assertThat(dienst.abmelden(token)).isTrue();
        assertThat(dienst.abmelden(token)).as("zweimal ist kein Fehler").isTrue();
        assertThat(dienst.abmelden("unbekannt")).isFalse();
        assertThat(adminJdbc.queryForObject("SELECT aktiv FROM zustellweg WHERE abmelde_token = ?", Boolean.class,
                token)).isFalse();
        greenMail.purgeEmailFromAllMailboxes();
        meldungEinreihen(sub, alarm(Instant.now().plusSeconds(5)));
        assertThat(zusteller.lauf(Instant.now().plusSeconds(2))).isZero();
        assertThat(greenMail.getReceivedMessages()).isEmpty();
    }

    @Test
    void eineMeldungVonVorDemWegGehtNichtUeberDieAnmeldeAdresse() {
        String sub = "sub-" + UUID.randomUUID();
        konto(sub, "benutzer", "aktiv", "bestand@example.test");
        UUID alt = alarm(Instant.now().minusSeconds(86_400));
        meldungEinreihen(sub, alt);

        assertThat(zusteller.lauf(Instant.now().plusSeconds(2))).isZero();
        assertThat(greenMail.getReceivedMessages()).isEmpty();
        assertThat(adminJdbc.queryForMap("SELECT zustand, grund FROM benachrichtigung WHERE tenant_id = ? "
                + "AND quelle_id = ?", tenant, alt)).containsEntry("zustand", "unterdrueckt")
                .containsEntry("grund", "vor_dem_weg");
    }

    @Test
    void einEigenerWegBleibtSeinerUndKenntKeineGrenze() throws Exception {
        String sub = "sub-" + UUID.randomUUID();
        konto(sub, "benutzer", "aktiv", "konto@example.test");
        TenantContext.set(tenant);
        try {
            zustellwege.anlegenOderErneuern(sub, "eigen@example.test", "tok-" + sub, Instant.now().plusSeconds(3600));
            zustellwege.bestaetigen("tok-" + sub, Instant.now());
            // Die Konto-Adresse ändert sich: ein eigener Weg folgt ihr nicht.
            appJdbc.update("UPDATE benutzer SET email = 'neu@example.test' WHERE tenant_id = ? AND sub = ?", tenant,
                    sub);
            assertThat(zustellwege.eigener(sub)).get().satisfies(w -> {
                assertThat(w.ziel()).isEqualTo("eigen@example.test");
                assertThat(w.herkunft()).isEqualTo(ZustellwegRepository.HERKUNFT_EIGEN);
            });
        } finally {
            TenantContext.clear();
        }
        meldungEinreihen(sub, alarm(Instant.now().minusSeconds(86_400)));

        assertThat(zusteller.lauf(Instant.now().plusSeconds(2))).isEqualTo(1);
        assertThat(greenMail.getReceivedMessages()[0].getAllRecipients()[0].toString()).isEqualTo("eigen@example.test");
    }

    @Test
    void derWegFolgtDerKontoAdresseUndNurKundenkontenMitAdresseBekommenEinen() {
        String sub = "sub-" + UUID.randomUUID();
        konto(sub, "benutzer", "aktiv", "alt@example.test");
        TenantContext.set(tenant);
        try {
            appJdbc.update("UPDATE benutzer SET email = 'neu@example.test' WHERE tenant_id = ? AND sub = ?", tenant,
                    sub);
            assertThat(zustellwege.eigener(sub)).get().extracting(ZustellwegRepository.Zustellweg::ziel)
                    .isEqualTo("neu@example.test");
        } finally {
            TenantContext.clear();
        }

        String ohneAdresse = "sub-" + UUID.randomUUID();
        String partner = "sub-" + UUID.randomUUID();
        konto(ohneAdresse, "benutzer", "aktiv", null);
        konto(partner, "partner", "aktiv", "partner@example.test");
        assertThat(adminJdbc.queryForObject("SELECT count(*) FROM zustellweg WHERE tenant_id = ? "
                + "AND benutzer_sub IN (?, ?)", Integer.class, tenant, ohneAdresse, partner)).isZero();
    }

    /** {@code benutzer} ist nur über die Laufzeitrolle schreibbar (RLS) - genau wie jeder Anlageweg im Betrieb. */
    private static void konto(String sub, String konto, String zustand, String email) {
        TenantContext.set(tenant);
        try {
            appJdbc.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, email, zustand) "
                    + "VALUES (?, ?, ?, ?, ?, ?)", tenant, sub, konto, "Person " + sub.substring(4, 10), email, zustand);
        } finally {
            TenantContext.clear();
        }
    }

    private static UUID alarm(Instant ausgeloestAm) {
        UUID alarm = UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            appJdbc.update("INSERT INTO alarm (id, tenant_id, kennzeichen, ueberwachung_id, fassung, bezug_kennung, "
                    + "wertart, schwere, ausgeloest_am, zustand) VALUES (?, ?, ?, ?, 1, ?, 'box.erreichbar', "
                    + "'warnung', ?, 'aktiv')", alarm, tenant, "AL-T-" + alarm.toString().substring(0, 8), regel,
                    "anlage:" + alarm, Timestamp.from(ausgeloestAm));
        } finally {
            TenantContext.clear();
        }
        return alarm;
    }

    private static void meldungEinreihen(String sub, UUID alarm) {
        TenantContext.set(tenant);
        try {
            ausgang.email("alarm", alarm, sub, "ausgeloest", 0, "Hof Lindenberg: Box meldet sich nicht",
                    "Inhalt der Meldung\n", Instant.now(), "warnung", null);
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
