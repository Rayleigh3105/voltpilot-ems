package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.simulation.SimulationHttp;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
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
 * The admin what-if re-optimize proxy (design vp-admin-optimizer-ui-design
 * §4.3) end to end against real Keycloak + TimescaleDB with a FAKE in-process
 * solve service (the SimulationApiTest/MastrApiTest seam - the JVM has no
 * Python; the Python side's own suite proves the math).
 *
 * <p>The load-bearing assertions are the GATES, in this order: only a
 * platform-admin may call it; a site the switched tenant cannot see is 404 and
 * <em>the solve service is never contacted</em> (it resolves sites with the
 * trusted backend credentials, so the RLS check on this side is the whole
 * tenancy fence); a battery-less site is refused here rather than sent off to
 * fail; and an upstream refusal keeps its German reason instead of becoming a
 * fake result.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AdminWhatIfApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String TENANT_B = "10000000-0000-0000-0000-000000000001";
    /** Demo Site Berlin - the dev seed's battery site. */
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    /** Nordwind Hamburg - tenant B, invisible to tenant A. */
    private static final String FOREIGN_SITE = "10000000-0000-0000-0000-000000000002";

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

    /** In-memory stand-in for the Python service's {@code POST /what-if}. */
    static class FakeSolveService implements SimulationHttp {

        final List<Map<String, Object>> submitted = new CopyOnWriteArrayList<>();
        volatile Response nextResponse;
        volatile IOException nextFailure;
        private final ObjectMapper json = new ObjectMapper();

        @Override
        @SuppressWarnings("unchecked")
        public Response post(URI uri, String jsonBody) throws IOException {
            submitted.add(json.readValue(jsonBody, Map.class));
            if (nextFailure != null) {
                IOException boom = nextFailure;
                nextFailure = null;
                throw boom;
            }
            if (nextResponse != null) {
                Response canned = nextResponse;
                nextResponse = null;
                return canned;
            }
            return new Response(200, """
                    {"siteId":"s","computedAt":"2026-08-03T10:00:00Z","horizonSlots":96,
                     "slotMinutes":15,"appliedOverrides":{},
                     "baseline":{"savingsEur":1.5,"cycles":1.0,"slots":[]},
                     "variant":{"savingsEur":2.5,"cycles":0.5,"slots":[]},
                     "delta":{"savingsEur":1.0,"cycles":-0.5}}""");
        }

        @Override
        public Response get(URI uri) {
            return new Response(404, "{\"message\":\"nicht gefunden\"}");
        }
    }

    @TestConfiguration
    static class FakeSolve {
        @Bean
        FakeSolveService simulationHttp() {
            return new FakeSolveService();
        }
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    FakeSolveService fake;

    // ---- the happy path ------------------------------------------------------

    @Test
    void adminReoptimizesOneSiteAndOnlyTheTouchedKnobsAreForwarded() {
        String admin = token("admin", "admin");
        fake.submitted.clear();

        ResponseEntity<Map<String, Object>> res = post(BERLIN_SITE, admin, TENANT_A,
                Map.of("wearCostCtPerKwh", 8.0, "netzladenErlaubt", true));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        // The service's document is relayed unchanged - the api adds no math.
        assertThat(cast(res.getBody().get("delta")).get("savingsEur")).isEqualTo(1.0);
        assertThat(cast(res.getBody().get("baseline")).get("savingsEur")).isEqualTo(1.5);

        Map<String, Object> payload = fake.submitted.get(fake.submitted.size() - 1);
        assertThat(payload.get("siteId")).isEqualTo(BERLIN_SITE);
        Map<String, Object> overrides = cast(payload.get("overrides"));
        // ONLY what the admin actually moved: an untouched knob must not be
        // forwarded at all, or the "solve it as configured" baseline would
        // silently be pinned to whatever the form happened to show.
        assertThat(overrides).containsOnlyKeys("wearCostCtPerKwh", "netzladenErlaubt");
        assertThat(((Number) overrides.get("wearCostCtPerKwh")).doubleValue()).isEqualTo(8.0);
        assertThat(overrides.get("netzladenErlaubt")).isEqualTo(true);
        assertThat(payload).doesNotContainKey("horizonSlots");
    }

    @Test
    void anEmptyBodyMeansSolveItExactlyAsConfigured() {
        String admin = token("admin", "admin");
        fake.submitted.clear();

        ResponseEntity<Map<String, Object>> res = post(BERLIN_SITE, admin, TENANT_A, Map.of());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(cast(fake.submitted.get(0).get("overrides"))).isEmpty();
    }

    // ---- the gates -----------------------------------------------------------

    @Test
    void aForeignSiteIs404AndTheSolveServiceIsNeverContacted() {
        String admin = token("admin", "admin");
        fake.submitted.clear();

        // Tenant A selected, tenant B's site addressed: RLS hides it.
        ResponseEntity<Map<String, Object>> foreign = post(FOREIGN_SITE, admin, TENANT_A,
                Map.of("wearCostCtPerKwh", 8.0));
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // No tenant selected at all: default-deny, same answer.
        ResponseEntity<Map<String, Object>> noTenant = post(BERLIN_SITE, admin, null, Map.of());
        assertThat(noTenant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // The whole tenancy fence lives on THIS side, so nothing may have been
        // forwarded: the solve service would have found both sites happily.
        assertThat(fake.submitted).isEmpty();

        // ... and the site IS reachable through its own tenant, so the 404s
        // above are the fence and not a broken route.
        assertThat(post(FOREIGN_SITE, admin, TENANT_B, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    @Test
    void customersAreRefusedEvenWithATenantHeader() {
        fake.submitted.clear();
        assertThat(post(BERLIN_SITE, token("demo", "demo"), TENANT_A, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        ResponseEntity<Map<String, Object>> anon = rest.exchange(
                url("/api/v1/admin/sites/" + BERLIN_SITE + "/optimizer-what-if"),
                HttpMethod.POST, new HttpEntity<>(Map.of()), mapType());
        assertThat(anon.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(fake.submitted).isEmpty();
    }

    @Test
    void impossibleKnobsAndBatterylessSitesAreRefusedBeforeAnySolve() {
        String admin = token("admin", "admin");

        // A site with no battery: there is nothing to re-plan.
        String bare = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + TENANT_A + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Ohne Speicher (What-if)",
                        "biddingZone", "DE-LU"), bearer(admin)),
                mapType()).getBody().get("id");
        fake.submitted.clear();
        ResponseEntity<Map<String, Object>> noBattery = post(bare, admin, TENANT_A, Map.of());
        assertThat(noBattery.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) noBattery.getBody().get("message")).contains("Batteriespeicher");

        // An inverted SoC band with BOTH sides posted is wrong whatever the
        // site holds, so it is caught here without a solve.
        ResponseEntity<Map<String, Object>> band = post(BERLIN_SITE, admin, TENANT_A,
                Map.of("socMinPct", 80, "socMaxPct", 20));
        assertThat(band.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) band.getBody().get("message")).contains("SoC-Band");

        // Out-of-range knobs never leave the api either (bean validation).
        assertThat(post(BERLIN_SITE, admin, TENANT_A, Map.of("wearCostCtPerKwh", -1))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post(BERLIN_SITE, admin, TENANT_A, Map.of("backupReserveSocPct", 140))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(fake.submitted).isEmpty();
    }

    @Test
    void aOneSidedBandKnobIsJudgedByTheSiteNotByThePlatformDefault() {
        String admin = token("admin", "admin");
        fake.submitted.clear();
        // Only the ceiling is posted, and it sits BELOW the platform default
        // floor (5 %). Refusing here would reject a preview that is perfectly
        // valid on a site whose own floor is lower - the solve service knows
        // the real other side, so the request must reach it.
        ResponseEntity<Map<String, Object>> res =
                post(BERLIN_SITE, admin, TENANT_A, Map.of("socMaxPct", 3));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(cast(fake.submitted.get(0).get("overrides"))).containsOnlyKeys("socMaxPct");
    }

    // ---- honesty on failure --------------------------------------------------

    @Test
    void upstreamRefusalsKeepTheirReasonAndAnOutageNeverLooksLikeAResult() {
        String admin = token("admin", "admin");

        fake.nextResponse = new SimulationHttp.Response(400,
                "{\"message\":\"Für diese Anlage lässt sich gerade kein Plan rechnen: "
                        + "keine Preisabdeckung.\"}");
        ResponseEntity<Map<String, Object>> unplannable =
                post(BERLIN_SITE, admin, TENANT_A, Map.of());
        assertThat(unplannable.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) unplannable.getBody().get("message")).contains("Preisabdeckung");

        fake.nextResponse = new SimulationHttp.Response(429,
                "{\"message\":\"Gerade laufen zu viele Neuberechnungen.\"}");
        ResponseEntity<Map<String, Object>> busy = post(BERLIN_SITE, admin, TENANT_A, Map.of());
        assertThat(busy.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat((String) busy.getBody().get("message")).contains("Neuberechnungen");

        fake.nextFailure = new IOException("connection refused");
        ResponseEntity<Map<String, Object>> down = post(BERLIN_SITE, admin, TENANT_A, Map.of());
        assertThat(down.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        // A dead service must never read as "your change made the plan worse".
        assertThat(down.getBody()).doesNotContainKeys("variant", "delta", "baseline");
        assertThat((String) down.getBody().get("message")).contains("gespeicherte Fahrplan gilt");

        fake.nextResponse = new SimulationHttp.Response(500, "kaputt");
        assertThat(post(BERLIN_SITE, admin, TENANT_A, Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.BAD_GATEWAY);
    }

    // ---- helpers -------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static Map<String, Object> cast(Object value) {
        return (Map<String, Object>) value;
    }

    private static ParameterizedTypeReference<Map<String, Object>> mapType() {
        return new ParameterizedTypeReference<>() {
        };
    }

    private ResponseEntity<Map<String, Object>> post(String siteId, String token,
            String tenantId, Map<String, Object> body) {
        HttpHeaders headers = bearer(token);
        if (tenantId != null) {
            headers.set("X-Tenant-Id", tenantId);
        }
        return rest.exchange(url("/api/v1/admin/sites/" + siteId + "/optimizer-what-if"),
                HttpMethod.POST, new HttpEntity<>(body, headers), mapType());
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
