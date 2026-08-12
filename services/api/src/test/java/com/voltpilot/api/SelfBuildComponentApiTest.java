package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.components.SelfBuildComponentService;
import com.voltpilot.api.components.SelfBuildDefinition;
import com.voltpilot.api.components.SelfBuildFlowCompiler;
import com.voltpilot.api.flows.FlowCompilerHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.core.ParameterizedTypeReference;
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
 * Die SELBSTBAU-TÜR gegen echtes TimescaleDB + Keycloak (Einheitsmodell
 * Stufe 3). flowc wird über die {@link FlowCompilerHttp}-Naht gefälscht - ein
 * JVM-Test hat keine Node-Laufzeit; dass ein Graph wirklich zum Artefakt
 * kompiliert, beweist die Node-Seite ({@code serve.test.js}).
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li><b>Der Besitzer-Zaun</b> - eine private Vorlage gehört EINER Anlage:
 *       ein fremder Mandant sieht sie nicht, und die öffentliche
 *       Vorlagen-Route liefert nie eine {@code custom}-Vorlage aus.</li>
 *   <li><b>Die Reise</b> - Verbindungstest-Pflicht → anlegen → Komponente mit
 *       Klartext-Messwerten + generiertem, AKTIVEM Lese-Flow.</li>
 *   <li><b>Kanal-Validierung + Poll-Budget</b> mit deutschem Grund.</li>
 *   <li><b>LAN-only</b> - ein öffentliches Ziel wird abgelehnt, ohne dass die
 *       Box je gefragt wird.</li>
 *   <li><b>Ändern/Löschen/Duplizieren</b> - neue Fassung, zurückgezogener
 *       Flow, private Vorlage OHNE die Adresse des Originals.</li>
 *   <li><b>RLS</b> - eine fremde Anlage ist 404, bevor irgendetwas passiert.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class SelfBuildComponentApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";

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

    /**
     * Die flowc-Naht: der ECHTE {@code FlowCompilerClient} läuft darüber
     * offline und bekommt die Vertrags-Fixture eines gültigen Artefakts zurück
     * - genau das, was der Sidecar liefern würde.
     */
    @TestConfiguration
    static class Fakes {
        @Bean
        FlowCompilerHttp flowCompilerHttp() throws IOException {
            String artifact = Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                    "examples", "flow-artifact.valid.artifact.json"));
            return (uri, body) -> new FlowCompilerHttp.Response(200, artifact);
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    ComponentConnectionReceipts receipts;

    private final ObjectMapper json = new ObjectMapper();

    // -- Der Besitzer-Zaun --------------------------------------------------

    /**
     * ⚠ Der Zaun, den Stufe 0a als offene Aufgabe hinterlassen hat: eine
     * private Vorlage gehört EINER Anlage. Zwei Richtungen zählen - ein fremder
     * Mandant darf sie nicht sehen, UND die mandanten-agnostische öffentliche
     * Route darf sie nie ausliefern.
     */
    @Test
    void aPrivateTemplateBelongsToOneSiteAndNeverLeavesIt() throws Exception {
        String customer = token("demo", "demo");
        String stranger = token("demo2", "demo2");
        UUID site = createSiteWithDevice(customer, "Selbstbau-Zaun", "sb-zaun-01");
        try {
            UUID entity = createDevice(customer, site, "Wärmepumpe", channel("Vorlauf", 100));

            ResponseEntity<String> dup = post(
                    "/api/v1/sites/" + site + "/components/custom/" + entity + "/duplicate",
                    customer, Map.of("label", "Wärmepumpen-Vorlage"));
            assertThat(dup.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode templates = json.readTree(dup.getBody());
            assertThat(templates).hasSize(1);
            String ref = templates.get(0).path("templateRef").asText();
            assertThat(ref).startsWith("custom:");

            // Der EIGENE Mandant sieht sie.
            assertThat(json.readTree(get("/api/v1/sites/" + site + "/component-templates",
                    customer).getBody())).hasSize(1);

            // ⚠ Ein FREMDER Mandant sieht die Anlage gar nicht - RLS macht sie
            // zu einer 404, bevor die Vorlage überhaupt zur Frage wird.
            assertThat(get("/api/v1/sites/" + site + "/component-templates", stranger)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(delete("/api/v1/sites/" + site + "/component-templates/" + ref, stranger)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

            // ⚠ Und die ÖFFENTLICHE Vorlagen-Route liefert nie eine private
            // aus - sie kennt nur builtin/certified.
            JsonNode publicTemplates = json.readTree(
                    get("/api/v1/component-templates", customer).getBody());
            assertThat(publicTemplates).isNotEmpty();
            for (JsonNode t : publicTemplates) {
                assertThat(t.path("kind").asText()).isIn("builtin", "certified");
                assertThat(t.path("templateRef").asText()).doesNotStartWith("custom:");
            }
            assertThat(get("/api/v1/component-templates/" + ref, customer).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);

            // ⚠ Die Adresse des Originals reist NICHT mit: eine Vorlage
            // beschreibt einen Gerätetyp, kein Exemplar.
            JsonNode conn = templates.get(0).path("connection");
            assertThat(conn.has("host")).isFalse();
            assertThat(conn.path("port").asInt()).isEqualTo(502);
            assertThat(templates.get(0).path("channels")).hasSize(1);
        } finally {
            deleteSite(site);
        }
    }

    // -- Die Reise ----------------------------------------------------------

    @Test
    void theJourneyFromReadToComponentWithItsGeneratedReadFlow() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSiteWithDevice(customer, "Selbstbau-Reise", "sb-reise-01");
        try {
            Map<String, Object> conn = connection("192.168.1.50");
            List<Map<String, Object>> channels = List.of(
                    channel("Wassertemperatur Speicher oben", 100),
                    Map.of("label", "Aufnahmeleistung", "unit", "kW", "registerKind", "input",
                            "address", 210, "dataType", "u32", "wordOrder", "little",
                            "scale", 0.001, "offset", 0.0, "minReadIntervalS", 10));

            // OHNE Beleg wird nicht gespeichert - die Verbindungstest-Pflicht.
            ResponseEntity<String> blind = post("/api/v1/sites/" + site + "/components/custom",
                    customer, Map.of("label", "Wärmepumpe", "connection", conn,
                            "channels", channels));
            assertThat(blind.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(blind.getBody()).contains("Messwert dieses Geräts");

            recordReceipt(site, "192.168.1.50");
            ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components/custom",
                    customer, Map.of("label", "Wärmepumpe", "connection", conn,
                            "channels", channels));
            assertThat(created.getStatusCode()).isEqualTo(HttpStatus.OK);

            JsonNode row = componentNamed(created.getBody(), "Wärmepumpe");
            UUID entity = UUID.fromString(row.path("id").asText());
            assertThat(row.path("entityType").asText()).isEqualTo("modbus-generic");
            assertThat(row.path("sourceKind").asText()).isEqualTo("custom");
            assertThat(row.path("communication").asText()).isEqualTo("modbus_baukasten");
            // ⚠ Die ERSTE gespeicherte Fassung ist 2, nicht 1: die Spalte
            // startet per DEFAULT auf 1 und `applyDefinition` zählt hoch. Das
            // ist NICHT selbst gewählt, sondern die Zählung der Stufe-1-
            // Maschinerie, die diese Tür wiederverwendet - `ComponentApiTest`
            // erwartet für ihren ersten Anlege-Vorgang dasselbe. Zwei
            // Bedeutungen von „Fassung 1" wären genau die zweite Wahrheit,
            // die das Einheitsmodell vermeidet.
            assertThat(row.path("definitionVersion").asInt()).isEqualTo(2);

            // Die Kennungen sind ABGELEITET, die Klartext-Namen reisen mit.
            JsonNode measure = entityCapabilities(entity).path("measure");
            assertThat(measure).hasSize(2);
            assertThat(measure.get(0).path("channel").asText())
                    .isEqualTo("wassertemperatur_speicher_oben");
            assertThat(measure.get(0).path("label").asText())
                    .isEqualTo("Wassertemperatur Speicher oben");
            assertThat(measure.get(0).path("unit").asText()).isEqualTo("°C");
            assertThat(measure.get(1).path("channel").asText()).isEqualTo("aufnahmeleistung");

            // Der generierte Lese-Flow ist AKTIV und trägt seine Herkunft.
            JsonNode doc = activeFlowDocument(SelfBuildFlowCompiler.generatedFlowId(entity));
            assertThat(doc.path("origin").path("kind").asText()).isEqualTo("modbus-device");
            assertThat(doc.path("origin").path("point_id").asText()).isEqualTo(entity.toString());
            // Der Stempel im Flow IST die angewandte Fassung - er kann von der
            // Komponenten-Zeile nicht abweichen.
            assertThat(doc.path("origin").path("definition_version").asInt()).isEqualTo(2);
            assertThat(doc.path("nodes")).hasSize(2);
            assertThat(doc.path("nodes").get(0).path("type").asText())
                    .isEqualTo("vp.modbus.read");
            JsonNode first = doc.path("nodes").get(0).path("parameters");
            assertThat(first.path("host").asText()).isEqualTo("192.168.1.50");
            assertThat(first.path("address").asInt()).isEqualTo(100);
            assertThat(first.path("entity_id").asText()).isEqualTo(entity.toString());
            assertThat(first.path("channel").asText()).isEqualTo("wassertemperatur_speicher_oben");
            // Der Takt ist der SCHNELLSTE Kanal-Wunsch.
            assertThat(doc.path("triggers").get(0).path("every_s").asInt()).isEqualTo(10);

            // Ändern = eine NEUE Fassung, mit neuem Lese-Flow.
            recordReceipt(site, "192.168.1.50");
            ResponseEntity<String> updated = put(
                    "/api/v1/sites/" + site + "/components/custom/" + entity, customer,
                    Map.of("label", "Wärmepumpe Keller", "connection", conn,
                            "channels", List.of(channel("Wassertemperatur Speicher oben", 100))));
            assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(componentNamed(updated.getBody(), "Wärmepumpe Keller")
                    .path("definitionVersion").asInt()).isEqualTo(3);
            // Ein entfernter Kanal verschwindet auch als Messwert - sonst
            // verspräche die Komponente einen Wert, den niemand mehr liest.
            assertThat(entityCapabilities(entity).path("measure")).hasSize(1);
            assertThat(activeFlowDocument(SelfBuildFlowCompiler.generatedFlowId(entity))
                    .path("nodes")).hasSize(1);

            // Löschen nimmt den Lese-Flow mit.
            assertThat(delete("/api/v1/sites/" + site + "/components/custom/" + entity, customer)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(activeFlowVersions(SelfBuildFlowCompiler.generatedFlowId(entity)))
                    .as("der generierte Flow ist zurückgezogen").isZero();
        } finally {
            deleteSite(site);
        }
    }

    // -- Die Regeln ---------------------------------------------------------

    @Test
    void everyRefusalNamesItsReasonAndTheBoxIsNeverAskedForAPublicTarget() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSiteWithDevice(customer, "Selbstbau-Regeln", "sb-regeln-01");
        try {
            // LAN-only: ein öffentliches Ziel wird abgelehnt, BEVOR die Box
            // gefragt wird (die Antwort kommt sofort, nicht nach einem
            // Broker-Umlauf) - deshalb ist es ein 200 mit ehrlichem Ausgang.
            ResponseEntity<String> publicTarget = post(
                    "/api/v1/sites/" + site + "/components/custom/read", customer,
                    Map.of("connection", connection("8.8.8.8"),
                            "channel", channel("Irgendwas", 1)));
            assertThat(publicTarget.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode read = json.readTree(publicTarget.getBody());
            assertThat(read.path("ok").asBoolean()).isFalse();
            assertThat(read.path("errorCode").asText()).isEqualTo("invalid_request");
            assertThat(read.path("message").asText()).contains("eigenen Netzwerk");
            assertThat(read.has("value")).as("ein Fehlschlag trägt NIE einen Wert").isFalse();

            recordReceipt(site, "192.168.1.50");

            // Poll-Budget: mehr als 16 Kanäle.
            List<Map<String, Object>> many = new ArrayList<>();
            for (int i = 0; i <= SelfBuildDefinition.MAX_CHANNELS; i++) {
                many.add(channel("Wert " + i, 100 + i));
            }
            assertThat(badRequest(site, customer, many)).contains("Höchstens 16 Messwerte");

            // Poll-Budget: zu kurzer Abstand.
            Map<String, Object> fast = new LinkedHashMap<>(channel("Schnell", 100));
            fast.put("minReadIntervalS", 1);
            assertThat(badRequest(site, customer, List.of(fast)))
                    .contains("mindestens 5 Sekunden");

            // Kanal-Form: unbekannter Datentyp.
            Map<String, Object> odd = new LinkedHashMap<>(channel("Krumm", 100));
            odd.put("dataType", "u48");
            assertThat(badRequest(site, customer, List.of(odd))).contains("Datentyp");

            // Ohne Messwert liest das Gerät nichts.
            assertThat(badRequest(site, customer, List.of())).contains("mindestens einen Messwert");

            // Und die LAN-Regel gilt auch beim SPEICHERN, nicht nur beim Lesen.
            ResponseEntity<String> publicSave = post(
                    "/api/v1/sites/" + site + "/components/custom", customer,
                    Map.of("label", "Fern", "connection", connection("1.1.1.1"),
                            "channels", List.of(channel("Vorlauf", 100))));
            assertThat(publicSave.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(publicSave.getBody()).contains("eigenen Netzwerk");
        } finally {
            deleteSite(site);
        }
    }

    /** Eine fremde Anlage ist 404, bevor irgendetwas geschrieben wird. */
    @Test
    void aForeignSiteIsNotFoundOnEverySelfBuildRoute() throws Exception {
        String customer = token("demo", "demo");
        String stranger = token("demo2", "demo2");
        UUID site = createSiteWithDevice(customer, "Selbstbau-RLS", "sb-rls-01");
        try {
            recordReceipt(site, "192.168.1.50");
            Map<String, Object> body = Map.of("label", "Fremd",
                    "connection", connection("192.168.1.50"),
                    "channels", List.of(channel("Vorlauf", 100)));

            assertThat(post("/api/v1/sites/" + site + "/components/custom", stranger, body)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(post("/api/v1/sites/" + site + "/components/custom/read", stranger,
                    Map.of("connection", connection("192.168.1.50"),
                            "channel", channel("Vorlauf", 100)))
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(get("/api/v1/sites/" + site + "/component-templates", stranger)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

            // Und die eigene Anlage funktioniert - der 404 ist der Zaun, kein
            // kaputter Weg.
            assertThat(post("/api/v1/sites/" + site + "/components/custom", customer, body)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);
        } finally {
            deleteSite(site);
        }
    }

    /**
     * Ohne verbundenes Gerät wird die Voraussetzung BEIM NAMEN genannt - und
     * zwar bevor irgendetwas geschrieben wird. Vorher endete derselbe Fall in
     * einem 503 „konnte nicht verteilt werden": eine Aussage über eine Störung,
     * wo in Wahrheit die Box fehlt.
     */
    @Test
    void aPlantWithoutAConnectedDeviceIsRefusedByNameAndNothingIsWritten() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Selbstbau-ohne-Gerät");
        try {
            recordReceipt(site, "192.168.1.50");
            ResponseEntity<String> res = post("/api/v1/sites/" + site + "/components/custom",
                    customer, Map.of("label", "Wärmepumpe",
                            "connection", connection("192.168.1.50"),
                            "channels", List.of(channel("Vorlauf", 100))));
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(json.readTree(res.getBody()).path("message").asText())
                    .contains("kein verbundenes Gerät");
            // Nichts angelegt - die Ablehnung kommt VOR dem ersten Schreibvorgang.
            assertThat(json.readTree(get("/api/v1/sites/" + site + "/components", customer)
                    .getBody()).path("components")).isEmpty();
        } finally {
            deleteSite(site);
        }
    }

    // -- Hilfen -------------------------------------------------------------

    private String badRequest(UUID site, String token, List<Map<String, Object>> channels)
            throws Exception {
        ResponseEntity<String> res = post("/api/v1/sites/" + site + "/components/custom", token,
                Map.of("label", "Prüfling", "connection", connection("192.168.1.50"),
                        "channels", channels));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        return json.readTree(res.getBody()).path("message").asText();
    }

    private UUID createDevice(String token, UUID site, String label, Map<String, Object> channel)
            throws Exception {
        recordReceipt(site, "192.168.1.50");
        ResponseEntity<String> res = post("/api/v1/sites/" + site + "/components/custom", token,
                Map.of("label", label, "connection", connection("192.168.1.50"),
                        "channels", List.of(channel)));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return UUID.fromString(componentNamed(res.getBody(), label).path("id").asText());
    }

    private void recordReceipt(UUID site, String host) {
        receipts.record(site, SelfBuildComponentService.RECEIPT_REF,
                SelfBuildComponentService.receiptFields(
                        new SelfBuildDefinition.Transport(host, 502, 1)));
    }

    private static Map<String, Object> connection(String host) {
        return Map.of("host", host, "port", 502, "unitId", 1);
    }

    private static Map<String, Object> channel(String label, int address) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("label", label);
        c.put("unit", "°C");
        c.put("registerKind", "holding");
        c.put("address", address);
        c.put("dataType", "s16");
        c.put("wordOrder", "big");
        c.put("scale", 0.1);
        c.put("offset", 0.0);
        c.put("minReadIntervalS", 10);
        return c;
    }

    private JsonNode componentNamed(String body, String label) throws Exception {
        for (JsonNode row : json.readTree(body).path("components")) {
            if (label.equals(row.path("label").asText())) {
                return row;
            }
        }
        throw new AssertionError("keine Komponente namens " + label + " in " + body);
    }

    private JsonNode entityCapabilities(UUID entityId) throws Exception {
        return json.readTree(scalar(
                "SELECT capabilities FROM measurement_point WHERE id = '" + entityId + "'"));
    }

    private JsonNode activeFlowDocument(UUID flowId) throws Exception {
        String doc = scalar("SELECT document FROM flow_definition WHERE flow_id = '" + flowId
                + "' AND lifecycle = 'active'");
        assertThat(doc).as("es gibt eine aktive Fassung des generierten Flows").isNotNull();
        return json.readTree(doc);
    }

    private int activeFlowVersions(UUID flowId) {
        String n = scalar("SELECT count(*) FROM flow_definition WHERE flow_id = '" + flowId
                + "' AND lifecycle = 'active'");
        return Integer.parseInt(n);
    }

    private String scalar(String sql) {
        try (Connection c = superuser(); Statement st = c.createStatement();
                ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * Eine Anlage MIT verbundenem Gerät - der Normalfall. Ohne Gerät gibt es
     * keine Box, die lesen könnte; das ist ein eigener Test.
     */
    private UUID createSiteWithDevice(String customerToken, String name, String ref) {
        UUID site = createSite(customerToken, name);
        ResponseEntity<String> res = post("/api/v1/devices/claim", customerToken,
                Map.of("externalRef", ref, "siteId", site.toString(), "kind", "inverter"));
        assertThat(res.getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
        return site;
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    /** Aufräumen per Superuser - Testanlagen dürfen die Demo-Flotte nicht verschieben. */
    private void deleteSite(UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM site WHERE id = '" + siteId + "'");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)),
                String.class);
    }

    private ResponseEntity<String> put(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)),
                String.class);
    }

    private ResponseEntity<String> get(String path, String token) {
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                String.class);
    }

    private ResponseEntity<String> delete(String path, String token) {
        return rest.exchange(url(path), HttpMethod.DELETE, new HttpEntity<>(bearer(token)),
                String.class);
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    private String token(String user, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-frontend");
        form.add("username", user);
        form.add("password", password);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                HttpMethod.POST, new HttpEntity<>(form, headers),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("access_token");
    }
}
