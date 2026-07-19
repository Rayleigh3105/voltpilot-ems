package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.simulation.SimulationHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
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
 * The E3a flow-editor backend end to end against real Keycloak + TimescaleDB
 * (fake in-process simulation service, the SimulationApiTest seam): the
 * ACCEPTANCE journey - admin bootstraps the site's v2 entities, builds the
 * pilot flow (Preis + PV-Prognose + Speicher lesen → Marktoptimierung →
 * Speicher steuern), gets validation feedback, runs the dry-run over the
 * site's real master data (lifecycle draft → simulated), and activation is
 * refused by the OFF activation flag (the flowc compiler is wired now) without
 * changing state. Plus: versioning (editing a simulated version creates a new
 * draft), tenancy (X-Tenant-Id switcher, wrong tenant = 404), and the
 * platform-admin gate (customer token = 403).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class FlowApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";
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

    /** In-memory stand-in for the Python simulation service. */
    static class FakeSimulationService implements SimulationHttp {

        final List<Map<String, Object>> submitted = new CopyOnWriteArrayList<>();
        final ConcurrentHashMap<String, String> statusBodies = new ConcurrentHashMap<>();
        final AtomicInteger counter = new AtomicInteger();
        private final ObjectMapper json = new ObjectMapper();

        @Override
        @SuppressWarnings("unchecked")
        public Response post(URI uri, String jsonBody) throws IOException {
            submitted.add(json.readValue(jsonBody, Map.class));
            String id = String.format("%032d", counter.incrementAndGet());
            statusBodies.put(id, "{\"status\":\"done\",\"progress\":1.0,\"result\":{"
                    + "\"headline\":{\"gesamtVorteilNettoEur\":364.0},"
                    + "\"annahmen\":{\"preisjahr\":\"2025\"}}}");
            return new Response(202, "{\"simulationId\":\"" + id + "\"}");
        }

        @Override
        public Response get(URI uri) {
            String path = uri.getPath();
            String id = path.substring(path.lastIndexOf('/') + 1);
            String body = statusBodies.get(id);
            return body != null ? new Response(200, body)
                    : new Response(404, "{\"message\":\"Simulation nicht gefunden.\"}");
        }
    }

    @TestConfiguration
    static class FakeSimulation {
        @Bean
        FakeSimulationService simulationHttp() {
            return new FakeSimulationService();
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    FakeSimulationService fake;

    @Test
    void adminBuildsValidatesSimulatesAndActivationIsGatedByTheFlag() {
        String admin = token("admin", "admin");

        // The catalog the editor palettes/validates against.
        JsonNode catalog = exchange("/api/v1/admin/flow-catalog", HttpMethod.GET, admin,
                TENANT_A, null).getBody();
        assertThat(catalog.path("types").size()).isGreaterThanOrEqualTo(10);

        // Bootstrap the pilot entities; the battery-hybrid is the claim target.
        JsonNode bootstrap = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/v2-entities/bootstrap", HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        String batteryEntity = null;
        for (JsonNode entity : bootstrap.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                batteryEntity = entity.path("id").asText();
            }
        }
        assertThat(batteryEntity).isNotNull();

        // Create → v1 draft with the server-stamped skeleton.
        ResponseEntity<JsonNode> created = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/flows", HttpMethod.POST, admin, TENANT_A,
                Map.of("name", "Marktoptimierung"));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String flowId = created.getBody().path("flowId").asText();
        assertThat(created.getBody().path("lifecycle").asText()).isEqualTo("draft");
        assertThat(created.getBody().path("document").path("flow_id").asText())
                .isEqualTo(flowId);

        // Save the pilot document; validation reports clean.
        String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId;
        ObjectNode pilot = pilotDocument(batteryEntity);
        JsonNode saved = exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Marktoptimierung", "document", pilot)).getBody();
        assertThat(saved.path("flowVersion").asInt()).isEqualTo(1);
        JsonNode validation = exchange(base + "/versions/1/validate", HttpMethod.POST, admin,
                TENANT_A, Map.of()).getBody();
        assertThat(validation.path("valid").asBoolean())
                .as("pilot flow validates clean: " + validation.path("findings"))
                .isTrue();

        // A broken edit gets validation FEEDBACK (V-1: required input gone).
        ObjectNode broken = pilot.deepCopy();
        ((ArrayNode) broken.path("edges")).remove(0); // price_in edge
        exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Marktoptimierung", "document", broken));
        JsonNode brokenValidation = exchange(base + "/versions/1/validate", HttpMethod.POST,
                admin, TENANT_A, Map.of()).getBody();
        assertThat(brokenValidation.path("valid").asBoolean()).isFalse();
        assertThat(brokenValidation.path("findings").toString()).contains("V-1");
        // ... and simulate/activate refuse an invalid flow.
        ResponseEntity<JsonNode> simulateBroken = exchange(base + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(simulateBroken.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // Repair, simulate: the dry-run runs over the site's real master data.
        exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Marktoptimierung", "document", pilot));
        ResponseEntity<JsonNode> simulated = exchange(base + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(simulated.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        String simulationId = simulated.getBody().path("simulationId").asText();
        assertThat(simulated.getBody().path("flowScenario").asText()).isEqualTo("voltpilot");
        // The strategy's Speicherschonung reached the job payload (ausgewogen = 4 ct).
        Map<String, Object> payload = fake.submitted.get(fake.submitted.size() - 1);
        assertThat(((Map<?, ?>) payload.get("battery")).get("wearCostCtPerKwh")).isEqualTo(4);

        // Poll: done → the lifecycle flips draft → simulated, summary recorded.
        JsonNode poll = exchange(base + "/versions/1/simulation/" + simulationId,
                HttpMethod.GET, admin, TENANT_A, null).getBody();
        assertThat(poll.path("status").asText()).isEqualTo("done");
        assertThat(poll.path("flowScenario").asText()).isEqualTo("voltpilot");
        JsonNode version = exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody();
        assertThat(version.path("lifecycle").asText()).isEqualTo("simulated");
        assertThat(version.path("simulation").path("headline").path("gesamtVorteilNettoEur")
                .asDouble()).isEqualTo(364.0);

        // Activation: the flowc compiler is wired now, but activation is gated
        // OFF on this environment (VOLTPILOT_FLOWS_ACTIVATION_ENABLED, only the
        // rig sets it), so it refuses honestly - nothing published, lifecycle
        // unchanged. The real compile→publish path is proven against a broker in
        // FlowActivationBrokerTest.
        ResponseEntity<JsonNode> activated = exchange(base + "/versions/1/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(activated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(activated.getBody().path("activated").asBoolean()).isFalse();
        assertThat(activated.getBody().path("reason").asText()).isEqualTo("activation_disabled");
        assertThat(activated.getBody().path("message").asText()).contains("deaktiviert");
        assertThat(exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody().path("lifecycle").asText()).isEqualTo("simulated");

        // Editing the SIMULATED version creates a NEW draft version (contract §5).
        JsonNode newDraft = exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Marktoptimierung", "document", pilot)).getBody();
        assertThat(newDraft.path("flowVersion").asInt()).isEqualTo(2);
        assertThat(newDraft.path("lifecycle").asText()).isEqualTo("draft");

        // The list shows one flow, latest v2 draft, no active version.
        JsonNode list = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.GET, admin, TENANT_A, null).getBody();
        assertThat(list.size()).isEqualTo(1);
        assertThat(list.get(0).path("latestVersion").asInt()).isEqualTo(2);
        assertThat(list.get(0).path("activeVersion").isNull()).isTrue();
        assertThat(list.get(0).path("versions").size()).isEqualTo(2);

        // A draft may not activate before its dry-run (the D1 safety gate).
        ResponseEntity<JsonNode> draftActivate = exchange(base + "/versions/2/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(draftActivate.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(draftActivate.getBody().path("message").asText()).contains("simulieren");
    }

    @Test
    void flowWithoutStrategyGetsAnHonestSimulationRefusal() {
        String admin = token("admin", "admin");
        String flowId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Nur Benachrichtigung"))
                .getBody().path("flowId").asText();
        ResponseEntity<JsonNode> refused = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/flows/" + flowId + "/versions/1/simulate", HttpMethod.POST, admin,
                TENANT_A, Map.of());
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(refused.getBody().path("message").asText())
                .contains("Validierungsfehler");
        // Clean up the draft so the shared BERLIN site's flow list stays
        // deterministic for adminBuilds… regardless of JUnit method order.
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId, HttpMethod.DELETE,
                admin, TENANT_A, null);
    }

    @Test
    void tenancyAndRoleGatesHold() {
        String admin = token("admin", "admin");
        String flowId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Gate-Test"))
                .getBody().path("flowId").asText();
        String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows";

        // Without the switcher header the site is invisible (RLS default-deny).
        assertThat(exchange(base, HttpMethod.GET, admin, null, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        // Through the WRONG tenant the site (and flow) is invisible.
        assertThat(exchange(base, HttpMethod.GET, admin, TENANT_B, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(exchange(base + "/" + flowId + "/versions/1", HttpMethod.GET, admin,
                TENANT_B, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A customer token gets 403 on every flow route (platform-admin only).
        String demo = token("demo", "demo");
        assertThat(exchange(base, HttpMethod.GET, demo, null, null).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(exchange("/api/v1/admin/flow-catalog", HttpMethod.GET, demo, null, null)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        // Draft cleanup works; a second delete is 404.
        assertThat(exchange(base + "/" + flowId, HttpMethod.DELETE, admin, TENANT_A, null)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(exchange(base + "/" + flowId, HttpMethod.DELETE, admin, TENANT_A, null)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- helpers -------------------------------------------------------------

    /** The pilot chain, claims editor-derived (only the delegated strategy). */
    private static ObjectNode pilotDocument(String batteryEntity) {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", "Marktoptimierung");
        doc.put("runtime", "edge");
        ArrayNode nodes = doc.putArray("nodes");
        nodes.add(node("price1", "vp.price.dayahead", Map.of()));
        nodes.add(node("pv1", "vp.forecast.pv", Map.of()));
        nodes.add(node("soc1", "vp.entity.read",
                Map.of("entity_id", batteryEntity, "channel", "soc_pct")));
        ObjectNode strategy = node("strat1", "vp.strategy.market",
                Map.of("entity_id", batteryEntity, "speicherschonung", "ausgewogen"));
        ObjectNode claim = strategy.putArray("claims").addObject();
        claim.put("entity_id", batteryEntity);
        claim.putArray("commands").add("setpoint_kw");
        claim.put("delegated", true);
        nodes.add(strategy);
        ObjectNode control = node("ctl1", "vp.entity.control",
                Map.of("entity_id", batteryEntity, "command", "setpoint_kw"));
        ((ObjectNode) control.path("parameters")).put("ttl_s", 180);
        nodes.add(control);
        ArrayNode edges = doc.putArray("edges");
        edges.add(edge("e1", "price1", "prices", "strat1", "price_in"));
        edges.add(edge("e2", "pv1", "forecast", "strat1", "pv_forecast"));
        edges.add(edge("e3", "soc1", "value", "strat1", "soc"));
        edges.add(edge("e4", "strat1", "wunsch", "ctl1", "plan"));
        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "t1");
        trigger.put("kind", "slot-boundary");
        return doc;
    }

    private static ObjectNode node(String id, String type, Map<String, String> params) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("id", id);
        node.put("type", type);
        node.put("type_version", "vp.logic.threshold".equals(type) ? "1.1.0" : "1.0.0");
        ObjectNode parameters = node.putObject("parameters");
        params.forEach(parameters::put);
        return node;
    }

    private static ObjectNode edge(String id, String fromNode, String fromPort, String toNode,
            String toPort) {
        ObjectNode edge = MAPPER.createObjectNode();
        edge.put("id", id);
        ObjectNode from = edge.putObject("from");
        from.put("node", fromNode);
        from.put("port", fromPort);
        ObjectNode to = edge.putObject("to");
        to.put("node", toNode);
        to.put("port", toPort);
        return edge;
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token,
            String tenantHeader, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenantHeader != null) {
            headers.add("X-Tenant-Id", tenantHeader);
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
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
