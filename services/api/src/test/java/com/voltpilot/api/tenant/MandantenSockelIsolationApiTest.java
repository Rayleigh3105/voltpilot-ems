package com.voltpilot.api.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Mandantentrennung mit EINER Verbindung je Anfrage (Lasttest Rang 13, {@link AnfrageVerbindung}) am echten
 * HTTP-Pfad: eingebetteter Tomcat, {@code TenantFilter}/{@code ZugriffFilter} der Anwendung, die echte RLS-Rolle
 * {@code voltpilot_app}, Dev-Seed mit zwei Kunden. Der Anfrage-Pool hat nur ZWEI Verbindungen (ebenso der
 * Hintergrund-Pool), damit jede physische Verbindung ständig zwischen den Kunden wechselt.
 *
 * <p>„Roh im Pool" heißt: alle Verbindungen eines Pools gleichzeitig direkt an Hikari ausleihen und lesen, was auf
 * ihnen steht - das, was die nächste Ausleihe erben würde, wenn sie nicht selbst setzte. Geprüft werden alle vier
 * Pools (Anfrage, Hintergrund, Admin-Anfrage, Admin-Hintergrund).
 *
 * <p>Die Prüf-Routen ({@link SockelPruefController}) leben nur im Test; sie stellen die Fälle her, die eine echte
 * Route nur selten zeigt (Ausnahme, Rollback, Zeitgrenze, liegengelassene oder abgerissene Verbindung, abgebrochene
 * Antwort, Arbeit in einem anderen Thread, Mandantenwechsel im Anfrage-Faden).
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MandantenSockelIsolationApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    /** Dev-Seed: der Mehr-Anlagen-Kunde und „Nordwind". */
    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID B = UUID.fromString("10000000-0000-0000-0000-000000000001");
    /** Ein dritter Kunde mit zwei Standorten - für den Standort-Zaun (site_scope) einer Leserin an EINEM Standort. */
    private static final UUID C = UUID.fromString("c5000000-0000-0000-0000-000000000001");
    private static final String C_ST1 = "c5000000-0000-0000-0001-000000000001";
    private static final String C_ST2 = "c5000000-0000-0000-0001-000000000002";
    private static final Set<String> ANLAGEN_C = Set.of("Sockel Halle Eins", "Sockel Halle Zwei", "Sockel ohne Standort");
    /** Was die Leserin an Standort 2 sehen darf. */
    private static final Set<String> ANLAGEN_C_LESERIN = Set.of("Sockel Halle Zwei");
    private static final String PLATTFORM = "plattform";
    private static final ObjectMapper JSON = new ObjectMapper();

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw")
            .withCommand("postgres", "-c", "shared_preload_libraries=timescaledb,pg_stat_statements");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri",
                () -> "http://127.0.0.1:9/realms/voltpilot");
        // Zwei Verbindungen je App-Pool: jede physische Verbindung dient abwechselnd beiden Kunden.
        registry.add("spring.datasource.hikari.maximum-pool-size", () -> "2");
        registry.add("spring.background-datasource.hikari.maximum-pool-size", () -> "2");
        // Wie AnfragePfadZeitgrenzeApiTest: 300 ms statt 30 s, derselbe Mechanismus.
        registry.add("spring.datasource.hikari.connection-init-sql", () -> "SET statement_timeout = 300");
    }

    @Autowired
    TestRestTemplate http;

    @LocalServerPort
    int port;

    @Autowired
    @Qualifier("jdbcTemplate")
    JdbcTemplate app;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @Autowired
    @Qualifier("realDataSource")
    HikariDataSource anfragePool;

    @Autowired
    @Qualifier("backgroundDataSource")
    HikariDataSource hintergrundPool;

    @Autowired
    @Qualifier("adminRequestDataSource")
    HikariDataSource adminAnfragePool;

    @Autowired
    @Qualifier("adminBackgroundDataSource")
    HikariDataSource adminHintergrundPool;

    private static Set<String> anlagenA;
    private static Set<String> anlagenB;

    /** Nach dem Start des Kontexts (Flyway hat migriert), einmal. */
    @BeforeEach
    void wahrheit() throws SQLException {
        if (anlagenA != null) {
            return;
        }
        // Was die Datenbank je Kunde wirklich hat - als Superuser gelesen, an RLS vorbei.
        Set<String> a = namen(A);
        Set<String> b = namen(B);
        assertThat(a).isNotEmpty();
        assertThat(b).isNotEmpty().doesNotContainAnyElementsOf(a);
        try (Connection c = superuser(); Statement s = c.createStatement()) {
            s.execute("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
            String t = "'" + C + "'";
            s.execute("INSERT INTO tenant (id, name) VALUES (" + t + ", 'Sockel Zaun GmbH')");
            s.execute("INSERT INTO unternehmen (tenant_id, name, zeitzone) VALUES (" + t
                    + ", 'Sockel Zaun GmbH', 'Europe/Berlin')");
            s.execute("INSERT INTO standort (id, tenant_id, unternehmen_id, name, kurzzeichen, zeitzone, zustand) "
                    + "SELECT v.id::uuid, u.tenant_id, u.id, v.name, v.kz, 'Europe/Berlin', 'aktiv' FROM unternehmen u, "
                    + "(VALUES ('" + C_ST1 + "', 'Werk Eins', 'SK-1'), ('" + C_ST2 + "', 'Werk Zwei', 'SK-2')) "
                    + "v(id, name, kz) WHERE u.tenant_id = " + t);
            s.execute("INSERT INTO site (id, tenant_id, name) VALUES "
                    + "('c5000000-0000-0000-0002-000000000001', " + t + ", 'Sockel Halle Eins'), "
                    + "('c5000000-0000-0000-0002-000000000002', " + t + ", 'Sockel Halle Zwei'), "
                    + "('c5000000-0000-0000-0002-000000000003', " + t + ", 'Sockel ohne Standort')");
            s.execute("INSERT INTO anlage_standort (tenant_id, site_id, standort_id, gueltig_ab) VALUES "
                    + "(" + t + ", 'c5000000-0000-0000-0002-000000000001', '" + C_ST1 + "', '2024-01-01'), "
                    + "(" + t + ", 'c5000000-0000-0000-0002-000000000002', '" + C_ST2 + "', '2024-01-01')");
            s.execute("INSERT INTO benutzer (tenant_id, sub, konto, anzeigename, zustand) VALUES (" + t
                    + ", 'sockel-leserin', 'benutzer', 'Leserin Werk Zwei', 'aktiv')");
            s.execute("INSERT INTO zugriff (tenant_id, benutzer_sub, rolle, standort_id, gueltig_ab, zeitzone) "
                    + "VALUES (" + t + ", 'sockel-leserin', 'leser', '" + C_ST2 + "', '2024-01-01T00:00:00Z', "
                    + "'Europe/Berlin')");
        }
        assertThat(namen(C)).isEqualTo(ANLAGEN_C);
        anlagenA = a;
        anlagenB = b;
    }

    // ------------------------------------------------------------------ der Standort-Zaun auf geteilten Verbindungen

    /**
     * Der Standort-Zaun hängt an {@code app.zugriff}/{@code app.standort_ids}, die erst NACH dem Laden des Zugriffs
     * feststehen - die gebundene Verbindung hat da schon den Mandanten ohne Zugriff (der ZugriffFilter las mit ihr).
     * Die Leserin an Standort 2 sieht trotzdem in jeder Anfrage nur ihre Anlage (nicht die am anderen Standort, nicht
     * die ohne Standort), während dieselben zwei Verbindungen reihum auch den Kunden A und B dienen.
     */
    @Test
    void eineLeserinAnEinemStandortSiehtAuchAufGeteiltenVerbindungenNurIhrenStandort() throws Exception {
        List<String> fehler = Collections.synchronizedList(new ArrayList<>());
        ExecutorService faeden = Executors.newFixedThreadPool(6);
        try {
            List<Future<?>> laeufe = new ArrayList<>();
            for (int f = 0; f < 6; f++) {
                int faden = f;
                laeufe.add(faeden.submit(() -> {
                    for (int i = 0; i < 20; i++) {
                        try {
                            if ((faden + i) % 2 == 0) {
                                JsonNode s = json(get(leserin(), "/api/v1/test-sockel/sitzung"));
                                if (!texte(s.path("anlagen")).equals(ANLAGEN_C_LESERIN)
                                        || !"standorte".equals(s.path("zugriff").asText())
                                        || !("{" + C_ST2 + "}").equals(s.path("standorte").asText())) {
                                    fehler.add("Leserin sah " + s);
                                }
                                Set<String> liste = new HashSet<>();
                                json(get(leserin(), "/api/v1/sites")).path("eintraege")
                                        .forEach(e -> liste.add(e.path("name").asText()));
                                if (!liste.equals(ANLAGEN_C_LESERIN)) {
                                    fehler.add("Leserin /sites sah " + liste);
                                }
                            } else {
                                UUID kunde = i % 4 < 2 ? A : B;
                                Set<String> gesehen = texte(json(get(kunde(kunde), "/api/v1/test-sockel/sitzung"))
                                        .path("anlagen"));
                                if (!gesehen.equals(kunde.equals(A) ? anlagenA : anlagenB)) {
                                    fehler.add(kunde + " sah " + gesehen);
                                }
                            }
                        } catch (Exception e) {
                            fehler.add(e.toString());
                        }
                    }
                }));
            }
            for (Future<?> l : laeufe) {
                l.get(5, TimeUnit.MINUTES);
            }
        } finally {
            faeden.shutdownNow();
        }
        assertThat(fehler).isEmpty();
        alleVierPoolsLeer();
    }

    // ------------------------------------------------------------------ zwei Kunden parallel

    /**
     * Acht Fäden, zwei Kunden, zwei Verbindungen: jede Anfrage sieht ausschließlich die eigenen Anlagen - auf der
     * echten Liste {@code /api/v1/sites} und auf der Prüf-Route, die zusätzlich in jeder ihrer vier Abfragen die
     * physische Verbindung und die Sitzungs-Variablen meldet. Beide Kunden haben dieselben physischen Verbindungen
     * benutzt (der Wechsel fand statt), und danach liegt jede Verbindung leer im Pool.
     */
    @Test
    void zweiKundenParallelSehenNieEineZeileDesAnderen() throws Exception {
        Map<UUID, Set<Integer>> pidsJeKunde = new ConcurrentHashMap<>();
        List<String> fehler = Collections.synchronizedList(new ArrayList<>());
        ExecutorService faeden = Executors.newFixedThreadPool(8);
        try {
            List<Future<?>> laeufe = new ArrayList<>();
            for (int f = 0; f < 8; f++) {
                int faden = f;
                laeufe.add(faeden.submit(() -> {
                    for (int i = 0; i < 25; i++) {
                        UUID kunde = (faden + i) % 2 == 0 ? A : B;
                        Set<String> eigene = kunde.equals(A) ? anlagenA : anlagenB;
                        try {
                            JsonNode liste = json(get(kunde(kunde), "/api/v1/sites"));
                            Set<String> gesehen = new HashSet<>();
                            liste.path("eintraege").forEach(e -> gesehen.add(e.path("name").asText()));
                            if (!gesehen.equals(eigene)) {
                                fehler.add(kunde + " /sites sah " + gesehen);
                            }
                            JsonNode s = json(get(kunde(kunde), "/api/v1/test-sockel/sitzung"));
                            if (!s.path("tenant").asText().equals(kunde.toString())) {
                                fehler.add(kunde + " Sitzung trug " + s.path("tenant").asText());
                            }
                            if (!texte(s.path("anlagen")).equals(eigene)) {
                                fehler.add(kunde + " Prüf-Route sah " + s.path("anlagen"));
                            }
                            Set<Integer> pids = new HashSet<>();
                            s.path("pids").forEach(p -> pids.add(p.asInt()));
                            if (pids.size() != 1) {
                                fehler.add(kunde + " vier Abfragen auf " + pids + " statt einer Verbindung");
                            }
                            pidsJeKunde.computeIfAbsent(kunde, k -> ConcurrentHashMap.newKeySet()).addAll(pids);
                        } catch (Exception e) {
                            fehler.add(kunde + " " + e);
                        }
                    }
                }));
            }
            for (Future<?> l : laeufe) {
                l.get(5, TimeUnit.MINUTES);
            }
        } finally {
            faeden.shutdownNow();
        }
        assertThat(fehler).isEmpty();
        Set<Integer> gemeinsam = new HashSet<>(pidsJeKunde.get(A));
        gemeinsam.retainAll(pidsJeKunde.get(B));
        assertThat(gemeinsam).as("dieselben physischen Verbindungen dienten beiden Kunden").isNotEmpty();
        alleVierPoolsLeer();
    }

    // ------------------------------------------------------------------ zurück im Pool ohne Kontext

    @Test
    void nachAusnahmeRollbackZeitgrenzeUndLiegengelassenerVerbindungLiegtJedeVerbindungLeerImPool()
            throws Exception {
        assertThat(get(kunde(A), "/api/v1/test-sockel/ausnahme").getStatusCode().value()).isEqualTo(500);
        alleVierPoolsLeer();

        assertThat(get(kunde(A), "/api/v1/test-sockel/rollback").getStatusCode().value()).isEqualTo(500);
        assertThat(namen(A)).as("zurückgerollt").isEqualTo(anlagenA);
        alleVierPoolsLeer();

        JsonNode abgebrochen = json(get(kunde(A), "/api/v1/test-sockel/abgebrochen"));
        assertThat(texte(abgebrochen.path("anlagen"))).as("nach der abgebrochenen Transaktion liest die Anfrage weiter")
                .isEqualTo(anlagenA);
        alleVierPoolsLeer();

        assertThat(get(kunde(A), "/api/v1/test-sockel/zeitgrenze").getStatusCode().value()).isEqualTo(500);
        alleVierPoolsLeer();

        JsonNode leck = json(get(kunde(A), "/api/v1/test-sockel/leck"));
        assertThat(leck.path("tenant").asText()).isEqualTo(A.toString());
        alleVierPoolsLeer();

        JsonNode abgerissen = json(get(kunde(A), "/api/v1/test-sockel/abgerissen"));
        assertThat(abgerissen.path("vorher").asInt()).isNotEqualTo(abgerissen.path("nachher").asInt());
        assertThat(texte(abgerissen.path("anlagen"))).as("die nächste Abfrage leiht frisch und setzt")
                .isEqualTo(anlagenA);
        alleVierPoolsLeer();

        // Und der andere Kunde bekommt danach auf denselben zwei Verbindungen nur seine Zeilen.
        for (int i = 0; i < 4; i++) {
            assertThat(texte(json(get(kunde(B), "/api/v1/test-sockel/sitzung")).path("anlagen"))).isEqualTo(anlagenB);
        }
    }

    /**
     * Der Client geht mitten in einer gestreamten Antwort (Antwort direkt in den Ausgabestrom, im Anfrage-Faden,
     * zwischen den Blöcken je eine Abfrage): Tomcat meldet den Abbruch beim Schreiben, die Anfrage endet mit der
     * Ausnahme - und die Verbindung liegt zurückgesetzt im Pool.
     */
    @Test
    void eineAbgebrocheneAntwortLaesstKeinenKontextZurueck() throws Exception {
        SockelPruefController.STROM_ENDE.set(new CountDownLatch(1));
        SockelPruefController.STROM_AUSGANG.set(null);
        try (Socket s = new Socket("127.0.0.1", port)) {
            OutputStream aus = s.getOutputStream();
            aus.write(("GET /api/v1/test-sockel/strom HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "
                    + kunde(A) + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            aus.flush();
            InputStream ein = s.getInputStream();
            byte[] puffer = new byte[4096];
            int gelesen = 0;
            while (gelesen < 8192) {
                int n = ein.read(puffer);
                if (n < 0) {
                    break;
                }
                gelesen += n;
            }
            assertThat(gelesen).as("die Antwort lief schon").isGreaterThanOrEqualTo(8192);
        }
        assertThat(SockelPruefController.STROM_ENDE.get().await(60, TimeUnit.SECONDS)).isTrue();
        assertThat(SockelPruefController.STROM_AUSGANG.get()).as("die Anfrage endete am Abbruch")
                .contains("IOException");
        warteBisAnfragePoolFrei();
        alleVierPoolsLeer();
    }

    // ------------------------------------------------------------------ Hintergrund, Admin, andere Threads

    @Test
    void hintergrundUndAdminWegeSehenNieEinenUebriggebliebenenKundenkontext() throws Exception {
        for (int i = 0; i < 6; i++) {
            get(kunde(i % 2 == 0 ? A : B), "/api/v1/test-sockel/sitzung");
        }
        // Ein Läufer ohne Mandant (Test-Faden: kein TenantFilter, also Hintergrund-Pool).
        Map<String, Object> ohne = app.queryForMap("SELECT current_setting('app.tenant_id', true) AS tenant, "
                + "(SELECT count(*) FROM site) AS anlagen");
        assertThat(String.valueOf(ohne.get("tenant"))).isIn("", "null");
        assertThat(((Number) ohne.get("anlagen")).longValue()).isZero();
        // Ein Läufer, der für einen Mandanten arbeitet, sieht genau dessen Zeilen.
        TenantContext.set(B);
        try {
            assertThat(new HashSet<>(app.queryForList("SELECT name FROM site", String.class))).isEqualTo(anlagenB);
        } finally {
            TenantContext.clear();
        }
        // Die Admin-Rolle (BYPASSRLS) stempelt nichts und erbt nichts.
        assertThat(admin.queryForObject("SELECT coalesce(current_setting('app.tenant_id', true), '')", String.class))
                .isEmpty();
        // Ein Plattform-Weg unter /api/v1/admin: die RLS-Sicht ohne Mandant leer, die Admin-Sicht vollständig.
        JsonNode plattform = json(get(PLATTFORM, "/api/v1/admin/test-sockel/sitzung"));
        assertThat(plattform.path("tenant").asText()).isEmpty();
        assertThat(plattform.path("appAnlagen").asInt()).isZero();
        assertThat(plattform.path("adminAnlagen").asInt()).isGreaterThanOrEqualTo(anlagenA.size() + anlagenB.size());
        alleVierPoolsLeer();
    }

    /**
     * Arbeit, die eine Anfrage an einen anderen Thread gibt ({@code CompletableFuture}): ohne ausdrückliche Übergabe
     * ohne Mandant (Hintergrund-Pool, keine Zeile), mit Übergabe genau mit dem Mandanten der Anfrage - nie mit dem
     * Kontext der gebundenen Verbindung.
     */
    @Test
    void arbeitInEinemAnderenThreadBekommtDenRichtigenOderKeinenKontext() throws Exception {
        JsonNode r = json(get(kunde(A), "/api/v1/test-sockel/async"));
        assertThat(r.path("ohne").path("tenant").asText()).isEmpty();
        assertThat(texte(r.path("ohne").path("anlagen"))).isEmpty();
        assertThat(r.path("mit").path("tenant").asText()).isEqualTo(A.toString());
        assertThat(texte(r.path("mit").path("anlagen"))).isEqualTo(anlagenA);
        assertThat(r.path("ohne").path("pids").get(0).asInt()).as("nicht die Verbindung der Anfrage")
                .isNotEqualTo(r.path("anfrage").asInt());
        alleVierPoolsLeer();
    }

    // ------------------------------------------------------------------ Wechsel, Plattform, Schreiben

    @Test
    void mandantenwechselInDerSitzungUndImAnfrageFaden() throws Exception {
        // Plattform am Umschalter (X-Tenant-Id) - nacheinander A, B, ohne Kunde.
        assertThat(texte(json(get(PLATTFORM, "/api/v1/test-sockel/sitzung", "X-Tenant-Id", A.toString()))
                .path("anlagen"))).isEqualTo(anlagenA);
        assertThat(texte(json(get(PLATTFORM, "/api/v1/test-sockel/sitzung", "X-Tenant-Id", B.toString()))
                .path("anlagen"))).isEqualTo(anlagenB);
        JsonNode ohneKunde = json(get(PLATTFORM, "/api/v1/test-sockel/sitzung"));
        assertThat(ohneKunde.path("tenant").asText()).isEmpty();
        assertThat(texte(ohneKunde.path("anlagen"))).isEmpty();
        assertThat(json(get(PLATTFORM, "/api/v1/sites")).path("eintraege")).isEmpty();
        // Kundensicht über X-Kundenbereich (Zugang Umschalter): der ZugriffFilter setzt den Mandanten in der Anfrage.
        JsonNode sicht = json(get(PLATTFORM, "/api/v1/test-sockel/sitzung", "X-Kundenbereich", B.toString()));
        assertThat(sicht.path("tenant").asText()).isEqualTo(B.toString());
        assertThat(sicht.path("zugriff").asText()).isEqualTo("unternehmen");
        assertThat(texte(sicht.path("anlagen"))).isEqualTo(anlagenB);

        // Ein Dienst schaltet im Anfrage-Faden um (wie AdminBenutzerService): jede Abfrage sieht den gerade gültigen.
        JsonNode wechsel = json(get(kunde(A), "/api/v1/test-sockel/wechsel"));
        List<JsonNode> schritte = new ArrayList<>();
        wechsel.path("schritte").forEach(schritte::add);
        assertThat(schritte).extracting(s -> s.path("tenant").asText())
                .containsExactly(A.toString(), B.toString(), A.toString(), "");
        assertThat(schritte).extracting(s -> texte(s.path("anlagen")))
                .containsExactly(anlagenA, anlagenB, anlagenA, Set.of());
        assertThat(schritte).extracting(s -> s.path("pid").asInt()).as("alles auf der einen Verbindung")
                .containsOnly(schritte.get(0).path("pid").asInt());
        alleVierPoolsLeer();
    }

    @Test
    void schreibendeAnfragenBleibenImEigenenMandanten() throws Exception {
        String fremde = idEinerAnlage(B);
        String eigene = idEinerAnlage(A);
        String alterName = namen(A, eigene);

        assertThat(post(kunde(A), "/api/v1/test-sockel/umbenennen?anlage=" + fremde + "&name=gekapert").path("zeilen")
                .asInt()).as("die Anlage des anderen Kunden gibt es für A nicht").isZero();
        assertThat(namen(B)).isEqualTo(anlagenB);

        assertThat(post(kunde(A), "/api/v1/test-sockel/umbenennen?anlage=" + eigene + "&name=Sockel-Probe")
                .path("zeilen").asInt()).isEqualTo(1);
        assertThat(namen(A, eigene)).isEqualTo("Sockel-Probe");
        assertThat(texte(json(get(kunde(B), "/api/v1/test-sockel/sitzung")).path("anlagen"))).isEqualTo(anlagenB);

        // Eine Zeile in den anderen Mandanten schieben: WITH CHECK lehnt ab, die Transaktion rollt zurück.
        ResponseEntity<String> verschieben = http.exchange("/api/v1/test-sockel/verschieben?anlage=" + eigene
                + "&nach=" + B, HttpMethod.POST, new HttpEntity<>(kopf(kunde(A))), String.class);
        assertThat(verschieben.getStatusCode().value()).isEqualTo(500);
        try (Connection c = superuser(); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                "SELECT tenant_id FROM site WHERE id = '" + eigene + "'")) {
            rs.next();
            assertThat(rs.getString(1)).isEqualTo(A.toString());
        }

        post(kunde(A), "/api/v1/test-sockel/umbenennen?anlage=" + eigene + "&name=" + alterName);
        assertThat(namen(A)).isEqualTo(anlagenA);
        alleVierPoolsLeer();
    }

    // ------------------------------------------------------------------ die Wirkung

    /**
     * Die Wirkung, an der Datenbank gezählt ({@code pg_stat_statements}, Rolle {@code voltpilot_app}): eine
     * Kundenanfrage auf {@code /api/v1/sites} schickt höchstens dreimal {@code set_config} - gesetzt beim Laden
     * des Zugriffs, neu gesetzt mit dem Zugriff, einmal zurückgesetzt. Vorher waren es zwei je Repository-Aufruf.
     * Gezählt wird die Anweisung mit den drei Variablen; die transaktionslokale Aufhebung des Standort-Zauns der
     * Teilansicht ({@code Geltungsbereich.ganzenKundenbereichLesen}, zwei Variablen) ist eine Abfrage der Route, kein
     * Sockel. Hintergrundjobs laufen mit derselben Rolle: gezählt wird das Minimum aus fünf Fenstern.
     */
    @Test
    void eineKundenanfrageSetztDieVariablenHoechstensDreimal() throws Exception {
        int minimum = Integer.MAX_VALUE;
        for (int i = 0; i < 5; i++) {
            statistikLeeren();
            get(kunde(A), "/api/v1/sites");
            minimum = Math.min(minimum, setConfigAufrufe());
        }
        assertThat(minimum).isBetween(1, 3);
    }

    // ------------------------------------------------------------------ Hilfen

    private void alleVierPoolsLeer() throws SQLException {
        warteBisAnfragePoolFrei();
        Map<String, HikariDataSource> pools = new LinkedHashMap<>();
        pools.put("Anfrage", anfragePool);
        pools.put("Hintergrund", hintergrundPool);
        pools.put("Admin-Anfrage", adminAnfragePool);
        pools.put("Admin-Hintergrund", adminHintergrundPool);
        for (Map.Entry<String, HikariDataSource> p : pools.entrySet()) {
            List<Connection> alle = new ArrayList<>();
            try {
                for (int i = 0; i < p.getValue().getMaximumPoolSize(); i++) {
                    alle.add(p.getValue().getConnection());
                }
                for (Connection c : alle) {
                    try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                            "SELECT coalesce(current_setting('app.tenant_id', true), '') || '|' "
                                    + "|| coalesce(current_setting('app.zugriff', true), '') || '|' "
                                    + "|| coalesce(current_setting('app.standort_ids', true), '')")) {
                        rs.next();
                        assertThat(rs.getString(1)).as(p.getKey() + "-Pool roh").isEqualTo("||");
                    }
                }
            } finally {
                for (Connection c : alle) {
                    c.close();
                }
            }
        }
    }

    /** Die Anfrage-Verbindung geht im finally des Filters zurück - nach der Antwort an den Client. */
    private void warteBisAnfragePoolFrei() {
        long bis = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (anfragePool.getHikariPoolMXBean().getActiveConnections() > 0 && System.nanoTime() < bis) {
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        assertThat(anfragePool.getHikariPoolMXBean().getActiveConnections()).isZero();
    }

    private static String kunde(UUID tenant) {
        return "kunde." + tenant;
    }

    private static String leserin() {
        return "leserin." + C;
    }

    private ResponseEntity<String> get(String token, String pfad, String... kopf) {
        HttpHeaders h = kopf(token);
        for (int i = 0; i + 1 < kopf.length; i += 2) {
            h.add(kopf[i], kopf[i + 1]);
        }
        return http.exchange(pfad, HttpMethod.GET, new HttpEntity<>(h), String.class);
    }

    private JsonNode post(String token, String pfad) throws IOException {
        ResponseEntity<String> r = http.exchange(pfad, HttpMethod.POST, new HttpEntity<>(kopf(token)), String.class);
        assertThat(r.getStatusCode().value()).as(pfad + " " + r.getBody()).isEqualTo(200);
        return JSON.readTree(r.getBody());
    }

    private static HttpHeaders kopf(String token) {
        HttpHeaders h = new HttpHeaders();
        h.add("Authorization", "Bearer " + token);
        return h;
    }

    private static JsonNode json(ResponseEntity<String> r) throws IOException {
        assertThat(r.getStatusCode().value()).as(r.getBody()).isEqualTo(200);
        return JSON.readTree(r.getBody());
    }

    private static Set<String> texte(JsonNode liste) {
        Set<String> s = new HashSet<>();
        liste.forEach(n -> s.add(n.asText()));
        return s;
    }

    private static Connection superuser() throws SQLException {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static Set<String> namen(UUID tenant) throws SQLException {
        Set<String> n = new HashSet<>();
        try (Connection c = superuser(); Statement s = c.createStatement();
                ResultSet rs = s.executeQuery("SELECT name FROM site WHERE tenant_id = '" + tenant + "'")) {
            while (rs.next()) {
                n.add(rs.getString(1));
            }
        }
        return n;
    }

    private static String namen(UUID tenant, String anlage) throws SQLException {
        try (Connection c = superuser(); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                "SELECT name FROM site WHERE tenant_id = '" + tenant + "' AND id = '" + anlage + "'")) {
            rs.next();
            return rs.getString(1);
        }
    }

    private static String idEinerAnlage(UUID tenant) throws SQLException {
        try (Connection c = superuser(); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                "SELECT id FROM site WHERE tenant_id = '" + tenant + "' ORDER BY name LIMIT 1")) {
            rs.next();
            return rs.getString(1);
        }
    }

    private static void statistikLeeren() throws SQLException {
        try (Connection c = superuser(); Statement s = c.createStatement()) {
            s.execute("SELECT pg_stat_statements_reset()");
        }
    }

    private static int setConfigAufrufe() throws SQLException {
        try (Connection c = superuser(); Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                "SELECT coalesce(sum(calls), 0) FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid "
                        + "WHERE r.rolname = '" + APP_USER + "' AND s.query ILIKE '%set_config%set_config%set_config%'")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    @TestConfiguration
    static class SockelPruefKonfiguration {

        @Bean
        SockelPruefController sockelPruefController(@Qualifier("jdbcTemplate") JdbcTemplate jdbc,
                @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc, DataSource dataSource,
                PlatformTransactionManager transaktionen) {
            return new SockelPruefController(jdbc, adminJdbc, dataSource, new TransactionTemplate(transaktionen));
        }

        /**
         * Tokens ohne Keycloak: {@code kunde.<uuid>} (Kundenkonto ohne Zuweisung, Bestandsregel: unternehmensweit),
         * {@code leserin.<uuid>} (Kundenkonto mit Zuweisung an einem Standort) und {@code plattform}.
         */
        @Bean
        JwtDecoder jwtDecoder() {
            return token -> {
                Instant jetzt = Instant.now();
                Jwt.Builder b = Jwt.withTokenValue(token).header("alg", "none").issuedAt(jetzt)
                        .expiresAt(jetzt.plusSeconds(3600));
                if (token.startsWith("kunde.")) {
                    String tenant = token.substring("kunde.".length());
                    return b.claim("sub", "sockel-" + tenant).claim("tenant_id", tenant).build();
                }
                if (token.startsWith("leserin.")) {
                    return b.claim("sub", "sockel-leserin").claim("tenant_id", token.substring("leserin.".length()))
                            .build();
                }
                if (PLATTFORM.equals(token)) {
                    return b.claim("sub", "sockel-plattform")
                            .claim("realm_access", Map.of("roles", List.of("platform-admin"))).build();
                }
                throw new BadJwtException("unbekanntes Test-Token");
            };
        }
    }

    /** Nur im Test: die Fälle, die eine echte Route selten zeigt. */
    @RestController
    @RequestMapping
    static class SockelPruefController {

        static final AtomicReference<CountDownLatch> STROM_ENDE = new AtomicReference<>(new CountDownLatch(1));
        static final AtomicReference<String> STROM_AUSGANG = new AtomicReference<>();

        private static final String SITZUNG = "SELECT pg_backend_pid() AS pid, "
                + "coalesce(current_setting('app.tenant_id', true), '') AS tenant, "
                + "coalesce(current_setting('app.zugriff', true), '') AS zugriff, "
                + "coalesce(current_setting('app.standort_ids', true), '') AS standorte";

        private final JdbcTemplate jdbc;
        private final JdbcTemplate adminJdbc;
        private final DataSource dataSource;
        private final TransactionTemplate transaktion;

        SockelPruefController(JdbcTemplate jdbc, JdbcTemplate adminJdbc, DataSource dataSource,
                TransactionTemplate transaktion) {
            this.jdbc = jdbc;
            this.adminJdbc = adminJdbc;
            this.dataSource = dataSource;
            this.transaktion = transaktion;
        }

        /** Vier getrennte Repository-Aufrufe: die Verbindung jedes Aufrufs, die Variablen, die sichtbaren Anlagen. */
        @GetMapping("/api/v1/test-sockel/sitzung")
        Map<String, Object> sitzung() {
            Map<String, Object> erste = jdbc.queryForMap(SITZUNG);
            List<String> anlagen = jdbc.queryForList("SELECT name FROM site", String.class);
            Map<String, Object> dritte = jdbc.queryForMap(SITZUNG);
            Map<String, Object> r = new LinkedHashMap<>(erste);
            r.remove("pid");
            r.put("pids", List.of(erste.get("pid"), anlagenPid(), dritte.get("pid")));
            r.put("anlagen", anlagen);
            return r;
        }

        private Object anlagenPid() {
            return jdbc.queryForObject("SELECT pg_backend_pid()", Integer.class);
        }

        @GetMapping("/api/v1/admin/test-sockel/sitzung")
        Map<String, Object> plattform() {
            Map<String, Object> r = new LinkedHashMap<>(jdbc.queryForMap(SITZUNG));
            r.put("appAnlagen", jdbc.queryForObject("SELECT count(*) FROM site", Integer.class));
            r.put("adminAnlagen", adminJdbc.queryForObject("SELECT count(*) FROM site", Integer.class));
            return r;
        }

        @GetMapping("/api/v1/test-sockel/ausnahme")
        String ausnahme() {
            jdbc.queryForList("SELECT name FROM site", String.class);
            throw new IllegalStateException("Prüf-Ausnahme nach einer Abfrage");
        }

        @GetMapping("/api/v1/test-sockel/rollback")
        String rollback() {
            transaktion.executeWithoutResult(status -> {
                jdbc.update("UPDATE site SET name = name || ' (geändert)'");
                throw new IllegalStateException("Prüf-Ausnahme in der Transaktion");
            });
            return "nie";
        }

        @GetMapping("/api/v1/test-sockel/abgebrochen")
        Map<String, Object> abgebrochen() {
            jdbc.execute((ConnectionCallback<Void>) c -> {
                c.setAutoCommit(false);
                try (Statement s = c.createStatement()) {
                    s.execute("SELECT 1 / 0");
                } catch (SQLException erwartet) {
                    // abgebrochene Transaktion, kein rollback()
                }
                return null;
            });
            return Map.of("anlagen", jdbc.queryForList("SELECT name FROM site", String.class));
        }

        @GetMapping("/api/v1/test-sockel/zeitgrenze")
        String zeitgrenze() {
            jdbc.queryForList("SELECT name FROM site", String.class);
            jdbc.execute("SELECT pg_sleep(2)");
            return "nie";
        }

        /** Eine Verbindung, die nie zurückgegeben wird. */
        @GetMapping("/api/v1/test-sockel/leck")
        Map<String, Object> leck() throws SQLException {
            Connection c = DataSourceUtils.getConnection(dataSource);
            c.setAutoCommit(false);
            try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery(
                    "SELECT coalesce(current_setting('app.tenant_id', true), '')")) {
                rs.next();
                return Map.of("tenant", rs.getString(1));
            }
        }

        /** Die eigene Verbindung wird mitten in der Anfrage beendet. */
        @GetMapping("/api/v1/test-sockel/abgerissen")
        Map<String, Object> abgerissen() {
            Integer vorher = jdbc.queryForObject("SELECT pg_backend_pid()", Integer.class);
            try {
                jdbc.execute("SELECT pg_terminate_backend(pg_backend_pid())");
            } catch (DataAccessException erwartet) {
                // die Verbindung ist weg
            }
            Integer nachher = jdbc.queryForObject("SELECT pg_backend_pid()", Integer.class);
            return Map.of("vorher", vorher, "nachher", nachher,
                    "anlagen", jdbc.queryForList("SELECT name FROM site", String.class));
        }

        /** Antwort direkt in den Ausgabestrom, zwischen den Blöcken je eine Abfrage - bis der Client geht. */
        @GetMapping("/api/v1/test-sockel/strom")
        void strom(HttpServletResponse antwort) throws IOException {
            String ausgang = "durchgelaufen";
            try {
                antwort.setContentType("application/octet-stream");
                OutputStream aus = antwort.getOutputStream();
                byte[] block = new byte[32 * 1024];
                for (int i = 0; i < 4000; i++) {
                    jdbc.queryForList("SELECT name FROM site", String.class);
                    aus.write(block);
                    aus.flush();
                }
            } catch (IOException e) {
                ausgang = "IOException " + e.getClass().getSimpleName();
                throw e;
            } finally {
                STROM_AUSGANG.set(ausgang);
                STROM_ENDE.get().countDown();
            }
        }

        /** Arbeit in einem anderen Thread: ohne und mit ausdrücklich übergebenem Mandanten. */
        @GetMapping("/api/v1/test-sockel/async")
        Map<String, Object> async() {
            UUID tenant = TenantContext.get();
            Integer anfrage = jdbc.queryForObject("SELECT pg_backend_pid()", Integer.class);
            Map<String, Object> ohne = CompletableFuture.supplyAsync(this::sitzung).join();
            Map<String, Object> mit = CompletableFuture.supplyAsync(() -> {
                TenantContext.set(tenant);
                try {
                    return sitzung();
                } finally {
                    TenantContext.clear();
                }
            }).join();
            return Map.of("anfrage", anfrage, "ohne", ohne, "mit", mit);
        }

        /** Umschalten im Anfrage-Faden: A, B, wieder A, ohne Mandant - je eine Abfrage. */
        @GetMapping("/api/v1/test-sockel/wechsel")
        Map<String, Object> wechsel() {
            UUID eigen = TenantContext.get();
            UUID anderer = eigen.equals(A) ? B : A;
            List<Map<String, Object>> schritte = new ArrayList<>();
            try {
                schritte.add(schritt());
                TenantContext.set(anderer);
                schritte.add(schritt());
                TenantContext.set(eigen);
                schritte.add(schritt());
                TenantContext.clear();
                schritte.add(schritt());
            } finally {
                TenantContext.set(eigen);
            }
            return Map.of("schritte", schritte);
        }

        private Map<String, Object> schritt() {
            Map<String, Object> s = new LinkedHashMap<>(jdbc.queryForMap(SITZUNG));
            s.put("anlagen", jdbc.queryForList("SELECT name FROM site", String.class));
            return s;
        }

        @PostMapping("/api/v1/test-sockel/umbenennen")
        Map<String, Object> umbenennen(@RequestParam UUID anlage, @RequestParam String name) {
            Integer zeilen = transaktion.execute(status ->
                    jdbc.update("UPDATE site SET name = ? WHERE id = ?", name, anlage));
            return Map.of("zeilen", zeilen);
        }

        @PostMapping("/api/v1/test-sockel/verschieben")
        Map<String, Object> verschieben(@RequestParam UUID anlage, @RequestParam UUID nach) {
            Integer zeilen = transaktion.execute(status ->
                    jdbc.update("UPDATE site SET tenant_id = ? WHERE id = ?", nach, anlage));
            return Map.of("zeilen", zeilen);
        }
    }
}
