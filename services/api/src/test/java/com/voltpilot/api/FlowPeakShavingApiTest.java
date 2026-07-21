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

    @Test
    void deviceAutomationsBuildValidateSimulateAndActivate() {
        // U3: a FREE device automation - no gated strategy, a Wenn/Dann rule
        // controlling a consumer. It maps to the standardSpeicher baseline
        // dry-run (the reference the rule runs on top of) so it reaches
        // 'simuliert' and activates, passing governance untouched.
        String admin = token("admin", "admin");

        JsonNode bootstrap = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/v2-entities/bootstrap", HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        String batteryEntity = null;
        for (JsonNode entity : bootstrap.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                batteryEntity = entity.path("id").asText();
            }
        }
        assertThat(batteryEntity).isNotNull();

        // A controllable consumer (open catalog type) is the automation's target.
        String wallbox = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities",
                HttpMethod.POST, admin, TENANT_A,
                Map.of("entityType", "wallbox", "label", "Wallbox", "maxPowerKw", 11))
                .getBody().path("id").asText();
        assertThat(wallbox).isNotBlank();

        // 1) Compound automation: SoC > 50 % UND Zeitfenster -> Wallbox ein.
        String compoundId = createActivate(admin, "Wallbox bei vollem Speicher und mittags",
                compoundAutomation(batteryEntity, wallbox));
        // Free automation stays reachable to deactivate, freeing the wallbox for
        // the next rule (V-5: one active flow per entity).
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + compoundId + "/deactivate",
                HttpMethod.POST, admin, TENANT_A, Map.of());

        // 2) Price automation: Börsenpreis < 10 ct -> Wallbox ein. vp.price.current
        // is GATED (#519 H3-c: the price down-channel to the device does not
        // exist yet, so such a rule would deploy and silently do nothing) - the
        // activation is refused until VoltPilot enables the node for the site.
        String priceFlow = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A,
                Map.of("name", "Preisregel (gesperrt)")).getBody().path("flowId").asText();
        String priceBase = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + priceFlow;
        exchange(priceBase + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Preisregel (gesperrt)", "document", priceAutomation(wallbox)));
        // It VALIDATES and SIMULATES fine - the gate is the activation, exactly
        // where a silently-dead price rule must be stopped.
        assertThat(exchange(priceBase + "/versions/1/validate", HttpMethod.POST, admin, TENANT_A,
                Map.of()).getBody().path("valid").asBoolean()).isTrue();
        String priceSim = exchange(priceBase + "/versions/1/simulate", HttpMethod.POST, admin,
                TENANT_A, Map.of()).getBody().path("simulationId").asText();
        assertThat(exchange(priceBase + "/versions/1/simulation/" + priceSim, HttpMethod.GET,
                admin, TENANT_A, null).getBody().path("status").asText()).isEqualTo("done");
        JsonNode priceGated = exchange(priceBase + "/versions/1/activate", HttpMethod.POST,
                admin, TENANT_A, Map.of()).getBody();
        assertThat(priceGated.path("activated").asBoolean()).isFalse();
        assertThat(priceGated.path("reason").asText()).isEqualTo("gated_node_not_enabled");
        assertThat(priceGated.path("gatedNodesNotEnabled").toString())
                .contains("vp.price.current");
        exchange(priceBase, HttpMethod.DELETE, admin, TENANT_A, null);

        // Once VoltPilot enables the node for the site, the SAME rule activates.
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.PUT, admin, TENANT_A,
                Map.of("enablements", java.util.List.of(
                        Map.of("nodeType", "vp.price.current", "enabled", true))));
        String priceId = createActivate(admin, "Wallbox bei günstigem Börsenpreis",
                priceAutomation(wallbox));

        // Cleanup so the shared site is left as this test found it.
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + priceId + "/deactivate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + priceId,
                HttpMethod.DELETE, admin, TENANT_A, null);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + compoundId,
                HttpMethod.DELETE, admin, TENANT_A, null);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities/" + wallbox,
                HttpMethod.DELETE, admin, TENANT_A, null);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.PUT, admin, TENANT_A,
                Map.of("enablements", java.util.List.of(
                        Map.of("nodeType", "vp.price.current", "enabled", false))));
    }

    @Test
    void modbusReadAutomationRecordsIntoAGenericEntityAndActivates() {
        // MB-M1: a modbus-generic entity (open catalog type) with a CUSTOM
        // channel declared via explicit capabilities (the design's R9
        // verification: validatedCapabilities accepts any CHANNEL_RE name),
        // then a RECORD-ONLY mapped-read flow: build → validate → dry-run
        // (standardSpeicher baseline - recording IS the action) → activate,
        // governance untouched (the read node is FREE). Plus the guard-
        // integrity refusal: mapping onto the COMPOSED battery entity fails
        // validation with the Stammdaten copy.
        String admin = token("admin", "admin");

        String meter = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities",
                HttpMethod.POST, admin, TENANT_A,
                Map.of("entityType", "modbus-generic", "label", "Wärmepumpen-Zähler",
                        "capabilities", Map.of(
                                "measure",
                                List.of(Map.of("channel", "wasser_temp_c", "unit", "°C")),
                                "actuate", List.of())))
                .getBody().path("id").asText();
        assertThat(meter).isNotBlank();

        // The mapped read validating CLEAN proves the capability view carries
        // the custom channel (V-6 would fire otherwise).
        ObjectNode doc = automationShell("Zähler aufzeichnen");
        ObjectNode read = addNode(doc, "mb1", "vp.modbus.read", Map.of());
        ((ObjectNode) read.path("parameters"))
                .put("host", "192.168.40.17")
                .put("register_kind", "input")
                .put("address", 100)
                .put("data_type", "float32")
                .put("entity_id", meter)
                .put("channel", "wasser_temp_c");
        String flowId = createActivate(admin, "Zähler aufzeichnen", doc);

        // Guard integrity: the SAME read mapped onto the composed battery
        // entity is refused at validation (V-6, the Stammdaten copy).
        JsonNode bootstrap = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/v2-entities/bootstrap", HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        String batteryEntity = null;
        for (JsonNode entity : bootstrap.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                batteryEntity = entity.path("id").asText();
            }
        }
        assertThat(batteryEntity).isNotNull();
        ObjectNode hostile = automationShell("SoC einspeisen");
        ObjectNode hostileRead = addNode(hostile, "mb1", "vp.modbus.read", Map.of());
        ((ObjectNode) hostileRead.path("parameters"))
                .put("host", "192.168.40.17")
                .put("address", 100)
                .put("entity_id", batteryEntity)
                .put("channel", "soc_pct");
        String hostileId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "SoC einspeisen"))
                .getBody().path("flowId").asText();
        String hostileBase = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + hostileId;
        exchange(hostileBase + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "SoC einspeisen", "document", hostile));
        JsonNode hostileValidation = exchange(hostileBase + "/versions/1/validate",
                HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        assertThat(hostileValidation.path("valid").asBoolean()).isFalse();
        boolean composedRefusal = false;
        for (JsonNode finding : hostileValidation.path("findings")) {
            composedRefusal |= "V-6".equals(finding.path("rule").asText())
                    && finding.path("message").asText().contains("Stammdaten");
        }
        assertThat(composedRefusal)
                .as("mapping onto a composed entity refused: " + hostileValidation)
                .isTrue();

        // Cleanup so the shared site is left as this test found it.
        exchange(hostileBase, HttpMethod.DELETE, admin, TENANT_A, null);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId + "/deactivate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId,
                HttpMethod.DELETE, admin, TENANT_A, null);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities/" + meter,
                HttpMethod.DELETE, admin, TENANT_A, null);
    }

    /** create -> save doc -> validate -> simulate(standardSpeicher) -> activate; returns flowId. */
    private String createActivate(String admin, String name, ObjectNode document) {
        String flowId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", name)).getBody().path("flowId").asText();
        String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId;
        exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", name, "document", document));
        JsonNode validation = exchange(base + "/versions/1/validate", HttpMethod.POST, admin,
                TENANT_A, Map.of()).getBody();
        assertThat(validation.path("valid").asBoolean())
                .as("automation validates clean: " + validation.path("findings")).isTrue();
        ResponseEntity<JsonNode> simulated = exchange(base + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(simulated.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(simulated.getBody().path("flowScenario").asText()).isEqualTo("standardSpeicher");
        String simulationId = simulated.getBody().path("simulationId").asText();
        assertThat(exchange(base + "/versions/1/simulation/" + simulationId, HttpMethod.GET,
                admin, TENANT_A, null).getBody().path("status").asText()).isEqualTo("done");
        ResponseEntity<JsonNode> activated = exchange(base + "/versions/1/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(activated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(activated.getBody().path("activated").asBoolean())
                .as("free device automation activates (governance untouched): " + activated.getBody())
                .isTrue();
        assertThat(activated.getBody().path("lifecycle").asText()).isEqualTo("active");
        return flowId;
    }

    /** SoC > 50 % UND Zeitfenster -> Wallbox on/off (threshold + schedule joined by AND). */
    private static ObjectNode compoundAutomation(String batteryEntity, String wallbox) {
        ObjectNode doc = automationShell("Compound");
        addNode(doc, "soc1", "vp.entity.read",
                Map.of("entity_id", batteryEntity, "channel", "soc_pct"));
        ObjectNode threshold = addNode(doc, "sw1", "vp.logic.threshold", Map.of());
        threshold.put("type_version", "1.1.0");
        ((ObjectNode) threshold.path("parameters")).put("threshold", 50.0).put("direction", "above");
        addNode(doc, "z1", "vp.schedule.window",
                Map.of("from", "11:00", "to", "15:00", "days", "alle"));
        addNode(doc, "und1", "vp.logic.and", Map.of());
        controlNode(doc, "steuern1", wallbox);
        edge(doc, "e1", "soc1", "value", "sw1", "input");
        edge(doc, "e2", "sw1", "result", "und1", "a");
        edge(doc, "e3", "z1", "active", "und1", "b");
        edge(doc, "e4", "und1", "result", "steuern1", "value");
        return doc;
    }

    /** Börsenpreis < 10 ct -> Wallbox on/off (price condition over vp.price.current). */
    private static ObjectNode priceAutomation(String wallbox) {
        ObjectNode doc = automationShell("Price");
        addNode(doc, "preis1", "vp.price.current", Map.of());
        ObjectNode threshold = addNode(doc, "sw1", "vp.logic.threshold", Map.of());
        threshold.put("type_version", "1.1.0");
        ((ObjectNode) threshold.path("parameters")).put("threshold", 10.0).put("direction", "below");
        controlNode(doc, "steuern1", wallbox);
        edge(doc, "e1", "preis1", "value", "sw1", "input");
        edge(doc, "e2", "sw1", "result", "steuern1", "value");
        return doc;
    }

    private static ObjectNode automationShell(String name) {
        ObjectNode doc = MAPPER.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", name);
        doc.put("runtime", "edge");
        doc.putArray("nodes");
        doc.putArray("edges");
        doc.putArray("triggers").addObject().put("id", "t1").put("kind", "slot-boundary");
        return doc;
    }

    private static void controlNode(ObjectNode doc, String id, String wallbox) {
        ObjectNode ctl = addNode(doc, id, "vp.entity.control",
                Map.of("entity_id", wallbox, "command", "on_off"));
        ((ObjectNode) ctl.path("parameters")).put("ttl_s", 300);
        ObjectNode claim = ctl.putArray("claims").addObject();
        claim.put("entity_id", wallbox);
        claim.putArray("commands").add("on_off");
    }

    private static void edge(ObjectNode doc, String id, String fromNode, String fromPort,
            String toNode, String toPort) {
        ObjectNode edge = ((ArrayNode) doc.path("edges")).addObject();
        edge.put("id", id);
        edge.putObject("from").put("node", fromNode).put("port", fromPort);
        edge.putObject("to").put("node", toNode).put("port", toPort);
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
