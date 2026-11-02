package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
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
 * Live-Fall „Zuhause“ (02.11.2026): der Captain legte über den Anlege-Weg einen Heizstab (Shelly
 * Pro 3, drei Ausgänge als EIN Gerät) an, und seine Box lehnte den ganzen Registry-Push ab -
 * „für … (heating-rod) ist nicht bestimmbar, welche Rolle das Gerät hat“. Die Ursache lag in der
 * Cloud: die Beschreibung trug nur Messkanäle und keine Schreibfähigkeit ({@code actuate}),
 * also las die Box den Stab als „nur messen“ und kannte dafür keine Bilanzrolle.
 *
 * <p>Dieser Test geht den echten Weg des Portals ({@code POST …/components} mit
 * {@code consumerType = heating-rod}) und prüft die BYTES, die der Push wirklich zur Box trägt -
 * gegen den gemeinsamen Vektor {@code docs/contracts/v2/heizstab-push-vectors.json}, den die Box
 * in {@code componentapply} ebenfalls liest. Die Push-Nutzlast wird zusätzlich unter
 * {@code target/heizstab-push/} abgelegt, damit sie 1:1 an eine echte Box verfüttert werden kann.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@org.springframework.context.annotation.Import(HeizstabPushApiTest.RecordingPublisherConfig.class)
class HeizstabPushApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String DEYE = "builtin:deye:sun-30k-sg01hp3";
    private static final String SHELLY = "builtin:shelly:shelly_http";
    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/heizstab-push-vectors.json");

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
    ComponentConnectionReceipts receipts;

    @Autowired
    EntityRegistryService entityRegistry;

    @Autowired
    EntityRegistryRepository entityRepo;

    @Autowired
    BoxFaehigkeiten faehigkeiten;

    @Autowired
    com.voltpilot.api.consumers.HeizstabFaehigkeitenNachtrag nachtrag;

    private final ObjectMapper json = new ObjectMapper();

    /** Zeichnet jeden Registry-Push auf - die Bytes, die wirklich auf den Draht gingen. */
    @org.springframework.boot.test.context.TestConfiguration
    static class RecordingPublisherConfig {
        static final List<byte[]> PUSHES = new java.util.concurrent.CopyOnWriteArrayList<>();

        @org.springframework.context.annotation.Bean
        com.voltpilot.api.entities.EntityRegistryPublisher entityRegistryPublisher() {
            var pub = org.mockito.Mockito.mock(
                    com.voltpilot.api.entities.EntityRegistryPublisher.class);
            org.mockito.Mockito.when(pub.publishRegistry(org.mockito.Mockito.any(),
                    org.mockito.Mockito.any(), org.mockito.Mockito.any(),
                    org.mockito.Mockito.any())).thenAnswer(inv -> {
                        PUSHES.add(inv.getArgument(3));
                        return true;
                    });
            return pub;
        }
    }

    /** Die Verbindung des Captains: ein Pro 3, drei Phasen, Stern mit N, 2 kW je Element. */
    private static Map<String, Object> pro3() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.178.43");
        c.put("port", 80);
        c.put("channels", List.of(0, 1, 2));
        c.put("output_kw", List.of(2.0, 2.0, 2.0));
        c.put("stages", List.of(1, 2, 3));
        c.put("anschluss", "stern_mit_n");
        return c;
    }

    private static Map<String, Object> deyeConnection() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.0.28");
        c.put("port", 8899);
        c.put("serial", "2985159064");
        c.put("mb_slave_id", 1);
        return c;
    }

    /**
     * Der Captain-Fall Schritt für Schritt: Anlage, Box mit {@code heizstab_regler}, Wechselrichter,
     * dann der Heizstab - und der Push trägt den Stab als steuerbaren Verbraucher, zeichengleich zum
     * Vektor, den die Box liest.
     */
    @Test
    void einHeizstabUeberDreiAusgaengeReistMitSchreibfaehigkeitZurBox() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Zuhause");
        try {
            UUID id = legeZuhauseAn(customer, site, "edge-heizstab-01");

            JsonNode push = pushJson(site);
            Path dump = dumpPush(push, "heizstab-push");
            JsonNode entity = entityOf(push, id);
            assertThat(entity).as("der Push trägt den Heizstab").isNotNull();

            JsonNode vektoren = json.readTree(Files.readString(VEKTOREN));
            JsonNode soll = vektoren.get("descriptor");

            // Treiber: die Verbindung reist unverändert (channels, output_kw, stages, anschluss).
            assertThat(normalisiert(entity.get("driver")))
                    .as("Treiberblock wie im Vektor (Push unter %s)", dump)
                    .isEqualTo(normalisiert(soll.get("driver")));
            assertThat(normalisiert(entity.get("guards")))
                    .as("Schutzgrenzen: oberste Stufe als Obergrenze, Ausfallverhalten aus")
                    .isEqualTo(normalisiert(soll.get("guards")));

            // DER Befund: ohne actuate liest die Box den Stab als „nur messen“ und kennt dafür keine
            // Rolle - der ganze Push fällt („für … (heating-rod) ist nicht bestimmbar, welche Rolle
            // das Gerät hat“). Ein Heizstab mit Ausgangsmenge IST ein geschaltetes Gerät: Stufenprofil,
            // „Jetzt heizen“ und der Regler der Box brauchen den Schreibweg.
            List<String> befehle = new ArrayList<>();
            for (JsonNode a : entity.path("capabilities").path("actuate")) {
                befehle.add(a.path("command").asText());
            }
            assertThat(befehle).as("Schreibfähigkeit im Push (Nutzlast unter %s)", dump)
                    .containsExactly("on_off", "setpoint_kw", "limit_kw");
            assertThat(normalisiert(entity.get("capabilities")))
                    .as("Fähigkeiten zeichengleich zum Vektor")
                    .isEqualTo(normalisiert(soll.get("capabilities")));

            // Und die Entität ist steuerbar - wie jeder Verbraucher aus dem Anlagen-Modell.
            JsonNode entities = getJson("/api/v1/sites/" + site + "/entities", customer);
            JsonNode dto = entityById(entities, id);
            assertThat(dto.path("control").asBoolean()).as("control").isTrue();
            assertThat(dto.path("capabilities").path("actuate").size()).isEqualTo(3);
        } finally {
            deleteSite(customer, site);
        }
    }

    /**
     * Der Stand des Captains in der Datenbank: ein Heizstab, der VOR dem Fix angelegt wurde - nur
     * Messkanäle, {@code control = false}. Sein Push ist retained und wird von der Box abgelehnt; kein
     * Klick des Kunden schreibt die Fähigkeiten nach. Der Nachtrag beim Start der API tut es - mit
     * derselben Regel wie das Anlegen - und stößt den Push der Anlage neu an.
     */
    @Test
    void einBestehenderHeizstabOhneSchreibfaehigkeitWirdBeimStartNachgetragenUndNeuGepusht() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Zuhause vor dem Fix");
        try {
            UUID id = legeZuhauseAn(customer, site, "edge-heizstab-02");
            try (Connection c = superuser(); Statement st = c.createStatement()) {
                st.execute("UPDATE measurement_point SET control = FALSE, capabilities = "
                        + "'{\"measure\":[{\"channel\":\"power_kw\",\"unit\":\"kW\"}]}'::jsonb, "
                        + "guard_config = '{\"limits\":{},\"failsafe\":{\"behavior\":\"measure-only\"}}'::jsonb "
                        + "WHERE id = '" + id + "'");
            }
            JsonNode kaputt = entityOf(pushJson(site), id);
            assertThat(kaputt.path("capabilities").path("actuate").size()).as("Ausgangslage: ohne Schreibweg").isZero();

            RecordingPublisherConfig.PUSHES.clear();
            List<UUID> nachgetragen = nachtrag.lauf();
            assertThat(nachgetragen).contains(id);

            // Der Lauf hat die Anlage neu gepusht - und der Push trägt den Stab mit Schreibweg.
            JsonNode neu = null;
            for (byte[] raw : RecordingPublisherConfig.PUSHES) {
                JsonNode p = json.readTree(raw);
                if (site.toString().equals(p.path("site_id").asText())) {
                    neu = p;
                }
            }
            assertThat(neu).as("ein neuer Push der Anlage").isNotNull();
            JsonNode entity = entityOf(neu, id);
            JsonNode soll = json.readTree(Files.readString(VEKTOREN)).get("descriptor");
            assertThat(normalisiert(entity.get("capabilities"))).isEqualTo(normalisiert(soll.get("capabilities")));
            assertThat(normalisiert(entity.get("guards"))).isEqualTo(normalisiert(soll.get("guards")));
            assertThat(entityById(getJson("/api/v1/sites/" + site + "/entities", customer), id)
                    .path("control").asBoolean()).isTrue();

            // Idempotent: ein zweiter Lauf findet nichts mehr.
            assertThat(nachtrag.lauf()).doesNotContain(id);
        } finally {
            deleteSite(customer, site);
        }
    }

    // --- Helfer ----------------------------------------------------------------------------------

    /** Die Anlage des Captains: Box mit {@code heizstab_regler}, Deye-Wechselrichter, Heizstab (Pro 3). */
    private UUID legeZuhauseAn(String customer, UUID site, String boxRef) throws Exception {
        claim(customer, site, boxRef);
        UUID box = anyDeviceOf(site);
        // Die Box meldet den Regler - ohne das lehnt der Anlege-Weg den Stab mit 409 ab. Die
        // Meldung schreibt unter RLS, also unter dem Mandanten der Box (wie der MQTT-Zuhörer).
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            faehigkeiten.record(box, Instant.now(), List.of("data_sources", "heizstab_regler"));
        } finally {
            TenantContext.clear();
        }

        receipts.record(site, DEYE, 1, deyeConnection());
        ResponseEntity<String> wr = post("/api/v1/sites/" + site + "/components", customer,
                saveBody(DEYE, "inverter", deyeConnection(), null));
        assertThat(wr.getStatusCode()).as("Wechselrichter: %s", wr.getBody()).isEqualTo(HttpStatus.OK);

        Map<String, Object> conn = pro3();
        receipts.record(site, SHELLY, 1, conn);
        ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components", customer,
                saveBody(SHELLY, "consumer", conn, "heating-rod"));
        assertThat(created.getStatusCode()).as("Heizstab anlegen: %s", created.getBody())
                .isEqualTo(HttpStatus.OK);
        JsonNode row = byRole(json.readTree(created.getBody()), "consumer");
        assertThat(row.path("entityType").asText()).isEqualTo("heating-rod");
        return UUID.fromString(row.get("id").asText());
    }

    /** Zahlen auf double, damit 6 und 6.0 gleich sind - die Datenbank schreibt jsonb, der Vektor Klartext. */
    private JsonNode normalisiert(JsonNode n) {
        if (n == null || n.isNull()) {
            return json.nullNode();
        }
        if (n.isNumber()) {
            return json.getNodeFactory().numberNode(n.doubleValue());
        }
        if (n.isArray()) {
            ArrayNode out = json.createArrayNode();
            n.forEach(x -> out.add(normalisiert(x)));
            return out;
        }
        if (n.isObject()) {
            ObjectNode out = json.createObjectNode();
            List<String> keys = new ArrayList<>();
            n.fieldNames().forEachRemaining(keys::add);
            java.util.Collections.sort(keys);
            for (String k : keys) {
                out.set(k, normalisiert(n.get(k)));
            }
            return out;
        }
        return n;
    }

    private Path dumpPush(JsonNode push, String name) throws Exception {
        Path dir = Path.of("target", "heizstab-push");
        Files.createDirectories(dir);
        Path file = dir.resolve(name + ".json");
        Files.writeString(file, json.writerWithDefaultPrettyPrinter().writeValueAsString(push));
        return file.toAbsolutePath();
    }

    private static JsonNode entityOf(JsonNode push, UUID entityId) {
        for (JsonNode e : push.get("entities")) {
            if (entityId.toString().equals(e.path("entity_id").asText())) {
                return e;
            }
        }
        return null;
    }

    private JsonNode pushJson(UUID siteId) throws Exception {
        RecordingPublisherConfig.PUSHES.clear();
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            entityRegistry.pushRegistryBestEffort(siteId);
        } finally {
            TenantContext.clear();
        }
        assertThat(RecordingPublisherConfig.PUSHES).as("ein Push wurde veröffentlicht").isNotEmpty();
        return json.readTree(RecordingPublisherConfig.PUSHES.get(RecordingPublisherConfig.PUSHES.size() - 1));
    }

    private UUID anyDeviceOf(UUID siteId) {
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            List<UUID> ids = entityRepo.siteDeviceIds(siteId);
            assertThat(ids).as("die Anlage hat eine Box").isNotEmpty();
            return ids.get(0);
        } finally {
            TenantContext.clear();
        }
    }

    private static Map<String, Object> saveBody(String templateRef, String role,
            Map<String, Object> connection, String consumerType) {
        Map<String, Object> body = new HashMap<>();
        body.put("templateRef", templateRef);
        body.put("role", role);
        body.put("connection", connection);
        if (consumerType != null) {
            body.put("consumerType", consumerType);
            body.put("label", "Heizstab");
        }
        return body;
    }

    private static JsonNode byRole(JsonNode response, String role) {
        for (JsonNode row : response.get("components")) {
            if (role.equals(row.path("role").asText())) {
                return row;
            }
        }
        throw new AssertionError("keine Komponente mit Rolle " + role);
    }

    private static JsonNode entityById(JsonNode entities, UUID id) {
        for (JsonNode e : entities.get("entities")) {
            if (id.toString().equals(e.path("id").asText())) {
                return e;
            }
        }
        throw new AssertionError("keine Entität " + id);
    }

    private void claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", TestKennung.box(ref), "siteId", siteId.toString(),
                        "kind", "inverter"), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private void deleteSite(String customerToken, UUID siteId) {
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
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)), String.class);
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
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                HttpMethod.POST, new HttpEntity<>(form, headers),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("access_token");
    }
}
