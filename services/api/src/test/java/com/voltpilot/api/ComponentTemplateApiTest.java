package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.templates.BuiltinComponentTemplates;
import com.voltpilot.api.templates.BuiltinComponentTemplates.BuiltinTemplate;
import com.voltpilot.api.templates.ComponentTemplateSeeder;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
 * Einheitsmodell Stufe 0a „Vorlagen werden Daten" gegen echtes TimescaleDB +
 * Keycloak.
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li><b>Katalog-Gleichheit:</b> die Tabelle trägt GENAU die Menge, die aus
 *       dem Go-Katalog exportiert wurde - Schlüssel für Schlüssel. Zusammen mit
 *       dem Go-Test, der Katalog und Datei byteweise vergleicht, ist damit die
 *       Kette Go-Katalog ⟷ Tabelle geschlossen.</li>
 *   <li><b>Ehrlichkeit:</b> Kanäle und Schreibwege stehen als {@code null} in
 *       der Antwort, nicht als leere Liste; eine unbekannte Nennleistung ist
 *       {@code null}, nie 0.</li>
 *   <li><b>Idempotenz:</b> ein zweiter Abgleich schreibt NICHTS.</li>
 *   <li><b>Rollen-/Zaun-Grenze:</b> Kunde und Admin lesen, anonym bekommt 401 -
 *       und eine {@code custom}-Zeile wird NIE ausgeliefert (sie hätte auf
 *       dieser mandantenlosen Tabelle keinen Zaun).</li>
 *   <li><b>Bestandsneutralität:</b> die vorhandenen Entitäten der Demo-Anlage
 *       sind unverändert; die zwei neuen Spalten sind bei ihnen NULL, und nur
 *       eine NEU komponierte Zeile trägt {@code source_kind='composed'}.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ComponentTemplateApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK =
            new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
                    .withRealmImportFile("keycloak/voltpilot-realm.json");

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
    BuiltinComponentTemplates builtin;

    @Autowired
    ComponentTemplateSeeder seeder;

    @Autowired
    com.voltpilot.api.templates.ComponentTemplateRepository templates;

    @Autowired
    DataSource dataSource;

    private final ObjectMapper json = new ObjectMapper();

    /**
     * Der Kern: die Tabelle IST der Go-Katalog, und die Antwort ist ehrlich.
     */
    @Test
    void theRegisterCarriesExactlyTheEdgeCatalogAndStaysHonest() throws Exception {
        String customer = token("demo", "demo");
        JsonNode list = getJson("/api/v1/component-templates", customer);

        List<String> served = new ArrayList<>();
        list.forEach(t -> served.add(t.get("templateRef").asText()));
        // ⚠ GENAU die exportierten Vorlagen OHNE die abgelösten: die
        // Katalog-Neustruktur hat den zweiten Fronius-Eintrag zu einer
        // Alias-Zeile gemacht - sie bleibt auflösbar, wird aber nicht mehr
        // angeboten (der eigene Test dazu ist unten).
        List<String> expected = builtin.all().stream()
                .filter(t -> t.supersededBy() == null)
                .map(BuiltinTemplate::templateRef).toList();
        assertThat(served)
                .as("die Lese-Route liefert GENAU die geltenden exportierten Vorlagen")
                .containsExactlyInAnyOrderElementsOf(expected);
        assertThat(served).hasSize(expected.size());

        // Sortierung: der Assistent gruppiert nach Marke, dann Modell.
        List<String> brands = new ArrayList<>();
        list.forEach(t -> brands.add(t.get("brand").asText()));
        assertThat(brands).isSorted();

        JsonNode deye = one(list, "builtin:deye:sun-30k-sg01hp3");
        assertThat(deye.get("kind").asText()).isEqualTo("builtin");
        assertThat(deye.get("version").asInt()).isEqualTo(1);
        assertThat(deye.get("family").asText()).isEqualTo("hybrid_3p");
        assertThat(deye.get("communication").asText()).isEqualTo("solarman_v5");
        assertThat(deye.get("certificationStatus").asText())
                .as("„builtin" + "\" ist NICHT „certified\" - das Wort gehört dem Prüfstand")
                .isEqualTo("builtin");
        assertThat(deye.get("ratedKw").asDouble()).isEqualTo(30.0);
        assertThat(deye.get("controlTier").asInt()).isEqualTo(3);

        // Das Transport-Schema reist als ECHTES JSON-Array, nicht als
        // Zeichenkette - sonst müsste der Assistent es nachparsen.
        assertThat(deye.get("transportSchema").isArray()).isTrue();
        List<String> keys = new ArrayList<>();
        deye.get("transportSchema").forEach(f -> keys.add(f.get("key").asText()));
        assertThat(keys).contains("ip", "port", "serial", "mb_slave_id");

        // ⚠ Die Ehrlichkeitsregel: null („hier nicht erklärt"), nie [].
        assertThat(deye.get("channels").isNull())
                .as("Kanäle einer eingebauten Vorlage wohnen im Decode-Profil").isTrue();
        assertThat(deye.get("writes").isNull())
                .as("der Schreibweg wohnt im Steuer-Adapter").isTrue();

        // Unbekannte Nennleistung = null, nie 0.
        JsonNode generic = one(list, "builtin:generic_modbus:sunspec");
        assertThat(generic.get("ratedKw").isNull()).isTrue();

        // Eine einzelne Vorlage ist ebenso lesbar; ein unbekannter Schlüssel 404.
        JsonNode single = getJson("/api/v1/component-templates/builtin:deye:sun-30k-sg01hp3",
                customer);
        assertThat(single.get("modelLabel").asText()).isEqualTo("SUN-30K-SG01HP3-EU");
        // Die TYPENSCHILD-VARIANTEN reisen mit (Bauplan P8) - als NAMEN, nicht
        // als zweite Vorlage: gewählt wird weiter `sun-30k-sg01hp3`, an dem die
        // Steuerungs-Freigabe hängt (brand+model, V20260814000000).
        List<String> varianten = new ArrayList<>();
        single.get("modelAliases").forEach(a -> varianten.add(a.asText()));
        assertThat(varianten)
                .containsExactly("SUN-30K-SG01HP3-EU-BM3", "SUN-30K-SG01HP3-EU-BM4");
        assertThat(single.get("model").asText()).isEqualTo("sun-30k-sg01hp3");
        // Ein Modell ohne Varianten behauptet nichts: null, nie [].
        assertThat(one(list, "builtin:deye:sun-12k-sg04lp3").get("modelAliases").isNull())
                .as("„hat nur seinen einen Namen\" ist nicht „hat keine\"").isTrue();
        assertThat(rest.exchange(url("/api/v1/component-templates/builtin:deye:gibtsnicht"),
                HttpMethod.GET, new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * DIE ALIAS-EBENE der harten Kompatibilitäts-Regel (Katalog-Neustruktur,
     * Konzept data/vp-anlegen-rework/konzept.md).
     *
     * <p>Die frühere zweite Fronius-Zeile (`fronius_sunspec`) wird NICHT mehr
     * ANGEBOTEN - sonst stünde „Fronius" zweimal im Assistenten. Sie bleibt aber
     * vollständig AUFLÖSBAR, und daran hängt eine laufende Kundenanlage: die
     * zwei Fronius Eco der Anlage Herzogau tragen ihren `template_ref` in
     * {@code component_definition}, und die Bestands-Übernahme sucht die Vorlage
     * über Marke+Modell. Verschwände die Zeile, verlöre die Anlage ihre Vorlage.
     */
    @Test
    void thesupersededFroniusTemplateIsNoLongerOfferedButStaysResolvable() throws Exception {
        String customer = token("demo", "demo");
        String alt = "builtin:fronius_sunspec:fronius-eco-27-3-s";
        String neu = "builtin:fronius:fronius-eco-27-3-s";

        JsonNode list = getJson("/api/v1/component-templates", customer);
        List<String> served = new ArrayList<>();
        list.forEach(t -> served.add(t.get("templateRef").asText()));
        assertThat(served).as("die abgelöste Zeile wird nicht angeboten").doesNotContain(alt);
        assertThat(served).as("ihre Nachfolgerin schon").contains(neu);

        // Genau EINE Fronius-Marke wird angeboten - der Befund, mit dem alles anfing.
        List<String> froniusBrands = new ArrayList<>();
        list.forEach(t -> {
            if ("Fronius".equals(t.get("brandLabel").asText())) {
                froniusBrands.add(t.get("brand").asText());
            }
        });
        assertThat(froniusBrands).as("nur noch EINE Fronius-Marken-Kennung sichtbar")
                .isNotEmpty().containsOnly("fronius");

        // ⚠ Und sie ist weiterhin NACHSCHLAGBAR - über ihren Schlüssel wie über
        // Marke+Modell (der Weg der Bestands-Übernahme).
        JsonNode single = getJson("/api/v1/component-templates/" + alt, customer);
        assertThat(single.get("templateRef").asText()).isEqualTo(alt);
        assertThat(single.get("supersededBy").asText()).isEqualTo(neu);
        assertThat(single.get("communication").asText()).isEqualTo("fronius_sunspec");
        assertThat(single.get("family").asText()).isEqualTo("sunspec_live");
        assertThat(single.get("ratedKw").asDouble()).isEqualTo(27.0);
        assertThat(templates.findNewestByBrandModel(BuiltinComponentTemplates.PUBLIC_KINDS,
                        "fronius_sunspec", "fronius-eco-27-3-s"))
                .as("die Bestands-Übernahme findet sie über Marke+Modell").isPresent();

        // Die Gerätetyp-Dimension reist mit - sie ersetzt die Klammer im Markennamen.
        JsonNode wallbox = one(list, "builtin:go-e:goe_http_api");
        assertThat(wallbox.get("deviceType").asText()).isEqualTo("wallbox");
        assertThat(wallbox.get("brandLabel").asText()).isEqualTo("go-e");
        assertThat(one(list, "builtin:shelly:shelly_http").get("deviceType").asText())
                .isEqualTo("switch");
        assertThat(one(list, neu).get("deviceType").asText()).isEqualTo("inverter");
        assertThat(one(list, neu).get("supersededBy").isNull())
                .as("eine geltende Vorlage nennt keinen Nachfolger").isTrue();
    }

    /**
     * Der Start-Abgleich ist idempotent: ein zweiter Lauf über einen
     * unveränderten Katalog schreibt NICHTS. Ohne das wäre {@code updated_at}
     * wertlos und jeder Neustart erzeugte 44 Schein-Änderungen.
     */
    @Test
    void aSecondSeedRunOverAnUnchangedCatalogWritesNothing() {
        ComponentTemplateSeeder.SeedSummary again = seeder.seed();
        assertThat(again.total()).isEqualTo(builtin.all().size());
        assertThat(again.failed()).isZero();
        assertThat(again.written()).as("unverändert => kein Schreibvorgang").isZero();
    }

    /**
     * Ein geänderter Katalog frischt die Zeile AN ORT UND STELLE auf (keine neue
     * Fassung: die Fassung einer eingebauten Vorlage IST der Edge-Softwarestand).
     */
    @Test
    void aChangedCatalogRefreshesTheRowInPlaceInsteadOfAddingAVersion() throws Exception {
        String ref = "builtin:kostal:plenticore-bi-10-26";
        try (Connection c = superuser();
                Statement s = c.createStatement()) {
            s.executeUpdate("UPDATE component_template SET model_label = 'ALT' "
                    + "WHERE template_ref = '" + ref + "'");
        }

        ComponentTemplateSeeder.SeedSummary run = seeder.seed();
        assertThat(run.written()).as("genau die eine geänderte Zeile").isEqualTo(1);

        try (Connection c = superuser();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT count(*) AS n, max(model_label) AS label, max(version) AS v "
                                + "FROM component_template WHERE template_ref = ?")) {
            ps.setString(1, ref);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getInt("n")).as("keine zweite Fassung").isEqualTo(1);
                assertThat(rs.getInt("v")).isEqualTo(1);
                assertThat(rs.getString("label")).isEqualTo("PLENTICORE BI 10/26");
            }
        }
    }

    /**
     * Der Zaun der Route ist die HERKUNFTS-Filterung: eine {@code custom}-Zeile
     * (private Vorlage je Anlage, Stufe 3) hat auf dieser mandantenlosen Tabelle
     * keinen Besitzer-Zaun und darf deshalb nie ausgeliefert werden. Der Test
     * legt eine solche Zeile absichtlich an - genau deshalb, weil es in dieser
     * Stufe keinen Schreiber gibt, der es tun könnte.
     */
    @Test
    void aCustomTemplateIsNeverServedAndTheRouteIsAuthenticated() throws Exception {
        try (Connection c = superuser();
                Statement s = c.createStatement()) {
            s.executeUpdate("INSERT INTO component_template (kind, template_ref, version, brand, "
                    + "brand_label, model, model_label, communication, transport_schema, "
                    + "certification_status, created_by) VALUES ('custom', "
                    + "'custom:privat:heizstab', 1, 'privat', 'Privat', 'heizstab', 'Heizstab', "
                    + "'modbus_tcp', '[]'::jsonb, 'not_certified', 'test')");
        }

        String customer = token("demo", "demo");
        JsonNode list = getJson("/api/v1/component-templates", customer);
        List<String> refs = new ArrayList<>();
        list.forEach(t -> refs.add(t.get("templateRef").asText()));
        assertThat(refs).doesNotContain("custom:privat:heizstab");

        // Unbekannt UND nicht-öffentlich antworten identisch - die Route verrät
        // nicht, ob es den Schlüssel gibt.
        assertThat(rest.exchange(url("/api/v1/component-templates/custom:privat:heizstab"),
                HttpMethod.GET, new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Ein Portal-Admin sieht dieselbe öffentliche Menge (keine Sonderrolle),
        // anonym bekommt 401.
        JsonNode adminList = getJson("/api/v1/component-templates", token("admin", "admin"));
        assertThat(adminList.size()).isEqualTo(list.size());
        assertThat(rest.exchange(url("/api/v1/component-templates"), HttpMethod.GET,
                HttpEntity.EMPTY, String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /**
     * Die App-Rolle darf LESEN und nichts anderes. Auf einer globalen Tabelle
     * ohne RLS wäre ein geerbtes INSERT (V2s {@code ALTER DEFAULT PRIVILEGES})
     * eine offene Tür - die Migration nimmt es ausdrücklich weg.
     */
    @Test
    void theAppRoleMayReadTemplatesButNeverWriteThem() throws Exception {
        try (Connection c = dataSource.getConnection();
                Statement s = c.createStatement()) {
            try (ResultSet rs = s.executeQuery("SELECT count(*) FROM component_template")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getInt(1)).isGreaterThan(0);
            }
            assertThatWriteIsRefused(s, "INSERT INTO component_template (kind, template_ref, "
                    + "version, brand, brand_label, model, model_label, communication, "
                    + "transport_schema, certification_status, created_by) VALUES ('builtin', "
                    + "'builtin:x:y', 1, 'x', 'X', 'y', 'Y', 'modbus_tcp', '[]'::jsonb, "
                    + "'builtin', 'app')");
            assertThatWriteIsRefused(s, "UPDATE component_template SET note = 'gekapert'");
            assertThatWriteIsRefused(s, "DELETE FROM component_template");
        }
    }

    /**
     * Bestandsneutralität: die Demo-Anlage hat ihre v2-Entitäten schon (der
     * automatische Backfill komponiert sie beim Start), und die zwei NEUEN
     * Spalten ändern daran nichts. Nur eine NEU komponierte Zeile trägt
     * {@code source_kind='composed'} - eine ältere bleibt ehrlich NULL
     * („unbekannt"), statt rückwirkend eine Herkunft zu behaupten.
     */
    @Test
    void existingEntitiesAreUntouchedAndOnlyFreshCompositionsAreStamped() throws Exception {
        String customer = token("demo", "demo");

        // Bestand: die Demo-Anlage trägt Entitäten, und die Vorlagen-Spalten
        // sind dort leer - eine Vorlage gab es zu ihrer Entstehung nicht.
        try (Connection c = superuser();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT count(*) AS n, count(template_ref) AS refs "
                                + "FROM measurement_point WHERE site_id = ?::uuid "
                                + "AND entity_type IS NOT NULL")) {
            ps.setString(1, BERLIN_SITE);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getInt("n")).as("die Demo-Anlage hat Komponenten").isPositive();
                assertThat(rs.getInt("refs"))
                        .as("keine Bestandszeile behauptet eine Vorlagen-Herkunft").isZero();
            }
        }

        // Eine FRISCH komponierte Anlage: Standort + Gerät anlegen lässt die
        // Auto-Komposition (#385) laufen.
        UUID site = createSite(customer, "Vorlagen-Testanlage");
        claim(customer, site, "edge-tpl-0a-01");

        try (Connection c = superuser();
                PreparedStatement ps = c.prepareStatement(
                        "SELECT role, source_kind, template_ref, template_version "
                                + "FROM measurement_point WHERE site_id = ?")) {
            ps.setObject(1, site);
            try (ResultSet rs = ps.executeQuery()) {
                int rows = 0;
                while (rs.next()) {
                    rows++;
                    assertThat(rs.getString("source_kind"))
                            .as("Rolle %s ist plattform-komponiert", rs.getString("role"))
                            .isEqualTo("composed");
                    assertThat(rs.getString("template_ref"))
                            .as("eine komponierte Zeile kommt aus keiner Vorlage").isNull();
                    rs.getInt("template_version");
                    assertThat(rs.wasNull()).isTrue();
                }
                assertThat(rows).as("Netz + Haus werden aus dem Gateway synthetisiert")
                        .isGreaterThanOrEqualTo(2);
            }
        }
    }

    // ── Helfer ────────────────────────────────────────────────────────────

    private static void assertThatWriteIsRefused(Statement s, String sql) {
        // ⚠ SQLException ist selbst ein Iterable<Throwable> - ohne den Cast ist
        // assertThat() mehrdeutig und der Test compiliert nicht.
        Throwable refused = catchSql(s, sql);
        assertThat(refused).as("die App-Rolle darf nicht schreiben: %s", sql).isNotNull();
        assertThat(refused.getMessage()).containsIgnoringCase("permission");
    }

    private static SQLException catchSql(Statement s, String sql) {
        try {
            s.executeUpdate(sql);
            return null;
        } catch (SQLException e) {
            return e;
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static JsonNode one(JsonNode list, String ref) {
        for (JsonNode t : list) {
            if (ref.equals(t.get("templateRef").asText())) {
                return t;
            }
        }
        throw new AssertionError("Vorlage " + ref + " nicht in der Antwort");
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private void claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId.toString(), "externalRef", ref),
                        bearer(customerToken)),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    private JsonNode getJson(String path, String token) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("GET %s", path).isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
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
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
