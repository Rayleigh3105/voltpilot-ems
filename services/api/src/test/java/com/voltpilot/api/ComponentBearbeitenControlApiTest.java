package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.math.BigDecimal;
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
 * Bearbeiten der Verbindung eines steuerbaren Verbrauchers darf {@code control}, Schreibweg und
 * Schutzgrenzen nicht abräumen (Bericht {@code vp-heizstab-rolle-push-rot} §7 N1).
 *
 * <p>Der Bearbeitungsweg ({@code applyEditDefinition}) setzte {@code control} für jeden Nicht-Speicher
 * auf false und schrieb den Anlege-Vorgabewert „nur messen“ in die Schutzgrenzen. Für den Heizstab war
 * das in #1644 behoben; hier steht der Beleg für jeden steuerbaren Typ des Katalogs über den echten
 * Weg des Portals ({@code PUT …/components/{id}}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ComponentBearbeitenControlApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String SHELLY = "builtin:shelly:shelly_http";

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

    private final ObjectMapper json = new ObjectMapper();

    private static Map<String, Object> shelly() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.178.60");
        c.put("port", 80);
        c.put("channel", 0);
        return c;
    }

    private static Map<String, Object> shellyNeu() {
        Map<String, Object> c = shelly();
        c.put("ip", "192.168.178.61");
        return c;
    }

    /** Die Spalten, an denen ein steuerbares Gerät hängt, direkt aus der Datenbank. */
    private record Stand(boolean control, String entityType, JsonNode capabilities, JsonNode guards,
            int version) {}

    private Stand stand(UUID id) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery("SELECT control, entity_type, capabilities::text, "
                        + "guard_config::text, definition_version FROM measurement_point WHERE id = '"
                        + id + "'")) {
            assertThat(rs.next()).as("Zeile %s", id).isTrue();
            return new Stand(rs.getBoolean(1), rs.getString(2), json.readTree(rs.getString(3)),
                    json.readTree(rs.getString(4)), rs.getInt(5));
        }
    }

    private Stand bearbeiteVerbindung(String customer, UUID site, UUID id) throws Exception {
        Stand vorher = stand(id);
        receipts.record(site, SHELLY, 1, shellyNeu());
        Map<String, Object> edit = saveBody(SHELLY, "consumer", shellyNeu(), null);
        edit.put("expectedRevision", vorher.version());
        ResponseEntity<String> res = put("/api/v1/sites/" + site + "/components/" + id, customer, edit);
        assertThat(res.getStatusCode()).as("Bearbeiten: %s", res.getBody()).isEqualTo(HttpStatus.OK);
        return stand(id);
    }

    /** Jeder steuerbare Verbrauchertyp des Katalogs, der den Schreibweg schon beim Anlegen bekommt. */
    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"wallbox", "ev-charger", "pump",
            "heat-pump-sgready", "modbus-load"})
    void einSteuerbarerVerbraucherBleibtBeimBearbeitenDerVerbindungSteuerbar(String typ) throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Bearbeiten " + typ);
        try {
            TenantContext.set(UUID.fromString(TENANT_A));
            UUID id;
            try {
                id = entityRegistry.createEntity(site, typ, "Gerät " + typ,
                        new BigDecimal("2.2"), null, null).id();
            } finally {
                TenantContext.clear();
            }
            // Der Bearbeiten-Weg adressiert jeden Verbraucher mit der Rolle „consumer“ (so führt ihn das
            // Portal); eine Zeile mit der Typ-Rolle würde schon vorher mit 409 abgewiesen.
            try (Connection c = superuser(); Statement st = c.createStatement()) {
                st.execute("UPDATE measurement_point SET role = 'consumer' WHERE id = '" + id + "'");
            }
            Stand vorher = stand(id);
            assertThat(vorher.control()).as("Ausgangslage: %s ist steuerbar angelegt", typ).isTrue();
            assertThat(vorher.capabilities().path("actuate").size()).as("Ausgangslage: Schreibweg").isPositive();

            Stand nachher = bearbeiteVerbindung(customer, site, id);

            assertThat(nachher.control()).as("control bleibt").isTrue();
            assertThat(nachher.entityType()).as("Entitätstyp bleibt").isEqualTo(typ);
            assertThat(nachher.capabilities()).as("Fähigkeiten bleiben").isEqualTo(vorher.capabilities());
            assertThat(nachher.guards()).as("Schutzgrenzen bleiben").isEqualTo(vorher.guards());
            assertThat(nachher.version()).as("die Fassung zählt hoch").isEqualTo(vorher.version() + 1);
        } finally {
            deleteSite(customer, site);
        }
    }

    /** Der Heizstab (#1644) über den echten Anlege-Weg: Bearbeiten ändert die Verbindung, nicht das Gerät. */
    @Test
    void einHeizstabBleibtBeimBearbeitenDerVerbindungDerselbeSteuerbareStab() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Bearbeiten Heizstab");
        try {
            claim(customer, site, "edge-bearbeiten-01");
            TenantContext.set(UUID.fromString(TENANT_A));
            try {
                faehigkeiten.record(anyDeviceOf(site), Instant.now(), List.of("data_sources", "heizstab_regler"));
            } finally {
                TenantContext.clear();
            }
            Map<String, Object> conn = pro3("192.168.178.43");
            receipts.record(site, SHELLY, 1, conn);
            Map<String, Object> body = saveBody(SHELLY, "consumer", conn, "heating-rod");
            body.put("label", "Heizstab");
            ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components", customer, body);
            assertThat(created.getStatusCode()).as("Heizstab anlegen: %s", created.getBody()).isEqualTo(HttpStatus.OK);
            UUID id = null;
            for (JsonNode row : json.readTree(created.getBody()).get("components")) {
                if ("heating-rod".equals(row.path("entityType").asText())) {
                    id = UUID.fromString(row.get("id").asText());
                }
            }
            assertThat(id).as("die Heizstab-Zeile").isNotNull();
            Stand vorher = stand(id);
            assertThat(vorher.control()).isTrue();

            Map<String, Object> neu = pro3("192.168.178.44");
            receipts.record(site, SHELLY, 1, neu);
            Map<String, Object> edit = saveBody(SHELLY, "consumer", neu, "heating-rod");
            edit.put("label", "Heizstab");
            edit.put("expectedRevision", vorher.version());
            ResponseEntity<String> res = put("/api/v1/sites/" + site + "/components/" + id, customer, edit);
            assertThat(res.getStatusCode()).as("Bearbeiten: %s", res.getBody()).isEqualTo(HttpStatus.OK);

            Stand nachher = stand(id);
            assertThat(nachher.control()).as("control bleibt").isTrue();
            assertThat(nachher.entityType()).as("Entitätstyp bleibt").isEqualTo("heating-rod");
            assertThat(nachher.capabilities()).as("Fähigkeiten bleiben").isEqualTo(vorher.capabilities());
            assertThat(nachher.guards()).as("Schutzgrenzen bleiben").isEqualTo(vorher.guards());
        } finally {
            deleteSite(customer, site);
        }
    }

    private static Map<String, Object> pro3(String ip) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", ip);
        c.put("port", 80);
        c.put("channels", List.of(0, 1, 2));
        c.put("output_kw", List.of(2.0, 2.0, 2.0));
        c.put("stages", List.of(1, 2, 3));
        c.put("anschluss", "stern_mit_n");
        return c;
    }

    private UUID anyDeviceOf(UUID siteId) {
        List<UUID> ids = entityRepo.siteDeviceIds(siteId);
        assertThat(ids).as("die Anlage hat eine Box").isNotEmpty();
        return ids.get(0);
    }

    // --- Helfer ----------------------------------------------------------------------------------

    private static Map<String, Object> saveBody(String templateRef, String role,
            Map<String, Object> connection, String consumerType) {
        Map<String, Object> body = new HashMap<>();
        body.put("templateRef", templateRef);
        body.put("role", role);
        body.put("connection", connection);
        if (consumerType != null) {
            body.put("consumerType", consumerType);
        }
        return body;
    }

    private ResponseEntity<String> put(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)), String.class);
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
