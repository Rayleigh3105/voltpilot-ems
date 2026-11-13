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
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.List;
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
 * Kunden-Alarmierung P4 · Beruhigung (Konzept §6.5): dieselbe Meldungsart an derselben Anlage meldet höchstens einmal
 * in sechs Stunden - gegen eine echte Datenbank (die Abfrage verbindet Ausgang und Meldungen über die Admin-Rolle) und
 * einen echten SMTP-Fänger, weil genau „kam eine Mail an oder nicht“ die Eigenschaft ist.
 *
 * <p>Geprüft: eine zweite Meldung derselben Regel am selben Bezug wartet bis sechs Stunden nach der ersten; ist sie
 * bis dahin erledigt, entfällt sie samt Entwarnung, gilt sie noch, kommt sie dann; eine andere Regel, ein anderer
 * Bezug oder eine andere Person kennen die Bremse nicht; nur was angekommen ist, zählt; der Zustellstand liest genau
 * diese Zeilen. Docker nötig.
 */
@Testcontainers(disabledWithoutDocker = true)
class BeruhigungIT {

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
    private static JdbcTemplate appJdbc;
    private static JdbcTemplate adminJdbc;
    private static VersandRepository ausgang;
    private static ZustellwegRepository zustellwege;
    private static Zusteller zusteller;
    private static GreenMail greenMail;
    private static UUID tenant;
    private static UUID regelBox;
    private static UUID regelDatenquelle;

    /** Ein fester Anfang, auf die Sekunde, damit die Sechs-Stunden-Grenze genau prüfbar ist. */
    private Instant t0;

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
        TelegramAdapter telegram = (chatId, text) -> { };
        zusteller = new Zusteller(ausgang, zustellwege, email, push, new WebhookVersandAdapter(), telegram, appJdbc);

