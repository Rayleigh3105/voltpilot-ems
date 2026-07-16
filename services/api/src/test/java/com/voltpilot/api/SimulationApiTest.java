package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
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
 * Ersparnis-Simulation orchestration end to end against real Keycloak +
 * TimescaleDB with a FAKE in-process simulation service (the MastrApiTest
 * seam): the customer route resolves the site's master data into the job
 * payload and stays tenant-scoped (foreign site 404, foreign job 404), the
 * admin route is platform-admin-gated and forwards explicit prospect inputs,
 * and the service's German refusals (400/429) are relayed verbatim.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class SimulationApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DACHAU_SITE = "00000000-0000-0000-0000-000000000012";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
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
     * In-memory stand-in for the Python simulation service: records every
     * submitted payload, hands out ids, and serves scripted status documents.
     */
    static class FakeSimulationService implements SimulationHttp {

        final List<Map<String, Object>> submitted = new CopyOnWriteArrayList<>();
        final ConcurrentHashMap<String, String> statusBodies = new ConcurrentHashMap<>();
        final AtomicInteger counter = new AtomicInteger();
        volatile Response nextSubmitResponse;
        private final ObjectMapper json = new ObjectMapper();

        @Override
        @SuppressWarnings("unchecked")
        public Response post(URI uri, String jsonBody) throws IOException {
            if (nextSubmitResponse != null) {
                Response canned = nextSubmitResponse;
                nextSubmitResponse = null;
                return canned;
            }
            submitted.add(json.readValue(jsonBody, Map.class));
            String id = String.format("%032d", counter.incrementAndGet());
            statusBodies.put(id,
                    "{\"status\":\"done\",\"progress\":1.0,\"result\":{\"headline\":"
                            + "{\"gesamtVorteilEur\":364.0}}}");
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

    // ---- customer route ------------------------------------------------------

    @Test
    void customerSimulationResolvesMasterDataAndRoundTrips() {
        String token = token("demo", "demo");

        ResponseEntity<Map<String, Object>> started = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, token,
                Map.of("consumption", Map.of("annualKwh", 5200)));
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        String simulationId = (String) started.getBody().get("simulationId");
        assertThat(simulationId).isNotBlank();

        // The payload the service received carries the SITE's master data ...
        Map<String, Object> payload = fake.submitted.get(fake.submitted.size() - 1);
        assertThat(payload.get("zone")).isEqualTo("DE-LU");
        Map<String, Object> plant = cast(payload.get("plant"));
        assertThat(((Number) plant.get("latitude")).doubleValue()).isCloseTo(52.52, within(0.01));
        Map<String, Object> battery = cast(payload.get("battery"));
        assertThat(((Number) battery.get("capacityKwh")).doubleValue()).isGreaterThan(0.0);
        // ... and the body override won over the default.
        Map<String, Object> consumption = cast(payload.get("consumption"));
        assertThat(((Number) consumption.get("annualKwh")).doubleValue()).isEqualTo(5200.0);

        // Poll relays the service's document.
        ResponseEntity<Map<String, Object>> status = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation/" + simulationId,
                HttpMethod.GET, token, null);
        assertThat(status.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(status.getBody().get("status")).isEqualTo("done");
        assertThat(cast(cast(status.getBody().get("result")).get("headline"))
                .get("gesamtVorteilEur")).isEqualTo(364.0);
    }

    @Test
    void speicherschonungPresetMapsToWearCt() {
        String token = token("demo", "demo");
        ResponseEntity<Map<String, Object>> started = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, token,
                Map.of("battery", Map.of("speicherschonung", "schonend")));
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        Map<String, Object> battery = cast(
                fake.submitted.get(fake.submitted.size() - 1).get("battery"));
        assertThat(((Number) battery.get("wearCostCtPerKwh")).doubleValue()).isEqualTo(8.0);

        ResponseEntity<Map<String, Object>> bad = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, token,
                Map.of("battery", Map.of("speicherschonung", "turbo")));
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) bad.getBody().get("message")).contains("Speicherschonung");
    }

    @Test
    void foreignTenantCannotStartOrPoll() {
        String demo2 = token("demo2", "demo2");
        ResponseEntity<Map<String, Object>> started = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, demo2, Map.of());
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A legitimate job of tenant A ...
        String demo = token("demo", "demo");
        String simulationId = (String) exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, demo,
                Map.of()).getBody().get("simulationId");
        // ... is invisible through tenant B's token (RLS hides the site).
        ResponseEntity<Map<String, Object>> poll = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation/" + simulationId,
                HttpMethod.GET, demo2, null);
        assertThat(poll.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        // ... and through ANOTHER site of the same tenant (job-scope check).
        ResponseEntity<Map<String, Object>> otherSite = exchange(
                "/api/v1/sites/" + DACHAU_SITE + "/simulation/" + simulationId,
                HttpMethod.GET, demo, null);
        assertThat(otherSite.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void upstreamRefusalsAreRelayedVerbatim() {
        String token = token("demo", "demo");
        fake.nextSubmitResponse = new SimulationHttp.Response(429,
                "{\"message\":\"Es laufen gerade zu viele Simulationen.\"}");
        ResponseEntity<Map<String, Object>> busy = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, token, Map.of());
        assertThat(busy.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat((String) busy.getBody().get("message")).contains("zu viele Simulationen");

        fake.nextSubmitResponse = new SimulationHttp.Response(400,
                "{\"message\":\"Für das Jahr 2025 liegen nur 3% der Börsenpreise vor.\"}");
        ResponseEntity<Map<String, Object>> invalid = exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, token, Map.of());
        assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) invalid.getBody().get("message")).contains("Börsenpreise");
    }

    // ---- admin route ---------------------------------------------------------

    @Test
    void adminProspectSimulationForwardsExplicitInputs() {
        String admin = token("admin", "admin");
        Map<String, Object> body = Map.of(
                "year", 2025,
                "zone", "DE-LU",
                "plant", Map.of("pvKwp", 10.0, "latitude", 48.1, "longitude", 11.5),
                "consumption", Map.of("annualKwh", 4500),
                "battery", Map.of("capacityKwh", 10.0, "speicherschonung", "ausgewogen"));
        ResponseEntity<Map<String, Object>> started = exchange(
                "/api/v1/admin/simulation", HttpMethod.POST, admin, body);
        assertThat(started.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        String simulationId = (String) started.getBody().get("simulationId");

        Map<String, Object> payload = fake.submitted.get(fake.submitted.size() - 1);
        assertThat(payload.get("year")).isEqualTo(2025);
        assertThat(cast(payload.get("battery")).get("wearCostCtPerKwh")).isEqualTo(4);

        ResponseEntity<Map<String, Object>> status = exchange(
                "/api/v1/admin/simulation/" + simulationId, HttpMethod.GET, admin, null);
        assertThat(status.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(status.getBody().get("status")).isEqualTo("done");

        // A customer job is NOT pollable through the admin route and vice versa.
        String demo = token("demo", "demo");
        String customerJob = (String) exchange(
                "/api/v1/sites/" + BERLIN_SITE + "/simulation", HttpMethod.POST, demo,
                Map.of()).getBody().get("simulationId");
        assertThat(exchange("/api/v1/admin/simulation/" + customerJob, HttpMethod.GET,
                admin, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(exchange("/api/v1/sites/" + BERLIN_SITE + "/simulation/" + simulationId,
                HttpMethod.GET, demo, null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void adminRouteRefusesCustomers() {
        String demo = token("demo", "demo");
        ResponseEntity<Map<String, Object>> res = exchange(
                "/api/v1/admin/simulation", HttpMethod.POST, demo, Map.of());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    // ---- helpers -------------------------------------------------------------

    private static org.assertj.core.data.Offset<Double> within(double d) {
        return org.assertj.core.data.Offset.offset(d);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) {
        return (Map<String, Object>) value;
    }

    private ResponseEntity<Map<String, Object>> exchange(String path, HttpMethod method,
            String token, Map<String, Object> body) {
        HttpHeaders headers = bearer(token);
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers)
                : new HttpEntity<>(headers);
        return rest.exchange(url(path), method, entity,
                new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {
                });
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
