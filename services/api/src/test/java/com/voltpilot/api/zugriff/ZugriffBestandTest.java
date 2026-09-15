package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.tenant.TenantAwareDataSource;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Aktion;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.RechteAbleitung.Zelle;
import com.voltpilot.api.zugriff.ZugriffRepository.Zeile;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.web.client.ResourceAccessException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * UEMS AP-03 IP-2, Captain-Entscheid E12 = A: die Bestandsübernahme der Rechte gegen eine echte Datenbank
 * (Testcontainers, Docker nötig, sonst übersprungen) — Keycloak als Attrappe, der Rest echt: RLS-Verbindung,
 * Transaktion, Tabellen aus {@code V20260915030000}.
 *
 * <p><b>Die wichtigste Eigenschaft des Pakets: niemand verliert Zugriff.</b> Ein Bestandsmandant mit mehreren
 * Konten — darunter die Träger der Realm-Rollen {@code admin} und {@code site-admin} und ein deaktiviertes Konto —
 * hat danach für JEDES Konto genau eine wirksame, unbefristete, mandantenweite Zuweisung als Kundenadministrator,
 * und der Rechte-Vertrag ({@link RechteAbleitung#darf}) erlaubt jedem aktiven Konto jede Zeile der Matrix, die der
 * Kundenadministrator unternehmensweit hat. Ohne die Übernahme hätte er keine davon — der Test beißt.
 */
@Testcontainers(disabledWithoutDocker = true)
class ZugriffBestandTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final Path MATRIX = Path.of("..", "..", "docs", "contracts", "v2", "rechte-matrix.json");
    private static final Instant JETZT = Instant.parse("2026-09-15T08:00:00Z");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    private static JdbcTemplate root;
    private static JdbcTemplate adminJdbc;
    private static ZugriffRepository zugriffe;
    private static ZugriffBestand bestand;
    private static SimpleMeterRegistry metriken;
    private static RechteAbleitung.Matrix matrix;

    @BeforeAll
    static void migration() throws IOException {
        Flyway.configure()
                .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations("classpath:db/migration")
                .baselineOnMigrate(true)
                .baselineVersion("0")
                .placeholders(Map.of("appDbUser", APP_USER, "appDbPassword", APP_PW,
                        "adminDbUser", ADMIN_USER, "adminDbPassword", ADMIN_PW))
                .load()
                .migrate();
        root = new JdbcTemplate(ds(POSTGRES.getUsername(), POSTGRES.getPassword()));
        adminJdbc = new JdbcTemplate(ds(ADMIN_USER, ADMIN_PW));
        DataSource rls = new TenantAwareDataSource(ds(APP_USER, APP_PW));
        JdbcTemplate app = new JdbcTemplate(rls);
        zugriffe = new ZugriffRepository(app);
        metriken = new SimpleMeterRegistry();
        bestand = new ZugriffBestand(zugriffe, app, new DataSourceTransactionManager(rls), metriken);
        bestand.uhrStellen(Clock.fixed(JETZT, ZoneOffset.UTC));
        matrix = RechteAbleitung.matrix(new ObjectMapper().readTree(MATRIX.toFile()));
    }

    @AfterEach
    void zaunZu() {
        TenantContext.clear();
    }

    @Test
    void jederBenutzerEinesBestandsmandantenIstDanachKundenadministratorUndKeinerOhne() {
        UUID ahrenberg = kunde("Kunststoffwerk Ahrenberg GmbH", "Europe/Berlin");
        UUID nordwind = kunde("Nordwind Energie", null);
        List<KeycloakUser> konten = List.of(
                konto("kc-jonas", "jonas", "Jonas", "Wendlinger", true, ahrenberg),    // operator
                konto("kc-ines", "ines", "Ines", "Kaltenbach", true, ahrenberg),       // Trägerin von admin
                konto("kc-claudia", "claudia", "Claudia", "Berger", true, ahrenberg),  // Trägerin von site-admin
                konto("kc-murat", "murat", null, null, false, ahrenberg));             // in Keycloak deaktiviert
        KeycloakUser nord = konto("kc-nord", "demo2", "Nordwind", "Operator", true, nordwind);
        KeycloakAdminClient keycloak = mock(KeycloakAdminClient.class);
        doReturn(konten).when(keycloak).listUsersForTenant(ahrenberg);
        doReturn(List.of(nord)).when(keycloak).listUsersForTenant(nordwind);

        ZugriffBestandLaeufer.Lauf lauf = new ZugriffBestandLaeufer(adminJdbc, keycloak, bestand, true).lauf();

        assertThat(lauf.fehler()).isZero();
        assertThat(lauf.zuweisungenNeu()).isEqualTo(5);
        assertThat(lauf.benutzerNeu()).isEqualTo(5);
        assertThat(TenantContext.get()).as("der Lauf räumt den Kontext auf").isNull();

        Instant danach = JETZT.plus(Duration.ofMinutes(1));
        alsTue(ahrenberg, () -> {
            for (KeycloakUser k : konten) {
                List<Zeile> alle = zugriffe.zuweisungen(k.id());
                assertThat(alle).as(k.username() + ": genau eine Zuweisung").hasSize(1);
                Zeile z = alle.get(0);
                assertThat(z.rolle()).isEqualTo(Rolle.KUNDENADMINISTRATOR);
                assertThat(z.standortId()).as("mandantenweit").isNull();
                assertThat(List.of(String.valueOf(z.art()), String.valueOf(z.umfang()), String.valueOf(z.gueltigBis()),
                        String.valueOf(z.endetAm()), String.valueOf(z.beendetAm()), String.valueOf(z.gewaehrtVon())))
                        .as("keine Unterstützung, unbefristet, nicht beendet, keine Person").containsOnly("null");
                assertThat(z.gueltigAb()).isEqualTo(JETZT);
                assertThat(z.zeitzone()).isEqualTo(ZoneId.of("Europe/Berlin"));
                assertThat(zugriffe.wirksam(k.id(), danach)).extracting(Zeile::id).containsExactly(z.id());
                assertThat(zugriffe.wirksam(k.id(), danach.plus(Duration.ofDays(3650)))).as("unbefristet").hasSize(1);
            }
            assertThat(zugriffe.zuweisungen("kc-nord")).as("das Konto eines anderen Kundenbereichs").isEmpty();
        });
        assertThat(root.queryForObject("SELECT count(*) FROM benutzer b WHERE b.tenant_id = ? AND NOT EXISTS ("
                + "SELECT 1 FROM zugriff z WHERE z.tenant_id = b.tenant_id AND z.benutzer_sub = b.sub "
                + "AND z.rolle = 'kundenadministrator' AND z.standort_id IS NULL "
                + "AND public.zugriff_zeitraum(z.gueltig_ab, z.endet_am, z.beendet_am) @> ?)", Long.class, ahrenberg,
                danach.atOffset(ZoneOffset.UTC))).as("kein Benutzer ohne wirksame Zuweisung").isZero();
        assertThat(als(nordwind, () -> zugriffe.zuweisungen("kc-nord")))
                .extracting(Zeile::rolle, Zeile::zeitzone)
                .as("ohne Unternehmen die Zone des Vertrags")
                .containsExactly(org.assertj.core.groups.Tuple.tuple(Rolle.KUNDENADMINISTRATOR, ZoneId.of("Europe/Berlin")));

        // Der Spiegel: ein Konto je Benutzer, deaktiviert heißt gesperrt (die Zuweisung bleibt, wirkt nicht, §4.8).
        assertThat(root.queryForList("SELECT sub || ' ' || konto || ' ' || anzeigename || ' ' || zustand FROM benutzer "
                + "WHERE tenant_id = ? ORDER BY sub", String.class, ahrenberg)).containsExactly(
                "kc-claudia benutzer Claudia Berger aktiv", "kc-ines benutzer Ines Kaltenbach aktiv",
                "kc-jonas benutzer Jonas Wendlinger aktiv", "kc-murat benutzer murat gesperrt");
        // Das Protokoll: je Konto ein `zuweisen`, Urheber „Bestandsübernahme" (VoltPilot ohne Person).
        assertThat(root.queryForList("SELECT betroffener_sub || ' ' || aktion || ' ' || rolle || ' ' || actor_name || ' ' "
                + "|| actor_art || ' ' || actor_rolle || ' ' || coalesce(actor_sub, '-') || ' ' || grund "
                + "FROM zugriff_protokoll WHERE tenant_id = ? ORDER BY betroffener_sub", String.class, ahrenberg))
                .containsExactly(
                        "kc-claudia zuweisen kundenadministrator Bestandsübernahme voltpilot voltpilot_betrieb - Bestandsübernahme",
                        "kc-ines zuweisen kundenadministrator Bestandsübernahme voltpilot voltpilot_betrieb - Bestandsübernahme",
                        "kc-jonas zuweisen kundenadministrator Bestandsübernahme voltpilot voltpilot_betrieb - Bestandsübernahme",
                        "kc-murat zuweisen kundenadministrator Bestandsübernahme voltpilot voltpilot_betrieb - Bestandsübernahme");

        // Kein Rechteverlust, nach dem Vertrag: jede Zeile, die der Kundenadministrator unternehmensweit hat,
        // ist für jedes aktive Konto erlaubt — am Unternehmen und am Standort. Ohne die Übernahme: keine.
        Kundenbereich kb = new Kundenbereich("Kunststoffwerk Ahrenberg GmbH",
                List.of(new RechteAbleitung.Standort("ST-1", "Werk Ahrenberg")),
                List.of(new RechteAbleitung.Person("kc-jonas", "Jonas Wendlinger")));
        List<Ziel> ziele = List.of(Ziel.unternehmen(), new Ziel("ST-1", null, null));
        int erlaubt = 0;
        for (KeycloakUser k : konten) {
            List<RechteAbleitung.Zuweisung> gespeichert = als(ahrenberg, () -> zugriffe.zuweisungen(k.id())).stream()
                    .map(Zeile::alsZuweisung).toList();
            Benutzer heute = new Benutzer(k.id(), k.username(), Konto.BENUTZER, KontoZustand.AKTIV, gespeichert);
            Benutzer gesperrt = new Benutzer(k.id(), k.username(), Konto.BENUTZER, KontoZustand.GESPERRT, gespeichert);
            Benutzer ohne = new Benutzer(k.id(), k.username(), Konto.BENUTZER, KontoZustand.AKTIV, List.of());
            for (Aktion a : matrix.aktionen().values()) {
                if (a.zelle(Rolle.KUNDENADMINISTRATOR) != Zelle.U) {
                    continue;
                }
                for (Ziel ziel : ziele) {
                    DarfErgebnis d = RechteAbleitung.darf(matrix, k.enabled() ? heute : gesperrt, kb, a.kennung(), ziel,
                            danach);
                    if (k.enabled()) {
                        assertThat(d.darf()).as("%s darf %s an %s (%s)", k.username(), a.kennung(), ziel, d.grund())
                                .isTrue();
                        erlaubt++;
                    } else {
                        assertThat(d.grund()).as("gesperrt ist angehalten, nicht verloren")
                                .isEqualTo(RechteAbleitung.Grund.KONTO_NICHT_AKTIV);
                        assertThat(RechteAbleitung.darf(matrix, heute, kb, a.kennung(), ziel, danach).darf())
                                .as("entsperrt wirkt die Zuweisung wieder: %s", a.kennung()).isTrue();
                    }
                    assertThat(RechteAbleitung.darf(matrix, ohne, kb, a.kennung(), ziel, danach).darf())
                            .as("ohne die Übernahme wäre %s verloren", a.kennung()).isFalse();
                }
            }
        }
        assertThat(erlaubt).as("3 aktive Konten × Zeilen × 2 Ziele").isGreaterThan(3 * 20 * 2);
    }

    @Test
    void einZweiterLaufSchreibtNichtsUndEinEntzogenerZugriffKommtNieZurueck() {
        UUID wien = kunde("Donau Kunststoff GmbH", "Europe/Vienna");
        List<KeycloakUser> konten = List.of(konto("kc-w-jonas", "jonas.w", "Jonas", "Wendlinger", true, wien),
                konto("kc-w-ines", "ines.w", "Ines", "Kaltenbach", true, wien));
        KeycloakAdminClient keycloak = mock(KeycloakAdminClient.class);
        doReturn(konten).when(keycloak).listUsersForTenant(wien);
        ZugriffBestandLaeufer laeufer = new ZugriffBestandLaeufer(adminJdbc, keycloak, bestand, true);

        assertThat(laeufer.lauf().zuweisungenNeu()).isEqualTo(2);
        List<Long> vorher = zahlen(wien);
        ZugriffBestandLaeufer.Lauf zweiter = laeufer.lauf();
        assertThat(zweiter.geaendert()).as("ein zweiter Lauf schreibt nichts").isFalse();
        assertThat(zweiter.konten()).isEqualTo(2);
        assertThat(zahlen(wien)).isEqualTo(vorher);
        assertThat(als(wien, () -> zugriffe.zuweisungen("kc-w-ines")).get(0).zeitzone())
                .as("die Zone des Unternehmens").isEqualTo(ZoneId.of("Europe/Vienna"));

        // Ines nimmt Jonas die Rolle (die Schutzregeln dafür bringt IP-9) — kein Lauf gibt sie zurück.
        UUID jonas = als(wien, () -> zugriffe.zuweisungen("kc-w-jonas")).get(0).id();
        Instant entzogen = JETZT.plus(Duration.ofHours(1));
        assertThat(als(wien, () -> zugriffe.beenden(jonas, entzogen,
                ProtokollAkteur.fuer("kc-w-ines", "Ines Kaltenbach", false), "Rolle neu vergeben"))).isTrue();
        ZugriffBestandLaeufer.Lauf dritter = laeufer.lauf();
        assertThat(dritter.zuweisungenNeu()).isZero();
        alsTue(wien, () -> {
            assertThat(zugriffe.wirksam("kc-w-jonas", entzogen.plus(Duration.ofHours(1)))).isEmpty();
            assertThat(zugriffe.zuweisungen("kc-w-jonas")).hasSize(1);
            assertThat(zugriffe.wirksam("kc-w-ines", entzogen.plus(Duration.ofHours(1)))).hasSize(1);
        });
    }

    @Test
    void einNeuAngelegtesKontoWirdSofortKundenadministratorUndEinFehlerBleibtBeimHoerer() {
        UUID selbst = kunde("Solar Hofmann", "Europe/Berlin");
        UUID umschalter = UUID.randomUUID();

        // Die Admin-Konsole: der Mandanten-Umschalter des Aufrufers bleibt, wie er war.
        TenantContext.set(umschalter);
        bestand.beiAnlage(new KundenbenutzerAngelegt(selbst, konto("kc-neu", "neu@example.de", null, null, true, selbst)));
        assertThat(TenantContext.get()).isEqualTo(umschalter);
        TenantContext.clear();
        assertThat(als(selbst, () -> zugriffe.wirksam("kc-neu", JETZT.plusSeconds(1))))
                .extracting(Zeile::rolle).containsExactly(Rolle.KUNDENADMINISTRATOR);
        assertThat(root.queryForObject("SELECT anzeigename FROM benutzer WHERE tenant_id = ? AND sub = 'kc-neu'",
                String.class, selbst)).isEqualTo("neu@example.de");

        // Ein Konto, das behauptet, in einen anderen Kundenbereich zu gehören, wird hier nie eingetragen.
        bestand.beiAnlage(new KundenbenutzerAngelegt(selbst, konto("kc-quer", "quer", null, null, true, umschalter)));
        assertThat(root.queryForObject("SELECT count(*) FROM benutzer WHERE sub = 'kc-quer'", Long.class)).isZero();

        // Ein Fehler (hier: einen Kundenbereich gibt es nicht) wirft nie, wird gezählt und lässt keinen Rest.
        double fehlerVorher = fehler();
        UUID gibtEsNicht = UUID.randomUUID();
        assertThatCode(() -> bestand.beiAnlage(new KundenbenutzerAngelegt(gibtEsNicht,
                konto("kc-x", "x", null, null, true, gibtEsNicht)))).doesNotThrowAnyException();
        assertThat(fehler()).isEqualTo(fehlerVorher + 1);
        assertThat(TenantContext.get()).isNull();
        assertThat(root.queryForObject("SELECT count(*) FROM benutzer WHERE sub = 'kc-x'", Long.class)).isZero();
    }

    @Test
    void keycloakNichtErreichbarBeendetDenLaufUndEineAblehnungHaeltDieAnderenNichtAuf() {
        UUID erreichbar = kunde("Erreichbar GmbH", "Europe/Berlin");
        List<Long> vorher = zahlen(erreichbar);

        KeycloakAdminClient weg = mock(KeycloakAdminClient.class);
        doThrow(new ResourceAccessException("Connection refused")).when(weg).listUsersForTenant(any());
        ZugriffBestandLaeufer.Lauf l = new ZugriffBestandLaeufer(adminJdbc, weg, bestand, true).lauf();
        assertThat(l.fehler()).as("EINE Meldung, dann Ende").isEqualTo(1);
        assertThat(l.konten()).isZero();
        verify(weg, times(1)).listUsersForTenant(any());
        assertThat(zahlen(erreichbar)).isEqualTo(vorher);

        KeycloakAdminClient abweisend = mock(KeycloakAdminClient.class);
        doThrow(new KeycloakAdminException(403, "User listing refused")).when(abweisend).listUsersForTenant(any());
        doReturn(List.of(konto("kc-e", "e", "Erika", "Erreichbar", true, erreichbar))).when(abweisend)
                .listUsersForTenant(erreichbar);
        ZugriffBestandLaeufer.Lauf a = new ZugriffBestandLaeufer(adminJdbc, abweisend, bestand, true).lauf();
        assertThat(a.fehler()).isEqualTo(a.kundenbereiche() - 1);
        assertThat(a.zuweisungenNeu()).isEqualTo(1);
        assertThat(als(erreichbar, () -> zugriffe.wirksam("kc-e", JETZT.plusSeconds(1)))).hasSize(1);
    }

    // ============================================================ Hilfen

    private static UUID kunde(String name, String zeitzone) {
        UUID t = root.queryForObject("INSERT INTO tenant (name) VALUES (?) RETURNING id", UUID.class, name);
        if (zeitzone != null) {
            root.update("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (?, ?, ?)", t, name, zeitzone);
        }
        return t;
    }

    private static KeycloakUser konto(String id, String username, String vorname, String nachname, boolean aktiv,
            UUID tenant) {
        return new KeycloakUser(id, username, username.contains("@") ? username : username + "@example.de", vorname,
                nachname, aktiv, tenant.toString());
    }

    private static List<Long> zahlen(UUID tenant) {
        List<Long> z = new ArrayList<>();
        for (String tabelle : List.of("benutzer", "zugriff", "zugriff_protokoll")) {
            z.add(root.queryForObject("SELECT count(*) FROM " + tabelle + " WHERE tenant_id = ?", Long.class, tenant));
        }
        return z;
    }

    private static double fehler() {
        return metriken.get(ZugriffBestand.ZAEHLER).tag("ergebnis", "fehler").counter().count();
    }

    private static <T> T als(UUID tenant, Supplier<T> arbeit) {
        TenantContext.set(tenant);
        try {
            return arbeit.get();
        } finally {
            TenantContext.clear();
        }
    }

    private static void alsTue(UUID tenant, Runnable arbeit) {
        als(tenant, () -> {
            arbeit.run();
            return null;
        });
    }

    private static DataSource ds(String user, String password) {
        PGSimpleDataSource ds = new PGSimpleDataSource();
        ds.setUrl(POSTGRES.getJdbcUrl());
        ds.setUser(user);
        ds.setPassword(password);
        return ds;
    }

    @SuppressWarnings("unused")
    private static OffsetDateTime utc(Instant t) {
        return t.atOffset(ZoneOffset.UTC);
    }
}