        tenant = root.queryForObject("INSERT INTO tenant (name) VALUES ('Hof Lindenberg') RETURNING id", UUID.class);
        regelBox = regel("box.erreichbar");
        regelDatenquelle = regel("datenquelle.liefert_daten");
    }

    @AfterAll
    static void beenden() {
        greenMail.stop();
    }

    @BeforeEach
    void leeren() throws Exception {
        greenMail.purgeEmailFromAllMailboxes();
        t0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);
    }

    @AfterEach
    void aufraeumen() {
        TenantContext.clear();
        adminJdbc.update("DELETE FROM benachrichtigung WHERE tenant_id = ?", tenant);
        adminJdbc.update("DELETE FROM zustellweg WHERE tenant_id = ?", tenant);
    }

    @Test
    void eineZweiteMeldungDerselbenArtWartetUndEntfaelltSamtEntwarnungWennSieVorbeiIst() {
        String sub = person("eva@example.test");
        String bezug = "anlage:" + UUID.randomUUID();

        UUID erste = alarm(regelBox, bezug, t0);
        einreihen(sub, erste, "ausgeloest", t0);
        assertThat(zusteller.lauf(t0.plusSeconds(1))).isEqualTo(1);
        erledigen(erste); // die Box meldet sich kurz wieder (je Regel und Bezug ist höchstens eine Meldung offen)

        // 40 Minuten später fällt die Box wieder aus: über diesen Weg ging die Art eben erst hinaus.
        Instant spaeter = t0.plus(Duration.ofMinutes(40));
        UUID zweite = alarm(regelBox, bezug, spaeter);
        einreihen(sub, zweite, "ausgeloest", spaeter);
        assertThat(zusteller.lauf(spaeter.plusSeconds(1))).isZero();
        assertThat(zeile(zweite, "ausgeloest")).containsEntry("zustand", "wartet").containsEntry("grund", "beruhigt");
        assertThat(((Timestamp) zeile(zweite, "ausgeloest").get("naechster_versuch")).toInstant())
                .as("sechs Stunden nach der ersten, nicht nach der zweiten").isEqualTo(t0.plusSeconds(1)
                        .plus(Zusteller.BERUHIGUNG));

        // Sie ist vorbei, bevor die sechs Stunden um sind: die Entwarnung spräche von etwas, das nie ankam.
        erledigen(zweite);
        einreihen(sub, zweite, "wieder_normal", spaeter.plus(Duration.ofMinutes(10)));
        assertThat(zusteller.lauf(spaeter.plus(Duration.ofMinutes(10)).plusSeconds(1))).isZero();
        assertThat(zeile(zweite, "wieder_normal")).containsEntry("zustand", "unterdrueckt")
                .containsEntry("grund", "beruhigt");

        // Nach sechs Stunden ist die zurückgehaltene Auslösung fällig - und entfällt, weil die Meldung erledigt ist.
        assertThat(zusteller.lauf(t0.plus(Zusteller.BERUHIGUNG).plusSeconds(5))).isZero();
        assertThat(zeile(zweite, "ausgeloest")).containsEntry("zustand", "unterdrueckt")
                .containsEntry("grund", "beruhigt");
        assertThat(greenMail.getReceivedMessages()).as("nur die erste Meldung kam an").hasSize(1);

        // Liste und Zusammenfassung sehen, was dazwischen passierte.
        TenantContext.set(tenant);
        try {
            assertThat(ausgang.beruhigteSeit(sub, t0.minusSeconds(60))).containsExactly(zweite);
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void giltDieMeldungNachSechsStundenNochKommtSieDann() {
        String sub = person("ole@example.test");
        String bezug = "anlage:" + UUID.randomUUID();

        UUID erste = alarm(regelBox, bezug, t0);
        einreihen(sub, erste, "ausgeloest", t0);
        zusteller.lauf(t0.plusSeconds(1));
        erledigen(erste);
        UUID zweite = alarm(regelBox, bezug, t0.plus(Duration.ofMinutes(20)));
        einreihen(sub, zweite, "ausgeloest", t0.plus(Duration.ofMinutes(20)));
        assertThat(zusteller.lauf(t0.plus(Duration.ofMinutes(20)).plusSeconds(1))).isZero();

        // Kurz vor der Grenze bleibt sie liegen, danach kommt sie - die Box ist ja immer noch weg.
        assertThat(zusteller.lauf(t0.plus(Zusteller.BERUHIGUNG).minusSeconds(5))).isZero();
        assertThat(zusteller.lauf(t0.plus(Zusteller.BERUHIGUNG).plusSeconds(5))).isEqualTo(1);
        assertThat(zeile(zweite, "ausgeloest")).containsEntry("zustand", "gesendet");
        assertThat(greenMail.getReceivedMessages()).hasSize(2);
    }

    @Test
    void andereRegelAndererBezugUndAnderePersonKennenDieBremseNicht() {
        String sub = person("ida@example.test");
        String nachbar = person("max@example.test");
        String bezug = "anlage:" + UUID.randomUUID();

        UUID erste = alarm(regelBox, bezug, t0);
        einreihen(sub, erste, "ausgeloest", t0);
        zusteller.lauf(t0.plusSeconds(1));
        erledigen(erste);

        Instant kurz = t0.plus(Duration.ofMinutes(5));
        UUID andereArt = alarm(regelDatenquelle, bezug, kurz);
        UUID andererBezug = alarm(regelBox, "anlage:" + UUID.randomUUID(), kurz);
        UUID gleicheArt = alarm(regelBox, bezug, kurz);
        einreihen(sub, andereArt, "ausgeloest", kurz);
        einreihen(sub, andererBezug, "ausgeloest", kurz);
        einreihen(nachbar, gleicheArt, "ausgeloest", kurz);

        assertThat(zusteller.lauf(kurz.plusSeconds(1))).isEqualTo(3);
        assertThat(greenMail.getReceivedMessages()).hasSize(4);
    }

    @Test
    void nurWasAngekommenIstZaehlt() {
        String sub = person("lea@example.test");
        String bezug = "anlage:" + UUID.randomUUID();

        // Die erste Meldung ging nie hinaus (kein Weg zu dem Zeitpunkt) - die zweite ist darum nicht beruhigt.
        UUID erste = alarm(regelBox, bezug, t0);
        einreihen(sub, erste, "ausgeloest", t0);
        root.update("UPDATE benachrichtigung SET zustand = 'unterdrueckt', grund = 'kein_weg' "
                + "WHERE quelle_id = ?", erste);
        erledigen(erste);
        UUID zweite = alarm(regelBox, bezug, t0.plus(Duration.ofMinutes(5)));
        einreihen(sub, zweite, "ausgeloest", t0.plus(Duration.ofMinutes(5)));

        assertThat(zusteller.lauf(t0.plus(Duration.ofMinutes(5)).plusSeconds(1))).isEqualTo(1);
        assertThat(zeile(zweite, "ausgeloest")).containsEntry("zustand", "gesendet");
    }

    @Test
    void derZustellstandLiestDieZeilenDerPersonUndNurIhre() {
        String sub = person("tom@example.test");
        String andere = person("uta@example.test");
        String bezug = "anlage:" + UUID.randomUUID();
        UUID erste = alarm(regelBox, bezug, t0);
        einreihen(sub, erste, "ausgeloest", t0);
        einreihen(andere, erste, "ausgeloest", t0);
        zusteller.lauf(t0.plusSeconds(1));
        erledigen(erste);
        UUID zweite = alarm(regelBox, bezug, t0.plus(Duration.ofMinutes(5)));
        einreihen(sub, zweite, "ausgeloest", t0.plus(Duration.ofMinutes(5)));
        zusteller.lauf(t0.plus(Duration.ofMinutes(5)).plusSeconds(1));

        TenantContext.set(tenant);
        List<VersandRepository.Zustellung> stand;
        try {
            stand = ausgang.zustellungen(sub, List.of(erste, zweite));
        } finally {
            TenantContext.clear();
        }
        assertThat(stand).hasSize(2).allSatisfy(z -> assertThat(z.weg()).isEqualTo("email"));
        assertThat(stand.get(0)).satisfies(z -> {
            assertThat(z.alarmId()).isEqualTo(erste);
            assertThat(z.zustand()).isEqualTo("gesendet");
            assertThat(z.am()).isEqualTo(t0.plusSeconds(1));
        });
        assertThat(stand.get(1)).satisfies(z -> {
            assertThat(z.alarmId()).isEqualTo(zweite);
            assertThat(z.zustand()).isEqualTo("wartet");
            assertThat(z.grund()).isEqualTo("beruhigt");
            assertThat(z.am()).isEqualTo(t0.plusSeconds(1).plus(Zusteller.BERUHIGUNG));
        });

        // Ein anderer Kundenbereich sieht über die Laufzeitrolle nichts davon.
        UUID fremd = root.queryForObject("INSERT INTO tenant (name) VALUES ('Fremd') RETURNING id", UUID.class);
        TenantContext.set(fremd);
        try {
            assertThat(ausgang.zustellungen(sub, List.of(erste, zweite))).isEmpty();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void einAusgefallenerEmailWegZeigtSichBisWiederEineDurchgeht() {
        String sub = person("kai@example.test");
        UUID erste = alarm(regelBox, "anlage:" + UUID.randomUUID(), t0);
        einreihen(sub, erste, "ausgeloest", t0);
        root.update("UPDATE benachrichtigung SET zustand = 'fehlgeschlagen', versuche = 3, "
                + "fehler = '550 mailbox unavailable' WHERE quelle_id = ?", erste);

        TenantContext.set(tenant);
        try {
            assertThat(ausgang.emailAusfall(sub)).get().satisfies(a ->
                    assertThat(a.fehler()).isEqualTo("550 mailbox unavailable"));
        } finally {
            TenantContext.clear();
        }

        UUID zweite = alarm(regelDatenquelle, "anlage:" + UUID.randomUUID(), t0.plusSeconds(30));
        einreihen(sub, zweite, "ausgeloest", t0.plusSeconds(30));
        assertThat(zusteller.lauf(t0.plusSeconds(31))).isEqualTo(1);
        TenantContext.set(tenant);
        try {
            assertThat(ausgang.emailAusfall(sub)).as("geheilt").isEmpty();
        } finally {
            TenantContext.clear();
        }
    }

    // ------------------------------------------------------------------ Welt

    private static UUID regel(String wertart) {
        UUID regel = UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            appJdbc.update("INSERT INTO ueberwachung (id, tenant_id, wertart, bezug, bedingung, schwere, empfaenger, "
                    + "herkunft, angelegt_von) VALUES (?, ?, ?, '{}'::jsonb, '{\"art\":\"zustand\"}'::jsonb, "
                    + "'warnung', '[]'::jsonb, 'ab_werk', 'system')", regel, tenant, wertart);
        } finally {
            TenantContext.clear();
        }
        return regel;
    }

    /** Eine Person mit eigenem, bestätigtem E-Mail-Weg (kein Weg „Anmeldung“, also keine Stichtag-Grenze). */
    private static String person(String adresse) {
        String sub = "sub-" + UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            appJdbc.update("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) "
                    + "VALUES (?, ?, 'benutzer', ?, 'aktiv')", tenant, sub, "Person " + sub.substring(4, 10));
            zustellwege.anlegenOderErneuern(sub, adresse, "tok-" + sub, Instant.now().plusSeconds(3600));
            zustellwege.bestaetigen("tok-" + sub, Instant.now());
        } finally {
            TenantContext.clear();
        }
        return sub;
    }

    private static UUID alarm(UUID regel, String bezug, Instant ausgeloestAm) {
        UUID alarm = UUID.randomUUID();
        TenantContext.set(tenant);
        try {
            appJdbc.update("INSERT INTO alarm (id, tenant_id, kennzeichen, ueberwachung_id, fassung, bezug_kennung, "
                    + "wertart, schwere, ausgeloest_am, zustand) VALUES (?, ?, ?, ?, 1, ?, "
                    + "(SELECT wertart FROM ueberwachung WHERE id = ?), 'warnung', ?, 'aktiv')", alarm, tenant,
                    "AL-B-" + alarm.toString().substring(0, 8), regel, bezug, regel, Timestamp.from(ausgeloestAm));
        } finally {
            TenantContext.clear();
        }
        return alarm;
    }

    private static void erledigen(UUID alarm) {
        root.update("UPDATE alarm SET zustand = 'erledigt', erledigt_am = now(), erledigt_durch = 'wert', "
                + "wieder_normal_am = now() "
                + "WHERE id = ?", alarm);
    }

    private static void einreihen(String sub, UUID alarm, String anlass, Instant wann) {
        TenantContext.set(tenant);
        try {
            ausgang.email("alarm", alarm, sub, anlass, 0, "Hof Lindenberg: Box meldet sich nicht",
                    "Inhalt der Meldung\n", wann, "warnung", null);
        } finally {
            TenantContext.clear();
        }
    }

    private static Map<String, Object> zeile(UUID alarm, String anlass) {
        return adminJdbc.queryForMap("SELECT zustand, grund, naechster_versuch FROM benachrichtigung "
                + "WHERE quelle_id = ? AND anlass = ?", alarm, anlass);
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }
}
