package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * End-to-end proof of the platform-admin API against a REAL Keycloak and a REAL
 * TimescaleDB. It exercises the full separation between Portal-Admins (platform
 * operators) and Portal-Users (customers):
 *
 * <ol>
 *   <li><b>A Portal-Admin can create a tenant and a customer user.</b> The admin
 *       token ({@code platform-admin} realm role) creates a tenant via the
 *       BYPASSRLS admin datasource and provisions a customer in Keycloak with the
 *       {@code tenant_id} attribute + {@code operator} role via the Admin REST
 *       API.</li>
 *   <li><b>That new customer logs in and sees only their tenant.</b> The
 *       provisioned user gets a token from Keycloak; through the same OIDC + RLS
 *       spine they see their own site and are denied another tenant's data.</li>
 *   <li><b>A Portal-User gets 403 on admin endpoints.</b> The seeded {@code demo}
 *       operator is refused by every admin route - the boundary is enforced in
 *       the backend by {@code @PreAuthorize}, not the UI.</li>
 * </ol>
 *
 * <p>Auto-skips where Docker is unavailable ({@code disabledWithoutDocker}).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class AdminApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

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
        // Customer datasource: non-privileged app role (RLS applies).
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", () -> APP_USER);
        registry.add("spring.datasource.password", () -> APP_PW);
        // Admin datasource: dedicated BYPASSRLS role (created by Flyway V4).
        registry.add("voltpilot.admin-datasource.url", POSTGRES::getJdbcUrl);
        registry.add("voltpilot.admin-datasource.username", () -> ADMIN_USER);
        registry.add("voltpilot.admin-datasource.password", () -> ADMIN_PW);
        // Flyway migrates as superuser and stamps both role passwords.
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> APP_USER);
        registry.add("spring.flyway.placeholders.appDbPassword", () -> APP_PW);
        registry.add("spring.flyway.placeholders.adminDbUser", () -> ADMIN_USER);
        registry.add("spring.flyway.placeholders.adminDbPassword", () -> ADMIN_PW);

        // OIDC on; issuer == the container's realm, JWKS discovered from it.
        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");

        // Keycloak Admin REST API: the API calls the container as the voltpilot-api
        // service account (client_credentials + realm-management roles).
        registry.add("voltpilot.keycloak.admin.base-url", KEYCLOAK::getAuthServerUrl);
        registry.add("voltpilot.keycloak.admin.realm", () -> "voltpilot");
        registry.add("voltpilot.keycloak.admin.client-id", () -> "voltpilot-api");
        registry.add("voltpilot.keycloak.admin.client-secret", () -> "voltpilot-api-dev-secret");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    // ---- (a) admin creates a tenant + a customer user -----------------------

    @Test
    void platformAdminCreatesTenantAndCustomerUser() {
        String admin = token("admin", "admin");

        // Create a tenant.
        Map<String, Object> tenant = createTenant(admin, "Acme Industrie GmbH", "CI");
        String tenantId = (String) tenant.get("id");
        assertThat(tenantId).isNotBlank();
        assertThat(tenant).containsEntry("name", "Acme Industrie GmbH");

        // It shows up in the cross-tenant listing.
        ResponseEntity<List<Map<String, Object>>> list = rest.exchange(
                url("/api/v1/admin/tenants"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(list.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(list.getBody()).extracting(t -> t.get("name")).contains("Acme Industrie GmbH");

        // Provision a customer user into it.
        Map<String, Object> user = createUser(admin, tenantId, "acme-operator",
                "acme@acme.example", "acme-pw");
        assertThat(user).containsEntry("username", "acme-operator");
        assertThat(user).containsEntry("tenantId", tenantId);
        assertThat(user).containsEntry("enabled", true);

        // ...and it is listed under the tenant.
        ResponseEntity<List<Map<String, Object>>> users = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(users.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(users.getBody()).extracting(u -> u.get("username")).contains("acme-operator");
    }

    // ---- (b) the new customer logs in and sees only their tenant ------------

    @Test
    void provisionedCustomerLogsInAndIsTenantScoped() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Nordsee Energie", "CI").get("id");
        createUser(admin, tenantId, "nordsee-operator", "op@nordsee.example", "nordsee-pw");

        // Give the fresh tenant one site (seeded as superuser, bypassing RLS) so
        // there is tenant-owned data to prove the customer can see THEIR data.
        UUID siteId = UUID.randomUUID();
        seedSite(siteId, UUID.fromString(tenantId), "Nordsee Cuxhaven");

        // The provisioned user logs in via the confidential client (password grant).
        String customer = token("nordsee-operator", "nordsee-pw");

        // They see exactly their own site - not the seeded demo tenant's Berlin.
        ResponseEntity<List<Map<String, Object>>> sites = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(sites.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(sites.getBody()).extracting(s -> s.get("name")).containsExactly("Nordsee Cuxhaven");

        // And RLS hides another tenant's site entirely (404, not 403).
        ResponseEntity<String> foreign = rest.exchange(
                url("/api/v1/sites/" + BERLIN_SITE + "/telemetry"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class);
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- (c) a Portal-User is forbidden from the admin API ------------------

    @Test
    void portalUserIsForbiddenFromAdminEndpoints() {
        String operator = token("demo", "demo");

        assertThat(rest.exchange(url("/api/v1/admin/tenants"), HttpMethod.GET,
                new HttpEntity<>(bearer(operator)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        assertThat(rest.exchange(url("/api/v1/admin/tenants"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Rogue Tenant"), bearer(operator)), String.class)
                .getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + UUID.randomUUID() + "/users"), HttpMethod.POST,
                new HttpEntity<>(Map.of("username", "x"), bearer(operator)), String.class)
                .getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void adminEndpointsRejectAnonymous() {
        assertThat(rest.getForEntity(url("/api/v1/admin/tenants"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ---- helpers ------------------------------------------------------------

    private Map<String, Object> createTenant(String token, String name, String segment) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/tenants"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", name, "segment", segment), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    private Map<String, Object> createUser(String token, String tenantId, String username,
            String email, String password) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users"), HttpMethod.POST,
                new HttpEntity<>(Map.of("username", username, "email", email,
                        "password", password, "temporaryPassword", false), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    /** Insert a site for a tenant using the Postgres superuser (bypasses RLS). */
    private void seedSite(UUID siteId, UUID tenantId, String name) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                PreparedStatement ps = c.prepareStatement(
                        "INSERT INTO site (id, tenant_id, name, bidding_zone) VALUES (?, ?, ?, 'DE-LU')")) {
            ps.setObject(1, siteId);
            ps.setObject(2, tenantId);
            ps.setString(3, name);
            ps.executeUpdate();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
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
        assertThat(body).as("token response for " + username).containsKey("access_token");
        return (String) body.get("access_token");
    }
}
