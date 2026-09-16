package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
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
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
 * Die BESTANDSÜBERNAHME der Standorte an der echten Strecke (UEMS AP-02 IP-9), auf der
 * DEV-SAAT: {@code demo} (drei Anlagen) und {@code demo2} (eine Anlage) sind genau die zwei
 * Fälle des Entscheids E5.
 *
 * <p>Der Prüfnachweis des Konzepts (§8 IP-9):
 * <ul>
 *   <li><b>A5</b> — ein Kundenbereich mit genau einer Anlage bekommt Standort (Name der
 *       Anlage, Entwurf, es fehlt: Adresse) und Zuordnung ab dem Tag von
 *       {@code site.created_at}, Protokoll „VoltPilot (Bestandsübernahme)" — hier zweimal:
 *       für {@code demo2} und für das Referenzunternehmen mit seinem echten Datum
 *       (12.03.2024, also rückwirkend).</li>
 *   <li><b>A6/E5</b> — {@code demo} bekommt drei Vorschläge und KEINE Zuordnung.</li>
 *   <li><b>idempotent</b> — der zweite Lauf schreibt nichts.</li>
 *   <li><b>die Anlage bleibt unverändert</b> — {@code GET /api/v1/overview},
 *       {@code GET /api/v1/sites}, {@code GET /api/v1/sites/&#123;id&#125;} und das
 *       Cockpit-Layout sind byte-identisch bis auf das additive Feld {@code standort} der
 *       einen zugeordneten Anlage, und KEINE andere Tabelle ändert sich (Kommando-Journal,
 *       Fahrpläne, Komponenten, Registry eingeschlossen).</li>
 *   <li><b>{@code POST /api/v1/sites}</b> — ohne Standort wie heute, bei genau einem
 *       vorbelegt, bei mehreren 422 mit der Auswahl, ein archivierter 409, ein fremder
 *       400; und das Anlagen-Löschen bleibt unverändert (W5: die Zuordnung bleibt als
 *       beendetes Intervall mit Protokolleintrag).</li>
 *   <li><b>Zaun</b> — ein Kundenbereich sieht die Vorschläge und Standorte des anderen
 *       nicht.</li>
 * </ul>
 *
 * <p>Der Start-Lauf ist im Testlauf abgeschaltet (surefire-Eigenschaft); diese Klasse ruft
 * {@link BestandsuebernahmeLaeufer#lauf()} selbst — und in dieser Reihenfolge
 * ({@code @Order}), weil die Übernahme den Kundenbereich als Ganzes sieht.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class BestandsuebernahmeApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

    /** Die Dev-Saat (db/dev/V100, V20260706020000): drei Anlagen bzw. eine. */
    private static final String DEMO = "00000000-0000-0000-0000-000000000001";
    private static final String NORDWIND = "10000000-0000-0000-0000-000000000001";
    private static final String NORDWIND_SITE = "10000000-0000-0000-0000-000000000002";

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path REFERENZ =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");

    /** Die Tabellen, in die die Übernahme schreiben DARF — alle anderen bleiben zeichengleich. */
    private static final List<String> SCHREIBT_IN = List.of("standort", "anlage_standort",
            "ort_aenderung", "ort_kurzzeichen", "ort_kurzzeichen_seq", "standort_vorschlag");

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
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

    @Autowired
    JdbcTemplate app;

    @Autowired
    @Qualifier("adminJdbcTemplate")
    JdbcTemplate admin;

    @Autowired
    BestandsuebernahmeLaeufer laeufer;

    @Autowired
    BestandsuebernahmeService bestandsuebernahme;

    @Autowired
    StandortVorschlagRepository vorschlaege;

    @Autowired
    AnlageStandortRepository zuordnungen;

    @Autowired
    StandortRepository standorte;

    /** Der Kundenbereich des Referenzunternehmens (A5 mit dem echten Datum). */
    private static String ahrenbergTenant;
    private static String ahrenbergSite;
    private static String zweiterStandortDemo2;
    private static String ohneStandortTenant;

    // ---- (1) der Lauf: A5, A6 und „die Anlage bleibt unverändert" ------------

    @Test
    @Order(1)
    void a5UndA6UndDieAnlagenAntwortenBleibenZeichengleich() throws IOException {
        String adminToken = token("admin", "admin");
        // Das Referenzunternehmen als dritter Fall: eine Bestandsanlage seit dem 12.03.2024.
        JsonNode referenz = MAPPER.readTree(Files.readString(REFERENZ));
        JsonNode an1 = referenz.get("anlagen").get(0);
        ahrenbergTenant = neuerKundenbereich(adminToken, referenz.at("/unternehmen/name").asText());
        ahrenbergSite = neueAnlage(adminToken, ahrenbergTenant, an1.get("name").asText());
        admin.update("UPDATE site SET created_at = ? WHERE id = ?::uuid",
                Timestamp.from(OffsetDateTime.parse(an1.get("seit").asText()).toInstant()), ahrenbergSite);

        Map<String, String> tabellenVorher = tabellenStand();
        JsonNode overviewDemoVorher = ok(get("/api/v1/overview", adminToken, DEMO));
        JsonNode overviewNordwindVorher = ok(get("/api/v1/overview", adminToken, NORDWIND));
        JsonNode sitesDemoVorher = ok(get("/api/v1/sites", adminToken, DEMO));
        JsonNode sitesNordwindVorher = ok(get("/api/v1/sites", adminToken, NORDWIND));
        JsonNode hamburgVorher = ok(get("/api/v1/sites/" + NORDWIND_SITE, adminToken, NORDWIND));
        JsonNode cockpitVorher = ok(get("/api/v1/sites/" + NORDWIND_SITE + "/cockpit-layout",
                adminToken, NORDWIND));
        assertThat(hamburgVorher.path("standort").isNull()).isTrue();

        BestandsuebernahmeLaeufer.Lauf lauf = laeufer.lauf();
        assertThat(lauf.fehler()).isZero();
        assertThat(lauf.standorteAngelegt()).isEqualTo(2);
        assertThat(lauf.zuordnungen()).isEqualTo(2);
        assertThat(lauf.vorschlaege()).isEqualTo(3);

        // ---- A5: demo2 („Nordwind Energie", eine Anlage) --------------------
        LocalDate hamburgAb = tagVon(NORDWIND_SITE);
        Map<String, Object> st = admin.queryForMap("SELECT id, name, kurzzeichen, zustand, strasse, plz, "
                + "ort, land, zeitzone, nutzung, notiz, lage_breitengrad, created_by "
                + "FROM standort WHERE tenant_id = ?::uuid", NORDWIND);
        assertThat(st.get("name")).isEqualTo("Nordwind Hamburg");
        assertThat(st.get("kurzzeichen")).isEqualTo("ST-1");
        assertThat(st.get("zustand")).isEqualTo("entwurf");
        assertThat(st.get("strasse")).isNull();
        assertThat(st.get("plz")).isNull();
        assertThat(st.get("ort")).isNull();
        assertThat(st.get("land")).isNull();
        assertThat(st.get("nutzung")).isNull();
        assertThat(st.get("notiz")).isNull();
        assertThat(st.get("lage_breitengrad")).as("keine erfundene Lage").isNull();
        assertThat(st.get("zeitzone")).isEqualTo("Europe/Berlin");
        assertThat(st.get("created_by")).as("VoltPilot selbst, keine Person").isNull();

        Map<String, Object> zu = admin.queryForMap("SELECT site_id, standort_id, gueltig_ab, gueltig_bis, "
                + "aufgehoben_am, created_by FROM anlage_standort WHERE tenant_id = ?::uuid", NORDWIND);
        assertThat(zu.get("site_id").toString()).isEqualTo(NORDWIND_SITE);
        assertThat(zu.get("standort_id")).isEqualTo(st.get("id"));
        assertThat(zu.get("gueltig_ab").toString()).isEqualTo(hamburgAb.toString());
        assertThat(zu.get("gueltig_bis")).isNull();
        assertThat(zu.get("aufgehoben_am")).isNull();
        assertThat(zu.get("created_by")).isNull();

        List<Map<String, Object>> protokoll = protokoll(NORDWIND);
        assertThat(protokoll).hasSize(2);
        assertThat(protokoll).allSatisfy(e -> {
            assertThat(e.get("actor_name")).isEqualTo("VoltPilot (Bestandsübernahme)");
            assertThat(e.get("actor_sub")).isNull();
            assertThat(e.get("gilt_ab").toString()).isEqualTo(hamburgAb.toString());
        });
        Map<String, Object> standortEintrag = eintrag(protokoll, "standort");
        assertThat(standortEintrag.get("art")).isEqualTo("angelegt");
        assertThat(standortEintrag.get("objekt_id")).isEqualTo(st.get("id"));
        JsonNode standortFelder = json(standortEintrag.get("neu"));
        assertThat(standortFelder.path("zustand").asText()).isEqualTo("entwurf");
        assertThat(standortFelder.path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(standortFelder.path("name").asText()).isEqualTo("Nordwind Hamburg");
        assertThat(standortFelder.path("adresse").path("strasse").isNull()).isTrue();
        Map<String, Object> anlageEintrag = eintrag(protokoll, "anlage");
        assertThat(anlageEintrag.get("art")).isEqualTo("verschoben");
        assertThat(anlageEintrag.get("objekt_id").toString()).isEqualTo(NORDWIND_SITE);
        assertThat(anlageEintrag.get("alt")).isNull();
        JsonNode zuordnungsFelder = json(anlageEintrag.get("neu"));
        assertThat(zuordnungsFelder.path("standort_kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(zuordnungsFelder.path("standort_id").asText()).isEqualTo(st.get("id").toString());
        assertThat(zuordnungsFelder.path("anlage_name").asText()).isEqualTo("Nordwind Hamburg");

        // Das Lesemodell zeigt ihn: Entwurf mit „es fehlt: Adresse" und der Anlage ab dem Tag.
        JsonNode sicht = ok(get("/api/v1/standorte", adminToken, NORDWIND)).path("standorte").get(0);
        assertThat(sicht.path("zustand").asText()).isEqualTo("entwurf");
        assertThat(sicht.path("esFehlt").get(0).asText()).isEqualTo("adresse");
        assertThat(sicht.path("anlagen").get(0).path("gueltigAb").asText()).isEqualTo(hamburgAb.toString());

        // ---- A5 mit dem echten Datum: das Referenzunternehmen ---------------
        Map<String, Object> ahrenbergStandort = admin.queryForMap("SELECT id, name, zustand, kurzzeichen "
                + "FROM standort WHERE tenant_id = ?::uuid", ahrenbergTenant);
        assertThat(ahrenbergStandort.get("name")).isEqualTo(an1.get("name").asText());
        assertThat(ahrenbergStandort.get("zustand")).isEqualTo("entwurf");
        assertThat(admin.queryForObject("SELECT gueltig_ab FROM anlage_standort WHERE tenant_id = ?::uuid",
                LocalDate.class, ahrenbergTenant)).isEqualTo(LocalDate.parse("2024-03-12"));
        // Die zwei Einträge der Übernahme (Standort und Zuordnung) gelten ab dem 12.03.2024 —
        // rückwirkend (E2); der dritte am Unternehmen stammt aus V20260911100000.
        assertThat(protokoll(ahrenbergTenant)).hasSize(2).allSatisfy(e -> {
            assertThat(e.get("actor_name")).isEqualTo("VoltPilot (Bestandsübernahme)");
            assertThat(e.get("gilt_ab").toString()).isEqualTo("2024-03-12");
            assertThat(e.get("rueckwirkend")).as("die Übernahme trägt die Vergangenheit nach")
                    .isEqualTo(true);
        });
        assertThat(protokoll(ahrenbergTenant)).extracting(e -> e.get("objekt_art") + "/" + e.get("art"))
                .containsExactly("standort/angelegt", "anlage/verschoben");

        // ---- A6: demo (drei Anlagen) → drei Vorschläge, KEINE Zuordnung -----
        assertThat(anzahl("SELECT count(*) FROM standort WHERE tenant_id = ?::uuid", DEMO)).isZero();
        assertThat(anzahl("SELECT count(*) FROM anlage_standort WHERE tenant_id = ?::uuid", DEMO)).isZero();
        assertThat(protokoll(DEMO)).as("ein Vorschlag ändert die Ortsstruktur nicht").isEmpty();
        List<Map<String, Object>> vorschlaegeDemo = admin.queryForList("SELECT v.name, v.zeitzone, "
                + "v.gueltig_ab, v.created_by, s.name AS anlage FROM standort_vorschlag v "
                + "JOIN site s ON s.id = v.site_id WHERE v.tenant_id = ?::uuid ORDER BY v.created_at", DEMO);
        assertThat(vorschlaegeDemo).hasSize(3);
        assertThat(vorschlaegeDemo).allSatisfy(v -> {
            assertThat(v.get("name")).as("ein Standort gleichen Namens").isEqualTo(v.get("anlage"));
            assertThat(v.get("zeitzone")).isEqualTo("Europe/Berlin");
            assertThat(v.get("created_by")).isNull();
        });
        assertThat(vorschlaegeDemo).extracting(v -> v.get("name"))
                .containsExactlyInAnyOrder("Demo Site Berlin", "Solarpark Dachau", "Hof Lindenberg");

        // ---- Die Anlage bleibt unverändert (A5) -----------------------------
        assertThat(ok(get("/api/v1/overview", adminToken, DEMO))).isEqualTo(overviewDemoVorher);
        assertThat(ok(get("/api/v1/sites", adminToken, DEMO))).isEqualTo(sitesDemoVorher);
        assertThat(ohneStandort(ok(get("/api/v1/sites", adminToken, NORDWIND))))
                .isEqualTo(ohneStandort(sitesNordwindVorher));
        assertThat(ok(get("/api/v1/sites/" + NORDWIND_SITE + "/cockpit-layout", adminToken, NORDWIND)))
                .isEqualTo(cockpitVorher);
        // … bis auf das EINE additive Feld der zugeordneten Anlage.
        JsonNode hamburgNachher = ok(get("/api/v1/sites/" + NORDWIND_SITE, adminToken, NORDWIND));
        assertThat(ohneStandort(hamburgNachher)).isEqualTo(ohneStandort(hamburgVorher));
        assertThat(hamburgNachher.path("standort").path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(hamburgNachher.path("standort").path("gueltigAb").asText())
                .isEqualTo(hamburgAb.toString());
        JsonNode overviewNordwindNachher = ok(get("/api/v1/overview", adminToken, NORDWIND));
        assertThat(ohneStandort(overviewNordwindNachher)).isEqualTo(ohneStandort(overviewNordwindVorher));
        // Vorher gab es keinen Standort, nachher genau den EINEN, den die Übernahme angelegt hat - die
        // Teilansicht zählt Standorte, und ein unternehmensweiter Zugriff sieht sie alle (AP-03 IP-10).
        assertThat(overviewNordwindVorher.path("teilansicht").path("gesamt").asInt()).isZero();
        assertThat(overviewNordwindNachher.path("teilansicht").path("sichtbar").asInt()).isEqualTo(1);
        assertThat(overviewNordwindNachher.path("teilansicht").path("gesamt").asInt()).isEqualTo(1);

        // … und KEINE andere Tabelle: kein Kommando, kein Fahrplan, keine Komponente, kein Push.
        Map<String, String> tabellenNachher = tabellenStand();
        assertThat(tabellenNachher.keySet()).isEqualTo(tabellenVorher.keySet());
        assertThat(Bestandsschutz.abweichungen(tabellenVorher, tabellenNachher)).isEmpty();
    }

    /** Der Vergleich beißt noch: eine geänderte Anlage fällt auf, eine leere neue Spalte nicht. */
    @Test
    @Order(1)
    void derTabellenvergleichFaengtEineGeaenderteZeile() {
        JdbcTemplate root = new JdbcTemplate(new DriverManagerDataSource(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword()));
        Bestandsschutz.mutationsprobe(root, SCHREIBT_IN, "site", "UPDATE site SET name = name || ' (Probe)'");
    }

    /** A6/A15: Lesen schreibt nichts; Bestätigen legt zwei Anlagen auf EINEN Standort und räumt die Karte ab. */
    @Test
    @Order(7)
    void vorschauZusammenlegenUndBestaetigen() {
        String adminToken = token("admin", "admin");
        String tenant = neuerKundenbereich(adminToken, "Vorschau Kunststoff GmbH");
        String halle1 = neueAnlage(adminToken, tenant, "Werk Ahrenberg – Halle 1");
        String halle2 = neueAnlage(adminToken, tenant, "Werk Ahrenberg – Halle 2");
        admin.update("UPDATE site SET created_at = '2025-01-03T09:00:00Z' WHERE id = ?::uuid", halle1);
        admin.update("UPDATE site SET created_at = '2025-06-04T09:00:00Z' WHERE id = ?::uuid", halle2);
        alsMandant(tenant, () -> bestandsuebernahme.uebernehmen());

        long standorteVorher = anzahl("SELECT count(*) FROM standort WHERE tenant_id = ?::uuid", tenant);
        long zuordnungenVorher = anzahl("SELECT count(*) FROM anlage_standort WHERE tenant_id = ?::uuid", tenant);
        JsonNode vorschau = ok(get("/api/v1/standorte/vorschlag", adminToken, tenant));
        assertThat(vorschau.path("anlagenZahl").asInt()).isEqualTo(2);
        assertThat(vorschau.path("gruppen")).hasSize(2);
        assertThat(anzahl("SELECT count(*) FROM standort WHERE tenant_id = ?::uuid", tenant)).isEqualTo(standorteVorher);
        assertThat(anzahl("SELECT count(*) FROM anlage_standort WHERE tenant_id = ?::uuid", tenant)).isEqualTo(zuordnungenVorher);
        assertThat(protokoll(tenant)).isEmpty();

        List<String> ids = new java.util.ArrayList<>();
        vorschau.path("gruppen").forEach(g -> ids.add(g.path("anlagen").get(0).path("vorschlagId").asText()));
        Map<String, Object> gruppe = new LinkedHashMap<>();
        gruppe.put("name", "Werk Ahrenberg");
        gruppe.put("zeitzone", "Europe/Berlin");
        gruppe.put("adresse", Map.of("strasse", "Gewerbering 7", "plz", "84123", "ort", "Ahrenberg", "land", "DE"));
        gruppe.put("vorschlagIds", ids);
        JsonNode ergebnis = ok(exchange("/api/v1/standorte/vorschlag/bestaetigen", HttpMethod.POST,
                adminToken, tenant, Map.of("gruppen", List.of(gruppe))));
        assertThat(ergebnis.path("standortIds")).hasSize(1);
        assertThat(ergebnis.path("zuordnungen").asInt()).isEqualTo(2);
        assertThat(anzahl("SELECT count(*) FROM standort WHERE tenant_id = ?::uuid", tenant)).isOne();
        assertThat(anzahl("SELECT count(*) FROM anlage_standort WHERE tenant_id = ?::uuid", tenant)).isEqualTo(2);
        assertThat(anzahl("SELECT count(*) FROM standort_vorschlag WHERE tenant_id = ?::uuid", tenant)).isZero();
        assertThat(admin.queryForList("SELECT gueltig_ab FROM anlage_standort WHERE tenant_id = ?::uuid ORDER BY gueltig_ab", tenant))
                .extracting(x -> x.get("gueltig_ab").toString()).containsExactly("2025-01-03", "2025-06-04");
        assertThat(protokoll(tenant)).extracting(x -> x.get("objekt_art") + "/" + x.get("art"))
                .containsExactly("standort/angelegt", "anlage/verschoben", "anlage/verschoben");
        assertThat(ok(get("/api/v1/standorte", adminToken, tenant)).path("nochNichtZugeordnet").isNull()).isTrue();
        assertThat(ok(get("/api/v1/standorte/vorschlag", adminToken, tenant)).path("gruppen")).isEmpty();
    }

    /** Die Übernahme kennt keinen Publisher — sie KANN nichts an eine Box schicken. */
    @Test
    @Order(1)
    void keinDienstDerUebernahmeKenntEinenPublisher() {
        for (Class<?> c : List.of(BestandsuebernahmeLaeufer.class, BestandsuebernahmeService.class,
                AnlageStandortService.class)) {
            for (Constructor<?> k : c.getDeclaredConstructors()) {
                for (Class<?> p : k.getParameterTypes()) {
                    assertThat(p.getSimpleName()).as("%s hängt an %s", c.getSimpleName(), p.getName())
                            .doesNotContain("Publisher").doesNotContain("Mqtt");
                }
            }
        }
    }

    // ---- (2) idempotent -----------------------------------------------------

    @Test
    @Order(2)
    void derZweiteLaufSchreibtNichts() {
        Map<String, String> vorher = uemsStand();
        BestandsuebernahmeLaeufer.Lauf lauf = laeufer.lauf();
        assertThat(lauf.geaendert()).isFalse();
        assertThat(lauf.fehler()).isZero();
        assertThat(lauf.standorteAngelegt()).isZero();
        assertThat(lauf.zuordnungen()).isZero();
        assertThat(lauf.vorschlaege()).isZero();
        assertThat(uemsStand()).isEqualTo(vorher);
    }

    // ---- (3) POST /api/v1/sites ---------------------------------------------

    /**
     * Der heutige Anlege-Weg des Portals (ohne {@code standortId}): bei genau einem Standort
     * vorbelegt — und das Löschen bleibt unverändert, die Zuordnung bleibt als Grabstein (W5).
     */
    @Test
    @Order(3)
    void beiGenauEinemStandortIstErVorbelegtUndDasLoeschenLaesstDenGrabsteinStehen() {
        String token = token("demo2", "demo2");
        String site = ok201(exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", "Nordwind Cuxhaven"))).path("id").asText();
        LocalDate heute = LocalDate.now(BERLIN);

        JsonNode neu = ok(get("/api/v1/sites/" + site, token, null));
        assertThat(neu.path("standort").path("kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(neu.path("standort").path("gueltigAb").asText()).isEqualTo(heute.toString());
        Map<String, Object> eintrag = admin.queryForMap("SELECT art, actor_name, actor_sub, gilt_ab, "
                + "rueckwirkend FROM ort_aenderung WHERE objekt_art = 'anlage' AND objekt_id = ?::uuid", site);
        assertThat(eintrag.get("art")).isEqualTo("verschoben");
        assertThat(eintrag.get("actor_name")).as("die Person, nicht VoltPilot").isEqualTo("demo2");
        assertThat(eintrag.get("actor_sub")).isNotNull();
        assertThat(eintrag.get("rueckwirkend")).isEqualTo(false);

        // W5: löschen geht wie bisher — und die Zuordnung bleibt als beendetes Intervall.
        ResponseEntity<JsonNode> geloescht = exchange("/api/v1/sites/" + site, HttpMethod.DELETE, token,
                null, null);
        assertThat(geloescht.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(anzahl("SELECT count(*) FROM site WHERE id = ?::uuid", site)).isZero();
        Map<String, Object> grabstein = admin.queryForMap("SELECT gueltig_ab, gueltig_bis, aufgehoben_am "
                + "FROM anlage_standort WHERE site_id = ?::uuid", site);
        assertThat(grabstein.get("gueltig_bis").toString()).isEqualTo(heute.toString());
        assertThat(grabstein.get("aufgehoben_am")).isNull();
        Map<String, Object> grabsteinEintrag = admin.queryForMap("SELECT art, alt::text AS alt, "
                + "neu::text AS neu, actor_name FROM ort_aenderung WHERE objekt_art = 'anlage' "
                + "AND objekt_id = ?::uuid AND art = 'geloescht'", site);
        JsonNode alt = json(grabsteinEintrag.get("alt"));
        assertThat(alt.path("anlage_name").asText()).isEqualTo("Nordwind Cuxhaven");
        assertThat(alt.path("standort_kurzzeichen").asText()).isEqualTo("ST-1");
        assertThat(alt.path("gueltig_bis").isNull()).isTrue();
        assertThat(json(grabsteinEintrag.get("neu")).path("gueltig_bis").asText())
                .isEqualTo(heute.toString());
        assertThat(grabsteinEintrag.get("actor_name")).isEqualTo("demo2");
    }

    /** Ohne Standort im Kundenbereich bleibt alles, wie es war: keine Zuordnung, kein Protokoll. */
    @Test
    @Order(3)
    void ohneStandortLegtDasAnlegenAnWieBisher() {
        String adminToken = token("admin", "admin");
        ohneStandortTenant = neuerKundenbereich(adminToken, "Kundenbereich ohne Standort");
        String tenant = ohneStandortTenant;
        String site = neueAnlage(adminToken, tenant, "Erste Anlage");
        assertThat(ok(get("/api/v1/sites/" + site, adminToken, tenant)).path("standort").isNull()).isTrue();
        assertThat(anzahl("SELECT count(*) FROM anlage_standort WHERE tenant_id = ?::uuid", tenant)).isZero();
        assertThat(anzahl("SELECT count(*) FROM ort_aenderung WHERE objekt_art = 'anlage' "
                + "AND tenant_id = ?::uuid", tenant)).isZero();
    }

    /** Mehrere Standorte: die Wahl ist Pflicht (422 mit der Auswahl), sonst entsteht keine Anlage. */
    @Test
    @Order(4)
    void beiMehrerenStandortenIstDieWahlPflicht() {
        String token = token("demo2", "demo2");
        Map<String, Object> adresse = new LinkedHashMap<>();
        adresse.put("strasse", "Hafenstraße 3");
        adresse.put("plz", "27472");
        adresse.put("ort", "Cuxhaven");
        adresse.put("land", "DE");
        zweiterStandortDemo2 = ok201(exchange("/api/v1/standorte", HttpMethod.POST, token, null,
                Map.of("name", "Werk Cuxhaven", "adresse", adresse))).path("id").asText();
        long anlagenVorher = anzahl("SELECT count(*) FROM site WHERE tenant_id = ?::uuid", NORDWIND);

        ResponseEntity<JsonNode> abgelehnt = exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", "Nordwind Bremerhaven"));
        assertThat(abgelehnt.getStatusCode().value()).isEqualTo(422);
        assertThat(abgelehnt.getBody().path("code").asText()).isEqualTo("standort_waehlen");
        assertThat(abgelehnt.getBody().path("message").asText())
                .isEqualTo("Ihr Unternehmen hat 2 Standorte. Bitte wählen Sie, zu welchem Standort die "
                        + "neue Anlage gehört.");
        assertThat(abgelehnt.getBody().path("feld").asText()).isEqualTo("standortId");
        assertThat(abgelehnt.getBody().path("standorte")).hasSize(2);
        assertThat(abgelehnt.getBody().path("standorte").get(0).path("kurzzeichen").asText())
                .isEqualTo("ST-1");
        assertThat(anzahl("SELECT count(*) FROM site WHERE tenant_id = ?::uuid", NORDWIND))
                .as("eine abgelehnte Anfrage legt keine Anlage an").isEqualTo(anlagenVorher);

        // Mit Wahl: 201 und die Zuordnung an genau diesen Standort.
        String site = ok201(exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", "Nordwind Bremerhaven", "standortId", zweiterStandortDemo2))).path("id").asText();
        assertThat(ok(get("/api/v1/sites/" + site, token, null)).path("standort").path("id").asText())
                .isEqualTo(zweiterStandortDemo2);

        // Eine unbekannte oder fremde ID: 400 mit dem Feld — nie ein 500, nie ein 403.
        ResponseEntity<JsonNode> unbekannt = exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", "Nordwind Unbekannt", "standortId", UUID.randomUUID().toString()));
        assertThat(unbekannt.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(unbekannt.getBody().path("code").asText()).isEqualTo("anfrage_ungueltig");
        assertThat(unbekannt.getBody().path("feld").asText()).isEqualTo("standortId");
        String fremder = admin.queryForObject("SELECT id::text FROM standort WHERE tenant_id = ?::uuid",
                String.class, ahrenbergTenant);
        assertThat(exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", "Nordwind Fremd", "standortId", fremder)).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /** Ein archivierter Standort nimmt keine neue Anlage (409) — und danach ist wieder genau einer da. */
    @Test
    @Order(5)
    void einArchivierterStandortNimmtKeineAnlage() {
        String token = token("demo2", "demo2");
        // Die Anlage von Werk Cuxhaven zieht als Korrektur zurück, dann ist das Archivieren frei.
        alsMandant(NORDWIND, () -> {
            zuordnungen.alle().stream()
                    .filter(z -> z.standortId().toString().equals(zweiterStandortDemo2))
                    .forEach(z -> zuordnungen.aufheben(z.id(), Instant.now()));
            return null;
        });
        ok(exchange("/api/v1/standorte/" + zweiterStandortDemo2 + "/archivieren", HttpMethod.POST, token,
                null, null));

        ResponseEntity<JsonNode> r = exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", "Nordwind Archiv", "standortId", zweiterStandortDemo2));
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(r.getBody().path("code").asText()).isEqualTo("ziel_archiviert");
        assertThat(r.getBody().path("message").asText()).contains("Werk Cuxhaven");
    }

    // ---- (6) der Zaun und die Rücknahme --------------------------------------

    @Test
    @Order(6)
    void derZaunHaeltUndDieRuecknahmeBleibtStehen() {
        String demoToken = token("demo", "demo");
        // demo sieht seine drei Vorschläge — und keinen fremden Standort.
        assertThat(ok(get("/api/v1/standorte", demoToken, null)).path("standorte")).isEmpty();
        assertThat(alsMandant(DEMO, () -> vorschlaege.alle())).hasSize(3);
        assertThat(alsMandant(NORDWIND, () -> vorschlaege.alle())).isEmpty();
        assertThat(alsMandant(DEMO, () -> standorte.alle())).isEmpty();

        // Rücknahme (§6.3): Zuordnung aufheben, Standort archivieren — der nächste Lauf
        // legt NICHTS wieder an (auch ein archivierter Standort zählt).
        alsMandant(NORDWIND, () -> {
            zuordnungen.alle().forEach(z -> zuordnungen.aufheben(z.id(), Instant.now()));
            return null;
        });
        String token = token("demo2", "demo2");
        String ersterStandort = admin.queryForObject("SELECT id::text FROM standort "
                + "WHERE tenant_id = ?::uuid AND kurzzeichen = 'ST-1'", String.class, NORDWIND);
        ok(exchange("/api/v1/standorte/" + ersterStandort + "/archivieren", HttpMethod.POST, token,
                null, null));

        Map<String, String> vorher = uemsStand(NORDWIND);
        BestandsuebernahmeLaeufer.Lauf lauf = laeufer.lauf();
        assertThat(lauf.fehler()).isZero();
        assertThat(uemsStand(NORDWIND)).as("die Rücknahme bleibt stehen").isEqualTo(vorher);
        assertThat(anzahl("SELECT count(*) FROM standort WHERE tenant_id = ?::uuid", NORDWIND)).isEqualTo(2);

        // Derselbe Lauf holt dafür den Kundenbereich nach, der inzwischen seine erste Anlage
        // angelegt hat (ohne Standort blieb sie „noch nicht zugeordnet", §6.3) — genau die
        // Arbeit, für die der Läufer bei jedem Start geht.
        assertThat(lauf.standorteAngelegt()).isEqualTo(1);
        assertThat(admin.queryForObject("SELECT name FROM standort WHERE tenant_id = ?::uuid",
                String.class, ohneStandortTenant)).isEqualTo("Erste Anlage");
    }

    // ---- Gerüst --------------------------------------------------------------

    /** Der Tag von {@code site.created_at} in der Zeitzone des Standorts (E9). */
    private LocalDate tagVon(String site) {
        return admin.queryForObject("SELECT (created_at AT TIME ZONE 'Europe/Berlin')::date "
                + "FROM site WHERE id = ?::uuid", LocalDate.class, site);
    }

    private List<Map<String, Object>> protokoll(String tenant) {
        return admin.queryForList("SELECT objekt_art, objekt_id, art, alt::text AS alt, neu::text AS neu, "
                + "gilt_ab, rueckwirkend, actor_sub, actor_name FROM ort_aenderung "
                + "WHERE tenant_id = ?::uuid AND objekt_art <> 'unternehmen' ORDER BY id", tenant);
    }

    private static Map<String, Object> eintrag(List<Map<String, Object>> protokoll, String objektArt) {
        return protokoll.stream().filter(e -> objektArt.equals(e.get("objekt_art"))).findFirst()
                .orElseThrow(() -> new AssertionError("kein Eintrag für " + objektArt));
    }

    /** Der Stand JEDER Tabelle, in die die Übernahme nicht schreiben darf. */
    private Map<String, String> tabellenStand() {
        return Bestandsschutz.fingerabdruck(admin, SCHREIBT_IN);
    }

    /** Der Stand der Tabellen, in die sie schreibt — für „ein zweiter Lauf schreibt nichts". */
    private Map<String, String> uemsStand() {
        return uemsStand(null);
    }

    /** Wie {@link #uemsStand()}, auf einen Kundenbereich verengt. */
    private Map<String, String> uemsStand(String tenant) {
        Map<String, String> stand = new LinkedHashMap<>();
        for (String t : SCHREIBT_IN) {
            String wo = tenant == null ? "" : " WHERE tenant_id = '" + UUID.fromString(tenant) + "'";
            stand.put(t, admin.queryForObject("SELECT coalesce(string_agg(x::text, E'\\n' "
                    + "ORDER BY x::text), 'leer') FROM (SELECT * FROM " + t + wo + ") x", String.class));
        }
        return stand;
    }

    /**
     * Dieselbe Antwort ohne die additiven Felder, die von der Bestandsübernahme SELBST abhängen:
     * {@code standort} (AP-02 IP-3, je Anlage in /overview und an /sites/{id}) und {@code teilansicht}
     * (AP-03 IP-10, {@code {sichtbar, gesamt}} an /overview).
     *
     * <p>Beide dürfen sich ändern — die Übernahme legt ja genau die Standorte an, die sie zählen. Dass sie
     * sich RICHTIG ändern, prüft der Aufrufer daneben ausdrücklich; hier fällt nur weg, was sonst jeden
     * Zeichenvergleich verdecken würde.
     */
    private static JsonNode ohneStandort(JsonNode antwort) {
        JsonNode kopie = antwort.deepCopy();
        entferne(kopie);
        return kopie;
    }

    private static void entferne(JsonNode n) {
        if (n.isObject()) {
            ((com.fasterxml.jackson.databind.node.ObjectNode) n).remove("standort");
            ((com.fasterxml.jackson.databind.node.ObjectNode) n).remove("teilansicht");
            n.forEach(BestandsuebernahmeApiTest::entferne);
        } else if (n.isArray()) {
            n.forEach(BestandsuebernahmeApiTest::entferne);
        }
    }

    private long anzahl(String sql, Object... args) {
        return admin.queryForObject(sql, Long.class, args);
    }

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

    /** Ein JSON-Feld des Protokolls ({@code jsonb} kommt normalisiert zurück). */
    private static JsonNode json(Object spalte) {
        try {
            return MAPPER.readTree((String) spalte);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private String neuerKundenbereich(String adminToken, String name) {
        return ok201(exchange("/api/v1/admin/tenants", HttpMethod.POST, adminToken, null,
                Map.of("name", name))).path("id").asText();
    }

    private String neueAnlage(String adminToken, String tenant, String name) {
        return ok201(exchange("/api/v1/sites", HttpMethod.POST, adminToken, tenant,
                Map.of("name", name))).path("id").asText();
    }

    private static JsonNode ok(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode()).as("Antwort %s", r.getBody()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    private static JsonNode ok201(ResponseEntity<JsonNode> r) {
        assertThat(r.getStatusCode()).as("Antwort %s", r.getBody()).isEqualTo(HttpStatus.CREATED);
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
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers) : new HttpEntity<>(headers);
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
