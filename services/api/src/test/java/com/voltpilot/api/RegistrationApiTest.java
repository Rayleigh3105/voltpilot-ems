package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.List;
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
 * End-to-end proof of self-service registration against a REAL Keycloak and a
 * REAL TimescaleDB - the front door of the customer onboarding journey:
 *
 * <ol>
 *   <li><b>A visitor registers and is immediately a working customer.</b> One
 *       unauthenticated POST creates the tenant + Keycloak login; the customer
 *       then logs in, creates their first site, and claims their edge device -
 *       the complete self-serve onboarding chain, no operator involved.</li>
 *   <li><b>A duplicate email is refused without leaving an orphan tenant.</b>
 *       The compensating delete keeps tenant creation atomic with its login.</li>
 *   <li><b>Garbage input is refused up front</b> (bean validation, 400).</li>
 *   <li><b>Anonymous flooding is rate-limited per client address</b> (429
 *       before any tenant/Keycloak work; other addresses unaffected).</li>
 * </ol>
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class RegistrationApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";

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
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");

        registry.add("voltpilot.keycloak.admin.base-url", KEYCLOAK::getAuthServerUrl);
        registry.add("voltpilot.keycloak.admin.realm", () -> "voltpilot");
        registry.add("voltpilot.keycloak.admin.client-id", () -> "voltpilot-api");
        registry.add("voltpilot.keycloak.admin.client-secret", () -> "voltpilot-api-dev-secret");

        // Low per-client cap so the rate-limit test stays fast. Its requests use
        // synthetic X-Forwarded-For addresses; the OTHER tests here register from
        // plain 127.0.0.1, which currently spends 3 of these 5 - keep headroom in
        // mind when adding registrations to this class.
        registry.add("voltpilot.registration.rate-limit.per-client-max", () -> "5");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    // ---- (1) register -> log in -> create site -> claim device ---------------

    @Test
    void selfRegisteredCustomerCompletesOnboardingWithoutAnOperator() {
        // An anonymous visitor registers - no Authorization header anywhere.
        ResponseEntity<Map<String, Object>> registered = rest.exchange(
                url("/api/v1/registration"), HttpMethod.POST,
                json(Map.of("name", "Sonnenhof Kaiser GmbH",
                        "email", "Erika@Sonnenhof-Kaiser.example",
                        "password", "sonne-123")),
                new ParameterizedTypeReference<>() {});
        assertThat(registered.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(registered.getBody()).containsEntry("tenantName", "Sonnenhof Kaiser GmbH");
        // The email became the (lowercased) login name.
        assertThat(registered.getBody()).containsEntry("username", "erika@sonnenhof-kaiser.example");

        // The fresh customer is signed in with exactly what they typed - via the
        // PUBLIC frontend client's direct grant, the same call the portal makes
        // for its seamless post-registration auto-login (no Keycloak login page).
        String token = publicClientToken("erika@sonnenhof-kaiser.example", "sonne-123");

        // Their world starts empty (tenant-scoped, not an error)...
        ResponseEntity<List<Map<String, Object>>> sites = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(sites.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(sites.getBody()).isEmpty();

        // ...they create their first site...
        ResponseEntity<Map<String, Object>> site = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Sonnenhof Kaiser", "biddingZone", "DE-LU"),
                        bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(site.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String siteId = (String) site.getBody().get("id");

        // The device they received was registered at manufacture: the operator
        // provisioned its sticker ID, which is what makes the claim below legal
        // (sticker claims validate against the registry - typos get 422).
        ResponseEntity<Map<String, Object>> provisioned = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", "vp-edge-4711"),
                        bearer(token("admin", "admin"))),
                new ParameterizedTypeReference<>() {});
        assertThat(provisioned.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(provisioned.getBody()).containsEntry("externalRef", "VP-EDGE-4711");

        // ...and claim the edge device they received - onboarding complete.
        ResponseEntity<Map<String, Object>> device = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "VP-EDGE-4711"),
                        bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(device.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(device.getBody()).containsEntry("status", "claimed");
    }

    // ---- (2) duplicate email -> 409, and no orphan tenant --------------------

    @Test
    void duplicateEmailIsRefusedWithoutOrphanTenant() {
        Map<String, Object> first = Map.of("name", "Doppelt GmbH",
                "email", "doppelt@example.com", "password", "doppelt-pw");
        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST, json(first),
                String.class).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        Map<String, Object> second = Map.of("name", "Doppelt Zwei GmbH",
                "email", "doppelt@example.com", "password", "doppelt-pw-2");
        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST, json(second),
                String.class).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // The refused registration's tenant was rolled back (admin cross-tenant view).
        String admin = token("admin", "admin");
        ResponseEntity<List<Map<String, Object>>> tenants = rest.exchange(
                url("/api/v1/admin/tenants"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(tenants.getBody()).extracting(t -> t.get("name"))
                .contains("Doppelt GmbH")
                .doesNotContain("Doppelt Zwei GmbH");
    }

    // ---- (3) invalid input -> 400 --------------------------------------------

    @Test
    void invalidInputIsRefused() {
        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                json(Map.of("name", "X", "email", "not-an-email", "password", "long-enough-pw")),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                json(Map.of("name", "X", "email", "ok@example.com", "password", "short")),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                json(Map.of("name", " ", "email", "ok@example.com", "password", "long-enough-pw")),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ---- (4) anonymous flooding -> 429, nothing created -----------------------

    @Test
    void floodingIsRateLimitedPerClientWithoutSideEffects() {
        // One address may register a handful of accounts within the window...
        for (int i = 1; i <= 5; i++) {
            assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                    json(Map.of("name", "Flut " + i + " GmbH",
                            "email", "flut-" + i + "@example.com", "password", "flut-pw-123"),
                            "198.51.100.23"),
                    String.class).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        }

        // ...then it is refused BEFORE any tenant or Keycloak work happens...
        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                json(Map.of("name", "Flut Sechs GmbH",
                        "email", "flut-6@example.com", "password", "flut-pw-123"),
                        "198.51.100.23"),
                String.class).getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);

        // ...while a different customer address registers unaffected.
        assertThat(rest.exchange(url("/api/v1/registration"), HttpMethod.POST,
                json(Map.of("name", "Nachbar GmbH",
                        "email", "nachbar@example.com", "password", "nachbar-pw-1"),
                        "198.51.100.99"),
                String.class).getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // The refused attempt left no orphan tenant behind.
        ResponseEntity<List<Map<String, Object>>> tenants = rest.exchange(
                url("/api/v1/admin/tenants"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("admin", "admin"))),
                new ParameterizedTypeReference<>() {});
        assertThat(tenants.getBody()).extracting(t -> t.get("name"))
                .contains("Flut 5 GmbH", "Nachbar GmbH")
                .doesNotContain("Flut Sechs GmbH");
    }

    // ---- helpers --------------------------------------------------------------

    private static HttpEntity<Map<String, Object>> json(Map<String, Object> body) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        return new HttpEntity<>(body, h);
    }

    /** JSON body arriving via the trusted proxy for the given client address. */
    private static HttpEntity<Map<String, Object>> json(Map<String, Object> body, String clientIp) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.add("X-Forwarded-For", clientIp);
        return new HttpEntity<>(body, h);
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

    /** Direct-access-grant token for a realm user via the confidential api client. */
    private String token(String username, String password) {
        return grantToken(username, password, "voltpilot-api", "voltpilot-api-dev-secret");
    }

    /**
     * Direct-access-grant token via the PUBLIC {@code voltpilot-frontend} client
     * (no secret) - the portal's seamless post-registration auto-login path.
     */
    private String publicClientToken(String username, String password) {
        return grantToken(username, password, "voltpilot-frontend", null);
    }

    private String grantToken(String username, String password, String clientId, String secret) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", clientId);
        if (secret != null) {
            form.add("client_secret", secret);
        }
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response for " + username + " via " + clientId)
                .containsKey("access_token");
        return (String) body.get("access_token");
    }
}
