package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.flows.FlowCompilerHttp;
import com.voltpilot.api.simulation.SimulationHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
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
 * The E5a peak-shaving flow end to end against real Keycloak + TimescaleDB
 * (fake in-process simulation service AND a fake flowc transport - a JVM test
 * has no Node runtime, so the {@link FlowCompilerHttp} seam serves the contract
 * fixture artifact; the Node {@code serve.test.js} pins the real graph→artifact
 * hash). This class runs with the activation flag ON, so it is SEPARATE from
 * {@link FlowApiTest} (which proves the OFF-flag refusal on the market flow).
 *
 * <p>The acceptance journey for {@code vp.strategy.peakshaving}: bootstrap the
 * site's v2 entities → build the peak-shaving flow on the battery → validate
 * (V-1..V-8) → dry-run (the co-optimized "voltpilot" scenario) → activation is
 * gated first by AE7 node governance (gated_node_not_enabled), then by the
 * peak-shaving module precondition (422 when no Leistungspreis is configured),
 * and finally SUCCEEDS once VoltPilot enables the node AND configures the
 * Leistungspreis. Plus: an atypical-grid flow is refused honestly at the
 * dry-run (its economics are E5b, not built).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class FlowPeakShavingApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String PEAKSHAVING = "vp.strategy.peakshaving";

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

        // The rig-only activation flag ON - this class proves the SUCCESS path.
        registry.add("voltpilot.flows.activation.enabled", () -> "true");

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    /** In-memory stand-in for the Python simulation service (SimulationApiTest seam). */
    static class FakeSimulationService implements SimulationHttp {

        final AtomicInteger counter = new AtomicInteger();
        final ConcurrentHashMap<String, String> statusBodies = new ConcurrentHashMap<>();
        final List<Map<String, Object>> submitted = new CopyOnWriteArrayList<>();
        private final ObjectMapper json = new ObjectMapper();

        @Override
        @SuppressWarnings("unchecked")
        public Response post(URI uri, String jsonBody) throws IOException {
            submitted.add(json.readValue(jsonBody, Map.class));
            String id = String.format("%032d", counter.incrementAndGet());
            statusBodies.put(id, "{\"status\":\"done\",\"progress\":1.0,\"result\":{"
                    + "\"headline\":{\"gesamtVorteilNettoEur\":221.0},"
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
    static class Fakes {

        @Bean
        FakeSimulationService simulationHttp() {
            return new FakeSimulationService();
        }

        /**
         * Fake flowc transport: a JVM test has no Node runtime, so the real
         * {@link com.voltpilot.api.flows.FlowCompilerClient} runs offline over
         * this seam and gets the contract fixture ARTIFACT back (kind=artifact,
         * valid shape) - exactly what the sidecar would return. The Node
         * serve.test.js proves the real graph→artifact→hash compile.
         */
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

    @Test
    void peakShavingActivatesWithGovernanceAndPriceWhileAtypicalGridIsRefused() {
        String admin = token("admin", "admin");

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

        // Ensure a clean slate (start with no Leistungspreis configured).
        setLeistungspreis(admin, null);

        // -- atypical-grid: validates, but its economics (E5b) are not built, so
        // it is refused HONESTLY at the dry-run (never a crash). Done FIRST, on a
        // DRAFT, so no active flow claims the battery before the peak-shaving run.
        String atypId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Atypische Netznutzung"))
                .getBody().path("flowId").asText();
        String atypBase = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + atypId;
        exchange(atypBase + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Atypische Netznutzung",
                        "document", strategyDocument(batteryEntity, "vp.strategy.atypical-grid")));
        assertThat(exchange(atypBase + "/versions/1/validate", HttpMethod.POST, admin, TENANT_A,
                Map.of()).getBody().path("valid").asBoolean()).isTrue();
        ResponseEntity<JsonNode> atypRefused = exchange(atypBase + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(atypRefused.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(atypRefused.getBody().path("message").asText())
                .contains("atypische Netznutzung").contains("Vorbereitung");
        // The draft never activated, so it deletes cleanly (no lingering claim).
        assertThat(exchange(atypBase, HttpMethod.DELETE, admin, TENANT_A, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        // Create → save the peak-shaving flow → it validates clean (V-1..V-8).
        String flowId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Lastspitzenkappung"))
                .getBody().path("flowId").asText();
        String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId;
        exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Lastspitzenkappung", "document", peakShavingDocument(batteryEntity)));
        JsonNode validation = exchange(base + "/versions/1/validate", HttpMethod.POST, admin,
                TENANT_A, Map.of()).getBody();
        assertThat(validation.path("valid").asBoolean())
                .as("peak-shaving flow validates clean: " + validation.path("findings"))
                .isTrue();

        // Dry-run: peak-shaving maps to the co-optimized "voltpilot" scenario.
        ResponseEntity<JsonNode> simulated = exchange(base + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(simulated.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(simulated.getBody().path("flowScenario").asText()).isEqualTo("voltpilot");
        String simulationId = simulated.getBody().path("simulationId").asText();
        JsonNode poll = exchange(base + "/versions/1/simulation/" + simulationId,
                HttpMethod.GET, admin, TENANT_A, null).getBody();
        assertThat(poll.path("status").asText()).isEqualTo("done");
        assertThat(exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody().path("lifecycle").asText()).isEqualTo("simulated");

        // 1) Governance: peak-shaving is a GATED node - refused before anything.
        ResponseEntity<JsonNode> gated = exchange(base + "/versions/1/activate", HttpMethod.POST,
                admin, TENANT_A, Map.of());
        assertThat(gated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(gated.getBody().path("activated").asBoolean()).isFalse();
        assertThat(gated.getBody().path("reason").asText()).isEqualTo("gated_node_not_enabled");
        assertThat(gated.getBody().path("gatedNodesNotEnabled").toString()).contains(PEAKSHAVING);

        // Enable the node type for the site (VoltPilot "richtet ein").
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance", HttpMethod.PUT,
                admin, TENANT_A,
                Map.of("enablements", List.of(Map.of("nodeType", PEAKSHAVING, "enabled", true))));

        // 2) Module precondition: no Leistungspreis configured → honest 422.
        ResponseEntity<JsonNode> noPrice = exchange(base + "/versions/1/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(noPrice.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(noPrice.getBody().path("activated").asBoolean()).isFalse();
        assertThat(noPrice.getBody().path("reason").asText()).isEqualTo("peakshaving_not_configured");
        assertThat(noPrice.getBody().path("message").asText()).contains("Leistungspreis");
        // Nothing changed - the flow stays simuliert.
        assertThat(exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody().path("lifecycle").asText()).isEqualTo("simulated");

        // 3) Configure the Leistungspreis (admin optimizer-config) → activates.
        setLeistungspreis(admin, 140);
        ResponseEntity<JsonNode> activated = exchange(base + "/versions/1/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(activated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(activated.getBody().path("activated").asBoolean())
                .as("activation succeeds with governance + Leistungspreis: " + activated.getBody())
                .isTrue();
        assertThat(activated.getBody().path("reason").isMissingNode()
                || activated.getBody().path("reason").isNull()).isTrue();
        assertThat(activated.getBody().path("lifecycle").asText()).isEqualTo("active");
        assertThat(exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody().path("lifecycle").asText()).isEqualTo("active");
    }

    // ---- helpers -------------------------------------------------------------

    /** The minimal peak-shaving flow: read SoC → delegated peak-shaving strategy. */
    private static ObjectNode peakShavingDocument(String batteryEntity) {
        return strategyDocument(batteryEntity, PEAKSHAVING);
    }

    /** A minimal delegated-strategy flow on the battery (soc read → strategy). */
    private static ObjectNode strategyDocument(String batteryEntity, String strategyType) {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", "Strategie");
        doc.put("runtime", "edge");
        doc.putArray("nodes");
        addNode(doc, "soc1", "vp.entity.read",
                Map.of("entity_id", batteryEntity, "channel", "soc_pct"));
        ObjectNode strategy = addNode(doc, "strat1", strategyType,
                Map.of("entity_id", batteryEntity));
        ObjectNode claim = strategy.putArray("claims").addObject();
        claim.put("entity_id", batteryEntity);
        claim.putArray("commands").add("setpoint_kw");
        claim.put("delegated", true);
        ObjectNode edge = doc.putArray("edges").addObject();
        edge.put("id", "e1");
        edge.putObject("from").put("node", "soc1").put("port", "value");
        edge.putObject("to").put("node", "strat1").put("port", "soc");
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

    /** Set (or clear, with null) the site's Leistungspreis via optimizer-config. */
    private void setLeistungspreis(String admin, Integer eurKw) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("leistungspreisEurKw", eurKw);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/optimizer-config", HttpMethod.PUT,
                admin, TENANT_A, body);
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
