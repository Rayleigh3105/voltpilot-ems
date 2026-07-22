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
 * E3b customer flow release (the "Kunden-Freigabe") end to end against real
 * Keycloak + TimescaleDB (fake in-process simulation service, the
 * SimulationApiTest seam): a Portal-User (operator token, tenant from the JWT -
 * NO {@code X-Tenant-Id} header) builds → validates → simulates → activates the
 * flows of THEIR OWN site through the tenant-scoped {@code /api/v1/sites/**}
 * surface, WITHOUT weakening any server-side gate.
 *
 * <p>The proof matrix:
 * <ul>
 *   <li>a FREE-node flow (Eigenverbrauch) passes the AE7 governance gate for a
 *       customer and reaches the activation flag (activation_disabled here, the
 *       rig-off default - the gate LET IT THROUGH);</li>
 *   <li>a GATED-node flow (Marktoptimierung) is refused for the customer
 *       ({@code gated_node_not_enabled}) - and the customer cannot self-enable
 *       (governance WRITE is 403 on the admin route); once a Portal-Admin
 *       enables the node type for the site, the SAME customer activation gets
 *       past the gate;</li>
 *   <li>foreign-site isolation is 404 (RLS), never 403;</li>
 *   <li>deactivate/delete of one's own flow work.</li>
 * </ul>
 * The activation flag stays OFF (default), so the real compile→publish path is
 * proven elsewhere (FlowActivationBrokerTest); here activation reaching
 * {@code activation_disabled} is exactly the "free node passed the gate" signal.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class CustomerFlowApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DACHAU_SITE = "00000000-0000-0000-0000-000000000012";
    private static final String MARKET = "vp.strategy.market";
    private static final String SELFCONSUMPTION = "vp.strategy.selfconsumption";

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
        // Portal v3 M5 go-live: production now runs with flow activation ON.
        // This test PROVES the flag still works, so it pins the OFF state
        // EXPLICITLY instead of relying on the application.yml default.
        registry.add("voltpilot.flows.activation.enabled", () -> "false");
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
                    + "\"headline\":{\"gesamtVorteilNettoEur\":180.0},"
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

    @Test
    void customerBuildsSimulatesActivatesFreeFlowWhileGatedStaysAdminEnabled() {
        // VoltPilot (Portal-Admin) bootstraps the site's v2 entities - a customer
        // cannot; the battery-hybrid is the strategy target.
        String admin = token("admin", "admin");
        JsonNode bootstrap = adminExchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/v2-entities/bootstrap", HttpMethod.POST, admin, Map.of()).getBody();
        String battery = null;
        for (JsonNode entity : bootstrap.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                battery = entity.path("id").asText();
            }
        }
        assertThat(battery).isNotNull();

        // From here on the CUSTOMER (demo = operator, tenant A) drives everything
        // through /api/v1/sites/** with NO X-Tenant-Id header - the tenant comes
        // from the JWT claim, RLS is the fence.
        String demo = token("demo", "demo");

        // The customer editor gets the same catalog (no admin gate on its route).
        JsonNode catalog = customer("/api/v1/flow-catalog", HttpMethod.GET, demo, null).getBody();
        assertThat(catalog.path("types").size()).isGreaterThanOrEqualTo(10);

        // The customer can READ governance (to render locked gated nodes) but the
        // gated market node is NOT enabled for the site yet.
        JsonNode governance = customer("/api/v1/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.GET, demo, null).getBody();
        assertThat(marketEnabled(governance)).isFalse();

        // ---- FREE-node flow: Eigenverbrauch (un-gated) -----------------------
        String freeBase = createFlow(demo, "Eigenverbrauch");
        customer(freeBase + "/versions/1", HttpMethod.PUT, demo,
                Map.of("name", "Eigenverbrauch",
                        "document", strategyDocument(battery, SELFCONSUMPTION)));
        assertThat(customer(freeBase + "/versions/1/validate", HttpMethod.POST, demo, Map.of())
                .getBody().path("valid").asBoolean())
                .as("free selfconsumption flow validates clean").isTrue();

        ResponseEntity<JsonNode> freeSim = customer(freeBase + "/versions/1/simulate",
                HttpMethod.POST, demo, Map.of());
        assertThat(freeSim.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(freeSim.getBody().path("flowScenario").asText()).isEqualTo("standardSpeicher");
        String freeSimId = freeSim.getBody().path("simulationId").asText();
        assertThat(customer(freeBase + "/versions/1/simulation/" + freeSimId, HttpMethod.GET, demo,
                null).getBody().path("status").asText()).isEqualTo("done");
        assertThat(customer(freeBase + "/versions/1", HttpMethod.GET, demo, null).getBody()
                .path("lifecycle").asText()).isEqualTo("simulated");

        // Activation of a FREE-node flow PASSES the AE7 governance gate for the
        // customer and reaches the activation flag: activation_disabled here (the
        // rig-off default), NOT gated_node_not_enabled - the gate let it through.
        JsonNode freeActivate = customer(freeBase + "/versions/1/activate", HttpMethod.POST, demo,
                Map.of()).getBody();
        assertThat(freeActivate.path("activated").asBoolean()).isFalse();
        assertThat(freeActivate.path("reason").asText())
                .as("free node passes governance, reaches the activation flag")
                .isEqualTo("activation_disabled");

        // ---- GATED-node flow: Marktoptimierung (needs VoltPilot enablement) ---
        String gatedBase = createFlow(demo, "Marktoptimierung");
        customer(gatedBase + "/versions/1", HttpMethod.PUT, demo,
                Map.of("name", "Marktoptimierung", "document", marketDocument(battery)));
        assertThat(customer(gatedBase + "/versions/1/validate", HttpMethod.POST, demo, Map.of())
                .getBody().path("valid").asBoolean()).isTrue();
        String gatedSimId = customer(gatedBase + "/versions/1/simulate", HttpMethod.POST, demo,
                Map.of()).getBody().path("simulationId").asText();
        assertThat(customer(gatedBase + "/versions/1/simulation/" + gatedSimId, HttpMethod.GET,
                demo, null).getBody().path("status").asText()).isEqualTo("done");

        // The customer cannot activate it (gated, not enabled) - the SAME refusal
        // as an admin, never relaxed by caller kind.
        JsonNode gatedRefusal = customer(gatedBase + "/versions/1/activate", HttpMethod.POST, demo,
                Map.of()).getBody();
        assertThat(gatedRefusal.path("activated").asBoolean()).isFalse();
        assertThat(gatedRefusal.path("reason").asText()).isEqualTo("gated_node_not_enabled");
        assertThat(gatedRefusal.path("gatedNodesNotEnabled").toString()).contains(MARKET);

        // The customer cannot self-enable a gated node: the governance WRITE is
        // platform-admin only (403 for the operator) - the gate is not weakened.
        assertThat(customer("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.PUT, demo,
                Map.of("enablements", List.of(Map.of("nodeType", MARKET, "enabled", true))))
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        // ... and the flow is still un-activatable for the customer.
        assertThat(customer(gatedBase + "/versions/1/activate", HttpMethod.POST, demo, Map.of())
                .getBody().path("reason").asText()).isEqualTo("gated_node_not_enabled");

        // VoltPilot (admin) enables the node type for the site ("richtet ein").
        adminExchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.PUT, admin,
                Map.of("enablements", List.of(Map.of("nodeType", MARKET, "enabled", true))));
        // Now the SAME customer activation gets PAST the governance gate and
        // reaches the activation flag (activation_disabled, not the gate refusal).
        assertThat(customer(gatedBase + "/versions/1/activate", HttpMethod.POST, demo, Map.of())
                .getBody().path("reason").asText())
                .as("with admin enablement, the customer's gated flow clears the gate")
                .isEqualTo("activation_disabled");

        // The list shows both of the customer's own flows.
        assertThat(customer("/api/v1/sites/" + BERLIN_SITE + "/flows", HttpMethod.GET, demo, null)
                .getBody().size()).isEqualTo(2);

        // Deactivating a not-active flow is an honest 409.
        ResponseEntity<JsonNode> notActive = customer(gatedBase + "/deactivate", HttpMethod.POST,
                demo, Map.of());
        assertThat(notActive.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(notActive.getBody().path("message").asText()).contains("nicht aktiv");

        // The customer can delete their own (never-active) flows.
        assertThat(customer(freeBase, HttpMethod.DELETE, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(customer(gatedBase, HttpMethod.DELETE, demo, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
    }

    /**
     * Portal v3 M3: the customer twin of the admin auto-start. Seeding a starter
     * DRAFT is what a Modus-Profil toggle needs; it is idempotent, and it does
     * NOT weaken the activation gate (proven by the gated-node case above, which
     * still refuses with {@code gated_node_not_enabled} without an enablement).
     * Runs on the DACHAU site so it never collides with the BERLIN journey.
     */
    @Test
    void customerAutoStartSeedsTheStarterFlowOnceAndIsIdempotent() {
        String admin = token("admin", "admin");
        adminExchange("/api/v1/admin/sites/" + DACHAU_SITE + "/v2-entities/bootstrap",
                HttpMethod.POST, admin, Map.of());

        String demo = token("demo", "demo");
        String path = "/api/v1/sites/" + DACHAU_SITE + "/flows/auto-start";
        ResponseEntity<JsonNode> created = customer(path, HttpMethod.POST, demo, Map.of());
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody().path("created").asBoolean()).isTrue();
        String flowId = created.getBody().path("flowId").asText();

        ResponseEntity<JsonNode> again = customer(path, HttpMethod.POST, demo, Map.of());
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody().path("created").asBoolean()).isFalse();
        assertThat(again.getBody().path("reason").asText()).isEqualTo("already_has_flow");

        // A foreign tenant cannot seed into someone else's site (RLS => 404).
        assertThat(customer(path, HttpMethod.POST, token("demo2", "demo2"), Map.of())
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(customer("/api/v1/sites/" + DACHAU_SITE + "/flows/" + flowId, HttpMethod.DELETE,
                demo, null).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
    }

    @Test
    void foreignSiteFlowsAreNotFoundForOtherCustomers() {
        // demo2 is tenant B's operator; BERLIN_SITE belongs to tenant A. RLS makes
        // it INVISIBLE => 404 (never 403) on every customer flow route.
        String demo2 = token("demo2", "demo2");
        String base = "/api/v1/sites/" + BERLIN_SITE + "/flows";
        assertThat(customer(base, HttpMethod.GET, demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer(base, HttpMethod.POST, demo2, Map.of("name", "X")).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(customer("/api/v1/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.GET, demo2, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // The catalog itself is tenant-agnostic and served to any authenticated user.
        assertThat(customer("/api/v1/flow-catalog", HttpMethod.GET, demo2, null).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    // ---- helpers -------------------------------------------------------------

    private String createFlow(String demo, String name) {
        String flowId = customer("/api/v1/sites/" + BERLIN_SITE + "/flows", HttpMethod.POST, demo,
                Map.of("name", name)).getBody().path("flowId").asText();
        return "/api/v1/sites/" + BERLIN_SITE + "/flows/" + flowId;
    }

    private static boolean marketEnabled(JsonNode governance) {
        for (JsonNode node : governance.path("gatedNodes")) {
            if (MARKET.equals(node.path("type").asText())) {
                return node.path("enabled").asBoolean();
            }
        }
        return false;
    }

    /** The market pilot chain (price + PV + SoC → market → control), claims derived. */
    private static ObjectNode marketDocument(String battery) {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", "Marktoptimierung");
        doc.put("runtime", "edge");
        doc.putArray("nodes");
        addNode(doc, "price1", "vp.price.dayahead", Map.of());
        addNode(doc, "pv1", "vp.forecast.pv", Map.of());
        addNode(doc, "soc1", "vp.entity.read", Map.of("entity_id", battery, "channel", "soc_pct"));
        ObjectNode strategy = addNode(doc, "strat1", MARKET,
                Map.of("entity_id", battery, "speicherschonung", "ausgewogen"));
        ObjectNode claim = strategy.putArray("claims").addObject();
        claim.put("entity_id", battery);
        claim.putArray("commands").add("setpoint_kw");
        claim.put("delegated", true);
        ObjectNode control = addNode(doc, "ctl1", "vp.entity.control",
                Map.of("entity_id", battery, "command", "setpoint_kw"));
        ((ObjectNode) control.path("parameters")).put("ttl_s", 180);
        ArrayNode edges = doc.putArray("edges");
        edge(edges, "e1", "price1", "prices", "strat1", "price_in");
        edge(edges, "e2", "pv1", "forecast", "strat1", "pv_forecast");
        edge(edges, "e3", "soc1", "value", "strat1", "soc");
        edge(edges, "e4", "strat1", "wunsch", "ctl1", "plan");
        doc.putArray("triggers").addObject().put("id", "t1").put("kind", "slot-boundary");
        return doc;
    }

    /** A minimal delegated-strategy flow on the battery (soc read → strategy). */
    private static ObjectNode strategyDocument(String battery, String strategyType) {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", "Strategie");
        doc.put("runtime", "edge");
        doc.putArray("nodes");
        addNode(doc, "soc1", "vp.entity.read", Map.of("entity_id", battery, "channel", "soc_pct"));
        ObjectNode strategy = addNode(doc, "strat1", strategyType, Map.of("entity_id", battery));
        ObjectNode claim = strategy.putArray("claims").addObject();
        claim.put("entity_id", battery);
        claim.putArray("commands").add("setpoint_kw");
        claim.put("delegated", true);
        ArrayNode edges = doc.putArray("edges");
        edge(edges, "e1", "soc1", "value", "strat1", "soc");
        doc.putArray("triggers").addObject().put("id", "t1").put("kind", "slot-boundary");
        return doc;
    }

    private static ObjectNode addNode(ObjectNode doc, String id, String type,
            Map<String, String> params) {
        ObjectNode node = ((ArrayNode) doc.path("nodes")).addObject();
        node.put("id", id);
        node.put("type", type);
        node.put("type_version", "1.0.0");
        ObjectNode parameters = node.putObject("parameters");
        params.forEach(parameters::put);
        return node;
    }

    private static void edge(ArrayNode edges, String id, String fromNode, String fromPort,
            String toNode, String toPort) {
        ObjectNode edge = edges.addObject();
        edge.put("id", id);
        edge.putObject("from").put("node", fromNode).put("port", fromPort);
        edge.putObject("to").put("node", toNode).put("port", toPort);
    }

    /** A customer call: operator token, NO X-Tenant-Id (tenant from the JWT). */
    private ResponseEntity<JsonNode> customer(String path, HttpMethod method, String token,
            Object body) {
        return exchange(path, method, token, null, body);
    }

    /** An admin call through the X-Tenant-Id switcher (bootstrap + governance write). */
    private ResponseEntity<JsonNode> adminExchange(String path, HttpMethod method, String token,
            Object body) {
        return exchange(path, method, token, TENANT_A, body);
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
