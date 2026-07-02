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
import org.springframework.http.client.JdkClientHttpRequestFactory;
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

    // ---- (b2) admin creates a site for a tenant; its customer then sees it ---

    @Test
    void platformAdminCreatesSiteForTenantAndCustomerSeesIt() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Rheinkraft AG", "CI").get("id");
        createUser(admin, tenantId, "rhein-operator", "op@rhein.example", "rhein-pw");

        // Admin creates a site for that arbitrary tenant via the admin API
        // (cross-tenant, BYPASSRLS) - no seeding needed.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Rhein Werk Köln", "biddingZone", "DE-LU",
                        "latitude", 50.9375, "longitude", 6.9603), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody()).containsEntry("name", "Rhein Werk Köln");

        // It shows up in the tenant's admin site listing.
        ResponseEntity<List<Map<String, Object>>> adminList = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(adminList.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(adminList.getBody()).extracting(s -> s.get("name")).containsExactly("Rhein Werk Köln");

        // And the tenant's own customer, through the RLS-scoped portal, sees it too.
        String customer = token("rhein-operator", "rhein-pw");
        ResponseEntity<List<Map<String, Object>>> customerSites = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(customerSites.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(customerSites.getBody()).extracting(s -> s.get("name")).containsExactly("Rhein Werk Köln");
    }

    // ---- (b3) the tenant switcher: admin reads customer pages per tenant -----

    /**
     * The unified-portal tenant switcher: a Portal-Admin selects a tenant and the
     * CUSTOMER endpoints (sites/devices/telemetry/...) render that tenant's data,
     * scoped by the same RLS the customer gets - via the {@code X-Tenant-Id}
     * header the {@link com.voltpilot.api.tenant.TenantFilter} honors for
     * platform-admin tokens only.
     */
    @Test
    void adminReadsCustomerEndpointsForSelectedTenantViaHeader() {
        String admin = token("admin", "admin");

        // Tenant A selected: the admin sees exactly what `demo` sees.
        ResponseEntity<List<Map<String, Object>>> tenantA = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(tenantA.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(tenantA.getBody()).extracting(s -> s.get("name")).contains("Demo Site Berlin");

        // Switch to tenant B: now exactly what `demo2` sees - never both at once.
        ResponseEntity<List<Map<String, Object>>> tenantB = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "10000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(tenantB.getBody()).extracting(s -> s.get("name")).contains("Nordwind Hamburg");
        assertThat(tenantB.getBody()).extracting(s -> s.get("name")).doesNotContain("Demo Site Berlin");

        // Devices follow the same context (RLS on the same app datasource).
        ResponseEntity<List<Map<String, Object>>> devices = rest.exchange(
                url("/api/v1/devices"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getBody()).extracting(d -> d.get("externalRef")).contains("demo-inverter-01");

        // No tenant selected ("Alle Mandanten"): default-deny, zero rows.
        ResponseEntity<List<Map<String, Object>>> none = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(none.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(none.getBody()).isEmpty();
    }

    /** A customer token can NOT use the header to widen its tenant scope. */
    @Test
    void customerCannotSwitchTenantsViaHeader() {
        String operator = token("demo", "demo"); // tenant A

        ResponseEntity<List<Map<String, Object>>> sites = rest.exchange(
                url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(operator), "10000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(sites.getStatusCode()).isEqualTo(HttpStatus.OK);
        // Still tenant A's data - the header is ignored for non-admin tokens.
        assertThat(sites.getBody()).extracting(s -> s.get("name")).contains("Demo Site Berlin");
        assertThat(sites.getBody()).extracting(s -> s.get("name")).doesNotContain("Nordwind Hamburg");
    }

    // ---- (b4) device provisioning registry -----------------------------------

    @Test
    void adminProvisionsStickerIdsWhichGateAndInformCustomerClaims() {
        String admin = token("admin", "admin");

        // Register a manufactured sticker ID - input is canonicalized like the
        // claim path (trim + uppercase), so batch tooling can be sloppy about case.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", "  vp-batch-7001 ", "kind", "inverter",
                        "note", "Charge 2026-07"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(created.getBody()).containsEntry("externalRef", "VP-BATCH-7001");
        assertThat(created.getBody()).containsEntry("claimed", false);

        // Re-running the batch is idempotent: 200 with the existing entry.
        ResponseEntity<Map<String, Object>> again = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", "VP-BATCH-7001"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody()).containsEntry("note", "Charge 2026-07");

        // A non-sticker ref does not belong in the registry -> 400.
        assertThat(rest.exchange(url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", "edge-thing-1"), bearer(admin)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // The customer's claim of the provisioned ID succeeds...
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "VP-BATCH-7001"),
                        bearer(token("demo", "demo"))),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // ...and the admin listing now shows who connected it.
        ResponseEntity<List<Map<String, Object>>> list = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(list.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> entry = list.getBody().stream()
                .filter(p -> "VP-BATCH-7001".equals(p.get("externalRef")))
                .findFirst().orElseThrow();
        assertThat(entry).containsEntry("claimed", true);
        assertThat(entry).containsEntry("claimedByTenant", "Demo C&I Tenant");
    }

    // ---- (b4) support password reset -----------------------------------------

    /**
     * The platform has no SMTP, so a forgotten password has exactly one recovery
     * path: support resets it from the admin console. This proves the whole
     * support story: the customer locks themselves out guessing, support sets a
     * new password through the tenant-scoped admin endpoint, and the new
     * password works immediately because the reset also lifts the brute-force
     * lockout. A user addressed under the wrong tenant's path is never touched.
     */
    @Test
    void supportResetsAForgottenPasswordAndLiftsTheLockout() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Alpenstrom GmbH", "B2C").get("id");
        Map<String, Object> user = createUser(admin, tenantId, "alpen-kunde",
                "kunde@alpen.example", "vergessen-pw-1");
        String userId = (String) user.get("id");

        // Baseline: the customer can log in.
        assertThat(tryToken("alpen-kunde", "vergessen-pw-1")).containsKey("access_token");

        // They forgot the password; guessing locks the account...
        for (int i = 0; i < 10; i++) {
            assertThat(tryToken("alpen-kunde", "falsch-" + i)).doesNotContainKey("access_token");
        }
        // ...so even the correct password is refused now.
        assertThat(tryToken("alpen-kunde", "vergessen-pw-1")).doesNotContainKey("access_token");

        // A user addressed under the WRONG tenant's path is not found - never reset.
        String otherTenant = (String) createTenant(admin, "Fremdstrom AG", "B2C").get("id");
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + otherTenant + "/users/" + userId + "/reset-password"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("password", "neues-passwort-1", "temporary", false),
                        bearer(admin)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A too-short password is refused (same rule as self-registration).
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId + "/reset-password"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("password", "kurz"), bearer(admin)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Support resets the password through the right tenant path.
        ResponseEntity<Map<String, Object>> reset = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId + "/reset-password"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("password", "neues-passwort-1", "temporary", false),
                        bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(reset.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(reset.getBody()).containsEntry("username", "alpen-kunde");

        // The new password works IMMEDIATELY (the reset lifted the lockout)...
        assertThat(tryToken("alpen-kunde", "neues-passwort-1")).containsKey("access_token");
        // ...and the old one no longer does.
        assertThat(tryToken("alpen-kunde", "vergessen-pw-1")).doesNotContainKey("access_token");
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

        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + UUID.randomUUID() + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Rogue Site"), bearer(operator)), String.class)
                .getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Customers cannot reset anyone's password.
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + UUID.randomUUID() + "/users/x/reset-password"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("password", "boese-absicht-1"), bearer(operator)),
                String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // Customers cannot write the manufacturing registry either.
        assertThat(rest.exchange(url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", "VP-ROGUE-0001"), bearer(operator)),
                String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void adminEndpointsRejectAnonymous() {
        assertThat(rest.getForEntity(url("/api/v1/admin/tenants"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ---- (c) entity lifecycle: edit + delete ----------------------------------

    @Test
    void adminUpdatesTenantAndEditsCustomerSitesViaTenantSwitcher() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Tippfelher GmbH", "CI").get("id");

        // Fix the typo'd tenant name + change the segment.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Tippfehler GmbH", "segment", "B2C"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(updated.getBody()).containsEntry("name", "Tippfehler GmbH");
        assertThat(updated.getBody()).containsEntry("segment", "B2C");

        // Unknown tenant -> 404; bad segment -> 400.
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + UUID.randomUUID()), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "X"), bearer(admin)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + tenantId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "X", "segment", "B2B"), bearer(admin)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Admin creates a site for the tenant, then EDITS and DELETES it through
        // the CUSTOMER endpoints with the tenant switcher (X-Tenant-Id) - the
        // any-tenant admin path for sites/devices, RLS-scoped, never BYPASSRLS.
        ResponseEntity<Map<String, Object>> site = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Werk Alt"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        String siteId = (String) site.getBody().get("id");

        ResponseEntity<Map<String, Object>> renamed = rest.exchange(
                url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Werk Neu", "biddingZone", "DE-LU"),
                        withTenant(bearer(admin), tenantId)),
                new ParameterizedTypeReference<>() {});
        assertThat(renamed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(renamed.getBody()).containsEntry("name", "Werk Neu");

        // Without a selected tenant the admin has no RLS context -> 404, no edit.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Kontextlos"), bearer(admin)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.DELETE,
                new HttpEntity<>(withTenant(bearer(admin), tenantId)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        ResponseEntity<List<Map<String, Object>>> remaining = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(remaining.getBody()).extracting(s -> s.get("name")).doesNotContain("Werk Neu");
    }

    @Test
    void tenantOffboardingIsTypeToConfirmAndCascadesDataAndKeycloakUsers() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Weggezogen GmbH", "CI").get("id");
        createUser(admin, tenantId, "weggezogen-operator", "op@weg.example", "weg-pw-123");

        // The customer builds up real state: a site, a claimed device, telemetry.
        String customer = token("weggezogen-operator", "weg-pw-123");
        ResponseEntity<Map<String, Object>> site = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Werk Weg"), bearer(customer)),
                new ParameterizedTypeReference<>() {});
        String siteId = (String) site.getBody().get("id");
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "edge-weg-01"),
                        bearer(customer)),
                new ParameterizedTypeReference<>() {});
        String deviceId = (String) claim.getBody().get("id");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "(now(), '" + tenantId + "', '" + siteId + "', '" + deviceId + "', 1.0)");

        // Type-to-confirm: a wrong name is refused and NOTHING is deleted.
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + tenantId + "/delete"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("confirmName", "Weggezogen"), bearer(admin)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(queryLong("SELECT count(*) FROM tenant WHERE id = '" + tenantId + "'")).isEqualTo(1L);

        // A customer must not be able to offboard anyone (403).
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + tenantId + "/delete"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("confirmName", "Weggezogen GmbH"), bearer(customer)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        // The exact name unlocks the cascade; the report says what was removed.
        ResponseEntity<Map<String, Object>> report = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/delete"), HttpMethod.POST,
                new HttpEntity<>(Map.of("confirmName", "Weggezogen GmbH"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(report.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(report.getBody()).containsEntry("deletedSites", 1);
        assertThat(report.getBody()).containsEntry("deletedDevices", 1);
        assertThat(((Number) report.getBody().get("deletedTelemetryRows")).longValue()).isEqualTo(1L);
        assertThat((List<?>) report.getBody().get("deletedUsers"))
                .isEqualTo(List.of("weggezogen-operator"));
        assertThat((List<?>) report.getBody().get("failedUsers")).isEmpty();

        // Database: tenant, site, device, telemetry - all gone.
        assertThat(queryLong("SELECT count(*) FROM tenant WHERE id = '" + tenantId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM site WHERE tenant_id = '" + tenantId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM device WHERE tenant_id = '" + tenantId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE tenant_id = '" + tenantId + "'")).isZero();

        // Keycloak: the login is gone too.
        assertThat(tryToken("weggezogen-operator", "weg-pw-123")).doesNotContainKey("access_token");

        // And the offboarded tenant is not in the listing anymore.
        ResponseEntity<List<Map<String, Object>>> tenants = rest.exchange(
                url("/api/v1/admin/tenants"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(tenants.getBody()).extracting(t -> t.get("id")).doesNotContain(tenantId);
    }

    @Test
    void adminEditsEnablesAndDeletesUsersButNeverTheirOwnAccount() throws Exception {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Benutzerpflege AG", "CI").get("id");
        String userId = (String) createUser(admin, tenantId, "pflege-operator",
                "alt@pflege.example", "pflege-pw").get("id");

        // Edit email + name; the username is immutable and stays.
        ResponseEntity<Map<String, Object>> updated = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("email", "neu@pflege.example", "firstName", "Petra",
                        "lastName", "Pflege"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(updated.getBody()).containsEntry("email", "neu@pflege.example");
        assertThat(updated.getBody()).containsEntry("firstName", "Petra");
        assertThat(updated.getBody()).containsEntry("username", "pflege-operator");

        // A user addressed through the WRONG tenant's path is 404, never edited.
        String otherTenant = (String) createTenant(admin, "Falscher Pfad eG", "CI").get("id");
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + otherTenant + "/users/" + userId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("email", "x@x.example"), bearer(admin)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Disable blocks the login; enable (the new counterpart) restores it.
        rest.exchange(url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId + "/disable"),
                HttpMethod.POST, new HttpEntity<>(bearer(admin)), String.class);
        assertThat(tryToken("pflege-operator", "pflege-pw")).doesNotContainKey("access_token");
        ResponseEntity<Map<String, Object>> enabled = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId + "/enable"),
                HttpMethod.POST, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(enabled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(enabled.getBody()).containsEntry("enabled", true);
        assertThat(tryToken("pflege-operator", "pflege-pw")).containsKey("access_token");

        // SELF-GUARD: the admin can neither disable nor delete their own account,
        // regardless of which tenant path they route through (409 before any
        // tenant check).
        String adminSub = jwtSub(admin);
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + adminSub + "/disable"),
                HttpMethod.POST, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + adminSub),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        assertThat(tryToken("admin", "admin")).containsKey("access_token");

        // Delete removes the customer's login for good.
        assertThat(rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(tryToken("pflege-operator", "pflege-pw")).doesNotContainKey("access_token");
        ResponseEntity<List<Map<String, Object>>> users = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(users.getBody()).extracting(u -> u.get("username")).doesNotContain("pflege-operator");
    }

    @Test
    void registryEntryDeleteIsRefusedWhileClaimedAndFreedByUnclaim() {
        String admin = token("admin", "admin");
        provision(admin, "VP-DEL-0001");
        provision(admin, "VP-DEL-0002");

        // A customer connects the first ID.
        String demo = token("demo", "demo");
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "VP-DEL-0001"),
                        bearer(demo)),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String deviceId = (String) claim.getBody().get("id");

        // Claimed -> the registry entry cannot be removed (409).
        assertThat(rest.exchange(url("/api/v1/admin/provisioned-devices/VP-DEL-0001"),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // Unclaimed entries delete fine (path input is canonicalized like the claim).
        assertThat(rest.exchange(url("/api/v1/admin/provisioned-devices/vp-del-0002"),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        ResponseEntity<List<Map<String, Object>>> list = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(list.getBody()).extracting(p -> p.get("externalRef")).doesNotContain("VP-DEL-0002");

        // Unknown entry -> 404.
        assertThat(rest.exchange(url("/api/v1/admin/provisioned-devices/VP-NIE-0000"),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Once the customer removes the device, the entry is deletable.
        assertThat(rest.exchange(url("/api/v1/devices/" + deviceId), HttpMethod.DELETE,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(rest.exchange(url("/api/v1/admin/provisioned-devices/VP-DEL-0001"),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
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

    /** Register a sticker Geräte-ID in the manufacturing registry. */
    private void provision(String adminToken, String externalRef) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", externalRef), bearer(adminToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode().is2xxSuccessful()).isTrue();
    }

    /** The token's subject (= the Keycloak user id of the caller). */
    private static String jwtSub(String token) throws Exception {
        String payload = new String(java.util.Base64.getUrlDecoder()
                .decode(token.split("\\.")[1]), java.nio.charset.StandardCharsets.UTF_8);
        return new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(payload).get("sub").asText();
    }

    /** Run a statement as the Postgres superuser (bypasses RLS). */
    private static void exec(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }

    /** Scalar count query as the Postgres superuser (sees all tenants' rows). */
    private static long queryLong(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
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

    /** Add the tenant-switcher header (honored only for platform-admin tokens). */
    private static HttpHeaders withTenant(HttpHeaders h, String tenantId) {
        h.set("X-Tenant-Id", tenantId);
        return h;
    }

    /** Direct-access-grant token for a realm user via the confidential api client. */
    private String token(String username, String password) {
        Map<String, Object> body = tryToken(username, password);
        assertThat(body).as("token response for " + username).containsKey("access_token");
        return (String) body.get("access_token");
    }

    /** Like {@link #token} but returns the raw response without asserting success. */
    private Map<String, Object> tryToken(String username, String password) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-api");
        form.add("client_secret", "voltpilot-api-dev-secret");
        form.add("username", username);
        form.add("password", password);
        form.add("scope", "openid");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        return keycloakRest().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
    }

    /**
     * Rest client for direct Keycloak calls. The default JDK
     * {@code HttpURLConnection} cannot read a 401 body on a streamed POST
     * (HttpRetryException), which a refused password grant triggers - the
     * java.net.http-based factory handles it fine.
     */
    private static TestRestTemplate keycloakRest() {
        TestRestTemplate t = new TestRestTemplate();
        t.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
        return t;
    }
}
