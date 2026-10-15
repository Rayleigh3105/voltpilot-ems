package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;

import com.icegreen.greenmail.util.GreenMail;
import com.icegreen.greenmail.util.ServerSetupTest;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
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
 * Alerting Scheibe 0: der Versand gegen einen echten (lokalen) SMTP-Fänger - GreenMail statt eines
 * Mocks, weil genau die Serialisierung der E-Mail (Absender, Empfänger, Betreff, Text) die Eigenschaft
 * ist, die ein Mock nicht prüfen kann. Testcontainers (Postgres), Docker nötig; GreenMail selbst
 * braucht kein Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
class ZustellungGreenMailIT {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String ABSENDER = "meldungen@voltpilot.de";

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
    private static Zusteller zusteller;
    private static GreenMail greenMail;
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
        appJdbc = new JdbcTemplate(new TenantAwareDataSource(ds(APP_USER, APP_PW)));
        adminJdbc = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        ausgang = new VersandRepository(appJdbc, adminJdbc);
        zustellwege = new ZustellwegRepository(appJdbc, adminJdbc);

        greenMail = new GreenMail(ServerSetupTest.SMTP);
        greenMail.start();

        JavaMailSenderImpl mailSender = new JavaMailSenderImpl();
        mailSender.setHost("localhost");
        mailSender.setPort(ServerSetupTest.SMTP.getPort());
        EmailVersandAdapter adapter = new EmailVersandAdapter(mailSender, ABSENDER);
        // Diese Probe prüft nur den E-Mail-Weg - der Push-Adapter bekommt nie etwas zu tun, seine
        // Schlüssel müssen darum nicht gültig sein, nur syntaktisch dekodierbar.
        // BouncyCastle verlangt fuer den privaten Schluessel einen Skalar in [1, n-1] - lauter
        // Nullen waeren ungueltig; diese Probe prueft ohnehin nur den E-Mail-Weg.
        byte[] privatPlatzhalter = new byte[32];
        privatPlatzhalter[31] = 1;
        WebPushAdapter push = new WebPushAdapter(Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[65]),
                Base64.getUrlEncoder().withoutPadding().encodeToString(privatPlatzhalter), "mailto:test@voltpilot.de");
        zusteller = new Zusteller(ausgang, zustellwege, adapter, push, appJdbc);

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('GreenMail-Test') RETURNING id", UUID.class);
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
    void bestaetigungsMailGehtDirektAnDasNochUnbestaetigteZiel() throws Exception {
        TenantContext.set(tenant);
        UUID zustellwegId = zustellwege.anlegenOderErneuern("sub-jonas", "jonas@example.test",
                "token-1", Instant.now().plusSeconds(3600));
        ausgang.emailMitZiel("zustellweg_bestaetigung", zustellwegId, "sub-jonas", "bestaetigung",
                "VoltPilot: Adresse bestätigen", "Bitte bestätigen Sie …", "jonas@example.test");
        TenantContext.clear();

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(1);
        var nachrichten = greenMail.getReceivedMessages();
        assertThat(nachrichten).hasSize(1);
        assertThat(nachrichten[0].getAllRecipients()[0].toString()).isEqualTo("jonas@example.test");
        assertThat(nachrichten[0].getFrom()[0].toString()).isEqualTo(ABSENDER);
        assertThat(nachrichten[0].getSubject()).isEqualTo("VoltPilot: Adresse bestätigen");
    }

    @Test
    void normaleMeldungGehtAnDenBestaetigtenZustellweg() throws Exception {
        TenantContext.set(tenant);
        String token = "token-2";
        zustellwege.anlegenOderErneuern("sub-ines", "ines@example.test", token, Instant.now().plusSeconds(3600));
        zustellwege.bestaetigen(token, Instant.now());
        ausgang.email("unterstuetzung_hinweis", UUID.randomUUID(), "sub-ines", "gewaehrt", "VoltPilot-Hinweis",
                "Installateur hat Zugriff auf Werk Ahrenberg.");
        TenantContext.clear();

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(1);
        var nachrichten = greenMail.getReceivedMessages();
        assertThat(nachrichten).hasSize(1);
        assertThat(nachrichten[0].getAllRecipients()[0].toString()).isEqualTo("ines@example.test");
        assertThat((String) nachrichten[0].getContent()).contains("Installateur hat Zugriff");
    }

    @Test
    void ohneBestaetigtenZustellwegWirdUnterdruecktUndNichtsVersandt() {
        TenantContext.set(tenant);
        ausgang.email("unterstuetzung_hinweis", UUID.randomUUID(), "sub-ohne-weg", "notfall", "Betreff", "Inhalt");
        TenantContext.clear();

        int gesendet = zusteller.lauf(Instant.now());

        assertThat(gesendet).isEqualTo(0);
        assertThat(greenMail.getReceivedMessages()).isEmpty();
        String zustand = adminJdbc.queryForObject(
                "SELECT zustand FROM benachrichtigung WHERE tenant_id = ? AND empfaenger_sub = 'sub-ohne-weg'",
                String.class, tenant);
        assertThat(zustand).isEqualTo("unterdrueckt");
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
