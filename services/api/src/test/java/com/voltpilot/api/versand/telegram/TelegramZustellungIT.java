package com.voltpilot.api.versand.telegram;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.EmailVersandAdapter;
import com.voltpilot.api.versand.VersandRepository;
import com.voltpilot.api.versand.Zusteller;
import com.voltpilot.api.versand.ZustellwegRepository;
import com.voltpilot.api.versand.webhook.WebhookVersandAdapter;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
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
 * {@code telegram_ziel}-Zeilen und einen lokalen HTTP-Fänger statt der echten Telegram-API
 * (Hausregel: "Tests gegen einen Stub-Adapter, nie gegen die echte Telegram-API") - in diesem
 * Paket, damit der package-sichtbare {@code apiBasis}-Konstruktor von {@link TelegramBotAdapter}
 * erreichbar ist.
 */
@Testcontainers(disabledWithoutDocker = true)
class TelegramZustellungIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "telegram_it_pw";

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
    void zustellerSendetAnAlleBestaetigtenChatsUndRaeumtEineBlockierteVerbindungAuf() throws Exception {
        AtomicReference<String> koerperAus = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/bottest-token/sendMessage", ex -> {
            String chatId = chatIdAus(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if ("111".equals(chatId)) {
                koerperAus.set("gesendet");
                antworte(ex, 200, "{\"ok\":true}");
            } else {
                antworte(ex, 403, "{\"ok\":false,\"error_code\":403,\"description\":\"Forbidden: bot was blocked by the user\"}");
            }
        });
        server.start();
        try {
            UUID t = tenant("Telegram-Lokal");
            String apiBasis = "http://localhost:" + server.getAddress().getPort();
            UUID alarmId = UUID.randomUUID();
            TenantContext.set(t);
            try {
                app.update("INSERT INTO telegram_ziel (tenant_id, benutzer_sub, chat_id, bestaetigt_am) "
                        + "VALUES (?, 'sub-jonas', '111', now())", t);
                app.update("INSERT INTO telegram_ziel (tenant_id, benutzer_sub, chat_id, bestaetigt_am) "
                        + "VALUES (?, 'sub-jonas', '222', now())", t);
                ausgang.telegram("alarm", alarmId, "sub-jonas", "ausgeloest", "Warnung: Netzbezug",
                        "über 120 kW", "warnung");
            } finally {
                TenantContext.clear();
            }

            EmailVersandAdapter email = new EmailVersandAdapter(
                    new org.springframework.mail.javamail.JavaMailSenderImpl(), "meldungen@voltpilot.de");
            WebPushAdapter push = new WebPushAdapter(platzhalter(65), platzhalterPrivatschluessel(),
                    "mailto:test@voltpilot.de");
            WebhookVersandAdapter webhook = new WebhookVersandAdapter();
            TelegramAdapter telegram = new TelegramBotAdapter("test-token", apiBasis);
            Zusteller zusteller = new Zusteller(ausgang, zustellwege, email, push, webhook, telegram, app);
            int gesendet = zusteller.lauf(Instant.now());

            assertThat(gesendet).isEqualTo(1);
            assertThat(koerperAus.get()).isEqualTo("gesendet");

            TenantContext.set(t);
            try {
                var ziele = zustellwege.telegramZieleEigene("sub-jonas");
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

    private static void antworte(com.sun.net.httpserver.HttpExchange ex, int status, String koerper)
            throws java.io.IOException {
        byte[] body = koerper.getBytes(StandardCharsets.UTF_8);
        ex.sendResponseHeaders(status, body.length);
        ex.getResponseBody().write(body);
        ex.close();
    }

    private static String chatIdAus(String koerper) {
        var m = java.util.regex.Pattern.compile("\"chat_id\":\"(\\d+)\"").matcher(koerper);
        return m.find() ? m.group(1) : "";
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
