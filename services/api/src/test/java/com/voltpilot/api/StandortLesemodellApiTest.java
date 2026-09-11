package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.AnlageStandortRepository;
import com.voltpilot.api.uems.FlaecheRepository;
import com.voltpilot.api.uems.OrtRepository;
import com.voltpilot.api.uems.OrtZuordnungRepository;
import com.voltpilot.api.uems.StandortRepository;
import com.voltpilot.api.uems.UnternehmenRepository;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Das Standort-Lesemodell (UEMS AP-02 IP-3 ★) durch den ganzen Stapel — echter
 * Keycloak, echte TimescaleDB, RLS als einziger Zaun:
 *
 * <ol>
 *   <li>Ein NEUER Kundenbereich bekommt beim Anlegen genau ein Unternehmen samt
 *       Protokolleintrag; ohne Standorte sind die Listen leer (nie 0-Objekte).</li>
 *   <li>Ein Kundenbereich ohne Unternehmen-Zeile bekommt einen benannten Zustand,
 *       nie einen 500; ein Admin ohne gewählten Mandanten 404.</li>
 *   <li>A5/A15: der Bestandskunde mit einer Anlage — erst „noch nicht zugeordnet",
 *       nach der Zuordnung (wie sie IP-9 anlegt) weder Gruppe noch Zahl.</li>
 *   <li>A12: „Stand am" an drei Stichtagen auf dem Referenzunternehmen Ahrenberg,
 *       über die Repositories gesät.</li>
 *   <li>A14: ein fremder Standort ist 404, nie 403.</li>
 *   <li>{@code /overview} und {@code /sites/{id}}: jedes bestehende Feld bleibt,
 *       {@code standort} kommt additiv ans Ende.</li>
 * </ol>
 *
 * <p>Die Ableitung selbst beweist {@code StandortLesemodellTest} gegen die
 * Vektor-Datei; hier geht es um Draht, Zaun und Bestand.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class StandortLesemodellApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VEKTOREN =
            Path.of("..", "..", "docs", "contracts", "v2", "ortsbaum-vectors.json");
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    /** Die Felder einer Flotten-Zeile VOR diesem Paket, in ihrer Reihenfolge. */
    private static final List<String> OVERVIEW_SITE_FELDER = List.of("id", "name", "plantKind",
            "netzladenErlaubt", "batteryWithoutDevice", "deviceCount", "onlineCount",
            "waitingCount", "worstStatus", "lastSeenAt", "live", "plannedSavingsTodayEur",
            "roleCounts", "usageProfile", "lastPlanGeneratedAt", "storageCapacityKwh",
            "energyToday", "chargePointCount", "anwendungen");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer(
            "quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);
        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    /** Die mandantengebundene App-Verbindung — RLS, wie jede Kunden-Route sie hat. */
    @Autowired
    JdbcTemplate app;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @Autowired
    UnternehmenRepository unternehmen;
    @Autowired
    StandortRepository standorte;
    @Autowired
    OrtRepository orte;
    @Autowired
    OrtZuordnungRepository ortZuordnungen;
    @Autowired
    FlaecheRepository flaechen;
    @Autowired
    AnlageStandortRepository anlageZuordnungen;

    /** Das gesäte Referenzunternehmen: Kennzeichen → ID, einmal je Testlauf. */
    private static Map<String, UUID> ahrenberg;
    private static String ahrenbergTenant;

    // ---------------------------------------------- (1) neuer Kundenbereich

    @Test
    void einNeuerKundenbereichBekommtGenauEinUnternehmenUndLeereListen() {
        String adminToken = token("admin", "admin");
        String tenant = neuerKundenbereich(adminToken, "Kunststoffwerk Ahrenberg GmbH");

        // In derselben Anweisung wie der Mandant: genau ein Unternehmen, Name des
        // Kundenbereichs, Europe/Berlin, keine Person — und sein Protokolleintrag.
        assertThat(admin.queryForObject("SELECT count(*) FROM unternehmen WHERE tenant_id = ?::uuid",
                Integer.class, tenant)).isEqualTo(1);
        Map<String, Object> u = admin.queryForMap("SELECT id, name, zeitzone, created_by "
                + "FROM unternehmen WHERE tenant_id = ?::uuid", tenant);
        assertThat(u.get("name")).isEqualTo("Kunststoffwerk Ahrenberg GmbH");
        assertThat(u.get("zeitzone")).isEqualTo("Europe/Berlin");
        assertThat(u.get("created_by")).isNull();
        Map<String, Object> eintrag = admin.queryForMap("SELECT art, gilt_ab, rueckwirkend, "
                + "akteur_sub, akteur_name, neu::text AS neu FROM ort_aenderung "
                + "WHERE objekt_art = 'unternehmen' AND objekt_id = ?", u.get("id"));
        assertThat(eintrag.get("art")).isEqualTo("angelegt");
        assertThat(eintrag.get("rueckwirkend")).isEqualTo(false);
        assertThat(eintrag.get("akteur_sub")).isNull();
        assertThat(eintrag.get("akteur_name")).isEqualTo("VoltPilot");
        assertThat(eintrag.get("gilt_ab").toString()).isEqualTo(LocalDate.now(BERLIN).toString());
        assertThat((String) eintrag.get("neu")).contains("Kunststoffwerk Ahrenberg GmbH");

        JsonNode sicht = ok(get("/api/v1/unternehmen", adminToken, tenant));
        assertThat(sicht.path("zustand").asText()).isEqualTo("angelegt");
        assertThat(sicht.path("id").asText()).isEqualTo(u.get("id").toString());
        assertThat(sicht.path("name").asText()).isEqualTo("Kunststoffwerk Ahrenberg GmbH");
        assertThat(sicht.path("zeitzone").asText()).isEqualTo("Europe/Berlin");
        assertThat(sicht.path("standortZahl").asInt()).isZero();
        assertThat(sicht.path("anlagenZahl").asInt()).isZero();
        assertThat(sicht.path("nochNichtZugeordnetZahl").asInt()).isZero();

        // Mandant ohne Standorte: leere Listen, keine Gruppe — nie ein 0-Objekt.
        JsonNode liste = ok(get("/api/v1/standorte", adminToken, tenant));
        assertThat(liste.path("standorte").isArray()).isTrue();
        assertThat(liste.path("standorte")).isEmpty();
        assertThat(liste.path("nichtGezeigt")).isEmpty();
        assertThat(liste.path("nochNichtZugeordnet").isNull()).isTrue();
        assertThat(liste.path("stichtag").asText()).isEqualTo(LocalDate.now(BERLIN).toString());
    }

    // -------------------------------------- (2) Kundenbereich ohne Unternehmen

    @Test
    void einKundenbereichOhneUnternehmenZeileIstEinBenannterZustandNieEin500() {
        // Ein Mandant, der am Anlege-Weg vorbei entstand (wie vor IP-3 jeder nach
        // der Migration): keine Unternehmen-Zeile.
        String tenant = admin.queryForObject(
                "INSERT INTO tenant (name) VALUES ('Ohne Unternehmen GmbH') RETURNING id::text",
                String.class);
        String adminToken = token("admin", "admin");

        JsonNode sicht = ok(get("/api/v1/unternehmen", adminToken, tenant));
        assertThat(sicht.path("zustand").asText()).isEqualTo("nicht_angelegt");
        assertThat(sicht.path("id").isNull()).isTrue();
        assertThat(sicht.path("name").isNull()).isTrue();
        assertThat(sicht.path("zeitzone").isNull()).isTrue();
        assertThat(sicht.path("standortZahl").asInt()).isZero();
        assertThat(ok(get("/api/v1/standorte", adminToken, tenant)).path("standorte")).isEmpty();

        // Ohne gewählten Mandanten: RLS default-deny — 404 wie /tenant-context.
        assertThat(get("/api/v1/unternehmen", adminToken, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ------------------------------------------------ (3) A5 + A15 Bestand

    @Test
    void a5BestandskundeMitEinerAnlageErstNochNichtZugeordnetDannAmStandort() {
        String adminToken = token("admin", "admin");
        String tenant = neuerKundenbereich(adminToken, "Kunststoffwerk Ahrenberg GmbH");
        String site = neueAnlage(adminToken, tenant, "Werk Ahrenberg – Halle 1");

        // Vorher (heute jeder Bestandskunde): kein Standort, die Anlage in der Gruppe.
        JsonNode vorher = ok(get("/api/v1/standorte", adminToken, tenant));
        assertThat(vorher.path("standorte")).isEmpty();
        assertThat(vorher.path("nochNichtZugeordnet").path("anlagenZahl").asInt()).isEqualTo(1);
        assertThat(vorher.path("nochNichtZugeordnet").path("anlagen").get(0).path("name").asText())
                .isEqualTo("Werk Ahrenberg – Halle 1");
        JsonNode u = ok(get("/api/v1/unternehmen", adminToken, tenant));
        assertThat(u.path("standortZahl").asInt()).isZero();
        assertThat(u.path("anlagenZahl").asInt()).isEqualTo(1);
        assertThat(u.path("nochNichtZugeordnetZahl").asInt()).isEqualTo(1);
        assertThat(overviewZeile(adminToken, tenant, site).path("standort").isNull()).isTrue();
        assertThat(ok(get("/api/v1/sites/" + site, adminToken, tenant)).path("standort").isNull())
                .isTrue();

        // Nachher — wie die Bestandsübernahme (IP-9) es anlegt: Standort mit dem
        // Namen der Anlage, Entwurf ohne Adresse, Zuordnung ab dem 12.03.2024.
        UUID standort = alsMandant(tenant, () -> {
            UUID un = unternehmen.desKundenbereichs().orElseThrow().id();
            UUID st = standorte.anlegen(new StandortRepository.NeuerStandort(UUID.fromString(tenant),
                    un, "Werk Ahrenberg – Halle 1", "ST-1", null, null, null, null,
                    "Europe/Berlin", null, null, null, null, "entwurf", null));
            anlageZuordnungen.zuordnen(UUID.fromString(tenant), UUID.fromString(site), st,
                    LocalDate.of(2024, 3, 12), null, null);
            return st;
        });

        JsonNode nachher = ok(get("/api/v1/standorte", adminToken, tenant));
        // A15: alles zugeordnet — die Gruppe existiert nicht mehr (kein „0 nicht zugeordnet").
        assertThat(nachher.path("nochNichtZugeordnet").isNull()).isTrue();
        JsonNode st = nachher.path("standorte").get(0);
        assertThat(st.path("id").asText()).isEqualTo(standort.toString());
        assertThat(st.path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(st.path("zustand").asText()).isEqualTo("entwurf");
        assertThat(st.path("esFehlt").get(0).asText()).isEqualTo("adresse");
        assertThat(st.path("adresse").isNull()).isTrue();
        assertThat(st.path("anlagenZahl").asInt()).isEqualTo(1);
        assertThat(st.path("anlagen").get(0).path("gueltigAb").asText()).isEqualTo("2024-03-12");
        // Ohne Gebäude und ohne eigene Fläche: null, nie 0.
        assertThat(st.path("flaecheM2").isNull()).isTrue();
        assertThat(st.path("gebaeudeZahl").asInt()).isZero();

        JsonNode un = ok(get("/api/v1/unternehmen", adminToken, tenant));
        assertThat(un.path("standortZahl").asInt()).isEqualTo(1);
        assertThat(un.path("nochNichtZugeordnetZahl").asInt()).isZero();

        JsonNode bezug = overviewZeile(adminToken, tenant, site).path("standort");
        assertThat(feldnamen(bezug)).containsExactly("id", "name", "kurzzeichen", "gueltigAb");
        assertThat(bezug.path("id").asText()).isEqualTo(standort.toString());
        assertThat(bezug.path("name").asText()).isEqualTo("Werk Ahrenberg – Halle 1");
        assertThat(bezug.path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(bezug.path("gueltigAb").asText()).isEqualTo("2024-03-12");
        assertThat(ok(get("/api/v1/sites/" + site, adminToken, tenant)).path("standort"))
                .isEqualTo(bezug);
    }

    // ------------------------------------------------------- (4) A12 Stand am

    @Test
    void a12StandAmDreiStichtageAufDemReferenzunternehmen() throws Exception {
        String adminToken = token("admin", "admin");
        Map<String, UUID> ids = ahrenberg(adminToken);

        JsonNode feb = ok(get("/api/v1/standorte?stichtag=2027-02-15", adminToken, ahrenbergTenant));
        assertThat(kurzzeichen(feb.path("standorte"))).containsExactly("ST-1", "ST-2");
        JsonNode werk = feb.path("standorte").get(0);
        assertThat(werk.path("name").asText()).isEqualTo("Werk Ahrenberg");
        assertThat(werk.path("adresse").path("strasse").asText()).isEqualTo("Gewerbering 7");
        assertThat(werk.path("adresse").path("ort").asText()).isEqualTo("Ahrenberg");
        assertThat(werk.path("adresse").path("plz").isNull()).isTrue();
        // A16: der Standort trägt die Zeitzone, Gebäude und Bereiche tragen keine.
        assertThat(werk.path("zeitzone").asText()).isEqualTo("Europe/Berlin");
        assertThat(werk.path("gebaeudeZahl").asInt()).isEqualTo(3);
        assertThat(werk.path("flaecheM2").asInt()).isEqualTo(8450);
        assertThat(werk.path("flaecheQuelle").asText()).isEqualTo("eigen");
        assertThat(namen(werk.path("anlagen")))
                .containsExactly("Werk Ahrenberg – Halle 1", "Werk Ahrenberg – Halle 2");
        assertThat(werk.path("anlagen").get(1).path("gueltigBis").asText()).isEqualTo("2027-02-28");
        assertThat(feb.path("nichtGezeigt").get(0).path("bestandText").asText())
                .isEqualTo("Am 15.02.2027 gab es Werk Ahrenberg Nord im Portal noch nicht.");
        assertThat(feb.path("nochNichtZugeordnet").isNull()).isTrue();

        JsonNode mrz = ok(get("/api/v1/standorte?stichtag=2027-03-15", adminToken, ahrenbergTenant));
        assertThat(kurzzeichen(mrz.path("standorte"))).containsExactly("ST-1", "ST-2", "ST-3");
        assertThat(mrz.path("standorte").get(0).path("gebaeudeZahl").asInt()).isEqualTo(2);
        JsonNode nord = mrz.path("standorte").get(2);
        assertThat(nord.path("gebaeudeZahl").asInt()).isEqualTo(1);
        assertThat(nord.path("flaecheM2").asInt()).isEqualTo(3400);
        assertThat(nord.path("flaecheQuelle").asText()).isEqualTo("aus_gebaeuden_summiert");
        assertThat(namen(nord.path("anlagen"))).containsExactly("Werk Ahrenberg – Halle 2");
        assertThat(nord.path("anlagen").get(0).path("gueltigAb").asText()).isEqualTo("2027-03-01");

        JsonNode sep = ok(get("/api/v1/standorte?stichtag=2026-09-15", adminToken, ahrenbergTenant));
        assertThat(sep.path("standorte")).isEmpty();
        assertThat(sep.path("nichtGezeigt").get(0).path("bestandText").asText())
                .isEqualTo("Am 15.09.2026 gab es Werk Ahrenberg im Portal noch nicht.");
        assertThat(sep.path("nochNichtZugeordnet").path("anlagenZahl").asInt()).isEqualTo(3);

        // Derselbe Eintrag einzeln — auch, wenn es ihn am Stichtag nicht gab.
        JsonNode einzeln = ok(get("/api/v1/standorte/" + ids.get("ST-3") + "?stichtag=2027-02-15",
                adminToken, ahrenbergTenant));
        assertThat(einzeln.path("bestand").asText()).isEqualTo("gab_es_noch_nicht");
        assertThat(einzeln.path("anlagen")).isEmpty();
        assertThat(einzeln.path("gebaeudeZahl").isNull()).isTrue();
        assertThat(get("/api/v1/standorte?stichtag=15.02.2027", adminToken, ahrenbergTenant)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ----------------------------------------------------------- (5) A14 Zaun

    @Test
    void a14EinFremderStandortIst404NieEin403() throws Exception {
        String adminToken = token("admin", "admin");
        UUID werk = ahrenberg(adminToken).get("ST-1");

        // Ein Kunde eines anderen Kundenbereichs: 404, und in seiner Liste fehlt er.
        String demo2 = token("demo2", "demo2");
        assertThat(get("/api/v1/standorte/" + werk, demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(ok(get("/api/v1/standorte", demo2, null)).toString())
                .doesNotContain(werk.toString());
        // Ein Admin, der auf einen anderen Mandanten geschaltet hat, ebenso.
        String anderer = neuerKundenbereich(adminToken, "Anderer Kundenbereich GmbH");
        assertThat(get("/api/v1/standorte/" + werk, adminToken, anderer).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(get("/api/v1/standorte/" + UUID.randomUUID(), adminToken, ahrenbergTenant)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // Und die fremde Anlage selbst bleibt 404 wie jede fremde Anlage.
        assertThat(get("/api/v1/sites/" + ahrenberg.get("AN-1"), demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ------------------------------------- (6) bestehende Felder unverändert

    @Test
    void overviewUndSiteBehaltenJedesFeldUndBekommenStandortAmEnde() {
        String demo = token("demo", "demo");

        JsonNode overview = ok(get("/api/v1/overview", demo, null));
        assertThat(overview.path("sites")).isNotEmpty();
        List<String> erwartet = new ArrayList<>(OVERVIEW_SITE_FELDER);
        erwartet.add("standort");
        for (JsonNode zeile : overview.path("sites")) {
            assertThat(feldnamen(zeile)).containsExactlyElementsOf(erwartet);
            assertThat(zeile.path("standort").isNull()).isTrue();
        }
        assertThat(feldnamen(overview)).containsExactly("sites", "totals", "dailySavings");

        // /sites/{id}: die Listen-Zeile, zeichengleich, plus standort am Ende.
        JsonNode liste = ok(get("/api/v1/sites", demo, null));
        JsonNode ausListe = null;
        for (JsonNode s : liste) {
            if (BERLIN_SITE.equals(s.path("id").asText())) {
                ausListe = s;
            }
        }
        assertThat(ausListe).isNotNull();
        JsonNode einzeln = ok(get("/api/v1/sites/" + BERLIN_SITE, demo, null));
        List<String> felder = feldnamen(ausListe);
        felder.add("standort");
        assertThat(feldnamen(einzeln)).containsExactlyElementsOf(felder);
        assertThat(einzeln.path("standort").isNull()).isTrue();
        ObjectNode ohne = einzeln.deepCopy();
        ohne.remove("standort");
        assertThat(ohne.toString()).isEqualTo(ausListe.toString());
        // Eine fremde Anlage bleibt 404.
        assertThat(get("/api/v1/sites/" + BERLIN_SITE, token("demo2", "demo2"), null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ------------------------------------------------------------------ Hilfen

    /**
     * Das Referenzunternehmen Kunststoffwerk Ahrenberg GmbH, über die Repositories
     * gesät: Stammdaten und Adressen aus {@code uems-referenzunternehmen.json},
     * Baum, Intervalle, Flächen und Anlagen-Zuordnungen aus dem Szenario
     * {@code ahrenberg} des Ortsbaum-Vertrags (der Neukunden-Weg mit dem Umzug von
     * Halle 2 nach Werk Ahrenberg Nord am 01.03.2027). Ein Standort besteht ab
     * seinem Anlegen: {@code created_at} ist der erste Tag seines Intervalls.
     */
    private synchronized Map<String, UUID> ahrenberg(String adminToken) throws Exception {
        if (ahrenberg != null) {
            return ahrenberg;
        }
        JsonNode ref = MAPPER.readTree(Files.readString(REFERENZ));
        JsonNode s = MAPPER.readTree(Files.readString(VEKTOREN)).path("szenarien").path("ahrenberg");
        String tenant = neuerKundenbereich(adminToken, ref.path("unternehmen").path("name").asText());
        Map<String, UUID> ids = new LinkedHashMap<>();
        for (JsonNode a : s.path("anlagen")) {
            ids.put(a.path("kennzeichen").asText(),
                    UUID.fromString(neueAnlage(adminToken, tenant, a.path("name").asText())));
        }
        Map<String, JsonNode> adressen = new LinkedHashMap<>();
        ref.path("standorte").forEach(x -> adressen.put(x.path("kennzeichen").asText(),
                x.path("adresse")));
        UUID t = UUID.fromString(tenant);
        alsMandant(tenant, () -> {
            app.update("UPDATE unternehmen SET kurzname = ?",
                    ref.path("unternehmen").path("kurzname").asText());
            UUID un = unternehmen.desKundenbereichs().orElseThrow().id();
            Map<String, String> art = new LinkedHashMap<>();
            for (JsonNode o : s.path("orte")) {
                String kz = o.path("kennzeichen").asText();
                art.put(kz, o.path("art").asText());
                if ("standort".equals(o.path("art").asText())) {
                    JsonNode a = adressen.get(kz);
                    UUID st = standorte.anlegen(new StandortRepository.NeuerStandort(t, un,
                            o.path("name").asText(), kz, text(a, "strasse"), text(a, "plz"),
                            text(a, "ort"), text(a, "land"), o.path("zeitzone").asText(), null,
                            null, null, null, "aktiv", "test"));
                    LocalDate ab = LocalDate.parse(o.path("intervalle").get(0).path("ab").asText());
                    app.update("UPDATE standort SET created_at = ? WHERE id = ?",
                            Timestamp.from(ab.atStartOfDay(BERLIN).toInstant()), st);
                    ids.put(kz, st);
                } else {
                    ids.put(kz, orte.anlegen(new OrtRepository.NeuerOrt(t, o.path("art").asText(),
                            o.path("name").asText(), kz, null, null, null, "aktiv", "test")));
                }
            }
            for (JsonNode o : s.path("orte")) {
                UUID ort = ids.get(o.path("kennzeichen").asText());
                boolean istStandort = "standort".equals(o.path("art").asText());
                for (JsonNode f : o.path("flaechen")) {
                    flaechen.eintragen(t, istStandort ? ort : null, istStandort ? null : ort,
                            f.path("m2").asInt(), tag(f.path("ab")), tag(f.path("bis")), "test");
                }
                if (istStandort) {
                    continue;
                }
                for (JsonNode iv : o.path("intervalle")) {
                    String eltern = iv.path("eltern").asText();
                    boolean anStandort = "standort".equals(art.get(eltern));
                    ortZuordnungen.zuordnen(t, ort, anStandort ? ids.get(eltern) : null,
                            anStandort ? null : ids.get(eltern), tag(iv.path("ab")),
                            tag(iv.path("bis")), "test");
                }
            }
            for (JsonNode a : s.path("anlagen")) {
                for (JsonNode iv : a.path("zuordnungen")) {
                    anlageZuordnungen.zuordnen(t, ids.get(a.path("kennzeichen").asText()),
                            ids.get(iv.path("eltern").asText()), tag(iv.path("ab")),
                            tag(iv.path("bis")), "test");
                }
            }
            return null;
        });
        ahrenbergTenant = tenant;
        ahrenberg = ids;
        return ids;
    }

    /** Schreibt unter RLS als dieser Mandant — derselbe Zaun wie jede Kunden-Route. */
    private static <T> T alsMandant(String tenant, Callable<T> arbeit) {
        TenantContext.set(UUID.fromString(tenant));
        try {
            return arbeit.call();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        } finally {
            TenantContext.clear();
        }
    }

    private String neuerKundenbereich(String adminToken, String name) {
        ResponseEntity<JsonNode> r = exchange("/api/v1/admin/tenants", HttpMethod.POST, adminToken,
                null, Map.of("name", name));
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return r.getBody().path("id").asText();
    }

    private String neueAnlage(String adminToken, String tenant, String name) {
        ResponseEntity<JsonNode> r = exchange("/api/v1/sites", HttpMethod.POST, adminToken, tenant,
                Map.of("name", name));
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return r.getBody().path("id").asText();
    }

    private JsonNode overviewZeile(String token, String tenant, String site) {
        for (JsonNode z : ok(get("/api/v1/overview", token, tenant)).path("sites")) {
            if (site.equals(z.path("id").asText())) {
                return z;
            }
        }
        throw new AssertionError("Anlage " + site + " fehlt in /overview");
    }

    private static String text(JsonNode n, String feld) {
        return n == null || n.path(feld).isNull() || n.path(feld).isMissingNode()
                ? null : n.path(feld).asText();
    }

    private static LocalDate tag(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : LocalDate.parse(n.asText());
    }

    private static List<String> feldnamen(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.fieldNames().forEachRemaining(out::add);
        return out;
    }

    private static List<String> kurzzeichen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.path("kurzzeichen").asText()));
        return out;
    }

    private static List<String> namen(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.path("name").asText()));
        return out;
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode()).as("Antwort %s", r.getBody()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private ResponseEntity<JsonNode> get(String path, String token, String tenant) {
        return exchange(path, HttpMethod.GET, token, tenant, null);
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token,
            String tenant, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenant != null) {
            headers.set("X-Tenant-Id", tenant);
        }
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers)
                : new HttpEntity<>(headers);
        return rest.exchange("http://localhost:" + port + path, method, entity,
                new ParameterizedTypeReference<JsonNode>() {
                });
    }

    private String token(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
