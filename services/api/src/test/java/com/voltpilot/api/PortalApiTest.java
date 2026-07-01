package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
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
 * End-to-end test of the auth + tenancy spine against a REAL Keycloak and a REAL
 * TimescaleDB: mints tenant-scoped tokens from the imported dev realm and drives
 * the portal endpoints, proving (1) token validation - unauthenticated/invalid
 * are rejected, valid accepted - and (2) RLS isolation through the full stack -
 * each tenant sees only its own sites/devices/telemetry, and cross-tenant device
 * claiming is refused.
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class PortalApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String HAMBURG_SITE = "10000000-0000-0000-0000-000000000002";

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
        // App connects as the non-privileged role; Flyway migrates as superuser.
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);

        // OIDC on; issuer == the container's realm, JWKS discovered from it.
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

    // ---- token validation ---------------------------------------------------

    @Test
    void rejectsUnauthenticatedRequest() {
        ResponseEntity<String> res = rest.getForEntity(url("/api/v1/sites"), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void rejectsGarbageToken() {
        ResponseEntity<String> res = rest.exchange(url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer("not-a-real-jwt")), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void healthStaysOpen() {
        assertThat(rest.getForEntity(url("/health"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    // ---- tenant isolation through the API -----------------------------------

    @Test
    void eachTenantSeesOnlyItsOwnSites() {
        List<Map<String, Object>> tenantA = sites(token("demo", "demo"));
        assertThat(tenantA).extracting(s -> s.get("name")).containsExactly("Demo Site Berlin");

        List<Map<String, Object>> tenantB = sites(token("demo2", "demo2"));
        assertThat(tenantB).extracting(s -> s.get("name")).containsExactly("Nordwind Hamburg");
    }

    @Test
    void telemetryIsTenantScoped() {
        // Tenant A can read its own site's telemetry...
        ResponseEntity<String> own = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(own.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(own.getBody()).contains("pvPowerKw");

        // ...but tenant B cannot even see tenant A's site (RLS => 404).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- device claiming ----------------------------------------------------

    @Test
    void claimsFreshDeviceButRefusesCrossTenantClaim() {
        // Tenant A claims a brand-new device into its own site -> 201.
        ResponseEntity<Map<String, Object>> ok = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "edge-fresh-01"),
                        bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(ok.getBody()).containsEntry("status", "claimed");

        // Tenant B tries to claim tenant A's already-claimed device -> 409.
        ResponseEntity<String> conflict = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", HAMBURG_SITE, "externalRef", "demo-inverter-01"),
                        bearer(token("demo2", "demo2"))),
                String.class);
        assertThat(conflict.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    // ---- data feeds: day-ahead prices + weather -----------------------------

    @Test
    void pricesEndpointReturnsZoneSeries() {
        // Prices are public market data (no RLS); seed a couple of DE-LU slots.
        exec("INSERT INTO day_ahead_prices (ts, bidding_zone, resolution, price_eur_mwh, currency, source) "
                + "VALUES (now(), 'DE-LU', 'PT15M', 42.5, 'EUR', 'energy-charts'), "
                + "(now() + interval '15 minutes', 'DE-LU', 'PT15M', 55.0, 'EUR', 'energy-charts') "
                + "ON CONFLICT DO NOTHING");

        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/prices"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsEntry("biddingZone", "DE-LU");
        assertThat(res.getBody()).containsEntry("resolution", "PT15M");
        List<?> points = (List<?>) res.getBody().get("points");
        assertThat(points).isNotEmpty();

        // A foreign site is invisible via RLS -> 404 (never another tenant's zone).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/prices"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void weatherIsTenantScoped() {
        // Seed one weather row for tenant A's Berlin site (writer bypasses RLS).
        exec("INSERT INTO weather_forecast "
                + "(time, tenant_id, site_id, run_at, temperature_c, cloud_cover_pct, ghi_w_m2, source) "
                + "VALUES (now(), '00000000-0000-0000-0000-000000000001', '" + BERLIN_SITE + "', "
                + "now(), 21.5, 30.0, 500.0, 'open-meteo') ON CONFLICT DO NOTHING");

        // Tenant A reads its own site's weather.
        ResponseEntity<String> own = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/weather"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(own.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(own.getBody()).contains("temperatureC");

        // Tenant B cannot even see tenant A's site (RLS => 404), so no weather leaks.
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/weather"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- helpers ------------------------------------------------------------

    /** Run a statement as the Postgres superuser (bypasses RLS) to seed feed rows. */
    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private List<Map<String, Object>> sites(String token) {
        return rest.exchange(url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody();
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
    }

    /** Direct-access-grant token for a seeded user via the confidential api client. */
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
