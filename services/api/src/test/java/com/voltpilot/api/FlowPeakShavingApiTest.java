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
         * Steuerung Stufe 3: the composed registry pushes, recorded. The real
         * publisher is @ConditionalOnProperty on the broker; this stand-in lets
         * the test read the BYTES the box would get (owner_claimed).
         */
        @Bean
        RecordingRegistryPublisher registryPublisher() {
            return new RecordingRegistryPublisher();
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

    /** The stand-in simulation service - E-8 asserts what is (not) submitted. */
    @Autowired
    FakeSimulationService simulationHttp;

    /** Steuerung Stufe 3: the composed registry pushes the box would receive. */
    @Autowired
    RecordingRegistryPublisher registryPublisher;

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
    void deviceAutomationDryRunNeverRunsTheYearSimulation() {
        // E-8: the audit's exact case - activating a pure TIME-WINDOW rule
        // ("mittags die Wallbox ein") ran a 365-day battery-dispatch MILP
        // taking ~2,5 minutes, needing a full previous calendar year of
        // day-ahead prices AND a live weather-archive call. A rule that touches
        // no battery cannot change the dispatch economics, so its dry-run is
        // SCOPED: nothing is submitted to the simulation service at all - which
        // is exactly why it no longer depends on a year of prices being there.
        String admin = token("admin", "admin");
        int submittedBefore = simulationHttp.submitted.size();

        String wallbox = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities",
                HttpMethod.POST, admin, TENANT_A,
                Map.of("entityType", "wallbox", "label", "Wallbox Zeitplan", "maxPowerKw", 11))
                .getBody().path("id").asText();
        assertThat(wallbox).isNotBlank();

        String flowId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Wallbox mittags"))
                .getBody().path("flowId").asText();
        String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId;
        exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Wallbox mittags", "document", scheduleAutomation(wallbox)));
        assertThat(exchange(base + "/versions/1/validate", HttpMethod.POST, admin, TENANT_A,
                Map.of()).getBody().path("valid").asBoolean()).isTrue();

        ResponseEntity<JsonNode> started = exchange(base + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(started.getBody().path("scope").asText()).isEqualTo("automation");
        assertThat(started.getBody().path("flowScenario").isNull()).isTrue();
        assertThat(simulationHttp.submitted)
                .as("no year simulation is submitted for a rule that touches no battery")
                .hasSize(submittedBefore);

        // The poll answers immediately and the version really reaches 'simuliert'.
        String simulationId = started.getBody().path("simulationId").asText();
        JsonNode poll = exchange(base + "/versions/1/simulation/" + simulationId, HttpMethod.GET,
                admin, TENANT_A, null).getBody();
        assertThat(poll.path("status").asText()).isEqualTo("done");
        assertThat(poll.path("scope").asText()).isEqualTo("automation");
        assertThat(simulationHttp.submitted).hasSize(submittedBefore);
        assertThat(exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody().path("lifecycle").asText()).isEqualTo("simulated");

        // ... and it activates, so the scoping did not cost the customer the gate.
        ResponseEntity<JsonNode> activated = exchange(base + "/versions/1/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(activated.getBody().path("activated").asBoolean())
                .as("scoped dry-run still satisfies the activation precondition: "
                        + activated.getBody()).isTrue();

        // A BATTERY strategy still runs the full-year simulation - the scoping
        // must not silently skip the economics where they exist.
        String stratFlow = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Lastspitzenkappung (Probe)"))
                .getBody().path("flowId").asText();
        String stratBase = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + stratFlow;
        exchange(stratBase + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Lastspitzenkappung (Probe)", "document",
                        batteryStrategyFlow(batteryEntityOf(admin))));
        ResponseEntity<JsonNode> stratSim = exchange(stratBase + "/versions/1/simulate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(stratSim.getBody().path("flowScenario").asText())
                .isEqualTo("voltpilot");
        assertThat(simulationHttp.submitted)
                .as("a battery strategy DOES submit the year simulation")
                .hasSize(submittedBefore + 1);

        // Cleanup - the shared site must be left as this test found it.
        exchange(base + "/deactivate", HttpMethod.POST, admin, TENANT_A, Map.of());
        exchange(stratBase, HttpMethod.DELETE, admin, TENANT_A, null);
        exchange(base, HttpMethod.DELETE, admin, TENANT_A, null);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities/" + wallbox,
                HttpMethod.DELETE, admin, TENANT_A, null);
    }

    /** The battery-hybrid entity id of the pilot site (bootstrap is idempotent). */
    private String batteryEntityOf(String admin) {
        JsonNode bootstrap = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/v2-entities/bootstrap", HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        for (JsonNode entity : bootstrap.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                return entity.path("id").asText();
            }
        }
        throw new IllegalStateException("no battery-hybrid entity on the pilot site");
    }

    /** Zeitfenster -> Wallbox on/off: no battery anywhere in the graph. */
    private static ObjectNode scheduleAutomation(String wallbox) {
        ObjectNode doc = automationShell("Zeitplan");
        addNode(doc, "z1", "vp.schedule.window",
                Map.of("from", "11:00", "to", "15:00", "days", "alle"));
        controlNode(doc, "steuern1", wallbox);
        edge(doc, "e1", "z1", "active", "steuern1", "value");
        return doc;
    }

    /** A battery strategy flow (the year-simulation contrast). */
    private static ObjectNode batteryStrategyFlow(String battery) {
        ObjectNode doc = automationShell("Lastspitzenkappung");
        ObjectNode strategy = addNode(doc, "strat1", "vp.strategy.peakshaving",
                Map.of("entity_id", battery));
        ObjectNode claim = strategy.putArray("claims").addObject();
        claim.put("entity_id", battery);
        claim.putArray("commands").add("setpoint_kw");
        claim.put("delegated", true);
        return doc;
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
        // E-8: an automation's dry-run is SCOPED to the flow - no scenario, no
        // year simulation (asserted job-by-job in
        // deviceAutomationDryRunNeverRunsTheYearSimulation).
        assertThat(simulated.getBody().path("scope").asText()).isEqualTo("automation");
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

    /**
     * Records every composed registry push (Steuerung Stufe 3). It EXTENDS the
     * real publisher so the ObjectProvider in EntityRegistryService resolves it
     * - only publishRegistry is intercepted, nothing else is faked away.
     */
    static class RecordingRegistryPublisher extends com.voltpilot.api.entities.EntityRegistryPublisher {

        final List<String> payloads = new CopyOnWriteArrayList<>();

        RecordingRegistryPublisher() {
            super("tcp://127.0.0.1:1", null, null);
        }

        @Override
        public boolean publishRegistry(java.util.UUID tenantId, java.util.UUID siteId,
                java.util.UUID deviceId, byte[] payload) {
            payloads.add(new String(payload, java.nio.charset.StandardCharsets.UTF_8));
            return true;
        }

        JsonNode lastEntity(String entityId) throws IOException {
            for (int i = payloads.size() - 1; i >= 0; i--) {
                JsonNode push = MAPPER.readTree(payloads.get(i));
                for (JsonNode e : push.path("entities")) {
                    if (entityId.equals(e.path("entity_id").asText())) {
                        return e;
                    }
                }
            }
            return null;
        }
    }

    /**
     * Steuerung Stufe 3 „Vorrang technisch" (Konzept vp-steuerung-konzept-b3
     * §3.7 A3/A4/A5b) - the CLOUD half of „Regel gewinnt", end to end against
     * a real DB + Keycloak. The edge half (the plan executor really releasing
     * the battery) is the in-process simulator proof
     * {@code agent.TestARuleClaimTakesTheBatteryFromThePlanAndGivesItBack}.
     *
     * <ol>
     *   <li>a DIRECT customer rule on the battery activates and materializes
     *       its claim; the composed registry push carries {@code owner_claimed}
     *       so the box stops injecting a plan setpoint for it;</li>
     *   <li>a running Betriebsmodell YIELDS instead of refusing with V-5 (A5b)
     *       - it is stilled and NAMED in the response;</li>
     *   <li>switching the rule off drops the claim and the push is byte-clean
     *       again - the plan takes the battery back;</li>
     *   <li>the DELEGATED claim of a Betriebsmodell never sets
     *       {@code owner_claimed} (it hands dispatch TO the plan - stamping it
     *       would invert the feature);</li>
     *   <li>a site with no rule at all is byte-identical to before Stufe 3.</li>
     * </ol>
     */
    @Test
    void aCustomerRuleClaimsTheBatteryAndTheBetriebsmodellYieldsInsteadOfRefusing() throws Exception {
        // ⚠ This class shares ONE site across its tests and JUnit's default
        // method order is unspecified: everything this test switches on (the
        // governance node, the Leistungspreis) and every flow it creates is
        // handed back in the finally block, or a sibling test fails for a
        // reason that has nothing to do with it (the documented FlowApiTest
        // footgun).
        String admin = token("admin", "admin");
        List<String> created = new java.util.ArrayList<>();
        try {
        JsonNode bootstrap = exchange("/api/v1/admin/sites/" + BERLIN_SITE
                + "/v2-entities/bootstrap", HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        String battery = null;
        String houseLoad = null;
        for (JsonNode entity : bootstrap.path("entities")) {
            if ("battery-hybrid".equals(entity.path("entityType").asText())) {
                battery = entity.path("id").asText();
            }
            if ("house-load".equals(entity.path("entityType").asText())) {
                houseLoad = entity.path("id").asText();
            }
        }
        assertThat(battery).isNotNull();

        // (5) BEFORE anything: no rule -> the push carries no owner_claimed at
        // all. This is the byte-identical baseline every existing plant has.
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities/bootstrap",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        JsonNode clean = registryPublisher.lastEntity(battery);
        assertThat(clean).isNotNull();
        assertThat(clean.has("owner_claimed"))
                .as("an unclaimed component must not carry the field at all")
                .isFalse();

        // (4) A Betriebsmodell first: its DELEGATED claim hands dispatch to the
        // plan, so it must NOT take the battery away from the plan.
        setLeistungspreis(admin, 140);
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance", HttpMethod.PUT,
                admin, TENANT_A,
                Map.of("enablements", List.of(Map.of("nodeType", PEAKSHAVING, "enabled", true))));
        String modeId = createSimulateActivate(admin, "Lastspitzenkappung Stufe3",
                peakShavingDocument(battery), true);
        created.add(modeId);
        assertThat(registryPublisher.lastEntity(battery).has("owner_claimed"))
                .as("a DELEGATED (Betriebsmodell) claim must never set owner_claimed")
                .isFalse();

        // (1)+(2) The customer rule on the SAME battery: it activates, the
        // Betriebsmodell yields (A5b) instead of a V-5 refusal, and the push
        // now carries owner_claimed.
        String ruleId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", "Speicher halten")).getBody()
                .path("flowId").asText();
        created.add(ruleId);
        String ruleBase = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + ruleId;
        exchange(ruleBase + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", "Speicher halten", "document", batterySetpointRule(battery)));
        JsonNode validation = exchange(ruleBase + "/versions/1/validate", HttpMethod.POST, admin,
                TENANT_A, Map.of()).getBody();
        assertThat(validation.path("valid").asBoolean())
                .as("a rule on a battery a Betriebsmodell holds must VALIDATE: "
                        + validation.path("findings"))
                .isTrue();
        assertThat(validation.path("findings").toString())
                .as("the yield stays visible as the Folgen-Karte's sentence")
                .contains("Ihre Regel geht vor");

        exchange(ruleBase + "/versions/1/simulate", HttpMethod.POST, admin, TENANT_A, Map.of());
        pollSimulation(admin, ruleBase);
        ResponseEntity<JsonNode> activated = exchange(ruleBase + "/versions/1/activate",
                HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(activated.getBody().path("activated").asBoolean())
                .as("the rule activates: " + activated.getBody()).isTrue();
        assertThat(activated.getBody().path("yieldedFlows").toString())
                .contains("Lastspitzenkappung Stufe3");
        assertThat(exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + modeId
                + "/versions/1", HttpMethod.GET, admin, TENANT_A, null).getBody()
                .path("lifecycle").asText())
                .as("the Betriebsmodell is really stilled, not just announced")
                .isEqualTo("retired");

        JsonNode claimed = registryPublisher.lastEntity(battery);
        assertThat(claimed.path("owner_claimed").asBoolean())
                .as("the box learns the claim: " + claimed).isTrue();
        if (houseLoad != null) {
            assertThat(registryPublisher.lastEntity(houseLoad).has("owner_claimed"))
                    .as("every UNCLAIMED component stays untouched").isFalse();
        }

        // (3) Switch the rule off -> the claim is dropped and the push is clean.
        exchange(ruleBase + "/deactivate", HttpMethod.POST, admin, TENANT_A, Map.of());
        assertThat(registryPublisher.lastEntity(battery).has("owner_claimed"))
                .as("the plan gets the battery back when the rule is switched off")
                .isFalse();
        } finally {
            for (String flowId : created) {
                String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId;
                exchange(base + "/deactivate", HttpMethod.POST, admin, TENANT_A, Map.of());
                exchange(base, HttpMethod.DELETE, admin, TENANT_A, null);
            }
            exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                    HttpMethod.PUT, admin, TENANT_A, Map.of("enablements",
                            List.of(Map.of("nodeType", PEAKSHAVING, "enabled", false))));
            setLeistungspreis(admin, null);
        }
    }

    /** Create → save → simulate → activate one flow; returns its id. */
    private String createSimulateActivate(String admin, String name, ObjectNode document,
            boolean expectActivated) {
        String flowId = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows",
                HttpMethod.POST, admin, TENANT_A, Map.of("name", name)).getBody()
                .path("flowId").asText();
        String base = "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId;
        exchange(base + "/versions/1", HttpMethod.PUT, admin, TENANT_A,
                Map.of("name", name, "document", document));
        exchange(base + "/versions/1/simulate", HttpMethod.POST, admin, TENANT_A, Map.of());
        pollSimulation(admin, base);
        ResponseEntity<JsonNode> res = exchange(base + "/versions/1/activate", HttpMethod.POST,
                admin, TENANT_A, Map.of());
        assertThat(res.getBody().path("activated").asBoolean())
                .as(name + " activation: " + res.getBody()).isEqualTo(expectActivated);
        return flowId;
    }

    /** Drive the (fake, instantly-done) dry-run to completion. */
    private void pollSimulation(String admin, String base) {
        JsonNode version = exchange(base + "/versions/1", HttpMethod.GET, admin, TENANT_A, null)
                .getBody();
        if ("simulated".equals(version.path("lifecycle").asText())) {
            return;
        }
        for (Map.Entry<String, String> entry : simulationHttp.statusBodies.entrySet()) {
            exchange(base + "/versions/1/simulation/" + entry.getKey(), HttpMethod.GET, admin,
                    TENANT_A, null);
        }
    }

    /**
     * A DIRECT customer rule on the battery: a time window sets a setpoint.
     * The control node claims the battery ITSELF (delegated=false) - that is
     * what takes the component away from the plan.
     */
    private static ObjectNode batterySetpointRule(String battery) {
        ObjectNode doc = automationShell("Speicher halten");
        addNode(doc, "fenster1", "vp.schedule.window",
                Map.of("from", "08:00", "to", "18:00", "days", "alle"));
        ObjectNode ifNode = addNode(doc, "wert1", "vp.logic.if", Map.of());
        ((ObjectNode) ifNode.path("parameters")).put("then_value", 0).put("else_value", 0);
        ObjectNode ctl = addNode(doc, "steuern1", "vp.entity.control",
                Map.of("entity_id", battery, "command", "setpoint_kw"));
        ((ObjectNode) ctl.path("parameters")).put("ttl_s", 300);
        ObjectNode claim = ctl.putArray("claims").addObject();
        claim.put("entity_id", battery);
        claim.putArray("commands").add("setpoint_kw");
        edge(doc, "e1", "fenster1", "active", "wert1", "condition");
        edge(doc, "e2", "wert1", "value", "steuern1", "setpoint");
        return doc;
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
