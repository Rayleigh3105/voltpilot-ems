package com.voltpilot.api.versand.webhook;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.EmailVersandAdapter;
import com.voltpilot.api.versand.VersandRepository;
import com.voltpilot.api.versand.Zusteller;
import com.voltpilot.api.versand.ZustellwegRepository;
import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
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
 * Alerting Scheibe 6 (§7 Scheibe 6): ein echter {@link Zusteller}-Takt gegen echte
 * {@code webhook_ziel}-Zeilen und einen lokalen HTTP-Fänger statt eines echten Teams-/Slack-
 * Webhooks - in diesem Paket, DAMIT der package-sichtbare {@code ZielValidator}-Konstruktor
 * erreichbar ist (die echte SSRF-Prüfung würde einen Loopback-Fänger sonst zu Recht sperren; sie
 * selbst ist in {@link WebhookZielPruefungTest} unabhängig unit-getestet).
 */
@Testcontainers(disabledWithoutDocker = true)
class WebhookZustellungIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "webhook_it_pw";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot").withUsername("voltpilot").withPassword("voltpilot_dev_pw");

    private static JdbcTemplate app;
    private static JdbcTemplate adminJdbc;
    private static VersandRepository ausgang;
    private static ZustellwegRepository zustellwege;

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
        ausgang = new VersandRepository(app, adminJdbc);
        zustellwege = new ZustellwegRepository(app, adminJdbc);
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    private static UUID tenant(String name) {
        UUID tenant = UUID.randomUUID();
        adminJdbc.update("INSERT INTO tenant (id, name) VALUES (?, ?)", tenant, name);
        return tenant;
    }

    @Test
    void zustellerSigniertUndSendetGegenEinenLokalenFaengerUndRaeumtEinDauerhaftTotesZielAuf() throws Exception {
        AtomicReference<String> koerperAus = new AtomicReference<>();
        AtomicReference<String> signaturAus = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/gueltig", ex -> {
            koerperAus.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            signaturAus.set(ex.getRequestHeaders().getFirst("X-VoltPilot-Signature"));
            ex.getResponseHeaders().add("Content-Length", "0");
            ex.sendResponseHeaders(204, -1);
            ex.close();
        });
        server.createContext("/tot", ex -> {
            ex.getResponseHeaders().add("Content-Length", "0");
            ex.sendResponseHeaders(410, -1);
            ex.close();
        });
        server.start();
        try {
            UUID t = tenant("Webhook-Lokal");
            String basis = "http://localhost:" + server.getAddress().getPort();
            UUID alarmId = UUID.randomUUID();
            TenantContext.set(t);
            try {
                app.update("INSERT INTO webhook_ziel (tenant_id, benutzer_sub, url, geheimnis, name) "
                        + "VALUES (?, 'sub-jonas', ?, 'mein-geheimnis', 'Teams-Kanal')", t, basis + "/gueltig");
                app.update("INSERT INTO webhook_ziel (tenant_id, benutzer_sub, url, geheimnis, name) "
                        + "VALUES (?, 'sub-jonas', ?, 'anderes-geheimnis', 'Alter Slack-Kanal')", t, basis + "/tot");
                ausgang.webhook("alarm", alarmId, "sub-jonas", "ausgeloest", "Warnung: Netzbezug",
                        "über 120 kW", "warnung");
            } finally {
                TenantContext.clear();
            }

            EmailVersandAdapter email = new EmailVersandAdapter(
                    new org.springframework.mail.javamail.JavaMailSenderImpl(), "meldungen@voltpilot.de");
            WebPushAdapter push = new WebPushAdapter(platzhalter(65), platzhalterPrivatschluessel(),
                    "mailto:test@voltpilot.de");
            WebhookVersandAdapter webhook = new WebhookVersandAdapter(url -> java.net.URI.create(url));
            TelegramAdapter telegram = (chatId, text) -> { };
            Zusteller zusteller = new Zusteller(ausgang, zustellwege, email, push, webhook, telegram, app);
            int gesendet = zusteller.lauf(Instant.now());

            assertThat(gesendet).isEqualTo(1);
            assertThat(koerperAus.get()).contains("Warnung: Netzbezug").contains("über 120 kW");
            assertThat(signaturAus.get()).isEqualTo("sha256=" + hmac("mein-geheimnis", koerperAus.get()));

            TenantContext.set(t);
            try {
                var ziele = zustellwege.webhookZieleEigene("sub-jonas");
                assertThat(ziele).hasSize(2)
                        .anySatisfy(z -> assertThat(z.aktiv()).isTrue())
                        .anySatisfy(z -> assertThat(z.aktiv()).isFalse());
            } finally {
                TenantContext.clear();
            }
        } finally {
            server.stop(0);
        }
    }

    private static String hmac(String geheimnis, String koerper) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(geheimnis.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] rohe = mac.doFinal(koerper.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(rohe.length * 2);
            for (byte b : rohe) {
                hex.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String platzhalter(int laenge) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[laenge]);
    }

    private static String platzhalterPrivatschluessel() {
        byte[] skalarEins = new byte[32];
        skalarEins[31] = 1;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(skalarEins);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
