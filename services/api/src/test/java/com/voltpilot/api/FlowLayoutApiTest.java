package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.Map;
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
 * Portal v3 M5 Part A/B: the editor's canvas LAYOUT and the device-reported
 * live flow state, end to end against real Keycloak + TimescaleDB.
 *
 * <p>The load-bearing property is NEGATIVE and is asserted directly here:
 * <b>a saved layout never appears in the stored flow document</b>. The
 * flow-graph schema is {@code additionalProperties: false} and flowc assigns
 * the artifact bundle's x/y itself INSIDE {@code content_hash}, so a position
 * that reached the document would change the content hash on every drag and
 * re-deploy the customer's device. Layout is its own RLS-scoped resource.
 *
 * <p>Also proven: unknown node ids are dropped server-side (a stale layout can
 * never resurrect a deleted node), the layout follows the flow IDENTITY (a
 * forked draft inherits it), RLS makes a foreign site's layout a 404, and the
 * flow-status read is an honest empty document while no device has reported.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class FlowLayoutApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    private static final ObjectMapper MAPPER = new ObjectMapper();

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

    @Test
    void layoutRoundTripsPerFlowAndNeverEntersTheStoredDocument() {
        String demo = token("demo", "demo");
        String flowId = customer("/api/v1/sites/" + BERLIN_SITE + "/flows", HttpMethod.POST, demo,
                Map.of("name", "Layout-Test")).getBody().path("flowId").asText();
        String base = "/api/v1/sites/" + BERLIN_SITE + "/flows/" + flowId;
        customer(base + "/versions/1", HttpMethod.PUT, demo,
                Map.of("name", "Layout-Test", "document", twoNodeDocument()));

        // A flow that was never arranged has no layout - the client then renders
        // the deterministic auto-layout.
        assertThat(customer(base + "/layout", HttpMethod.GET, demo, null)
                .getBody().path("positions").size()).isZero();

        // Save an arrangement - including a position for a node that does NOT
        // exist (a stale layout must never resurrect a deleted node).
        JsonNode saved = customer(base + "/layout", HttpMethod.PUT, demo, Map.of("positions", Map.of(
                "lesen1", Map.of("x", 40, "y", 64),
                "schwelle1", Map.of("x", 320, "y", 128),
                "geloescht", Map.of("x", 999, "y", 999)))).getBody();
        assertThat(saved.path("positions").fieldNames()).toIterable()
                .containsExactlyInAnyOrder("lesen1", "schwelle1");

        JsonNode reread = customer(base + "/layout", HttpMethod.GET, demo, null).getBody();
        assertThat(reread.path("positions").path("schwelle1").path("x").asDouble()).isEqualTo(320);
        assertThat(reread.path("positions").has("geloescht")).isFalse();

        // THE POINT: the stored document is untouched by the layout write - no
        // node carries x/y, so the compiled artifact's content_hash cannot move.
        JsonNode version = customer(base + "/versions/1", HttpMethod.GET, demo, null).getBody();
        for (JsonNode node : version.path("document").path("nodes")) {
            assertThat(node.has("x")).as("a position must never reach the document").isFalse();
            assertThat(node.has("y")).isFalse();
        }
        assertThat(version.path("document").toString()).doesNotContain("positions");

        // Layout follows the flow IDENTITY, not the version: saving the flow
        // again creates version 2, which inherits the same arrangement.
        int forked = customer(base + "/versions/1", HttpMethod.PUT, demo,
                Map.of("name", "Layout-Test", "document", twoNodeDocument()))
                .getBody().path("flowVersion").asInt();
        assertThat(forked).isGreaterThanOrEqualTo(1);
        assertThat(customer(base + "/layout", HttpMethod.GET, demo, null)
                .getBody().path("positions").path("lesen1").path("y").asDouble()).isEqualTo(64);

        // RLS: another tenant's operator sees neither the flow nor its layout.
        String demo2 = token("demo2", "demo2");
        assertThat(customer(base + "/layout", HttpMethod.GET, demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(base + "/layout", HttpMethod.PUT, demo2,
                Map.of("positions", Map.of("lesen1", Map.of("x", 1, "y", 1)))).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        customer(base, HttpMethod.DELETE, demo, null);
    }

    @Test
    void flowStatusIsAnHonestEmptyDocumentUntilADeviceReports() {
        String demo = token("demo", "demo");
        JsonNode status = customer("/api/v1/sites/" + BERLIN_SITE + "/flow-node-status",
                HttpMethod.GET, demo, null).getBody();
        // No device has reported: no acks, and NO node states - the editor then
        // shows channel values only and never a guessed per-node state.
        assertThat(status.path("acks").size()).isZero();
        assertThat(status.path("nodes").size()).isZero();

        assertThat(customer("/api/v1/sites/" + BERLIN_SITE + "/flow-node-status", HttpMethod.GET,
                token("demo2", "demo2"), null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- helpers -------------------------------------------------------------

    /** A minimal valid two-node document (read -> threshold). */
    private static ObjectNode twoNodeDocument() {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", "Layout-Test");
        doc.put("runtime", "edge");
        ArrayNode nodes = doc.putArray("nodes");
        ObjectNode read = nodes.addObject();
        read.put("id", "lesen1");
        read.put("type", "vp.entity.read");
        read.put("type_version", "1.0.0");
        read.putObject("parameters").put("entity_id", "irgendwas").put("channel", "power_kw");
        ObjectNode threshold = nodes.addObject();
        threshold.put("id", "schwelle1");
        threshold.put("type", "vp.logic.threshold");
        threshold.put("type_version", "1.1.0");
        threshold.putObject("parameters").put("threshold", -3.0).put("direction", "below");
        ObjectNode edge = doc.putArray("edges").addObject();
        edge.put("id", "e1");
        edge.putObject("from").put("node", "lesen1").put("port", "value");
        edge.putObject("to").put("node", "schwelle1").put("port", "input");
        doc.putArray("triggers").addObject().put("id", "t1").put("kind", "slot-boundary");
        return doc;
    }

    private ResponseEntity<JsonNode> customer(String path, HttpMethod method, String token,
            Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
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
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
