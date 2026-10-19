package com.voltpilot.api.versand;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.versand.telegram.TelegramAdapter;
import com.voltpilot.api.versand.webhook.WebhookVersandAdapter;
import com.voltpilot.api.versand.webpush.WebPushAdapter;
import java.net.InetSocketAddress;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
 * Alerting Scheibe 3 (§6.7, §7 "Push-Versand gegen einen lokalen Test-Endpunkt - kein echter
 * Browser-Push-Dienst im Test"): Web-Push-Abo-Verwaltung ("Abo je Gerät"), die Zustell-Vorgabe je
 * Stufe (§6.4) und ein echter {@link Zusteller}-Takt gegen einen lokalen {@link HttpServer} statt
 * eines echten Push-Diensts.
 */
@Testcontainers(disabledWithoutDocker = true)
class PushUndStufenRoutingIT {

    private static final String APP = "voltpilot_app";
    private static final String ADMIN = "voltpilot_admin";
    private static final String PW = "push_it_pw";

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

    // =========================================================== Abo je Gerät (§7 Punkt 1)

    @Test
    void mehrereAbosJeGeraetMitEigenerVorgabeUndRlsZaun() {
        UUID t1 = tenant("Push A");
        UUID t2 = tenant("Push B");
        TenantContext.set(t1);
        try {
            app.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet, ab_schwere) "
                    + "VALUES (?, 'sub-ines', 'https://push.example/1', 'p1', 'a1', 'iPhone von Ines', 'warnung')",
                    t1);
            app.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet, ab_schwere) "
                    + "VALUES (?, 'sub-ines', 'https://push.example/2', 'p2', 'a2', 'Laptop von Ines', 'dringend')",
                    t1);
        } finally {
            TenantContext.clear();
        }
        TenantContext.set(t2);
        try {
            app.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet) "
                    + "VALUES (?, 'sub-ines', 'https://push.example/3', 'p3', 'a3', 'Anderer Mandant')", t2);
        } finally {
            TenantContext.clear();
        }

        // Nur das Gerät mit ab_schwere <= 'warnung' gilt für eine Warnung; beide gelten für Dringend.
        List<WebPushAdapter.Abo> fuerWarnung = zustellwege.pushAbosFuerVersand(t1, "sub-ines", "warnung");
        assertThat(fuerWarnung).extracting(WebPushAdapter.Abo::endpoint)
                .containsExactly("https://push.example/1");
        List<WebPushAdapter.Abo> fuerDringend = zustellwege.pushAbosFuerVersand(t1, "sub-ines", "dringend");
        assertThat(fuerDringend).extracting(WebPushAdapter.Abo::endpoint)
                .containsExactlyInAnyOrder("https://push.example/1", "https://push.example/2");
        // Der RLS-Zaun: der Mandant t2 taucht in keiner der beiden Listen auf (bereits durch tenant_id=t1 erzwungen).
        assertThat(zustellwege.pushAbosFuerVersand(t2, "sub-ines", "dringend"))
                .extracting(WebPushAdapter.Abo::endpoint).containsExactly("https://push.example/3");
    }

    @Test
    void pushJeGeraetAnAusUndEntfernen() {
        UUID t = tenant("Push je Geraet");
        TenantContext.set(t);
        try {
            UUID id = zustellwege.pushAboAnlegen("sub-jonas", "https://push.example/x", "p", "a", "Handy", "UA");
            assertThat(zustellwege.hatAktivesPushAbo(t, "sub-jonas", "warnung")).isTrue();

            boolean geaendert = zustellwege.pushAboEinstellungenSetzen(id, "sub-jonas", false, "warnung");
            assertThat(geaendert).isTrue();
            assertThat(zustellwege.hatAktivesPushAbo(t, "sub-jonas", "warnung")).isFalse();

            zustellwege.pushAboEinstellungenSetzen(id, "sub-jonas", true, "warnung");
            assertThat(zustellwege.pushAboEntfernen(id, "sub-jonas")).isTrue();
            assertThat(zustellwege.pushAboEigene("sub-jonas")).isEmpty();
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== B8: geteiltes Gerät (Entscheid 9A)

    @Test
    void einNeuesAboAmSelbenEndpunktGehtAufDieAngemeldetePersonUeber() {
        // B8: der Endpunkt gehört dem GERÄT (Browser), nicht der Person. Meldet sich am selben Gerät
        // eine ANDERE Person an und abonniert erneut, muss die Zeile auf sie übergehen - sonst bleibt
        // sie der ERSTEN Person zugeordnet und die zweite findet ihr eigenes Abo nie (vormals 500 am
        // Controller, weil `pushAboEigene` die fremd gebliebene Zeile nicht fand).
        UUID t = tenant("Geteiltes Geraet");
        TenantContext.set(t);
        try {
            String geteilterEndpunkt = "https://push.example/leitstand-rechner";
            zustellwege.pushAboAnlegen("sub-erste-person", geteilterEndpunkt, "p1", "a1", "Leitstand", "UA");

            UUID uebernommen = zustellwege.pushAboAnlegen("sub-zweite-person", geteilterEndpunkt, "p2", "a2",
                    "Leitstand", "UA");

            assertThat(zustellwege.pushAboEigene("sub-erste-person")).isEmpty();
            assertThat(zustellwege.pushAboEigene("sub-zweite-person")).extracting(
                    ZustellwegRepository.PushAbo::id).containsExactly(uebernommen);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void pushAboEntfernenNachEndpunktBeendetNurDasEigeneAboBeimAbmelden() {
        UUID t = tenant("Abmelden beendet Push");
        TenantContext.set(t);
        try {
            String endpunkt = "https://push.example/geraet-beim-abmelden";
            zustellwege.pushAboAnlegen("sub-rundgang", endpunkt, "p", "a", "Handy", "UA");

            boolean beendet = zustellwege.pushAboEntfernenNachEndpoint("sub-rundgang", endpunkt);

            assertThat(beendet).isTrue();
            assertThat(zustellwege.pushAboEigene("sub-rundgang")).isEmpty();
            // bestmöglich: ein Abmelden ohne (oder mit schon entferntem) Push-Abo ist kein Fehler.
            assertThat(zustellwege.pushAboEntfernenNachEndpoint("sub-rundgang", endpunkt)).isFalse();
        } finally {
            TenantContext.clear();
        }
    }

    // =========================================================== Zustell-Vorgabe je Stufe (§6.4)

    @Test
    void hatAktivenEmailWegPrueftAbSchwereBestaetigungUndAktiv() {
        UUID t = tenant("Email Stufen");
        TenantContext.set(t);
        try {
            app.update("INSERT INTO zustellweg (tenant_id, benutzer_sub, weg, ziel, bestaetigt_am, ab_schwere) "
                    + "VALUES (?, 'sub-dora', 'email', 'dora@example.test', now(), 'dringend')", t);
        } finally {
            TenantContext.clear();
        }
        assertThat(zustellwege.hatAktivenEmailWeg(t, "sub-dora", "warnung")).isFalse(); // ab_schwere ist hoeher
        assertThat(zustellwege.hatAktivenEmailWeg(t, "sub-dora", "dringend")).isTrue();
        assertThat(zustellwege.hatAktivenEmailWeg(t, "sub-unbekannt", "dringend")).isFalse();
    }

    // =========================================================== Zusteller gegen einen lokalen Test-Endpunkt

    @Test
    void zustellerSendetPushGegenEinenLokalenTestEndpunktUndRaeumtEinAbgelaufenesAboAuf() throws Exception {
        AtomicInteger treffer = new AtomicInteger(0);
        HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/gueltig", ex -> {
            treffer.incrementAndGet();
            ex.getResponseHeaders().add("Content-Length", "0");
            ex.sendResponseHeaders(201, -1);
            ex.close();
        });
        server.createContext("/veraltet", ex -> {
            ex.getResponseHeaders().add("Content-Length", "0");
            ex.sendResponseHeaders(410, -1);
            ex.close();
        });
        server.start();
        try {
            UUID t = tenant("Lokaler Push-Endpunkt");
            String basis = "http://localhost:" + server.getAddress().getPort();
            TenantContext.set(t);
            try {
                app.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet) "
                        + "VALUES (?, 'sub-jonas', ?, ?, ?, 'Handy')", t, basis + "/gueltig",
                        gueltigerP256dh(), gueltigerAuth());
                app.update("INSERT INTO push_abo (tenant_id, benutzer_sub, endpoint, p256dh, auth, geraet) "
                        + "VALUES (?, 'sub-jonas', ?, ?, ?, 'Altes Handy')", t, basis + "/veraltet",
                        gueltigerP256dh(), gueltigerAuth());
                UUID alarmId = UUID.randomUUID();
                ausgang.webpush("alarm", alarmId, "sub-jonas", "ausgeloest", "Warnung: Netzbezug",
                        "über 120 kW", "warnung");
            } finally {
                TenantContext.clear();
            }

            WebPushAdapter push = new WebPushAdapter(platzhalter(65), platzhalterPrivatschluessel(),
                    "mailto:test@voltpilot.de");
            EmailVersandAdapter email = new EmailVersandAdapter(
                    new org.springframework.mail.javamail.JavaMailSenderImpl(), "meldungen@voltpilot.de");
            WebhookVersandAdapter webhook = new WebhookVersandAdapter();
            TelegramAdapter telegram = (chatId, text) -> { };
            Zusteller zusteller = new Zusteller(ausgang, zustellwege, email, push, webhook, telegram, app);
            int gesendet = zusteller.lauf(Instant.now());

            assertThat(gesendet).isEqualTo(1);
            assertThat(treffer.get()).isEqualTo(1);
            TenantContext.set(t);
            try {
                assertThat(zustellwege.pushAboEigene("sub-jonas")).hasSize(2)
                        .anySatisfy(a -> assertThat(a.aktiv()).isTrue())
                        .anySatisfy(a -> assertThat(a.aktiv()).isFalse());
            } finally {
                TenantContext.clear();
            }
        } finally {
            server.stop(0);
        }
    }

    /**
     * EIN ECHTER Punkt auf secp256r1 (65 Bytes, 0x04-Präfix) - {@code WebPushEncryption} verschlüsselt
     * wirklich (RFC 8291), ein beliebiger Byte-Wert wäre kein gültiger Kurvenpunkt.
     */
    private static String gueltigerP256dh() throws Exception {
        var kpg = java.security.KeyPairGenerator.getInstance("EC");
        kpg.initialize(new java.security.spec.ECGenParameterSpec("secp256r1"));
        var pub = (java.security.interfaces.ECPublicKey) kpg.generateKeyPair().getPublic();
        byte[] x = aufFesteLaenge(pub.getW().getAffineX());
        byte[] y = aufFesteLaenge(pub.getW().getAffineY());
        byte[] punkt = new byte[65];
        punkt[0] = 0x04;
        System.arraycopy(x, 0, punkt, 1, 32);
        System.arraycopy(y, 0, punkt, 33, 32);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(punkt);
    }

    private static byte[] aufFesteLaenge(java.math.BigInteger zahl) {
        byte[] roh = zahl.toByteArray();
        byte[] ergebnis = new byte[32];
        int quelle = Math.max(0, roh.length - 32);
        int ziel = Math.max(0, 32 - roh.length);
        System.arraycopy(roh, quelle, ergebnis, ziel, roh.length - quelle);
        return ergebnis;
    }

    private static String gueltigerAuth() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[16]);
    }

    private static String platzhalter(int laenge) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[laenge]);
    }

    /** BouncyCastle verlangt einen Skalar in [1, n-1] - lauter Nullen wären ungültig. */
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
