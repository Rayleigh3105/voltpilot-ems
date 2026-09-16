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
 *       {@code tenant_id} attribute (no realm role since AP-03 IP-3) via the Admin REST
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

    @Autowired
    com.voltpilot.api.repo.DeviceRepository deviceRepo;

    @Autowired
    com.voltpilot.api.entities.EntityObservedRepository entityObservedRepo;

    @Autowired
    com.voltpilot.api.components.ComponentApplyRepository componentApplyRepo;

    @Autowired
    com.voltpilot.api.entities.V2SiteBackfillRunner backfillRunner;

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
        ResponseEntity<List<Map<String, Object>>> sites = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
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
        ResponseEntity<List<Map<String, Object>>> customerSites = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
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
        ResponseEntity<List<Map<String, Object>>> tenantA = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(tenantA.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(tenantA.getBody()).extracting(s -> s.get("name")).contains("Demo Site Berlin");

        // Switch to tenant B: now exactly what `demo2` sees - never both at once.
        ResponseEntity<List<Map<String, Object>>> tenantB = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "10000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(tenantB.getBody()).extracting(s -> s.get("name")).contains("Nordwind Hamburg");
        assertThat(tenantB.getBody()).extracting(s -> s.get("name")).doesNotContain("Demo Site Berlin");

        // Devices follow the same context (RLS on the same app datasource).
        ResponseEntity<List<Map<String, Object>>> devices = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/devices"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(devices.getBody()).extracting(d -> d.get("externalRef")).contains("demo-inverter-01");

        // No tenant selected ("Alle Mandanten"): default-deny, zero rows.
        ResponseEntity<List<Map<String, Object>>> none = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(none.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(none.getBody()).isEmpty();
    }

    /** A customer token can NOT use the header to widen its tenant scope. */
    @Test
    void customerCannotSwitchTenantsViaHeader() {
        String operator = token("demo", "demo"); // tenant A

        ResponseEntity<List<Map<String, Object>>> sites = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
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

    @Test
    void pendingEnrollmentsListsEnrolledButUnclaimedDevices() {
        String admin = token("admin", "admin");

        // A device enrolled (uploaded a CSR) under a ref that was never claimed -
        // the mistyped-reference dead-end: the device polls forever, invisible to
        // the customer. It must show up in the operator's pending view.
        exec("INSERT INTO device_enrollment (external_ref, csr_pem) "
                + "VALUES ('edge-orphan-77', 'dummy-csr') ON CONFLICT DO NOTHING");
        // A ref that IS claimed (the dev-seeded device demo-inverter-01) enrolled
        // too - it has a matching device row, so it is NOT pending.
        exec("INSERT INTO device_enrollment (external_ref, csr_pem) "
                + "VALUES ('demo-inverter-01', 'dummy-csr') ON CONFLICT DO NOTHING");

        ResponseEntity<List<Map<String, Object>>> pending = rest.exchange(
                url("/api/v1/admin/enrollments/pending"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(pending.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Object> refs = pending.getBody().stream().map(e -> e.get("externalRef")).toList();
        assertThat(refs).contains("edge-orphan-77").doesNotContain("demo-inverter-01");
        Map<String, Object> orphan = pending.getBody().stream()
                .filter(e -> "edge-orphan-77".equals(e.get("externalRef"))).findFirst().orElseThrow();
        assertThat(orphan).containsEntry("everIssued", false);

        // A customer may never see the operator view.
        assertThat(rest.exchange(url("/api/v1/admin/enrollments/pending"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
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
    void startpasswortGehoertDemKundenadministratorUndNichtMehrDemSupport() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Alpenstrom GmbH", "B2C").get("id");
        String userId = (String) createUser(admin, tenantId, "alpen-kunde", "kunde@alpen.example", "eigenes-passwort-1").get("id");
        String otherTenant = (String) createTenant(admin, "Fremdstrom AG", "B2C").get("id");
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + otherTenant + "/users/" + userId + "/reset-password"),
                HttpMethod.POST, new HttpEntity<>(Map.of("password", "unbenutzt"), bearer(admin)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + tenantId + "/users/" + userId + "/reset-password"),
                HttpMethod.POST, new HttpEntity<>(Map.of("password", "unbenutzt"), bearer(admin)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(tryToken("alpen-kunde", "eigenes-passwort-1")).containsKey("access_token");
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

    /**
     * U0 Kontotyp/Betriebsart frame (design vp-ems-ui-overhaul §2, hardened by
     * the pre-deploy audit HIGH-1): ONLY an explicit admin-set override picks a
     * shell frame - an unset override stays UNKNOWN (null) for every segment,
     * so an existing admin-provisioned (segment {@code CI}) customer keeps the
     * pre-U0 site-count behavior instead of silently landing in the operator
     * Portfolio shell. Clearing returns to automatic, and the EFFECTIVE value is
     * echoed both on the admin tenant DTOs and on the customer's
     * {@code /tenant-context} login bootstrap. Only a Portal-Admin can set it -
     * the customer path never writes the frame.
     */
    @Test
    void betriebsartFrameIsAdminSetNeverSegmentDerivedAndEchoedOnTenantContext() {
        String admin = token("admin", "admin");

        // No override stored => unknown frame, for BOTH segments. The CI case is
        // the HIGH-1 regression guard: it must NOT read 'betreiber'.
        Map<String, Object> b2c = createTenant(admin, "Familie Sonnenhof", "B2C");
        String b2cId = (String) b2c.get("id");
        assertThat(b2c.get("betriebsart")).isNull();
        assertThat(b2c.get("betriebsartEffective")).isNull();
        assertThat(createTenant(admin, "Stadtwerke Windau", "CI").get("betriebsartEffective"))
                .isNull();

        // The admin flips the household to the fleet shell: the override wins.
        ResponseEntity<Map<String, Object>> flipped = rest.exchange(
                url("/api/v1/admin/tenants/" + b2cId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Familie Sonnenhof", "segment", "B2C",
                        "betriebsart", "betreiber"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(flipped.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(flipped.getBody()).containsEntry("betriebsart", "betreiber");
        assertThat(flipped.getBody()).containsEntry("betriebsartEffective", "betreiber");

        // The customer's login bootstrap reads the EFFECTIVE frame of exactly
        // their own tenant (RLS; no admin route involved).
        createUser(admin, b2cId, "sonnenhof-operator", "op@sonnenhof.example", "sonne-pw-123");
        String customer = token("sonnenhof-operator", "sonne-pw-123");
        ResponseEntity<Map<String, Object>> ctx = rest.exchange(
                url("/api/v1/tenant-context"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), new ParameterizedTypeReference<>() {});
        assertThat(ctx.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ctx.getBody()).containsEntry("tenantId", b2cId);
        assertThat(ctx.getBody()).containsEntry("segment", "B2C");
        assertThat(ctx.getBody()).containsEntry("betriebsart", "betreiber");

        // Clearing = the full-representation PUT WITHOUT the field: back to
        // automatic (unknown), and the customer's next bootstrap follows - the
        // portal then falls back to the pre-U0 site-count heuristic.
        ResponseEntity<Map<String, Object>> cleared = rest.exchange(
                url("/api/v1/admin/tenants/" + b2cId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Familie Sonnenhof", "segment", "B2C"),
                        bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(cleared.getBody().get("betriebsart")).isNull();
        assertThat(cleared.getBody().get("betriebsartEffective")).isNull();
        assertThat(rest.exchange(url("/api/v1/tenant-context"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), new ParameterizedTypeReference<Map<String, Object>>() {})
                .getBody().get("betriebsart")).isNull();

        // Garbage refuses with 400; nothing changes.
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + b2cId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "X", "segment", "B2C", "betriebsart", "portfolio"),
                        bearer(admin)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // The customer path can never SET the frame: the admin tenant route is
        // platform-admin-only, an operator token gets 403.
        assertThat(rest.exchange(url("/api/v1/admin/tenants/" + b2cId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Hack", "segment", "B2C",
                        "betriebsart", "betreiber"), bearer(customer)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        // Admins read a tenant's context via the X-Tenant-Id switcher; without
        // a selected tenant the RLS default-deny yields 404 - never another
        // tenant's frame.
        ResponseEntity<Map<String, Object>> adminCtx = rest.exchange(
                url("/api/v1/tenant-context"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), b2cId)),
                new ParameterizedTypeReference<>() {});
        assertThat(adminCtx.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(adminCtx.getBody()).containsEntry("tenantId", b2cId);
        assertThat(adminCtx.getBody().get("betriebsart")).isNull();
        assertThat(rest.exchange(url("/api/v1/tenant-context"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * The per-site grid-charging switch (netzladen_erlaubt) is editable by the
     * SITE OWNER too (captain revision 2026-07-07 of decision 3 - not only the
     * Portal-Admin): a customer sets it on create and flips it on update of
     * their OWN sites; RLS keeps scoping which sites they reach, so a foreign
     * tenant's site stays a 404 exactly as before. An omitted flag stays the
     * safe default FALSE (EEG) on create and keeps the stored value on update.
     * The admin paths (admin create + the tenant-switcher flip through the
     * customer PUT) keep working unchanged.
     */
    @Test
    void netzladenSwitchIsEditableByTheSiteOwnerAndAdmins() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Netzlader GmbH", "CI").get("id");
        createUser(admin, tenantId, "netzlader-operator", "op@netzlader.example", "netz-pw-123");
        String customer = token("netzlader-operator", "netz-pw-123");

        // Admin path accepts the flag; an omitted flag defaults to FALSE (EEG).
        ResponseEntity<Map<String, Object>> merchant = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Speicherpark", "netzladenErlaubt", true),
                        bearer(admin)),
                new ParameterizedTypeReference<>() {});
        assertThat(merchant.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(merchant.getBody()).containsEntry("netzladenErlaubt", true);

        // The CUSTOMER sets the flag on create of their own site...
        ResponseEntity<Map<String, Object>> customerMerchant = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Eigenwerk", "netzladenErlaubt", true),
                        bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(customerMerchant.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(customerMerchant.getBody()).containsEntry("netzladenErlaubt", true);

        // ...while an omitted flag still lands on the safe default FALSE.
        ResponseEntity<Map<String, Object>> eeg = rest.exchange(
                url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Hof Sonnenfeld"), bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(eeg.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(eeg.getBody()).containsEntry("netzladenErlaubt", false);
        String eegId = (String) eeg.getBody().get("id");

        // The customer flips their own site both ways via the normal update.
        ResponseEntity<Map<String, Object>> flippedOn = rest.exchange(
                url("/api/v1/sites/" + eegId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Hof Sonnenfeld", "netzladenErlaubt", true),
                        bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(flippedOn.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(flippedOn.getBody()).containsEntry("netzladenErlaubt", true);
        ResponseEntity<Map<String, Object>> flippedOff = rest.exchange(
                url("/api/v1/sites/" + eegId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Hof Sonnenfeld", "netzladenErlaubt", false),
                        bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(flippedOff.getBody()).containsEntry("netzladenErlaubt", false);

        // An edit WITHOUT the field keeps the stored value (null = COALESCE).
        ResponseEntity<Map<String, Object>> renamed = rest.exchange(
                url("/api/v1/sites/" + eegId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Hof Sonnenfeld Süd"), bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(renamed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(renamed.getBody()).containsEntry("netzladenErlaubt", false);

        // A FOREIGN tenant's site stays out of reach (RLS 404, unchanged):
        // the flag being customer-editable never widens WHICH sites a
        // customer can touch.
        String otherTenant = (String) createTenant(admin, "Fremd AG", "CI").get("id");
        ResponseEntity<Map<String, Object>> foreign = rest.exchange(
                url("/api/v1/admin/tenants/" + otherTenant + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Fremdwerk"), bearer(admin)),
                new ParameterizedTypeReference<>() {});
        String foreignId = (String) foreign.getBody().get("id");
        assertThat(rest.exchange(url("/api/v1/sites/" + foreignId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Fremdwerk", "netzladenErlaubt", true),
                        bearer(customer)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        ResponseEntity<List<Map<String, Object>>> foreignAfter = rest.exchange(
                url("/api/v1/admin/tenants/" + otherTenant + "/sites"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(foreignAfter.getBody().stream()
                .filter(x -> foreignId.equals(x.get("id"))).findFirst().orElseThrow())
                .containsEntry("netzladenErlaubt", false);

        // The overview echoes the flag per site for the customer.
        ResponseEntity<Map<String, Object>> overview = rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat((List<Map<String, Object>>) overview.getBody().get("sites"))
                .extracting(x -> x.get("netzladenErlaubt"))
                .containsExactlyInAnyOrder(true, true, false);

        // The admin still flips it through the CUSTOMER endpoint via the
        // tenant switcher (the standard any-tenant edit path).
        ResponseEntity<Map<String, Object>> adminFlip = rest.exchange(
                url("/api/v1/sites/" + eegId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "Hof Sonnenfeld Süd", "netzladenErlaubt", true),
                        withTenant(bearer(admin), tenantId)),
                new ParameterizedTypeReference<>() {});
        assertThat(adminFlip.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(adminFlip.getBody()).containsEntry("netzladenErlaubt", true);
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
        OcppTestData.seed(AdminApiTest::exec, tenantId, siteId, deviceId);
        assertThat(queryLong(OcppTestData.countByTenantSql(tenantId))).isEqualTo(11);

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
        assertThat(queryLong(OcppTestData.countByTenantSql(tenantId))).isZero();

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

    // ---- admin optimizer surface: diagnostics + config -----------------------

    /**
     * The per-slot "why" decomposition (design vp-admin-optimizer-ui-design
     * §4.2) against hand-computed economics on two plants: a Direktvermarktung
     * site (dynamic tariff + Marktprämie incl. the §51 negative-price
     * suspension) and an Eigenverbrauch site (flat retail tariff + feste
     * Vergütung surviving negative spot for a 2023 plant). Also: generatedAt
     * defaults to the LATEST run and can select an older one; wear derives
     * from the PERSISTED wear_cost_eur; auth + tenant scoping mirror the
     * sanctioned admin switcher pattern.
     */
    @Test
    void optimizerDiagnosticsDecomposeSlotsWithRealTariffAndRemuneration() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Optimizer Diagnose GmbH", "CI").get("id");

        String dvSite = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "DV Anlage", "biddingZone", "DE-LU",
                        "plantKind", "direktvermarktung", "anzulegenderWertCtKwh", 8.11,
                        "tarifArt", "dynamisch", "tarifParamCtKwh", 18.0), bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String evSite = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "EV Anlage", "biddingZone", "DE-LU",
                        "plantKind", "eigenverbrauch",
                        "tarifArt", "fest", "tarifParamCtKwh", 30.0), bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // Batteries: DV without a wear override (platform default 4.0 applies),
        // EV with a 6.0 ct override; the EV site's PV asset carries the MaStR
        // commissioning date + kWp driving its feste Vergütung (2023 => 8.2 ct).
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + dvSite + "', 'battery', 20, 10, 10, 92)");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct, wear_cost_ct_per_kwh) VALUES ('"
                + tenantId + "', '" + evSite + "', 'battery', 20, 10, 10, 92, 6.0)");
        exec("INSERT INTO asset (tenant_id, site_id, type, commissioned_on, pv_capacity_kwp) "
                + "VALUES ('" + tenantId + "', '" + evSite + "', 'pv', DATE '2023-06-15', 5.0)");

        // The slots' Monatsmarktwert Solar (current + next Berlin month so a
        // month-boundary run stays deterministic): 4.5 ct => premium 3.61 ct.
        // ON CONFLICT DO UPDATE - a premium test must OWN its months (the
        // seedHistoryDay price rule; dev-seed rows would otherwise win).
        exec("INSERT INTO monthly_market_value (month, technology, value_ct_kwh, provisional, source) "
                + "VALUES (date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')::date, "
                + "'solar', 4.5, false, 'test'), "
                + "((date_trunc('month', now() AT TIME ZONE 'Europe/Berlin') + interval '1 month')::date, "
                + "'solar', 4.5, false, 'test') "
                + "ON CONFLICT (technology, month) DO UPDATE SET "
                + "value_ct_kwh = EXCLUDED.value_ct_kwh, provisional = EXCLUDED.provisional");

        // Two DV runs: an older single-slot run (must NOT be the default) and
        // the latest run with hand-computable slots. Wear 0.02 EUR on 4 kW *
        // 15 min = 1 kWh throughput => 2.0 ct/kWh. Anchored at noon Berlin
        // TODAY (not now()): availableRuns is day-scoped since the date-nav
        // increment, so both runs must share one Berlin day even when CI runs
        // shortly after midnight.
        java.time.ZoneId berlin = java.time.ZoneId.of("Europe/Berlin");
        java.time.Instant genNew = java.time.LocalDate.now(berlin)
                .atTime(12, 0).atZone(berlin).toInstant();
        java.time.Instant genOld = genNew.minusSeconds(3600);
        java.time.Instant slot1 = genNew.plusSeconds(900);
        java.time.Instant slot2 = genNew.plusSeconds(1800);
        exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, battery_kw, "
                + "grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur) "
                + "VALUES ('" + slot1 + "', '" + tenantId + "', '" + dvSite + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000001', '" + genOld + "', 0, 0, 50, 0, 0, 100, 0, 0)");
        // The newer run also carries the Morgenprognose anchor (a RUN-level
        // fact repeated per row); the older one predates the column.
        exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, battery_kw, "
                + "grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur, "
                + "curtail_kw, wear_cost_eur, pv_anchor_ratio) VALUES "
                + "('" + slot1 + "', '" + tenantId + "', '" + dvSite + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000002', '" + genNew + "', "
                + "4.0, 6.0, 55, 2.0, 0.0, 100, 0.15, 0.05, 0, 0.02, 2.4), "
                + "('" + slot2 + "', '" + tenantId + "', '" + dvSite + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000002', '" + genNew + "', "
                + "-4.0, -2.0, 35, 2.0, 4.0, -40, -0.02, 0.01, 1.5, 0.02, 2.4)");
        // One EV run: a positive- and a negative-price slot.
        exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, battery_kw, "
                + "grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, baseline_cost_eur) VALUES "
                + "('" + slot1 + "', '" + tenantId + "', '" + evSite + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000003', '" + genNew + "', "
                + "3.0, -1.0, 60, 1.0, 5.0, 200, 0, 0), "
                + "('" + slot2 + "', '" + tenantId + "', '" + evSite + "', "
                + "'bbbbbbbb-0000-0000-0000-000000000003', '" + genNew + "', "
                + "0.0, -2.0, 60, 1.0, 3.0, -40, 0, 0)");

        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        // ---- DV site, default run = the LATEST ------------------------------
        ResponseEntity<Map<String, Object>> dv = rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(dv.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> dvBody = dv.getBody();
        assertThat(dvBody).containsEntry("generatedAt", genNew.toString());
        assertThat(dvBody).containsEntry("plantKind", "direktvermarktung");
        assertThat(dvBody).containsEntry("tarifArt", "dynamisch");
        // Stufe 2 admin echo: dynamisch + Aufschlag, no sheet yet => Sammelaufschlag.
        assertThat(dvBody).containsEntry("priceSource", "sammelaufschlag");
        assertThat(dvBody).containsEntry("storedEnergyValueIsApproximation", true);
        // Morgenprognose: the run names the PV nowcast anchor it corrected by,
        // right next to the active model that needed it.
        assertThat(num(dvBody, "pvAnchorRatio")).isEqualTo(2.4);
        @SuppressWarnings("unchecked")
        List<Object> availableRuns = (List<Object>) dvBody.get("availableRuns");
        assertThat(availableRuns).contains(genNew.toString(), genOld.toString());
        @SuppressWarnings("unchecked")
        Map<String, Object> dvBattery = (Map<String, Object>) dvBody.get("battery");
        assertThat(num(dvBattery, "wearCostCtPerKwh")).isEqualTo(4.0);
        assertThat(dvBattery).containsEntry("wearCostSource", "platform-default");
        assertThat(num(dvBattery, "socMinPct")).isEqualTo(5.0);
        assertThat(num(dvBattery, "socMaxPct")).isEqualTo(95.0);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> dvSlots = (List<Map<String, Object>>) dvBody.get("slots");
        assertThat(dvSlots).hasSize(2);
        Map<String, Object> s1 = dvSlots.get(0);
        double eta = Math.sqrt(0.92);
        // Spot 100 EUR/MWh: solver 10 ct; import = spot + 18 ct Aufschlag;
        // export = spot + max(8.11 - 4.5, 0) Marktprämie; grid-charging slot.
        assertThat(num(s1, "solverPriceCtKwh")).isCloseTo(10.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(s1, "importPriceCtKwh")).isCloseTo(28.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(s1, "exportValueCtKwh")).isCloseTo(13.61, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(s1, "wearCostCtKwh")).isCloseTo(2.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(s1).containsEntry("decisionLabel", "netzladen");
        // Forward best-use = max over both slots of max(import, export):
        // slot1 28 ct, slot2 14 ct => 28; discounted by eta and half the
        // effective wear (4.0 platform default / 2).
        assertThat(num(s1, "valueOfStoredEnergyCtKwh"))
                .isCloseTo(eta * (28.0 - 2.0), org.assertj.core.data.Offset.offset(1e-6));
        assertThat((String) s1.get("whyText")).contains("aus dem Netz");
        // Netz-null-Reduzieren (08.09.2026): a CHARGING slot never grants the
        // REDUCE-only right - there is no discharge to limit.
        assertThat(s1).containsEntry("limitDischargeToLoad", false);

        Map<String, Object> s2 = dvSlots.get(1);
        // Spot -40: the Marktprämie is SUSPENDED (§51), export = bare spot.
        assertThat(num(s2, "solverPriceCtKwh")).isCloseTo(-4.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(s2, "importPriceCtKwh")).isCloseTo(14.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(s2, "exportValueCtKwh")).isCloseTo(-4.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(s2).containsEntry("decisionLabel", "entladen");
        assertThat(num(s2, "curtailKw")).isEqualTo(1.5);
        assertThat(num(s2, "valueOfStoredEnergyCtKwh"))
                .isCloseTo(eta * (14.0 - 2.0), org.assertj.core.data.Offset.offset(1e-6));
        assertThat((String) s2.get("whyText")).contains("Drosselt");
        // ...and a slot the plan deliberately EXPORTS from is excluded too: the
        // box cannot tell an intended sale from a forecast overshoot, so the
        // grid deadband (|grid_kw| <= 0,05) decides here, where both numbers are.
        assertThat(s2).containsEntry("limitDischargeToLoad", false);
        // Pre-Fahrplan-Warum rows carry no persisted role/flags.
        assertThat(s1.get("slotRole")).isNull();
        assertThat(s1.get("slotFlags")).isNull();

        // ---- Fahrplan-Warum: the persisted EXACT stored value is preferred ---
        // Once the optimizer's explain layer persisted the run's why columns,
        // the diagnostics serve the exact SoC shadow price instead of the
        // forward best-use heuristic, the approximation flag drops to false,
        // and role + binding flags pass through.
        exec("UPDATE schedule SET stored_value_ct_kwh = 23.7, "
                + "slot_role = 'guenstig_laden', slot_flags = 'charge_cap' "
                + "WHERE plan_id = 'bbbbbbbb-0000-0000-0000-000000000002'");
        ResponseEntity<Map<String, Object>> exact = rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        Map<String, Object> exactBody = exact.getBody();
        assertThat(exactBody).containsEntry("storedEnergyValueIsApproximation", false);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> exactSlots = (List<Map<String, Object>>) exactBody.get("slots");
        assertThat(num(exactSlots.get(0), "valueOfStoredEnergyCtKwh")).isEqualTo(23.7);
        assertThat(exactSlots.get(0)).containsEntry("slotRole", "guenstig_laden");
        assertThat(exactSlots.get(0).get("slotFlags")).isEqualTo(List.of("charge_cap"));
        // The OLDER run still has NULL columns - fetching it keeps the honest
        // approximation flag.
        ResponseEntity<Map<String, Object>> stillApprox = rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics?generatedAt=" + genOld),
                HttpMethod.GET, new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(stillApprox.getBody())
                .containsEntry("storedEnergyValueIsApproximation", true);

        // ---- explicit generatedAt selects the OLDER run ----------------------
        ResponseEntity<Map<String, Object>> old = rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics?generatedAt=" + genOld),
                HttpMethod.GET, new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(old.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(old.getBody()).containsEntry("generatedAt", genOld.toString());
        assertThat((List<?>) old.getBody().get("slots")).hasSize(1);
        // A run without an established anchor says NOTHING - never a
        // misleading "1,0", which would itself be a real statement.
        assertThat(old.getBody().get("pvAnchorRatio")).isNull();
        // ...and an unknown run is a 404, not silently the latest.
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + dvSite
                        + "/optimizer-diagnostics?generatedAt=1999-01-01T00:00:00Z"),
                HttpMethod.GET, new HttpEntity<>(adminTenant), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // ---- EV site: flat tariff + feste Vergütung ---------------------------
        ResponseEntity<Map<String, Object>> ev = rest.exchange(
                url("/api/v1/admin/sites/" + evSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> evSlots = (List<Map<String, Object>>) ev.getBody().get("slots");
        assertThat(evSlots).hasSize(2);
        // Import is the flat 30 ct retail price at ANY spot; export is the 8.2 ct
        // feste Vergütung (<=10 kWp, 2023) - which SURVIVES the negative slot
        // (pre-Solarspitzengesetz plant, the F6 rule).
        assertThat(num(evSlots.get(0), "importPriceCtKwh")).isEqualTo(30.0);
        assertThat(num(evSlots.get(0), "exportValueCtKwh")).isEqualTo(8.2);
        assertThat(evSlots.get(0)).containsEntry("decisionLabel", "solarladen");
        assertThat(num(evSlots.get(1), "importPriceCtKwh")).isEqualTo(30.0);
        assertThat(num(evSlots.get(1), "exportValueCtKwh")).isEqualTo(8.2);
        @SuppressWarnings("unchecked")
        Map<String, Object> evBattery = (Map<String, Object>) ev.getBody().get("battery");
        assertThat(num(evBattery, "wearCostCtPerKwh")).isEqualTo(6.0);
        assertThat(evBattery).containsEntry("wearCostSource", "asset");

        // ---- structured supply-price sheet (site_supply_price) ---------------
        // A maintained sheet replaces the dynamisch Sammelaufschlag with the
        // report-§3.1 composition (spot + Σ components netto) × (1 + USt):
        // sheet 7.6+2.05+1.59+2.946+1.5 = 15.686 ct netto, USt 19% => spot
        // 100 EUR/MWh composes to 30.56634 ct/kWh, spot -40 to 13.90634 -
        // the SlotEconomicsTest/test_pricing.py vectors, here through the real
        // migration + LEFT JOIN + service wiring.
        exec("INSERT INTO site_supply_price (site_id, tenant_id, "
                + "netzentgelt_arbeitspreis_ct, stromsteuer_ct, konzessionsabgabe_ct, "
                + "umlagen_ct, vertriebsaufschlag_ct, ust_pct, komponenten_stand) VALUES ('"
                + dvSite + "', '" + tenantId + "', 7.6, 2.05, 1.59, 2.946, 1.5, 19.0, "
                + "DATE '2026-01-01')");
        ResponseEntity<Map<String, Object>> sheet = rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> sheetSlots = (List<Map<String, Object>>) sheet.getBody().get("slots");
        // Stufe 2 admin echo: a maintained sheet => the structured Preisblatt source.
        assertThat(sheet.getBody()).containsEntry("priceSource", "preisblatt");
        assertThat(num(sheetSlots.get(0), "importPriceCtKwh"))
                .isCloseTo(30.56634, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(num(sheetSlots.get(1), "importPriceCtKwh"))
                .isCloseTo(13.90634, org.assertj.core.data.Offset.offset(1e-9));
        // Export values are untouched by the sheet (import-only instrument).
        assertThat(num(sheetSlots.get(0), "exportValueCtKwh"))
                .isCloseTo(13.61, org.assertj.core.data.Offset.offset(1e-9));
        // The fest EV site ignores a maintained sheet (never double-counted).
        exec("INSERT INTO site_supply_price (site_id, tenant_id, "
                + "netzentgelt_arbeitspreis_ct, ust_pct) VALUES ('"
                + evSite + "', '" + tenantId + "', 7.6, 19.0)");
        ResponseEntity<Map<String, Object>> evSheet = rest.exchange(
                url("/api/v1/admin/sites/" + evSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> evSheetSlots =
                (List<Map<String, Object>>) evSheet.getBody().get("slots");
        assertThat(num(evSheetSlots.get(0), "importPriceCtKwh")).isEqualTo(30.0);
        // fest wins even with a maintained sheet => the flat all-in source.
        assertThat(evSheet.getBody()).containsEntry("priceSource", "fest");

        // ---- Netz-null-Reduzieren: the DERIVED reduce right -------------------
        // The flag is deliberately NOT persisted (like its three siblings), but
        // unlike them its rule reads no price and no lambda - so the diagnostics
        // recompute it EXACTLY from the row's own battery/grid power. Turning
        // slot 2 into a "grid ~ 0" discharge is therefore the whole test.
        exec("UPDATE schedule SET grid_kw = 0.0 WHERE plan_id = "
                + "'bbbbbbbb-0000-0000-0000-000000000002' AND time = '" + slot2 + "'");
        ResponseEntity<Map<String, Object>> limiting = rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> limitSlots =
                (List<Map<String, Object>>) limiting.getBody().get("slots");
        assertThat(limitSlots.get(1)).containsEntry("limitDischargeToLoad", true);
        // The charging slot of the same run stays false - the field is per slot,
        // never a run-level claim.
        assertThat(limitSlots.get(0)).containsEntry("limitDischargeToLoad", false);

        // ---- auth + tenant scoping -------------------------------------------
        // A customer token is refused outright (backend boundary, not UI).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        // An admin WITHOUT a selected tenant sees nothing (RLS default-deny).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        // ...and with the WRONG tenant selected the site stays invisible.
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + dvSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * The run picker is DATE-navigable (Europe/Berlin days): availableRuns
     * lists ONE day's runs (the schedule hypertable keeps every run, so the
     * former newest-30 list only reached ~7.5 h back at the 15-min cadence),
     * the response carries the site's covered run-date range to bound the UI
     * date picker, and the BERLIN midnight decides which day a run belongs
     * to. Seeded across three Berlin days in June (CEST = UTC+2) with a run
     * at exactly 00:00 Berlin as the boundary proof.
     */
    @Test
    void optimizerDiagnosticsRunListIsDateNavigableAcrossBerlinDays() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Optimizer Tage GmbH", "CI").get("id");
        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Tage Anlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // Five runs on three Berlin days (all UTC literals):
        //   2026-06-10 Berlin: 09:00 + 23:45 Berlin  = 07:00Z + 21:45Z
        //   2026-06-11 Berlin: 00:00 Berlin          = 2026-06-10T22:00Z (boundary)
        //   2026-06-15 Berlin: 10:00 + 10:15 Berlin  = 08:00Z + 08:15Z (newest day)
        String[] runs = {"2026-06-10T07:00:00Z", "2026-06-10T21:45:00Z",
                "2026-06-10T22:00:00Z", "2026-06-15T08:00:00Z", "2026-06-15T08:15:00Z"};
        for (String gen : runs) {
            java.time.Instant g = java.time.Instant.parse(gen);
            exec("INSERT INTO schedule (time, tenant_id, site_id, plan_id, generated_at, "
                    + "battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh, cost_eur, "
                    + "baseline_cost_eur) VALUES ('" + g.plusSeconds(900) + "', '" + tenantId
                    + "', '" + siteId + "', 'cccccccc-0000-0000-0000-00000000000"
                    + (java.util.Arrays.asList(runs).indexOf(gen) + 1) + "', '" + g
                    + "', 1, 0, 50, 1, 2, 100, 0.1, 0.2)");
        }

        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);
        String base = url("/api/v1/admin/sites/" + siteId + "/optimizer-diagnostics");

        // Default (no params): the latest run, its day's runs ONLY, plus the
        // full covered run-date range for the picker bounds.
        ResponseEntity<Map<String, Object>> latest = rest.exchange(base, HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(latest.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(latest.getBody()).containsEntry("generatedAt", "2026-06-15T08:15:00Z");
        @SuppressWarnings("unchecked")
        List<Object> latestRuns = (List<Object>) latest.getBody().get("availableRuns");
        assertThat(latestRuns).containsExactly("2026-06-15T08:15:00Z", "2026-06-15T08:00:00Z");
        assertThat(latest.getBody()).containsEntry("availableRunsDate", "2026-06-15");
        assertThat(latest.getBody()).containsEntry("firstRunDate", "2026-06-10");
        assertThat(latest.getBody()).containsEntry("lastRunDate", "2026-06-15");

        // date=2026-06-10: that Berlin day's newest run; the 00:00-Berlin run
        // of the NEXT day (2026-06-10T22:00Z) is excluded by the boundary.
        ResponseEntity<Map<String, Object>> day10 = rest.exchange(base + "?date=2026-06-10",
                HttpMethod.GET, new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(day10.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(day10.getBody()).containsEntry("generatedAt", "2026-06-10T21:45:00Z");
        @SuppressWarnings("unchecked")
        List<Object> day10Runs = (List<Object>) day10.getBody().get("availableRuns");
        assertThat(day10Runs).containsExactly("2026-06-10T21:45:00Z", "2026-06-10T07:00:00Z");
        assertThat(day10.getBody()).containsEntry("availableRunsDate", "2026-06-10");
        assertThat((List<?>) day10.getBody().get("slots")).hasSize(1);

        // date=2026-06-11: exactly the midnight-Berlin run (22:00Z the day before).
        ResponseEntity<Map<String, Object>> day11 = rest.exchange(base + "?date=2026-06-11",
                HttpMethod.GET, new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(day11.getBody()).containsEntry("generatedAt", "2026-06-10T22:00:00Z");
        @SuppressWarnings("unchecked")
        List<Object> day11Runs = (List<Object>) day11.getBody().get("availableRuns");
        assertThat(day11Runs).containsExactly("2026-06-10T22:00:00Z");

        // A day INSIDE the range without runs: 200 with an empty well-formed
        // body (never 404 - gaps inside the covered range are legitimate).
        ResponseEntity<Map<String, Object>> gap = rest.exchange(base + "?date=2026-06-13",
                HttpMethod.GET, new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(gap.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(gap.getBody().get("generatedAt")).isNull();
        assertThat((List<?>) gap.getBody().get("availableRuns")).isEmpty();
        assertThat((List<?>) gap.getBody().get("slots")).isEmpty();
        assertThat(gap.getBody()).containsEntry("availableRunsDate", "2026-06-13");
        assertThat(gap.getBody()).containsEntry("firstRunDate", "2026-06-10");
        assertThat(gap.getBody()).containsEntry("lastRunDate", "2026-06-15");

        // Explicit generatedAt still selects the exact run; without a date
        // param the run list follows THAT run's Berlin day.
        ResponseEntity<Map<String, Object>> exact = rest.exchange(
                base + "?generatedAt=2026-06-10T07:00:00Z", HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(exact.getBody()).containsEntry("generatedAt", "2026-06-10T07:00:00Z");
        assertThat(exact.getBody()).containsEntry("availableRunsDate", "2026-06-10");

        // A malformed date is a 400, never silently ignored.
        assertThat(rest.exchange(base + "?date=morgen", HttpMethod.GET,
                new HttpEntity<>(adminTenant), String.class).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * The optimizer-config panel (design §2.7): effective values merge the
     * platform defaults with the per-site/per-asset overrides; the PUT is
     * full-representation (null clears back to the default) and lands on the
     * exact columns the optimizer reads; an inconsistent SoC band is refused;
     * battery knobs need a battery asset; auth + tenancy as everywhere.
     */
    @Test
    void optimizerConfigMergesDefaultsWithOverridesAndWritesThem() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Optimizer Konfig AG", "CI").get("id");
        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Konfig Anlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 20, 10, 10, 92)");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);
        String configUrl = url("/api/v1/admin/sites/" + siteId + "/optimizer-config");

        // Fresh site: platform defaults, no overrides, effective == defaults.
        ResponseEntity<Map<String, Object>> initial = rest.exchange(configUrl, HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(initial.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(initial.getBody()).containsEntry("hasBattery", true);
        @SuppressWarnings("unchecked")
        Map<String, Object> defaults = (Map<String, Object>) initial.getBody().get("defaults");
        assertThat(num(defaults, "wearCostCtPerKwh")).isEqualTo(4.0);
        assertThat(num(defaults, "socMinPct")).isEqualTo(5.0);
        assertThat(num(defaults, "socMaxPct")).isEqualTo(95.0);
        assertThat(num(defaults, "terminalValueQuantile")).isEqualTo(0.3);
        assertThat(defaults.get("terminalValueCtPerKwh")).isNull();
        @SuppressWarnings("unchecked")
        Map<String, Object> noOverrides = (Map<String, Object>) initial.getBody().get("overrides");
        assertThat(noOverrides.get("wearCostCtPerKwh")).isNull();
        assertThat(noOverrides.get("backupReserveSocPct")).isNull();
        @SuppressWarnings("unchecked")
        Map<String, Object> effective = (Map<String, Object>) initial.getBody().get("effective");
        assertThat(num(effective, "wearCostCtPerKwh")).isEqualTo(4.0);
        assertThat(num(effective, "socMinPct")).isEqualTo(5.0);
        assertThat(num(effective, "socMaxPct")).isEqualTo(95.0);
        assertThat(effective.get("backupReserveSocPct")).isNull();

        // Write overrides; the response and a fresh GET both reflect them.
        ResponseEntity<Map<String, Object>> written = rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("wearCostCtPerKwh", 2.5, "socMinPct", 10,
                        "socMaxPct", 90, "backupReserveSocPct", 30), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(written.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> setEffective = (Map<String, Object>) written.getBody().get("effective");
        assertThat(num(setEffective, "wearCostCtPerKwh")).isEqualTo(2.5);
        assertThat(num(setEffective, "socMinPct")).isEqualTo(10.0);
        assertThat(num(setEffective, "socMaxPct")).isEqualTo(90.0);
        assertThat(num(setEffective, "backupReserveSocPct")).isEqualTo(30.0);
        // ...and they landed on the exact columns the OPTIMIZER reads
        // (inputs.load_battery_sites), not a parallel store.
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'battery' AND wear_cost_ct_per_kwh = 2.5 "
                + "AND soc_min_pct = 10 AND soc_max_pct = 90")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + siteId
                + "' AND backup_reserve_soc_pct = 30")).isEqualTo(1);

        // Full-representation PUT with nothing set CLEARS every override.
        ResponseEntity<Map<String, Object>> cleared = rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of(), adminTenant), new ParameterizedTypeReference<>() {});
        @SuppressWarnings("unchecked")
        Map<String, Object> clearedEffective = (Map<String, Object>) cleared.getBody().get("effective");
        assertThat(num(clearedEffective, "wearCostCtPerKwh")).isEqualTo(4.0);
        assertThat(num(clearedEffective, "socMinPct")).isEqualTo(5.0);
        assertThat(clearedEffective.get("backupReserveSocPct")).isNull();
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId
                + "' AND wear_cost_ct_per_kwh IS NULL AND soc_min_pct IS NULL")).isEqualTo(1);

        // An inconsistent EFFECTIVE band is refused: one-sided min crossing the
        // default max, and an explicit min >= max.
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("socMinPct", 96), adminTenant), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("socMinPct", 50, "socMaxPct", 40), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // A battery-less site refuses battery knobs (409) but takes the
        // site-level reserve; its diagnostics are empty but well-formed.
        String bareSite = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Ohne Speicher", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        String bareUrl = url("/api/v1/admin/sites/" + bareSite + "/optimizer-config");
        assertThat(rest.exchange(bareUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("wearCostCtPerKwh", 3.0), adminTenant), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        ResponseEntity<Map<String, Object>> bare = rest.exchange(bareUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("backupReserveSocPct", 25), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(bare.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(bare.getBody()).containsEntry("hasBattery", false);
        @SuppressWarnings("unchecked")
        Map<String, Object> bareEffective = (Map<String, Object>) bare.getBody().get("effective");
        assertThat(bareEffective.get("wearCostCtPerKwh")).isNull();
        assertThat(num(bareEffective, "backupReserveSocPct")).isEqualTo(25.0);
        ResponseEntity<Map<String, Object>> noPlan = rest.exchange(
                url("/api/v1/admin/sites/" + bareSite + "/optimizer-diagnostics"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(noPlan.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) noPlan.getBody().get("slots")).isEmpty();
        assertThat(noPlan.getBody().get("generatedAt")).isNull();

        // Auth + tenancy: customer 403; admin without/with the wrong tenant 404.
        String demo = token("demo", "demo");
        assertThat(rest.exchange(configUrl, HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("backupReserveSocPct", 1), bearer(demo)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(configUrl, HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("backupReserveSocPct", 1),
                        withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Peak shaving (PS-1/PS-2, V20260716020000) is configured ADMIN-ONLY via
     * optimizer-config (captain decision: vertragsnahe Module richtet
     * VoltPilot ein, nicht der Kunde): the PUT lands on the exact site
     * columns the optimizer reads, the full-representation clear works, the
     * fields are echoed READ-ONLY on the customer SiteDto, and the customer
     * site-update path cannot touch them. Auth + tenancy as everywhere.
     */
    @Test
    void peakShavingModuleIsAdminConfiguredAndEchoedReadOnlyOnTheSite() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Lastspitzen GmbH", "CI").get("id");
        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "RLM Halle", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);
        String configUrl = url("/api/v1/admin/sites/" + siteId + "/optimizer-config");

        // Fresh site: module off, billing period at the 'jahr' default.
        ResponseEntity<Map<String, Object>> initial = rest.exchange(configUrl, HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(initial.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> off = (Map<String, Object>) initial.getBody().get("peakShaving");
        assertThat(off.get("leistungspreisEurKw")).isNull();
        assertThat(off).containsEntry("abrechnungLeistung", "jahr");
        assertThat(off.get("peakReserveSocPct")).isNull();

        // Activate the module (no battery asset needed - the site-level
        // fields are like backupReserveSocPct).
        ResponseEntity<Map<String, Object>> written = rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("leistungspreisEurKw", 120.5,
                        "abrechnungLeistung", "monat", "peakReserveSocPct", 40), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(written.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> on = (Map<String, Object>) written.getBody().get("peakShaving");
        assertThat(num(on, "leistungspreisEurKw")).isEqualTo(120.5);
        assertThat(on).containsEntry("abrechnungLeistung", "monat");
        assertThat(num(on, "peakReserveSocPct")).isEqualTo(40.0);
        // ...and it landed on the exact columns the OPTIMIZER reads
        // (inputs.load_battery_sites), not a parallel store.
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + siteId
                + "' AND leistungspreis_eur_kw = 120.5 AND abrechnung_leistung = 'monat' "
                + "AND peak_reserve_soc_pct = 40")).isEqualTo(1);

        // The customer-facing SiteDto echoes the module READ-ONLY...
        ResponseEntity<List<Map<String, Object>>> sites = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<>() {});
        Map<String, Object> siteDto = sites.getBody().stream()
                .filter(s -> siteId.equals(s.get("id"))).findFirst().orElseThrow();
        assertThat(num(siteDto, "leistungspreisEurKw")).isEqualTo(120.5);
        assertThat(siteDto).containsEntry("abrechnungLeistung", "monat");
        assertThat(num(siteDto, "peakReserveSocPct")).isEqualTo(40.0);
        // ...and the customer site-update path cannot touch it: the fields do
        // not exist on UpdateSiteRequest, so a crafted body is simply ignored.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId), HttpMethod.PUT,
                new HttpEntity<>(Map.of("name", "RLM Halle", "biddingZone", "DE-LU",
                        "leistungspreisEurKw", 0.01, "peakReserveSocPct", 1), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + siteId
                + "' AND leistungspreis_eur_kw = 120.5 AND peak_reserve_soc_pct = 40"))
                .isEqualTo(1);

        // Validation: negative LP, unknown billing period, reserve > 100.
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("leistungspreisEurKw", -1), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("abrechnungLeistung", "quartal"), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("peakReserveSocPct", 101), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Full-representation PUT with nothing set switches the module OFF
        // and resets the billing period to its 'jahr' default.
        ResponseEntity<Map<String, Object>> cleared = rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of(), adminTenant), new ParameterizedTypeReference<>() {});
        @SuppressWarnings("unchecked")
        Map<String, Object> clearedPeak =
                (Map<String, Object>) cleared.getBody().get("peakShaving");
        assertThat(clearedPeak.get("leistungspreisEurKw")).isNull();
        assertThat(clearedPeak).containsEntry("abrechnungLeistung", "jahr");
        assertThat(clearedPeak.get("peakReserveSocPct")).isNull();
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + siteId
                + "' AND leistungspreis_eur_kw IS NULL AND abrechnung_leistung = 'jahr' "
                + "AND peak_reserve_soc_pct IS NULL")).isEqualTo(1);

        // Auth + tenancy: customer 403 on the ONLY writable surface; admin
        // without / with the wrong tenant 404.
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("leistungspreisEurKw", 99), bearer(token("demo", "demo"))),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("leistungspreisEurKw", 99), bearer(admin)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(configUrl, HttpMethod.PUT,
                new HttpEntity<>(Map.of("leistungspreisEurKw", 99),
                        withTenant(bearer(admin), "00000000-0000-0000-0000-000000000001")),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ---- der Prognose-Schalter (Captain-Auftrag 18.08.2026) ------------------

    /**
     * Die PLATTFORM-VORGABE des Prognosemodells als Endpunkt: ein Portal-Admin
     * stellt sie um, die Umstellung trägt ihre Papier-Spur (von-&gt;zu, wer,
     * wann), jede Anlage OHNE eigene Wahl zeigt danach sofort das neue Modell
     * als „live" - und der Rückweg ist derselbe Aufruf in die Gegenrichtung.
     *
     * <p>Der Rollen-Zaun ist Teil desselben Tests, weil er die eigentliche
     * Sicherheits-Aussage ist: die VORGABE gilt für die ganze Flotte, ein Kunde
     * darf sie also nie stellen können. Seine eigene Anlage stellt er über die
     * mandantenbezogene Route {@code /sites/{id}/forecast-models} um (Captain
     * 19.08.2026, bewiesen von {@code PortalApiTest}), und eine Anlage mit
     * EIGENER Wahl folgt der Vorgabe hier ausdrücklich NICHT.
     */
    @Test
    void theForecastPromotionSwitchIsAdminOnlyAuditedAndVisibleToTheCustomer() {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        String url = url("/api/v1/admin/forecast-models");

        // (1) Vor jeder Umstellung: die Umgebung (bzw. der Registry-Default)
        //     entscheidet, und die Fläche SAGT das - „env", nie „portal".
        Map<String, Object> before = getForecastModels(admin);
        List<Map<String, Object>> kinds = kindsOf(before);
        assertThat(kinds).hasSize(2);
        Map<String, Object> load = kindOf(kinds, "load");
        assertThat(load.get("activeModel")).isEqualTo("load-persistence");
        assertThat(load.get("source")).isEqualTo("env");
        assertThat(load.get("envDefault")).isEqualTo("load-persistence");
        assertThat(load.get("setByName")).isNull();
        assertThat(load.get("setAt")).isNull();
        assertThat(load.get("selectable"))
                .isEqualTo(List.of("load-persistence", "load-xgb"));
        assertThat((List<?>) before.get("history")).isEmpty();

        // (2) Der Kunde kommt an die VORGABE nicht heran - weder lesend noch
        //     schreibend (sie gilt der ganzen Flotte). Seine eigene Anlage
        //     stellt er über /sites/{id}/forecast-models um.
        assertThat(rest.exchange(url, HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url, HttpMethod.POST,
                new HttpEntity<>(Map.of("kind", "load", "model", "load-xgb"), bearer(customer)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url, HttpMethod.GET, HttpEntity.EMPTY, String.class)
                .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(queryLong("SELECT count(*) FROM forecast_model_choice")).isZero();

        // (3) Der Klick: der Kandidat übernimmt.
        Map<String, Object> after = promoteModel(admin, "load", "load-xgb");
        Map<String, Object> promoted = kindOf(kindsOf(after), "load");
        assertThat(promoted.get("activeModel")).isEqualTo("load-xgb");
        assertThat(promoted.get("source")).isEqualTo("portal");
        assertThat(promoted.get("envDefault")).isEqualTo("load-persistence");
        assertThat(promoted.get("setByName")).isEqualTo("admin");
        assertThat(promoted.get("setAt")).isNotNull();
        // Die ANDERE Prognoseart bleibt unberührt - ein Schalter je Art.
        assertThat(kindOf(kindsOf(after), "pv").get("activeModel")).isEqualTo("pv-physical");

        // (4) Die Papier-Spur: von->zu, wer, wann - in der Tabelle, die zugleich
        //     der Zustand ist (append-only, deshalb kein zweites Journal).
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> history = (List<Map<String, Object>>) after.get("history");
        assertThat(history).hasSize(1);
        assertThat(history.get(0)).containsEntry("kind", "load")
                .containsEntry("model", "load-xgb")
                .containsEntry("previousModel", "load-persistence")
                .containsEntry("setByName", "admin");
        assertThat(history.get(0).get("setAt")).isNotNull();
        // Der Urheber ist ZUSÄTZLICH das JWT-Subject (die maschinenstabile
        // Identität) - der Anzeige-Name allein wäre keine Papier-Spur.
        assertThat(queryLong(
                "SELECT count(*) FROM forecast_model_choice WHERE set_by <> 'admin'"))
                .isEqualTo(1);

        // (5) Die KUNDEN-Seite folgt sofort: dieselbe Anlage, neues „live".
        Map<String, Object> quality = forecastQuality(customer, BERLIN_SITE);
        assertThat(quality.get("activeLoadModel")).isEqualTo("load-xgb");
        assertThat(quality.get("activePvModel")).isEqualTo("pv-physical");

        // (5b) ... ABER eine Anlage mit EIGENER Wahl bleibt bei ihr. Die
        //      Präzedenz ist Anlage > Plattform, sonst nähme der Betreiber dem
        //      Kunden stillschweigend seine Entscheidung ab.
        exec("INSERT INTO site_forecast_model_choice (site_id, tenant_id, model_kind,"
                + " model_id, previous_model_id, set_by, set_by_name) VALUES ("
                + "'" + BERLIN_SITE + "', '00000000-0000-0000-0000-000000000001',"
                + " 'load', 'load-persistence', 'load-xgb', 'demo', 'demo')");
        assertThat(forecastQuality(customer, BERLIN_SITE).get("activeLoadModel"))
                .isEqualTo("load-persistence");
        exec("DELETE FROM site_forecast_model_choice WHERE site_id = '" + BERLIN_SITE + "'");
        assertThat(forecastQuality(customer, BERLIN_SITE).get("activeLoadModel"))
                .isEqualTo("load-xgb");

        // (6) Derselbe Knopf in die Gegenrichtung - der Rückweg bleibt offen.
        Map<String, Object> reverted = promoteModel(admin, "load", "load-persistence");
        assertThat(kindOf(kindsOf(reverted), "load").get("activeModel"))
                .isEqualTo("load-persistence");
        // ... und bleibt „portal": es IST eine Entscheidung, auch wenn sie
        // zufällig auf denselben Wert wie die Umgebung fällt.
        assertThat(kindOf(kindsOf(reverted), "load").get("source")).isEqualTo("portal");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> history2 = (List<Map<String, Object>>) reverted.get("history");
        assertThat(history2).hasSize(2);
        assertThat(history2.get(0)).containsEntry("model", "load-persistence")
                .containsEntry("previousModel", "load-xgb");
        assertThat(forecastQuality(customer, BERLIN_SITE).get("activeLoadModel"))
                .isEqualTo("load-persistence");

        // (7) Jede Ablehnung ist ein deutscher Satz UND schreibt nichts.
        long rows = queryLong("SELECT count(*) FROM forecast_model_choice");
        assertRefused(admin, Map.of("kind", "load", "model", "pv-physical"),
                HttpStatus.BAD_REQUEST, "andere Prognoseart");
        assertRefused(admin, Map.of("kind", "load", "model", "load_xgb"),
                HttpStatus.BAD_REQUEST, "Unbekanntes Prognosemodell");
        assertRefused(admin, Map.of("kind", "waerme", "model", "load-xgb"),
                HttpStatus.BAD_REQUEST, "Prognoseart");
        assertRefused(admin, Map.of("kind", "load", "model", "load-persistence"),
                HttpStatus.CONFLICT, "plant bereits");
        assertThat(queryLong("SELECT count(*) FROM forecast_model_choice")).isEqualTo(rows);

        exec("DELETE FROM forecast_model_choice");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> getForecastModels(String adminToken) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/forecast-models"), HttpMethod.GET,
                new HttpEntity<>(bearer(adminToken)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private Map<String, Object> promoteModel(String adminToken, String kind, String model) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/forecast-models"), HttpMethod.POST,
                new HttpEntity<>(Map.of("kind", kind, "model", model), bearer(adminToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private void assertRefused(
            String adminToken, Map<String, ?> body, HttpStatus status, String needle) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/forecast-models"), HttpMethod.POST,
                new HttpEntity<>(body, bearer(adminToken)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(status);
        assertThat(String.valueOf(res.getBody().get("message"))).contains(needle);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> kindsOf(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("kinds");
    }

    private static Map<String, Object> kindOf(List<Map<String, Object>> kinds, String kind) {
        return kinds.stream().filter(k -> kind.equals(k.get("kind"))).findFirst().orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> forecastQuality(String token, String siteId) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/forecast-quality"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    // ---- helpers ------------------------------------------------------------

    /**
     * E1a pilot mapping: the admin bootstrap composes the three pilot entity
     * types from a v1 site's existing asset/measurement_point master data -
     * idempotently, admin-only, tenant-fenced - and the v1 customer surface
     * cannot delete the platform-managed battery-hybrid control row.
     */
    @Test
    @SuppressWarnings("unchecked")
    void v2EntityBootstrapCreatesPilotEntitiesFromV1MasterData() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Entitaeten GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Pilotanlage", "biddingZone", "DE-LU",
                        "netzladenErlaubt", true), bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // v1 master data: a battery asset (the future battery-hybrid entity),
        // a claimed gateway device (auto-links to the battery), and the two
        // customer-recorded source points (producer + grid meter).
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 65, 30, 30, 92)");
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "entity-rig-01"),
                        adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String deviceId = (String) claim.getBody().get("id");
        rest.exchange(url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "pv-generation", "label", "AC-PV",
                        "capacityKwp", 27), adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        rest.exchange(url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "grid-meter", "label", "Netzanschluss"),
                        adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});

        // Bootstrap: three pilot entities from the v1 rows.
        ResponseEntity<Map<String, Object>> boot = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"), HttpMethod.POST,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(boot.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> entities =
                (List<Map<String, Object>>) boot.getBody().get("entities");
        // MIG: the site already HAS a grid-meter point, so only the Hausverbrauch
        // is synthesized from the gateway (§2.4); the pv ASSET never composes a
        // producer - the one here comes from the pv-generation POINT (§2.2).
        assertThat(entities).extracting(e -> e.get("entityType"))
                .containsExactlyInAnyOrder("battery-hybrid", "producer", "grid-meter",
                        "house-load");

        Map<String, Object> battery = entities.stream()
                .filter(e -> "battery-hybrid".equals(e.get("entityType"))).findFirst().orElseThrow();
        assertThat(battery.get("deviceId")).as("gateway = the auto-linked device")
                .isEqualTo(deviceId);
        Map<String, Object> batteryGuards = (Map<String, Object>) battery.get("guards");
        Map<String, Object> batteryLimits = (Map<String, Object>) batteryGuards.get("limits");
        assertThat(num(batteryLimits, "max_charge_kw")).isEqualTo(30.0);
        assertThat(num(batteryLimits, "max_discharge_kw")).isEqualTo(30.0);
        assertThat(num(batteryLimits, "soc_min_pct")).isEqualTo(5.0); // platform default
        assertThat(num(batteryLimits, "soc_max_pct")).isEqualTo(95.0);
        assertThat(batteryLimits.get("charge_from_grid_allowed"))
                .as("mirrors site.netzladen_erlaubt").isEqualTo(true);
        assertThat(((Map<String, Object>) batteryGuards.get("failsafe")).get("behavior"))
                .isEqualTo("self-consumption");

        Map<String, Object> producer = entities.stream()
                .filter(e -> "producer".equals(e.get("entityType"))).findFirst().orElseThrow();
        Map<String, Object> producerGuards = (Map<String, Object>) producer.get("guards");
        assertThat(num((Map<String, Object>) producerGuards.get("limits"), "max_generation_kw"))
                .isEqualTo(27.0);
        assertThat(((Map<String, Object>) producerGuards.get("failsafe")).get("behavior"))
                .isEqualTo("release");

        Map<String, Object> meter = entities.stream()
                .filter(e -> "grid-meter".equals(e.get("entityType"))).findFirst().orElseThrow();
        Map<String, Object> meterGuards = (Map<String, Object>) meter.get("guards");
        assertThat(((Map<String, Object>) meterGuards.get("failsafe")).get("behavior"))
                .isEqualTo("measure-only");
        assertThat(((Map<String, Object>) meter.get("capabilities")).get("actuate"))
                .as("a grid meter is measure-only").isNull();

        // Push is honest about the missing broker in this context (no MQTT).
        Map<String, Object> push = (Map<String, Object>) boot.getBody().get("push");
        assertThat(push.get("published")).isEqualTo(false);
        assertThat(push.get("reason")).isEqualTo("mqtt_not_configured");

        // Idempotent: a re-run refreshes the SAME rows (still exactly four).
        ResponseEntity<Map<String, Object>> again = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"), HttpMethod.POST,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        List<Map<String, Object>> entitiesAgain =
                (List<Map<String, Object>>) again.getBody().get("entities");
        assertThat(entitiesAgain).hasSize(4);
        assertThat(entitiesAgain).extracting(e -> e.get("id"))
                .containsExactlyInAnyOrderElementsOf(
                        entities.stream().map(e -> e.get("id")).toList());

        // The battery-hybrid registry row is platform-managed: the v1 customer
        // delete path refuses it (409), while source rows stay deletable.
        String batteryPointId = (String) battery.get("id");
        ResponseEntity<String> refuse = rest.exchange(
                url("/api/v1/sites/" + siteId + "/measurement-points/" + batteryPointId),
                HttpMethod.DELETE, new HttpEntity<>(adminTenant), String.class);
        assertThat(refuse.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Tenant fencing + role gate: wrong tenant selected => 404; a customer
        // token gets 403 on the admin route.
        String otherTenant = (String) createTenant(admin, "Fremdentitaet AG", "CI").get("id");
        ResponseEntity<String> wrongTenant = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"), HttpMethod.POST,
                new HttpEntity<>(withTenant(bearer(admin), otherTenant)), String.class);
        assertThat(wrongTenant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        ResponseEntity<String> customer = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(customer.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    /**
     * MIG §2 + §6 + §7 on a REAL v1 site (the shape of every existing plant:
     * battery asset + pv asset + one claimed device + ZERO measurement points):
     *
     * <ul>
     *   <li>the automatic backfill composes <b>battery-hybrid + grid-meter +
     *       house-load</b> - Netz and Haus SYNTHESIZED from the gateway, so the
     *       Energiefluss has all four nodes;</li>
     *   <li>the pv ASSET composes <b>no producer</b> - the hybrid already
     *       carries {@code pv_power_kw} and the topology sums per role, so a
     *       second PV member would double-count (measured 5,85 -> 11,7 kW);</li>
     *   <li>the synthesized rows are <b>measure-only</b> (no actuate,
     *       control=false) - nothing composed can reach a device;</li>
     *   <li>the v1 master data is <b>untouched</b> (asset.pv_capacity_kwp);</li>
     *   <li>a <b>device-less</b> site is skipped and NOT marked, so it is
     *       retried after a claim (Mienbach, §7);</li>
     *   <li>the run is <b>idempotent</b>, and the marker makes a <b>rollback
     *       stick</b> - deleting the entities is not re-migrated.</li>
     * </ul>
     */
    @Test
    @SuppressWarnings("unchecked")
    void automaticBackfillComposesGridAndHouseFromTheGatewayAndIsGuardedAndReversible() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Backfill GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Auernheim", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        // Exactly the real-world v1 shape: a battery AND a pv asset, one device.
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 13.8, 12, 12, 92)");
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES ('"
                + tenantId + "', '" + siteId + "', 'pv', 12.9)");
        String deviceId = (String) rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "backfill-rig-01"),
                        adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // A second site of the same tenant with NO device at all (Mienbach).
        String deviceLessSiteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Mienbach", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw) VALUES ('" + tenantId + "', '" + deviceLessSiteId
                + "', 'battery', 5.9, 1.8, 1.8)");

        // The runner already ran at boot, so these two sites are unmarked and
        // pending - run it exactly as ApplicationReadyEvent would.
        backfillRunner.run();

        List<Map<String, Object>> entities = (List<Map<String, Object>>) rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody();
        assertThat(entities).extracting(e -> e.get("entityType"))
                .as("Netz + Haus synthesized; the pv ASSET composes NO producer")
                .containsExactlyInAnyOrder("battery-hybrid", "grid-meter", "house-load");

        for (String type : List.of("grid-meter", "house-load")) {
            Map<String, Object> row = entities.stream()
                    .filter(e -> type.equals(e.get("entityType"))).findFirst().orElseThrow();
            assertThat(row.get("deviceId")).as(type + " measures through the gateway")
                    .isEqualTo(deviceId);
            Map<String, Object> caps = (Map<String, Object>) row.get("capabilities");
            assertThat(caps.get("actuate")).as(type + " is measure-only").isNull();
            assertThat((List<Map<String, Object>>) caps.get("measure"))
                    .extracting(m -> m.get("channel")).containsExactly("power_kw");
            assertThat(((Map<String, Object>) ((Map<String, Object>) row.get("guards"))
                    .get("failsafe")).get("behavior")).isEqualTo("measure-only");
            // control = FALSE in the row itself: nothing composed here can ever
            // carry a command to a device (the DB CHECK enforces it too).
            assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE id = '"
                    + row.get("id") + "' AND control = FALSE")).isEqualTo(1);
        }

        // The topology the portal renders: all four nodes exist.
        Map<String, Object> topology = (Map<String, Object>) rest.exchange(
                url("/api/v1/sites/" + siteId + "/topology"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody()
                .get("topology");
        assertThat((List<Map<String, Object>>) topology.get("nodes"))
                .extracting(n -> n.get("role"))
                .containsExactly("pv", "storage", "consumer", "grid");
        assertThat((List<Map<String, Object>>) ((List<Map<String, Object>>) topology.get("nodes"))
                .get(0).get("members"))
                .as("exactly ONE PV member - the hybrid; no asset-composed producer")
                .hasSize(1);

        // Safety envelope: v1 master data untouched.
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv' AND pv_capacity_kwp = 12.9")).isEqualTo(1);

        // §7: the device-less site is SKIPPED and NOT marked (it retries later).
        assertThat((List<Map<String, Object>>) rest.exchange(
                url("/api/v1/admin/sites/" + deviceLessSiteId + "/v2-entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody())
                .as("a device-less plant keeps its honest v1 onboarding face").isEmpty();
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + deviceLessSiteId
                + "' AND v2_backfilled_at IS NULL")).isEqualTo(1);
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + siteId
                + "' AND v2_backfilled_at IS NOT NULL")).isEqualTo(1);

        // Idempotent: a second run composes nothing new.
        backfillRunner.run();
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "'")).isEqualTo(3);

        // Reversible AND sticky: delete the entities -> the site is v1 again,
        // and a further run does NOT silently re-migrate it (the marker holds).
        exec("DELETE FROM measurement_point WHERE site_id = '" + siteId + "'");
        backfillRunner.run();
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "'")).as("rollback sticks").isZero();

        // Clearing the marker is how an operator deliberately re-arms one site.
        exec("UPDATE site SET v2_backfilled_at = NULL WHERE id = '" + siteId + "'");
        backfillRunner.run();
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "'")).isEqualTo(3);
    }

    /**
     * <b>Das Anlagen-Modell füllt sich von selbst - NULL Nutzer-Schritte,
     * weder Kunde noch Admin</b> (Captain-Order 10.08.2026: „der hat den Deye
     * schon auf der Edge Seite angelegt, der sollte sich beim Portal schon
     * automatisch melden").
     *
     * <p>Der Live-Befund war „Mienbach": eine fertig gekoppelte Neuanlage
     * (Telemetrie floss, Fahrplan lief) zeigte dauerhaft „Noch keine
     * Komponenten. Sobald Ihr Gerät sich meldet, erscheint hier, wie Ihre
     * Anlage verschaltet ist." - ein Versprechen, das die Plattform nicht
     * halten konnte: die Komposition hing am platform-admin-gated Bootstrap
     * bzw. am einmaligen Lauf beim api-Start.
     *
     * <p>Bewiesen werden hier die drei Auslöser und ihre Wächter:
     * <ul>
     *   <li><b>Claim</b> - ein KUNDE (Rolle {@code operator}, kein Admin,
     *       kein {@code X-Tenant-Id}) beansprucht sein Gerät und liest
     *       unmittelbar danach ein vollständiges Modell;</li>
     *   <li><b>Selbstheilung</b> - eine BESTANDSanlage (Gerät längst
     *       verbunden, Komposition nie gelaufen) wird vom Takt genau EINMAL
     *       komponiert, ohne Deploy und ohne Klick;</li>
     *   <li><b>Speicher danach</b> - eine Anlage, die ihr Gerät VOR dem
     *       Speicher bekam, bleibt nicht halb komponiert;</li>
     *   <li><b>Ehrlichkeit</b> - eine Anlage ohne eindeutiges Gateway bleibt
     *       still und ungestempelt, und nichts davon weicht RLS auf.</li>
     * </ul>
     */
    @Test
    @SuppressWarnings("unchecked")
    void theAnlagenModellComposesItselfOnClaimAndHealsAnExistingPlantWithoutAnyHumanStep() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Selbstbau GmbH", "B2C").get("id");
        createUser(admin, tenantId, "selbstbau-kunde", "kunde@selbstbau.example", "kunde-pw-123");
        // Ab hier spricht der KUNDE - operator-Rolle, Mandant aus dem Token,
        // kein Umschalter-Header, kein einziger /admin/**-Aufruf.
        HttpHeaders kunde = bearer(token("selbstbau-kunde", "kunde-pw-123"));

        // (1) Claim-Auslöser: der Kunde legt seine Anlage an, trägt Speicher +
        // PV ein und verbindet sein Gerät - der normale Assistenten-Weg.
        String claimSite = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Neubau Mienbach", "biddingZone", "DE-LU"), kunde),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + claimSite + "', 'battery', 30, 15, 15, 92)");
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES ('"
                + tenantId + "', '" + claimSite + "', 'pv', 29.9)");

        assertThat(customerEntities(kunde, claimSite))
                .as("vor dem Gerät gibt es ehrlich nichts zu zeigen").isEmpty();

        rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", claimSite, "externalRef", "selbstbau-deye-01"),
                        kunde),
                new ParameterizedTypeReference<Map<String, Object>>() {});

        assertThat(customerEntities(kunde, claimSite))
                .as("der Claim allein komponiert das Modell - kein Admin, kein Neustart, "
                        + "kein Takt")
                .containsExactlyInAnyOrder("battery-hybrid", "grid-meter", "house-load");

        // (2) Der Bestandsfall „Mienbach": Gerät längst verbunden (hier per
        // Superuser eingesetzt, damit KEIN Claim-Auslöser feuert - genau der
        // Zustand einer Anlage, die vor diesem Umbau verbunden wurde), Modell
        // leer. Bis hierher hätte nur ein Deploy oder ein Admin geholfen.
        String bestand = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Bestand Mienbach", "biddingZone", "DE-LU"), kunde),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw) VALUES ('" + tenantId + "', '" + bestand + "', 'battery', "
                + "13.8, 12, 12)");
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + UUID.randomUUID() + "', '" + tenantId + "', '" + bestand
                + "', 'edge-vv6yx5m', 'inverter')");
        assertThat(customerEntities(kunde, bestand)).as("der gemeldete Zustand").isEmpty();

        // Der getaktete Abgleich fährt GENAU DIESEN Lauf (der Takt selbst ist in
        // V2SiteBackfillRunnerTest verdrahtungsgenau geprüft und im Testlauf
        // ausgeschaltet - siehe pom.xml).
        backfillRunner.run();

        assertThat(customerEntities(kunde, bestand))
                .as("die Bestandsanlage heilt sich über den Takt - ohne Deploy, ohne Klick")
                .containsExactlyInAnyOrder("battery-hybrid", "grid-meter", "house-load");
        // Mandanten-Korrektheit: geschrieben wurde unter dem Mandanten der
        // Anlage (RLS ist der Zaun, nicht BYPASSRLS).
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + bestand
                + "' AND tenant_id = '" + tenantId + "'")).isEqualTo(3);

        // GENAU EINMAL: ein zweiter Takt komponiert nichts nach.
        backfillRunner.run();
        assertThat(queryLong("SELECT count(*) FROM measurement_point WHERE site_id = '" + bestand
                + "'")).as("idempotent").isEqualTo(3);

        // (3) Speicher NACH dem Gerät: bis zum Speicher trägt die Anlage nur
        // die aus dem Gateway synthetisierten Zeilen - danach ist sie komplett.
        String spaeter = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Speicher kommt später", "biddingZone", "DE-LU"),
                        kunde),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", spaeter, "externalRef", "selbstbau-deye-02"),
                        kunde),
                new ParameterizedTypeReference<Map<String, Object>>() {});
        assertThat(customerEntities(kunde, spaeter))
                .as("ohne Speicher-Stammdaten wird keine Speicher-Zeile erfunden")
                .containsExactlyInAnyOrder("grid-meter", "house-load");

        rest.exchange(url("/api/v1/sites/" + spaeter + "/battery"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("capacityKwh", 13.8, "maxChargeKw", 12,
                        "maxDischargeKw", 12), kunde),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        assertThat(customerEntities(kunde, spaeter))
                .as("der Speicher-Schreibpfad vervollständigt die Komposition")
                .containsExactlyInAnyOrder("battery-hybrid", "grid-meter", "house-load");

        // (4) Ehrlichkeit: eine Anlage ohne Gerät bekommt NICHTS - weder eine
        // Komposition (das ersetzte ihren Einrichtungs-Wegweiser durch einen
        // leeren Energiefluss) noch einen Stempel, sie wird also später erneut
        // betrachtet.
        String ohneGeraet = (String) rest.exchange(url("/api/v1/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Wartet auf Gerät", "biddingZone", "DE-LU"), kunde),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw) VALUES ('" + tenantId + "', '" + ohneGeraet + "', 'battery', "
                + "5.9, 1.8, 1.8)");
        backfillRunner.run();
        assertThat(customerEntities(kunde, ohneGeraet)).isEmpty();
        assertThat(queryLong("SELECT count(*) FROM site WHERE id = '" + ohneGeraet
                + "' AND v2_backfilled_at IS NULL")).as("nicht gestempelt = wird erneut betrachtet")
                .isEqualTo(1);

        // RLS bleibt der Zaun: ein FREMDER Mandant sieht keine dieser Zeilen.
        String fremd = (String) createTenant(admin, "Fremd GmbH", "B2C").get("id");
        createUser(admin, fremd, "fremd-kunde", "kunde@fremd.example", "fremd-pw-123");
        assertThat(rest.exchange(url("/api/v1/sites/" + bestand + "/entities"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("fremd-kunde", "fremd-pw-123"))), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /** Die Entitätstypen, die der KUNDE auf seiner eigenen Anlage sieht. */
    @SuppressWarnings("unchecked")
    private List<String> customerEntities(HttpHeaders customer, String siteId) {
        Map<String, Object> body = rest.exchange(url("/api/v1/sites/" + siteId + "/entities"),
                HttpMethod.GET, new HttpEntity<>(customer),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        return ((List<Map<String, Object>>) body.get("entities")).stream()
                .map(e -> (String) e.get("entityType")).toList();
    }

    private static double num(Map<String, Object> map, String key) {
        Object v = map.get(key);
        assertThat(v).as("numeric field '" + key + "'").isInstanceOf(Number.class);
        return ((Number) v).doubleValue();
    }

    /**
     * MIG conversion preview (migration runbook step 1): the read-only dry-run
     * reports EXACTLY what bootstrap would create - the three pilot entities,
     * their derived roles, the resolved gateway - WITHOUT writing anything (the
     * v2-entities list stays empty until apply). Applying then matches the
     * preview and flips the actions to "refresh". The per-site history cutover
     * (the bridge seam) is set and cleared through the admin endpoints.
     */
    @Test
    @SuppressWarnings("unchecked")
    void v2ConversionPreviewMatchesBootstrapWithoutWritingAndCutoverIsControllable() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Migration GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Bestandsanlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 40, 20, 20, 95)");
        // Das Gerät wird per Superuser eingesetzt, damit der CLAIM-Auslöser
        // NICHT feuert: die Vorschau ist das Werkzeug für eine Anlage, die noch
        // NICHT konvertiert ist - also genau eine Bestandsanlage, die vor der
        // automatischen Komposition verbunden wurde.
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + UUID.randomUUID() + "', '" + tenantId + "', '" + siteId
                + "', 'mig-rig-01', 'inverter')");
        rest.exchange(url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "pv-generation", "label", "AC-PV",
                        "capacityKwp", 18), adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        rest.exchange(url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "grid-meter", "label", "Netz"), adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});

        // Preview: reports the three pilot entities + derived roles, NO write.
        Map<String, Object> preview = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/preview"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        assertThat(preview.get("alreadyConverted")).isEqualTo(false);
        assertThat(preview.get("gatewayDevice")).as("das EINE Gerät der Anlage").isNotNull();
        List<Map<String, Object>> plan = (List<Map<String, Object>>) preview.get("plan");
        // MIG: the preview twin must announce the synthesized Hausverbrauch too,
        // or it would lie about what the conversion does.
        assertThat(plan).extracting(p -> p.get("entityType"))
                .containsExactlyInAnyOrder("battery-hybrid", "producer", "grid-meter",
                        "house-load");
        assertThat(plan).allSatisfy(p -> assertThat(p.get("action")).isEqualTo("create"));
        assertThat((List<String>) plan.stream()
                .filter(p -> "house-load".equals(p.get("entityType"))).findFirst().orElseThrow()
                .get("roles")).as("Haus = Verbraucher-Knoten").containsExactly("consumer");
        Map<String, Object> plannedBattery = plan.stream()
                .filter(p -> "battery-hybrid".equals(p.get("entityType"))).findFirst().orElseThrow();
        assertThat((List<String>) plannedBattery.get("roles"))
                .as("a hybrid maps to PV + Speicher").containsExactly("pv", "storage");
        assertThat((List<String>) plan.stream()
                .filter(p -> "grid-meter".equals(p.get("entityType"))).findFirst().orElseThrow()
                .get("roles")).containsExactly("grid");

        // The preview wrote nothing: the site still has zero v2 entities.
        assertThat((List<Map<String, Object>>) rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody()).isEmpty();

        // Apply: creates exactly what the preview promised.
        List<Map<String, Object>> created = (List<Map<String, Object>>) rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"), HttpMethod.POST,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("entities");
        assertThat(created).extracting(e -> e.get("entityType"))
                .containsExactlyInAnyOrder("battery-hybrid", "producer", "grid-meter",
                        "house-load");

        // Preview after apply: idempotent - now "refresh", alreadyConverted.
        Map<String, Object> again = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/preview"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody();
        assertThat(again.get("alreadyConverted")).isEqualTo(true);
        assertThat((List<Map<String, Object>>) again.get("plan"))
                .allSatisfy(p -> assertThat(p.get("action")).isEqualTo("refresh"));

        // History cutover: null -> set -> cleared (the bridge control + rollback).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/history-cutover"),
                HttpMethod.GET, new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("cutoverAt"))
                .isNull();
        Object setAt = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/history-cutover"),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("at", "2026-05-20T09:00:00Z"), adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("cutoverAt");
        assertThat(setAt).isEqualTo("2026-05-20T09:00:00Z");
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/history-cutover"),
                HttpMethod.DELETE, new HttpEntity<>(adminTenant), Void.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/history-cutover"),
                HttpMethod.GET, new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("cutoverAt"))
                .isNull();

        // Tenant fencing: a foreign tenant selection sees neither preview nor cutover.
        String otherTenant = (String) createTenant(admin, "Fremd AG", "CI").get("id");
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/preview"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), otherTenant)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * AE1 Anlagen-Topologie-Read-Model: a hybrid entity (Deye: PV+Speicher) and
     * a pure producer (Fronius: PV) plus the grid-meter at one site produce a
     * topology where PV-Erzeugung aggregates the hybrid's PV + the producer,
     * Speicher = the battery, Netz = the grid measurement flagged maßgeblich -
     * via GET /sites/{id}/topology; the capability→role assignment is settable
     * by the admin; RLS fences it. Live values come from telemetry_v2.
     */
    @Test
    @SuppressWarnings("unchecked")
    void topologyReadModelAggregatesRolesFromV2EntitiesAndAssignmentIsSettable() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Topologie GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Pilotanlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 65, 30, 30, 92)");
        String deviceId = (String) rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "topo-rig-01"), adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        rest.exchange(url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "pv-generation", "label", "Fronius Eco 27",
                        "capacityKwp", 27), adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        rest.exchange(url("/api/v1/sites/" + siteId + "/measurement-points"), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "grid-meter", "label", "Netzanschluss"), adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {});
        List<Map<String, Object>> entities = (List<Map<String, Object>>) rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"), HttpMethod.POST,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<Map<String, Object>>() {})
                .getBody().get("entities");
        String batteryId = entityId(entities, "battery-hybrid");
        String producerId = entityId(entities, "producer");
        String gridId = entityId(entities, "grid-meter");

        // Live per-entity values (telemetry_v2, seeded as superuser).
        seedV2(tenantId, siteId, deviceId, batteryId, "soc_pct", 62.5);
        seedV2(tenantId, siteId, deviceId, batteryId, "battery_power_kw", 12.4);
        seedV2(tenantId, siteId, deviceId, batteryId, "pv_power_kw", 18.9);
        seedV2(tenantId, siteId, deviceId, producerId, "pv_power_kw", 44.2);
        seedV2(tenantId, siteId, deviceId, gridId, "power_kw", -49.7);

        Map<String, Object> topo = getTopology(siteId, adminTenant);
        assertThat(topo.get("schemaVersion")).isEqualTo("1.0");

        // The entity graph carries the resolved role + primary + value per capability.
        List<Map<String, Object>> ents = (List<Map<String, Object>>) topo.get("entities");
        // Since MIG the bootstrap also synthesizes the Hausverbrauch from the
        // gateway (it has no reading here, so its consumer node stays valueless).
        assertThat(ents).hasSize(4);
        Map<String, Object> gridPow = capability(ents, gridId, "power_kw");
        assertThat(gridPow.get("role")).isEqualTo("grid");
        assertThat(gridPow.get("primary")).as("the sole grid measurement is maßgeblich")
                .isEqualTo(true);
        assertThat(capability(ents, batteryId, "pv_power_kw").get("role"))
                .as("the hybrid's PV channel contributes to the PV role").isEqualTo("pv");
        assertThat(capability(ents, batteryId, "soc_pct").get("role")).isEqualTo("storage");

        // The derived hub topology: PV aggregates hybrid+producer, storage = the
        // battery, grid = the maßgebliche meter.
        Map<String, Object> nodes = topologyNodes(topo);
        Map<String, Object> pv = (Map<String, Object>) nodes.get("pv");
        assertThat(num(pv, "value_kw")).isEqualTo(63.1); // 18.9 + 44.2
        assertThat(pv.get("direction")).isEqualTo("in");
        assertThat((List<?>) pv.get("members")).hasSize(2);
        Map<String, Object> storage = (Map<String, Object>) nodes.get("storage");
        assertThat(num(storage, "soc_pct")).isEqualTo(62.5);
        assertThat(num(storage, "value_kw")).isEqualTo(12.4);
        assertThat(storage.get("direction")).isEqualTo("out"); // charging
        Map<String, Object> grid = (Map<String, Object>) nodes.get("grid");
        assertThat(num(grid, "value_kw")).isEqualTo(49.7);
        assertThat(grid.get("direction")).isEqualTo("out"); // export
        List<Map<String, Object>> gridMembers = (List<Map<String, Object>>) grid.get("members");
        assertThat(gridMembers).singleElement().satisfies(
                m -> assertThat(m.get("primary")).isEqualTo(true));

        // Assignment is settable: re-assign the producer's PV to the consumer
        // role -> PV loses it, a consumer node appears.
        Map<String, Object> reassigned = putRoles(siteId, adminTenant, Map.of(
                "assignments", List.of(Map.of("entityId", producerId, "channel", "pv_power_kw",
                        "role", "consumer", "primary", false))));
        Map<String, Object> nodes2 = topologyNodes(reassigned);
        assertThat(num((Map<String, Object>) nodes2.get("pv"), "value_kw")).isEqualTo(18.9);
        assertThat(num((Map<String, Object>) nodes2.get("consumer"), "value_kw")).isEqualTo(44.2);
        assertThat(((Map<String, Object>) nodes2.get("consumer")).get("direction")).isEqualTo("out");

        // Clearing the override (blank role) reverts to the DefaultRole mapping.
        Map<String, Object> cleared = putRoles(siteId, adminTenant, Map.of(
                "assignments", List.of(Map.of("entityId", producerId, "channel", "pv_power_kw",
                        "role", ""))));
        assertThat(num((Map<String, Object>) topologyNodes(cleared).get("pv"), "value_kw"))
                .isEqualTo(63.1);

        // Validation + authorization.
        ResponseEntity<String> badRole = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of(Map.of("entityId", producerId,
                        "channel", "pv_power_kw", "role", "wolke"))), adminTenant), String.class);
        assertThat(badRole.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        ResponseEntity<String> foreignEntity = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of(Map.of("entityId",
                        UUID.randomUUID().toString(), "channel", "power_kw", "role", "grid"))),
                        adminTenant), String.class);
        assertThat(foreignEntity.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        ResponseEntity<String> customerPut = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("assignments", List.of()), bearer(token("demo", "demo"))),
                String.class);
        assertThat(customerPut.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        // RLS: a foreign customer and a wrong-tenant admin switcher get 404.
        ResponseEntity<String> foreignCustomer = rest.exchange(
                url("/api/v1/sites/" + siteId + "/topology"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(foreignCustomer.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        String otherTenant = (String) createTenant(admin, "Fremd-Topo AG", "CI").get("id");
        ResponseEntity<String> wrongTenant = rest.exchange(
                url("/api/v1/sites/" + siteId + "/topology"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(admin), otherTenant)), String.class);
        assertThat(wrongTenant.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // A site with no v2 entities: a well-formed empty read-model.
        String freshSite = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Leer", "biddingZone", "DE-LU"), bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        Map<String, Object> empty = getTopology(freshSite, adminTenant);
        assertThat((List<?>) empty.get("entities")).isEmpty();
        assertThat((List<?>) ((Map<String, Object>) empty.get("topology")).get("nodes")).isEmpty();
    }

    private static String entityId(List<Map<String, Object>> entities, String type) {
        return entities.stream().filter(e -> type.equals(e.get("entityType")))
                .map(e -> (String) e.get("id")).findFirst().orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> capability(List<Map<String, Object>> entities,
            String entityId, String channel) {
        for (Map<String, Object> e : entities) {
            if (!entityId.equals(e.get("id"))) {
                continue;
            }
            for (Map<String, Object> c : (List<Map<String, Object>>) e.get("capabilities")) {
                if (channel.equals(c.get("channel"))) {
                    return c;
                }
            }
        }
        throw new AssertionError("capability " + channel + " of entity " + entityId + " not found");
    }

    /** Index the topology's nodes by role for easy lookup. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> topologyNodes(Map<String, Object> topologyResponse) {
        Map<String, Object> topology = (Map<String, Object>) topologyResponse.get("topology");
        Map<String, Object> byRole = new java.util.LinkedHashMap<>();
        for (Map<String, Object> node : (List<Map<String, Object>>) topology.get("nodes")) {
            byRole.put((String) node.get("role"), node);
        }
        return byRole;
    }

    private Map<String, Object> getTopology(String siteId, HttpHeaders headers) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/sites/" + siteId + "/topology"), HttpMethod.GET,
                new HttpEntity<>(headers), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private Map<String, Object> putRoles(String siteId, HttpHeaders headers, Map<String, Object> body) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/topology-roles"), HttpMethod.PUT,
                new HttpEntity<>(body, headers), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** Seed one telemetry_v2 sample (superuser, RLS-bypassing). */
    private static void seedV2(String tenantId, String siteId, String deviceId, String entityId,
            String channel, double value) {
        exec("INSERT INTO telemetry_v2 (time, received_at, tenant_id, site_id, device_id, "
                + "entity_id, channel, value) VALUES (now(), now(), '" + tenantId + "', '" + siteId
                + "', '" + deviceId + "', '" + entityId + "', '" + channel + "', " + value + ")");
    }

    @Test
    @SuppressWarnings("unchecked")
    void adminManagesOpenEntityTypesAndSollIstDriftSurfaces() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Entitaeten E1b GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "E1b-Anlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 65, 30, 30, 92)");
        String deviceId = (String) rest.exchange(
                url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "e1b-rig-01"),
                        adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        rest.exchange(url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"),
                HttpMethod.POST, new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {});

        // The data-driven type catalog is served to the admin editor.
        ResponseEntity<Map<String, Object>> cat = rest.exchange(
                url("/api/v1/admin/entity-type-catalog"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(cat.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> types = (List<Map<String, Object>>) cat.getBody().get("types");
        Map<String, Object> wallboxType = types.stream()
                .filter(t -> "wallbox".equals(t.get("type"))).findFirst().orElseThrow();
        assertThat(wallboxType.get("label")).isEqualTo("Wallbox");
        assertThat(wallboxType.get("controllable")).isEqualTo(true);

        // Create a wallbox entity - the SECOND control point of the site next
        // to the battery-hybrid row, which the dropped one-control-per-site
        // index would have refused before E1b.
        ResponseEntity<Map<String, Object>> created = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities"), HttpMethod.POST,
                new HttpEntity<>(Map.of("entityType", "wallbox", "label", "Wallbox Carport",
                        "maxPowerKw", 11), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.OK);
        String wallboxId = (String) created.getBody().get("id");
        Map<String, Object> wbGuards = (Map<String, Object>) created.getBody().get("guards");
        assertThat(num((Map<String, Object>) wbGuards.get("limits"), "max_consumption_kw"))
                .isEqualTo(11.0);
        assertThat(((Map<String, Object>) wbGuards.get("failsafe")).get("behavior"))
                .isEqualTo("release");
        List<Map<String, Object>> actuate = (List<Map<String, Object>>)
                ((Map<String, Object>) created.getBody().get("capabilities")).get("actuate");
        Map<String, Object> setpoint = actuate.stream()
                .filter(a -> "setpoint_kw".equals(a.get("command"))).findFirst().orElseThrow();
        assertThat(num(setpoint, "max")).isEqualTo(11.0);

        // Catalog-driven refusals: unknown type 400; a composed pilot type is
        // not directly creatable (422) and its guard config not editable (422).
        assertThat(rest.exchange(url("/api/v1/admin/sites/" + siteId + "/v2-entities"),
                HttpMethod.POST, new HttpEntity<>(Map.of("entityType", "toaster"), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(rest.exchange(url("/api/v1/admin/sites/" + siteId + "/v2-entities"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("entityType", "battery-hybrid"), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        String batteryId = (String) rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody().stream()
                .filter(e -> "battery-hybrid".equals(e.get("entityType")))
                .map(e -> (String) e.get("id")).findFirst().orElseThrow();
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + batteryId),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("guards", Map.of("failsafe", Map.of("behavior", "off"))),
                        adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // Guard-config edit on the open type: valid replaces, garbage is 400.
        ResponseEntity<Map<String, Object>> edited = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + wallboxId),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("guards", Map.of(
                        "limits", Map.of("max_consumption_kw", 7),
                        "failsafe", Map.of("behavior", "off"))), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(edited.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(num((Map<String, Object>) ((Map<String, Object>) edited.getBody()
                .get("guards")).get("limits"), "max_consumption_kw")).isEqualTo(7.0);
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + wallboxId),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("guards",
                        Map.of("failsafe", Map.of("behavior", "explode"))), adminTenant),
                String.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // ---- The customer entities surface: Soll/Ist reconciliation --------
        ResponseEntity<Map<String, Object>> surface = rest.exchange(
                url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(surface.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> registryState =
                (Map<String, Object>) surface.getBody().get("registry");
        assertThat(registryState).as("the composed Soll revision is recorded").isNotNull();
        String revision = (String) registryState.get("revision");
        assertThat(revision).isNotBlank();
        List<Map<String, Object>> surfaceEntities =
                (List<Map<String, Object>>) surface.getBody().get("entities");
        // The bootstrap made THREE entities (battery-hybrid from the asset plus
        // the MIG-synthesized grid-meter + house-load from the gateway) + the
        // wallbox created above.
        assertThat(surfaceEntities).hasSize(4);
        Map<String, Object> wbSurface = surfaceEntities.stream()
                .filter(e -> wallboxId.equals(e.get("id"))).findFirst().orElseThrow();
        assertThat(wbSurface.get("typeLabel")).isEqualTo("Wallbox");
        assertThat(wbSurface.get("control")).isEqualTo(true);
        assertThat(wbSurface.get("syncStatus"))
                .as("device never reported -> unreported").isEqualTo("unreported");

        // The edge reports its Ist: wallbox applied at the CURRENT revision,
        // plus the edge-local commissioning view. The battery is deliberately
        // absent from the report (not yet applied on the device).
        var listener = new com.voltpilot.api.entities.EntityStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo, componentApplyRepo);
        String topic = "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/status";
        String heartbeat = "{"
                + "\"schema_version\":\"1.0\",\"tenant_id\":\"" + tenantId + "\","
                + "\"site_id\":\"" + siteId + "\",\"device_id\":\"" + deviceId + "\","
                + "\"online\":true,"
                + "\"entities\":{\"revision\":\"" + revision + "\",\"count\":1,"
                + "\"ids\":[\"" + wallboxId + "\"],"
                + "\"observed\":{\"" + wallboxId + "\":{\"entity_type\":\"wallbox\","
                + "\"health\":\"ok\",\"last_telemetry_at\":\"2026-07-19T10:00:00Z\","
                + "\"channels\":[\"power_kw\"]}},"
                + "\"local_setup\":[{\"id\":\"inverter\",\"kind\":\"inverter\","
                + "\"brand\":\"deye\",\"model\":\"SUN-12K-SG04LP3-EU\"}]}}";
        listener.handle(topic, heartbeat.getBytes(java.nio.charset.StandardCharsets.UTF_8));

        surface = rest.exchange(url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        surfaceEntities = (List<Map<String, Object>>) surface.getBody().get("entities");
        wbSurface = surfaceEntities.stream()
                .filter(e -> wallboxId.equals(e.get("id"))).findFirst().orElseThrow();
        assertThat(wbSurface.get("syncStatus")).isEqualTo("in_sync");
        Map<String, Object> observed = (Map<String, Object>) wbSurface.get("observed");
        assertThat(observed.get("health")).isEqualTo("ok");
        Map<String, Object> batterySurface = surfaceEntities.stream()
                .filter(e -> batteryId.equals(e.get("id"))).findFirst().orElseThrow();
        assertThat(batterySurface.get("syncStatus"))
                .as("reported device without this entity = missing on device")
                .isEqualTo("missing_on_device");
        List<Map<String, Object>> localSetup =
                (List<Map<String, Object>>) surface.getBody().get("localSetup");
        assertThat(localSetup).hasSize(1);
        // Brand/model ride their OWN fields; the label stays the operator-given
        // name only (absent here) - never a "brand · model · …" concatenation
        // (the Pilsting ghost-name bug, scout vp-vier-erzeuger-p9).
        assertThat(localSetup.get(0).get("brand")).isEqualTo("deye");
        assertThat(localSetup.get(0).get("model")).isEqualTo("SUN-12K-SG04LP3-EU");
        assertThat(localSetup.get(0).get("label")).isNull();

        // Drift is honest, never silently resolved: an OLD applied revision
        // reads pending; a reported ghost entity surfaces as stale-on-device;
        // a spoofed identity is ignored outright.
        String oldRevisionBeat = heartbeat.replace("\"revision\":\"" + revision + "\"",
                "\"revision\":\"1999-01-01T00:00:00Z\"");
        listener.handle(topic, oldRevisionBeat.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        surface = rest.exchange(url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        wbSurface = ((List<Map<String, Object>>) surface.getBody().get("entities")).stream()
                .filter(e -> wallboxId.equals(e.get("id"))).findFirst().orElseThrow();
        assertThat(wbSurface.get("syncStatus")).isEqualTo("pending");

        String ghostBeat = heartbeat.replace(
                "\"observed\":{\"" + wallboxId + "\"",
                "\"observed\":{\"ghost-entity-1\":{\"entity_type\":\"wallbox\","
                        + "\"health\":\"never\"},\"" + wallboxId + "\"");
        listener.handle(topic, ghostBeat.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        surface = rest.exchange(url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat((List<String>) surface.getBody().get("staleOnDevice"))
                .containsExactly("ghost-entity-1");

        String spoofed = heartbeat.replace(
                "\"tenant_id\":\"" + tenantId + "\"",
                "\"tenant_id\":\"99999999-9999-9999-9999-999999999999\"");
        listener.handle(topic, spoofed.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        surface = rest.exchange(url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat((List<String>) surface.getBody().get("staleOnDevice"))
                .as("a spoofed heartbeat must not replace the observed state")
                .containsExactly("ghost-entity-1");

        // Delete the wallbox: the row goes, the surface follows (the three
        // composed pilot entities stay).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + wallboxId),
                HttpMethod.DELETE, new HttpEntity<>(adminTenant), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        surface = rest.exchange(url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), new ParameterizedTypeReference<>() {});
        assertThat((List<Map<String, Object>>) surface.getBody().get("entities")).hasSize(3);
    }

    @Test
    @SuppressWarnings("unchecked")
    void adminAdoptsEdgeReportedSourcesIntoV2EntitiesIdempotently() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Adoption GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);

        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Adoptionsanlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + tenantId + "', '"
                + siteId + "', 'battery', 65, 30, 30, 92)");
        // The site's aggregate PV asset (so a producer adoption can add to it).
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES ('"
                + tenantId + "', '" + siteId + "', 'pv', 10)");
        String deviceId = (String) rest.exchange(url("/api/v1/devices/claim"), HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", "adopt-rig-01"),
                        adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // The edge reports two local sources: a go-e wallbox (consumer) and an
        // AC-coupled PV (producer). Neither has a matching entity yet.
        var listener = new com.voltpilot.api.entities.EntityStatusListener(
                "tcp://localhost:1883", "", "", deviceRepo, entityObservedRepo, componentApplyRepo);
        String topic = "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/status";
        String heartbeat = "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + tenantId + "\","
                + "\"site_id\":\"" + siteId + "\",\"device_id\":\"" + deviceId + "\","
                + "\"online\":true,\"entities\":{\"revision\":\"r1\",\"local_setup\":["
                + "{\"id\":\"goe-1\",\"kind\":\"source\",\"role\":\"consumer\",\"brand\":\"go-e\","
                + "\"model\":\"Charger 3\"},"
                + "{\"id\":\"pv-2\",\"kind\":\"source\",\"role\":\"pv-generation\","
                + "\"brand\":\"Fronius\",\"model\":\"Eco 27\",\"label\":\"PV Halle Ost\"}]}}";
        listener.handle(topic, heartbeat.getBytes(java.nio.charset.StandardCharsets.UTF_8));

        // The entities surface reports the sources with their role/brand, both
        // unadopted (no matching entity yet).
        Map<String, Object> surface = entitiesSurface(siteId, adminTenant);
        List<Map<String, Object>> localSetup =
                (List<Map<String, Object>>) surface.get("localSetup");
        assertThat(localSetup).hasSize(2);
        Map<String, Object> goe = localSetup.stream()
                .filter(l -> "goe-1".equals(l.get("id"))).findFirst().orElseThrow();
        assertThat(goe.get("role")).isEqualTo("consumer");
        assertThat(goe.get("brand")).isEqualTo("go-e");
        assertThat(goe.get("model")).isEqualTo("Charger 3");
        assertThat(goe.get("label")).as("no operator name reported, none invented").isNull();
        assertThat(goe.get("adoptedEntityId")).as("not adopted yet").isNull();

        // Adopt the wallbox (non-composed consumer type) -> a v2 entity pinned
        // to its source id.
        ResponseEntity<Map<String, Object>> adopted = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "goe-1", "entityType", "wallbox",
                        "label", "Wallbox Carport", "maxPowerKw", 11), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(adopted.getStatusCode()).isEqualTo(HttpStatus.OK);
        String wallboxId = (String) adopted.getBody().get("id");
        assertThat(adopted.getBody().get("entityType")).isEqualTo("wallbox");

        // It shows up in "Ihre Geräte" carrying its edge source id; the reported
        // source now points at it (adopted).
        surface = entitiesSurface(siteId, adminTenant);
        Map<String, Object> wbEntity = ((List<Map<String, Object>>) surface.get("entities"))
                .stream().filter(e -> wallboxId.equals(e.get("id"))).findFirst().orElseThrow();
        assertThat(wbEntity.get("edgeSourceId")).isEqualTo("goe-1");
        goe = ((List<Map<String, Object>>) surface.get("localSetup")).stream()
                .filter(l -> "goe-1".equals(l.get("id"))).findFirst().orElseThrow();
        assertThat(goe.get("adoptedEntityId")).isEqualTo(wallboxId);

        // Re-adoption is idempotent: the same source returns the same entity.
        ResponseEntity<Map<String, Object>> reAdopt = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "goe-1", "entityType", "wallbox"), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(reAdopt.getBody().get("id")).isEqualTo(wallboxId);

        // Adopt the producer (composed) -> a producer entity + its kWp sums into
        // the aggregate site PV (the retired ErzeugerSourcesPanel job).
        ResponseEntity<Map<String, Object>> producer = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "pv-2", "entityType", "producer",
                        "label", "AC-PV Nord", "capacityKwp", 27, "registryUnitId", "SEE900"),
                        adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(producer.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(producer.getBody().get("entityType")).isEqualTo("producer");
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv' AND is_primary")).isEqualTo(37.0); // 10 + 27

        String producerId = (String) producer.getBody().get("id");
        surface = entitiesSurface(siteId, adminTenant);
        Map<String, Object> pvSource = ((List<Map<String, Object>>) surface.get("localSetup"))
                .stream().filter(l -> "pv-2".equals(l.get("id"))).findFirst().orElseThrow();
        assertThat(pvSource.get("adoptedEntityId")).isEqualTo(producerId);
        // A reported operator name survives EXACTLY as given - no concatenation.
        assertThat(pvSource.get("label")).isEqualTo("PV Halle Ost");
        assertThat(pvSource.get("model")).isEqualTo("Eco 27");

        // MEDIUM-1: deleting a COMPOSED entity keeps its measurement point (only
        // the entity config is cleared), so the point stays pinned to "pv-2" -
        // the portal shows the source as adoptable again...
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + producerId),
                HttpMethod.DELETE, new HttpEntity<>(adminTenant), String.class)
                .getStatusCode().is2xxSuccessful()).isTrue();
        surface = entitiesSurface(siteId, adminTenant);
        assertThat(((List<Map<String, Object>>) surface.get("entities")).stream()
                .anyMatch(e -> producerId.equals(e.get("id")))).isFalse();
        pvSource = ((List<Map<String, Object>>) surface.get("localSetup")).stream()
                .filter(l -> "pv-2".equals(l.get("id"))).findFirst().orElseThrow();
        assertThat(pvSource.get("adoptedEntityId")).as("offered for adoption again").isNull();

        // ... and re-adopting it RE-COMPOSES that very point instead of inserting
        // a second one (which the (site, edge_source) unique index refused with an
        // opaque 500). The kWp is applied as a DELTA, never counted twice.
        ResponseEntity<Map<String, Object>> reProducer = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "pv-2", "entityType", "producer",
                        "label", "AC-PV Nord", "capacityKwp", 27, "registryUnitId", "SEE900"),
                        adminTenant), new ParameterizedTypeReference<>() {});
        assertThat(reProducer.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(reProducer.getBody().get("entityType")).isEqualTo("producer");
        assertThat(reProducer.getBody().get("id")).as("the same point, re-composed")
                .isEqualTo(producerId);
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv' AND is_primary")).isEqualTo(37.0); // still 10 + 27
        assertThat(queryDouble("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "' AND edge_source_id = 'pv-2'")).isEqualTo(1.0);

        // A changed kWp on the re-adopt moves the aggregate by the delta only.
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + producerId),
                HttpMethod.DELETE, new HttpEntity<>(adminTenant), String.class)
                .getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "pv-2", "entityType", "producer",
                        "capacityKwp", 30), adminTenant),
                new ParameterizedTypeReference<Map<String, Object>>() {})
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv' AND is_primary")).isEqualTo(40.0); // 37 - 27 + 30

        // PR 3 (vp-vier-erzeuger-p9): purgePoint=true is the duplicate-cleanup
        // lever - the point is deleted OUTRIGHT (not just de-entitied), its kWp
        // leaves the aggregate and its source pin is freed, so the source is
        // cleanly adoptable again as a FRESH row (no 500 from the unique index).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/" + producerId
                        + "?purgePoint=true"),
                HttpMethod.DELETE, new HttpEntity<>(adminTenant), String.class)
                .getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv' AND is_primary")).isEqualTo(10.0); // 40 - 30, back to seed
        assertThat(queryDouble("SELECT count(*) FROM measurement_point WHERE site_id = '" + siteId
                + "' AND edge_source_id = 'pv-2'")).as("point gone, pin freed").isEqualTo(0.0);
        ResponseEntity<Map<String, Object>> afterPurge = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "pv-2", "entityType", "producer",
                        "capacityKwp", 27), adminTenant),
                new ParameterizedTypeReference<>() {});
        assertThat(afterPurge.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(afterPurge.getBody().get("id")).as("a FRESH row after the purge")
                .isNotEqualTo(producerId);
        assertThat(queryDouble("SELECT pv_capacity_kwp FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'pv' AND is_primary")).isEqualTo(37.0); // 10 + 27

        // battery-hybrid is never adopted as a source (422; a FRESH source id so
        // the idempotency short-circuit does not mask the type refusal).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "bh-3", "entityType", "battery-hybrid"),
                        adminTenant), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

        // A customer cannot adopt (admin-only route -> 403).
        assertThat(rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/adopt"), HttpMethod.POST,
                new HttpEntity<>(Map.of("sourceId", "x", "entityType", "wallbox"),
                        bearer(token("demo", "demo"))), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> entitiesSurface(String siteId, HttpHeaders headers) {
        return rest.exchange(url("/api/v1/sites/" + siteId + "/entities"), HttpMethod.GET,
                new HttpEntity<>(headers), new ParameterizedTypeReference<Map<String, Object>>() {})
                .getBody();
    }

    @Test
    void aSecondNonPrimaryBatteryAssetRowLeavesV1PathsIntact() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Zweitspeicher GmbH", "CI").get("id");
        HttpHeaders adminTenant = withTenant(bearer(admin), tenantId);
        String siteId = (String) rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/sites"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "Zweitspeicher-Anlage", "biddingZone", "DE-LU"),
                        bearer(admin)),
                new ParameterizedTypeReference<Map<String, Object>>() {}).getBody().get("id");

        // The customer battery editor creates the PRIMARY battery asset.
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/battery"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("capacityKwh", 20, "maxChargeKw", 10,
                        "maxDischargeKw", 10), adminTenant),
                String.class).getStatusCode().is2xxSuccessful()).isTrue();

        // A SECOND battery row is now REPRESENTABLE (non-primary; the old
        // UNIQUE(site_id, type) would have refused it outright).
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, is_primary) VALUES ('" + tenantId + "', '" + siteId
                + "', 'battery', 10, 5, 5, FALSE)");

        // v1 paths stay pinned to the primary: the editor upsert still updates
        // exactly the primary row (no duplicate, no ambiguity)...
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/battery"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("capacityKwh", 22, "maxChargeKw", 11,
                        "maxDischargeKw", 11), adminTenant),
                String.class).getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'battery'")).isEqualTo(2);
        assertThat(queryLong("SELECT count(*) FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'battery' AND is_primary")).isEqualTo(1);
        assertThat(queryLong("SELECT capacity_kwh::bigint FROM asset WHERE site_id = '" + siteId
                + "' AND type = 'battery' AND is_primary")).isEqualTo(22);

        // ...and the battery-reading endpoints keep answering (single row).
        assertThat(rest.exchange(url("/api/v1/sites/" + siteId + "/schedule"), HttpMethod.GET,
                new HttpEntity<>(adminTenant), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(rest.exchange(url("/api/v1/admin/sites/" + siteId + "/optimizer-config"),
                HttpMethod.GET, new HttpEntity<>(adminTenant), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    // ---- der EINE Flotten-Endpunkt (Admin-Umbau Stufe 2) ---------------------

    /**
     * {@code GET /api/v1/admin/fleet}: eine Zeile je Anlage über ALLE Mandanten,
     * server-seitig - der Ersatz für die Client-Schleife der Stufe 1.
     *
     * <p>Bewiesen wird beides, was an diesem Endpunkt zählt: die ROLLEN-Grenze
     * (ein Kunde bekommt 403, anonym 401, und die BYPASSRLS-Sicht leckt an
     * keiner Kunden-Route) und die INHALTE inklusive der B4-Pflege-Ableitung
     * (kWp-Plausibilität + Prognose-Ausreißer über die Flotte).
     */
    @Test
    @SuppressWarnings("unchecked")
    void adminFleetAggregatesEveryTenantServerSideAndStaysRoleGated() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Flottenpuls GmbH", "CI").get("id");

        UUID nord = UUID.randomUUID();
        UUID sued = UUID.randomUUID();
        UUID ost = UUID.randomUUID();
        UUID west = UUID.randomUUID();
        seedSite(nord, UUID.fromString(tenantId), "Puls Nord");
        seedSite(sued, UUID.fromString(tenantId), "Puls Sued");
        seedSite(ost, UUID.fromString(tenantId), "Puls Ost");
        seedSite(west, UUID.fromString(tenantId), "Puls West");

        // Nord: der Sorgenfall. Tarifart 'ohne' (rechnet mit Standard-Komponenten),
        // ein Speicher OHNE steuerndes Gerät, ein Gerät das gerade gemeldet hat,
        // ein frischer Optimierer-Lauf, Steuerungs-/Abregel-Beleg, Edge-Stand,
        // zwei gemeldete Quellen (eine davon verstummt).
        exec("UPDATE site SET tarif_art = 'ohne' WHERE id = '" + nord + "'");
        // Die anderen drei sind gepflegt - „Ost" soll gleich beweisen, dass eine
        // Anlage OHNE Datenlage gar nichts behauptet bekommt.
        exec("UPDATE site SET tarif_art = 'fest', tarif_param_ct_kwh = 30 WHERE id IN ('"
                + sued + "', '" + ost + "', '" + west + "')");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw) VALUES ('" + tenantId + "', '" + nord + "', 'battery', 20, 10, 10)");
        UUID nordDevice = UUID.randomUUID();
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + nordDevice + "', '" + tenantId + "', '" + nord + "', 'fleet-nord-01', 'inverter')");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at, pv_power_kw) "
                + "VALUES (now(), '" + tenantId + "', '" + nord + "', '" + nordDevice + "', now(), 3.2)");
        exec("INSERT INTO schedule (site_id, tenant_id, plan_id, generated_at, time, battery_kw) "
                + "VALUES ('" + nord + "', '" + tenantId + "', gen_random_uuid(), "
                + "now() - interval '10 minutes', now(), 1.0)");
        exec("INSERT INTO device_control_status (device_id, tenant_id, site_id, commanded_kw, "
                + "confirmed_kw, all_match, control_enabled, certified, checked_at) VALUES ('"
                + nordDevice + "', '" + tenantId + "', '" + nord + "', -4.3, -4.3, TRUE, TRUE, TRUE, now())");
        exec("INSERT INTO device_curtailment_status (device_id, tenant_id, site_id, units, "
                + "certified_units, control_enabled, active, possible_override, checked_at) VALUES ('"
                + nordDevice + "', '" + tenantId + "', '" + nord + "', 2, 0, TRUE, FALSE, FALSE, now())");
        exec("INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, "
                + "palette_version, reported_at) VALUES ('" + nordDevice + "', '" + tenantId + "', '"
                + nord + "', '1.4.0', '0.3.0', now())");
        exec("INSERT INTO device_source_status (device_id, source_id, tenant_id, site_id, kind, "
                + "health, reported_at) VALUES ('" + nordDevice + "', 'primary', '" + tenantId + "', '"
                + nord + "', 'primary', 'ok', now())");
        exec("INSERT INTO device_source_status (device_id, source_id, tenant_id, site_id, kind, "
                + "health, reported_at) VALUES ('" + nordDevice + "', 'pv-2', '" + tenantId + "', '"
                + nord + "', 'source', 'stale', now())");

        // Sued: 30 kWp gepflegt, aber die Rollups melden eine Spitze von 105 kW
        // (26,25 kWh je Viertelstunde) - der Skalierungsfehler-Fall.
        exec("INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) VALUES ('"
                + tenantId + "', '" + sued + "', 'pv', 30)");
        exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, pv_kwh, n_samples) "
                + "SELECT now() - (g || ' hours')::interval, '" + tenantId + "', '" + sued
                + "', 26.25, 90 FROM generate_series(1, 120) g");

        // Prognose: vier bewertete Anlagen (Median 13 %), Nord ist mit 60 % der
        // Ausreisser. Nur das AKTIVE Modell zaehlt.
        seedForecastAccuracy(tenantId, nord, "load-persistence", "load", 60);
        seedForecastAccuracy(tenantId, sued, "load-persistence", "load", 10);
        seedForecastAccuracy(tenantId, ost, "load-persistence", "load", 12);
        seedForecastAccuracy(tenantId, west, "load-persistence", "load", 14);
        // Ein SCHATTEN-Modell mit katastrophalem Fehler darf nichts auslösen.
        seedForecastAccuracy(tenantId, west, "load-xgb", "load", 400);

        List<Map<String, Object>> fleet = fleet(admin);
        Map<String, Map<String, Object>> bySite = new java.util.HashMap<>();
        for (Map<String, Object> row : fleet) {
            bySite.put((String) row.get("siteName"), row);
        }

        // (1) cross-tenant: der neue Mandant UND der Demo-Mandant stehen drin.
        assertThat(bySite).containsKeys("Puls Nord", "Puls Sued", "Puls Ost", "Puls West");
        assertThat(fleet).extracting(r -> r.get("tenantName")).contains("Demo C&I Tenant");
        assertThat(bySite.get("Puls Nord")).containsEntry("tenantName", "Flottenpuls GmbH");

        // (2) Nord: Overview-Kernfelder + Plan-Alter + die drei Kurzbelege.
        Map<String, Object> n = bySite.get("Puls Nord");
        assertThat(n).containsEntry("deviceCount", 1).containsEntry("onlineCount", 1)
                .containsEntry("waitingCount", 0).containsEntry("worstStatus", "online")
                .containsEntry("hasStorage", true).containsEntry("batteryWithoutDevice", true);
        assertThat(n.get("lastSeenAt")).isNotNull();
        assertThat(n.get("lastPlanGeneratedAt")).as("der jüngste Optimierer-Lauf").isNotNull();
        assertThat((Map<String, Object>) n.get("control")).containsEntry("certified", true)
                .containsEntry("allMatch", true).containsEntry("commandedKw", -4.3);
        assertThat((Map<String, Object>) n.get("curtailment")).containsEntry("units", 2)
                .containsEntry("certifiedUnits", 0);
        assertThat((Map<String, Object>) n.get("edge")).containsEntry("coreVersion", "1.4.0")
                .containsEntry("paletteVersion", "0.3.0");
        assertThat((Map<String, Object>) n.get("sources")).containsEntry("total", 2)
                .containsEntry("ok", 1).containsEntry("stale", 1);

        // (3) die Pflege-Flags sind SERVER-abgeleitet (Stufe-1-Regeln + B4).
        assertThat((List<Map<String, Object>>) n.get("pflege"))
                .extracting(f -> f.get("code"))
                .containsExactly("tarif-fehlt", "speicher-ohne-geraet", "prognose-ausreisser-load");
        Map<String, Object> forecast = ((List<Map<String, Object>>) n.get("forecast")).get(0);
        assertThat(forecast).containsEntry("kind", "load").containsEntry("outlier", true);
        assertThat((Double) forecast.get("fleetMedianPct")).isEqualTo(13.0);

        // (4) B4a: die kWp-Plausibilität nennt ihren Grund.
        Map<String, Object> s = bySite.get("Puls Sued");
        Map<String, Object> kwp = (Map<String, Object>) s.get("kwp");
        assertThat(kwp).containsEntry("verdict", "zu_hoch");
        assertThat((String) kwp.get("reason")).contains("105,0 kW").contains("30,0 kWp");
        assertThat((List<Map<String, Object>>) s.get("pflege")).extracting(f -> f.get("code"))
                .contains("kwp-unplausibel");

        // (5) keine Daten = Lücke MIT Grund, nie ein erfundenes Urteil.
        Map<String, Object> o = bySite.get("Puls Ost");
        assertThat((Map<String, Object>) o.get("kwp")).containsEntry("verdict", "unbekannt");
        assertThat((String) ((Map<String, Object>) o.get("kwp")).get("reason"))
                .contains("Keine PV-Nennleistung gepflegt");
        assertThat(o.get("edge")).as("nie gemeldet heißt unbekannt, nicht veraltet").isNull();
        assertThat(o.get("sources")).isNull();
        assertThat(o.get("control")).isNull();
        assertThat(o.get("curtailment")).isNull();
        assertThat(o.get("lastPlanGeneratedAt")).isNull();
        assertThat((List<Map<String, Object>>) o.get("pflege"))
                .as("ohne Datenlage wird nichts behauptet").isEmpty();

        // (6) die Rollen-Grenze: ein Kunde bekommt 403, anonym 401 - und die
        // BYPASSRLS-Sicht leckt an keiner Kunden-Route.
        String customer = token("demo", "demo");
        assertThat(rest.exchange(url("/api/v1/admin/fleet"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/fleet"), HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        // Auch MIT gesetztem Umschalter-Header (den nur Admins tragen dürfen).
        assertThat(rest.exchange(url("/api/v1/admin/fleet"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(customer), tenantId)), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        ResponseEntity<Map<String, Object>> customerOverview = rest.exchange(
                url("/api/v1/overview"), HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(customerOverview.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<Map<String, Object>>) customerOverview.getBody().get("sites"))
                .as("der Kunde sieht weiterhin nur seine eigenen Anlagen")
                .extracting(r -> r.get("name")).doesNotContain("Puls Nord", "Puls Sued");
    }

    /**
     * B4c: die Plausibilität der gepflegten Einspeisegrenze im Flotten-Endpunkt,
     * mit den Pilsting-Zahlen als Abnahme-Anker.
     *
     * <p>Zwei Anlagen mit IDENTISCHER gemessener Export-Decke (~30 kW, an vielen
     * Tagen), aber verschieden gepflegter Grenze: <b>Kappe</b> mit 75 kW (der
     * reale Pilsting-Fehler - vermutlich Summe der Wechselrichter-Nennleistungen
     * statt der 30-kW-Netzanschluss-Grenze) MUSS anschlagen, <b>Recht</b> mit
     * korrekt gepflegten 30 kW bleibt still. So ist der Kontrast rein die
     * Konfiguration, nicht die Messung.
     */
    @Test
    @SuppressWarnings("unchecked")
    void adminFleetFlagsAFeedInLimitTheAnlageClingsFarBelow() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "Einspeise GmbH", "CI").get("id");

        UUID kappe = UUID.randomUUID();
        UUID recht = UUID.randomUUID();
        seedSite(kappe, UUID.fromString(tenantId), "Kappe Pilsting");
        seedSite(recht, UUID.fromString(tenantId), "Kappe Recht");
        // Ein Stromtarif, damit kein zusätzlicher Pflege-Chip entsteht.
        exec("UPDATE site SET tarif_art = 'fest', tarif_param_ct_kwh = 30 WHERE id IN ('"
                + kappe + "', '" + recht + "')");
        // Der Pilsting-Fehler vs. die korrekte Pflege.
        exec("UPDATE site SET max_feed_in_kw = 75 WHERE id = '" + kappe + "'");
        exec("UPDATE site SET max_feed_in_kw = 30 WHERE id = '" + recht + "'");

        // Beide Anlagen kleben an EXAKT 30 kW Einspeisung: je Anlage 8 Tage à 48
        // Viertelstunden (halber Tag ab Mitternacht, bleibt in EINEM Berliner Tag)
        // mit 7,5 kWh Export je Viertelstunde = 30 kW Mittelleistung.
        for (UUID s : new UUID[] {kappe, recht}) {
            exec("INSERT INTO telemetry_rollup_15m (bucket, tenant_id, site_id, grid_export_kwh, "
                    + "n_samples) SELECT date_trunc('day', now()) - (d || ' days')::interval "
                    + "+ (q * interval '15 minutes'), '" + tenantId + "', '" + s + "', 7.5, 90 "
                    + "FROM generate_series(1, 8) d, generate_series(0, 47) q");
        }

        Map<String, Map<String, Object>> bySite = new java.util.HashMap<>();
        for (Map<String, Object> row : fleet(admin)) {
            bySite.put((String) row.get("siteName"), row);
        }

        // Der Pilsting-Fall schlägt an.
        Map<String, Object> k = bySite.get("Kappe Pilsting");
        Map<String, Object> feedIn = (Map<String, Object>) k.get("feedIn");
        assertThat(feedIn).containsEntry("verdict", "zu_hoch");
        assertThat((Number) feedIn.get("observedCeilingKw")).extracting(Number::doubleValue)
                .isEqualTo(30.0);
        assertThat((String) feedIn.get("reason")).contains("30,0 kW").contains("75,0 kW")
                .contains("zu hoch");
        assertThat((List<Map<String, Object>>) k.get("pflege")).extracting(f -> f.get("code"))
                .contains("einspeisegrenze-unplausibel");

        // Dieselbe Messung, plausibel gepflegte Grenze: still.
        Map<String, Object> r = bySite.get("Kappe Recht");
        assertThat((Map<String, Object>) r.get("feedIn")).containsEntry("verdict", "ok");
        assertThat((List<Map<String, Object>>) r.get("pflege")).extracting(f -> f.get("code"))
                .doesNotContain("einspeisegrenze-unplausibel");
    }

    // ---- OTA Stufe 0 „Sehen" (Scout vp-ota-rollout-h4) ----------------------

    /**
     * Der Ingest des TOP-LEVEL-{@code version}-Feldes samt {@code update}-Block,
     * das Release-Register und der Soll-gegen-Ist-Stoff im Flotten-Endpunkt.
     *
     * <p>Bewiesen werden die drei Löcher, die Stufe 0 schließt (§2.3):
     * <ol>
     *   <li>ein Gerät OHNE Flow-Deployment meldet trotzdem seinen Stand - der
     *       alte Ingest hing am {@code flows}-Block, den so ein Gerät nie
     *       baut;</li>
     *   <li>es GIBT jetzt einen Soll: das Register reist als Ordnung mit, und
     *       ohne Register wird nichts als veraltet behauptet;</li>
     *   <li>die Ordnung ist {@code release_seq} - eine monotone Ganzzahl statt
     *       eines SHA-Vergleichs; das Register erzwingt sie serverseitig.</li>
     * </ol>
     * Dazu die Rollen-Grenze der Registerroute (Kunde 403, anonym 401).
     */
    @Test
    @SuppressWarnings("unchecked")
    void otaUpdateStatusIsIngestedAndTheFleetCarriesTheRegisterSoll() {
        String admin = token("admin", "admin");
        String tenantId = (String) createTenant(admin, "OTA Flotte GmbH", "CI").get("id");

        UUID mitFlow = UUID.randomUUID();
        UUID ohneFlow = UUID.randomUUID();
        UUID stumm = UUID.randomUUID();
        seedSite(mitFlow, UUID.fromString(tenantId), "OTA Mit Automation");
        seedSite(ohneFlow, UUID.fromString(tenantId), "OTA Ohne Automation");
        seedSite(stumm, UUID.fromString(tenantId), "OTA Stumm");

        UUID devA = UUID.randomUUID();
        UUID devB = UUID.randomUUID();
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + devA + "', '" + tenantId + "', '" + mitFlow + "', 'ota-a-01', 'inverter')");
        exec("INSERT INTO device (id, tenant_id, site_id, external_ref, kind) VALUES ('"
                + devB + "', '" + tenantId + "', '" + ohneFlow + "', 'ota-b-01', 'inverter')");

        // (1) Anlage MIT Automation: beide Wege melden - der alte flows-Block
        // UND der neue OTA-Block. Sie leben in getrennten Zeilen mit eigenem
        // Frische-Anker.
        exec("INSERT INTO device_edge_version (device_id, tenant_id, site_id, core_version, "
                + "palette_version, reported_at) VALUES ('" + devA + "', '" + tenantId + "', '"
                + mitFlow + "', 'edge-2026.08.0', '0.3.0', now())");
        exec("INSERT INTO device_update_status (device_id, tenant_id, site_id, version, backend, "
                + "current_version, state, reported_at) VALUES ('" + devA + "', '" + tenantId
                + "', '" + mitFlow + "', 'edge-2026.08.0', 'compose', 'edge-2026.08.0', 'idle', "
                + "now())");
        // (2) Anlage OHNE Automation: NUR der OTA-Block - genau das Gerät, das
        // vorher gar keine Version meldete.
        exec("INSERT INTO device_update_status (device_id, tenant_id, site_id, version, backend, "
                + "current_version, state, reported_at) VALUES ('" + devB + "', '" + tenantId
                + "', '" + ohneFlow + "', 'edge-2026.07.2', 'compose', 'edge-2026.07.2', 'idle', "
                + "now())");

        // (3) Das Register: OHNE Eintrag gibt es keinen Maßstab. Erst prüfen,
        // dass der Endpunkt genau das sagt (der Zustand am Deploy-Tag).
        Map<String, Object> before = fleetBody(admin);
        List<Map<String, Object>> registerBefore =
                (List<Map<String, Object>>) before.get("releases");
        assertThat(registerBefore).as("das Register reist mit, auch leer").isNotNull();

        Map<String, Map<String, Object>> bySite = new java.util.HashMap<>();
        for (Map<String, Object> row : (List<Map<String, Object>>) before.get("sites")) {
            bySite.put((String) row.get("siteName"), row);
        }

        Map<String, Object> a = bySite.get("OTA Mit Automation");
        assertThat((Map<String, Object>) a.get("edge")).containsEntry("coreVersion",
                "edge-2026.08.0");
        assertThat((Map<String, Object>) a.get("update"))
                .containsEntry("version", "edge-2026.08.0")
                .containsEntry("backend", "compose").containsEntry("state", "idle");

        Map<String, Object> b = bySite.get("OTA Ohne Automation");
        assertThat(b.get("edge")).as("ohne Flow-Deployment gibt es keinen flows-Block").isNull();
        assertThat((Map<String, Object>) b.get("update"))
                .as("der OTA-Block sieht dieses Gerät trotzdem - das ist der ganze Punkt")
                .containsEntry("version", "edge-2026.07.2");

        Map<String, Object> c = bySite.get("OTA Stumm");
        assertThat(c.get("update")).as("nie gemeldet heißt unbekannt, nicht veraltet").isNull();
        assertThat(c.get("edge")).isNull();

        // (4) Register anlegen: die Sequenz setzt sich von selbst fort.
        Map<String, Object> r1 = createRelease(admin,
                Map.of("version", "edge-2026.07.2", "targetCommit", "665d59b8"));
        Map<String, Object> r2 = createRelease(admin,
                Map.of("version", "edge-2026.08.0", "targetCommit", "3bf8c038",
                        "notes", "Puls Soll-gegen-Ist"));
        long seq1 = ((Number) r1.get("releaseSeq")).longValue();
        long seq2 = ((Number) r2.get("releaseSeq")).longValue();
        assertThat(seq2).as("die Ordnung ist monoton").isGreaterThan(seq1);
        assertThat(r2).containsEntry("targetCommit", "3bf8c038");
        assertThat(r2.get("createdAt")).isNotNull();

        // (5) Die Ordnung wird SERVERSEITIG erzwungen - eine Nummer, die nicht
        // strikt wächst, wäre genau der Zufallsvergleich, den das Register
        // ablöst. Und ein doppeltes Release ist 409, kein stilles No-op.
        assertThat(postRelease(admin,
                Map.of("version", "edge-2026.09.0", "releaseSeq", seq1)).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(postRelease(admin, Map.of("version", "edge-2026.08.0")).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        // Ein nackter Commit-SHA ist im REGISTER kein gültiger Stand (ein GERÄT
        // darf ihn melden - dort heißt er dann „nicht registriert").
        assertThat(postRelease(admin, Map.of("version", "3bf8c0380000")).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        // (6) Jetzt trägt der Flotten-Endpunkt den Soll - neueste zuerst.
        List<Map<String, Object>> register =
                (List<Map<String, Object>>) fleetBody(admin).get("releases");
        assertThat(register).isNotEmpty();
        assertThat(((Number) register.get(0).get("releaseSeq")).longValue())
                .as("neueste zuerst - der erste Eintrag IST der Soll-Stand")
                .isEqualTo(seq2);
        assertThat(register.get(0)).containsEntry("version", "edge-2026.08.0");
        assertThat(register).extracting(x -> x.get("version"))
                .contains("edge-2026.07.2", "edge-2026.08.0");

        // (7) Die Rollen-Grenze der Registerroute.
        String customer = token("demo", "demo");
        assertThat(rest.exchange(url("/api/v1/admin/edge-releases"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/edge-releases"), HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(postRelease(customer, Map.of("version", "edge-2026.10.0")).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    /**
     * OTA Stufe 1 „Vertrauen": ein Register-Eintrag traegt das SIGNIERTE
     * Release - und die Bytes ueberstehen den Weg durch die Datenbank
     * unveraendert.
     *
     * <p>Das ist die eine Eigenschaft, an der die ganze Kette haengt: die
     * Signatur geht ueber die ROHEN Manifest-Bytes, also muss jede Station sie
     * bytegenau durchreichen. Die Spalte ist deshalb {@code text} und niemals
     * {@code jsonb} (das normalisiert Schluesselreihenfolge und Leerraum und
     * machte die Signatur lautlos unpruefbar) - genau das prueft dieser Test,
     * indem er ein bewusst „unaufgeraeumtes" Manifest schickt und es Zeichen
     * fuer Zeichen zurueckerwartet.
     *
     * <p>Die api PRUEFT die Signatur nicht (der Verifizierer ist das Geraet mit
     * seiner eingebackenen Wurzel). Sie prueft WIDERSPRUCHSFREIHEIT: das
     * Register darf nie etwas anderes behaupten als das, was unterschrieben
     * wurde.
     */
    @Test
    @SuppressWarnings("unchecked")
    void aSignedReleaseIsRegisteredByteExactAndNeverContradictsItsManifest() {
        String admin = token("admin", "admin");
        String version = "edge-2027.03.0";
        // Absichtlich unregelmaessig eingerueckt + mit Leerzeile: exakt SO
        // wurde signiert, exakt SO muss es zurueckkommen.
        String manifest = "{\n"
                + "  \"schema_version\": \"1.0\",\n"
                + "\t\"release\": \"" + version + "\",\n"
                + "\n"
                + "  \"release_seq\": 4711,\n"
                + "  \"target_commit\": \"3bf8c038a1b2\",\n"
                + "  \"signing_key_id\": \"rel-2026-a\"\n"
                + "}\n";
        String signature = "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\","
                + "\"key_id\":\"rel-2026-a\",\"domain\":\"release\","
                + "\"signature\":\"" + "A".repeat(86) + "==\"}\n";

        Map<String, Object> created = createRelease(admin, Map.of(
                "version", version, "manifest", manifest, "signature", signature));

        assertThat(created).containsEntry("signingKeyId", "rel-2026-a");
        assertThat(((Number) created.get("releaseSeq")).longValue())
                .as("Sequenz und Commit kommen AUS dem signierten Manifest")
                .isEqualTo(4711L);
        assertThat(created).containsEntry("targetCommit", "3bf8c038a1b2");

        // Der Rundlauf durch die Datenbank: Byte fuer Byte.
        List<Map<String, Object>> register = listReleases(admin);
        Map<String, Object> back = register.stream()
                .filter(r -> version.equals(r.get("version"))).findFirst().orElseThrow();
        assertThat((String) back.get("manifest"))
                .as("die signierten Bytes muessen den Weg durch die DB unveraendert ueberstehen")
                .isEqualTo(manifest);
        assertThat((String) back.get("signature")).isEqualTo(signature);

        // Widerspruch zum signierten Manifest = Fehler, nie eine stille
        // Abweichung: das Register ist die Papier-Spur.
        assertThat(postRelease(admin, Map.of("version", "edge-2027.04.0",
                "manifest", manifest, "signature", signature)).getStatusCode())
                .as("eine andere Version als die signierte").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(postRelease(admin, Map.of("version", version, "releaseSeq", 9999,
                "manifest", manifest, "signature", signature)).getStatusCode())
                .as("eine andere Sequenz als die signierte").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(postRelease(admin, Map.of("version", version, "targetCommit", "deadbeef",
                "manifest", manifest, "signature", signature)).getStatusCode())
                .as("ein anderer Commit als der signierte").isEqualTo(HttpStatus.BAD_REQUEST);

        // Manifest und Signatur gehoeren zusammen - halb geht nicht.
        assertThat(postRelease(admin, Map.of("version", "edge-2027.05.0", "manifest", manifest))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(postRelease(admin, Map.of("version", "edge-2027.05.0", "signature", signature))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Eine fremde Signatur an ein Manifest zu heften waere im Register eine
        // Luege, die niemand mehr bemerkt.
        assertThat(postRelease(admin, Map.of("version", "edge-2027.05.0", "manifest", manifest,
                "signature", signature.replace("rel-2026-a", "rel-2099-x"))).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        // Eine Signatur fuer ein Trust-Set ist keine fuer ein Release.
        assertThat(postRelease(admin, Map.of("version", "edge-2027.05.0", "manifest", manifest,
                "signature", signature.replace("\"domain\":\"release\"",
                        "\"domain\":\"trust-set\""))).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        // Und der Stufe-0-Handpfad bleibt unveraendert gueltig: ein Eintrag
        // ohne Manifest liest sich ehrlich als „nicht signiert", nie als
        // „geprueft".
        Map<String, Object> unsigned = createRelease(admin,
                Map.of("version", "edge-2027.06.0", "targetCommit", "aabbccdd"));
        assertThat(unsigned.get("manifest")).isNull();
        assertThat(unsigned.get("signature")).isNull();
        assertThat(unsigned.get("signingKeyId")).isNull();
    }

    /**
     * Die AUTORITAETS-GRENZE der Release-Automatisierung: das
     * Veroeffentlichungs-Konto darf REGISTRIEREN - und sonst nichts.
     *
     * <p><b>Warum dieser Test die halbe Begruendung der Automatisierung
     * traegt:</b> mit ihr wird der Release-Schluessel ein heisses CI-Geheimnis
     * (bewusste Revision von Entscheid D3). Der Preis dafuer ist nur dann
     * bezahlbar, wenn ein uebernommener Runner die Flotte NICHT erreichen kann:
     * er darf die Release-LISTE verunreinigen, aber keinen Rollout starten,
     * keine Welle freigeben, kein Geraeteziel setzen. Das ist keine
     * Absichtserklaerung, sondern wird hier Endpunkt fuer Endpunkt nachgewiesen
     * - und es steht serverseitig, nicht im CI-Skript.
     */
    @Test
    void theReleasePublisherAccountMayOnlyRegisterAndReachesNoDevice() {
        String publisher = serviceToken("voltpilot-release-publisher",
                "voltpilot-release-publisher-dev-secret");
        String admin = token("admin", "admin");

        // (1) Was es KANN: die Ordnung lesen und ein signiertes Release
        // eintragen. Die Sequenz muss VOR dem Signieren feststehen (sie steht
        // im Manifest, die Signatur geht ueber dessen Bytes) - deshalb gibt es
        // die schmale next-seq-Route ueberhaupt.
        ResponseEntity<Map<String, Object>> next = rest.exchange(
                url("/api/v1/admin/edge-releases/next-seq"), HttpMethod.GET,
                new HttpEntity<>(bearer(publisher)), new ParameterizedTypeReference<>() {});
        assertThat(next.getStatusCode()).isEqualTo(HttpStatus.OK);
        long seq = ((Number) next.getBody().get("nextSeq")).longValue();
        Long current = next.getBody().get("currentSeq") == null ? null
                : ((Number) next.getBody().get("currentSeq")).longValue();
        assertThat(current == null ? 1L : current + 1L)
                .as("nextSeq setzt das Register fort").isEqualTo(seq);

        String version = "edge-2028.01.0";
        String manifest = "{\n  \"schema_version\": \"1.0\",\n  \"release\": \"" + version
                + "\",\n  \"release_seq\": " + seq + ",\n"
                + "  \"target_commit\": \"c0ffee123456\",\n"
                + "  \"signing_key_id\": \"rel-2026-a\"\n}\n";
        String signature = "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\","
                + "\"key_id\":\"rel-2026-a\",\"domain\":\"release\","
                + "\"signature\":\"" + "B".repeat(86) + "==\"}\n";
        Map<String, ?> body = Map.of("version", version, "manifest", manifest,
                "signature", signature);

        assertThat(postRelease(publisher, body).getStatusCode())
                .as("registrieren DARF es").isEqualTo(HttpStatus.CREATED);

        // (2) Ein wiederholter Lauf mit BYTEGLEICHEN Bytes ist derselbe
        // Eintrag - sonst waere jeder erneut gestartete Job rot, obwohl nichts
        // fehlt. Abweichende Bytes unter derselben Version bleiben 409: das
        // Register ist die Papier-Spur.
        assertThat(postRelease(publisher, body).getStatusCode())
                .as("bytegleiche Wiederholung").isEqualTo(HttpStatus.OK);
        assertThat(postRelease(publisher, Map.of("version", version,
                "manifest", manifest.replace("c0ffee123456", "deadbeef9999"),
                "signature", signature)).getStatusCode())
                .as("abweichende Bytes unter derselben Version").isEqualTo(HttpStatus.CONFLICT);
        // Auch die Notiz zaehlt zur Gleichheit - sie ist das einzige Feld, das
        // nicht aus dem Manifest stammt.
        assertThat(postRelease(publisher, Map.of("version", version, "manifest", manifest,
                "signature", signature, "notes", "nachtraeglich")).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // (3) Was es NICHT kann. Jede dieser Routen ist ein Weg zur FLOTTE -
        // und genau deshalb steht hier jede einzeln.
        //
        // ⚠ Die Rumpfe sind bewusst GUELTIG: Bean-Validation laeuft bei der
        // Argument-Aufloesung und damit VOR @PreAuthorize, ein krummer Rumpf
        // ergaebe also 400 statt 403 - und haette hier gar nichts bewiesen.
        UUID device = UUID.randomUUID();
        assertForbidden(publisher, HttpMethod.POST, "/api/v1/admin/rollouts",
                Map.of("releaseSeq", seq, "devices", List.of(device.toString())));
        assertForbidden(publisher, HttpMethod.POST, "/api/v1/admin/devices/" + device
                + "/update-target", Map.of("releaseSeq", seq));
        assertForbidden(publisher, HttpMethod.POST, "/api/v1/admin/devices/" + device
                + "/update-target/revert", Map.of());
        // Lesen ist ebenfalls zu - auch das Lesen ist Aufklaerung ueber die
        // Flotte, und Registrieren braucht nichts davon.
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/edge-updates", null);
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/rollout-journal.md", null);
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/fleet", null);
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/tenants", null);
        assertForbidden(publisher, HttpMethod.POST, "/api/v1/admin/tenants",
                Map.of("name", "Uebernommener Runner", "segment", "CI"));
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/provisioned-devices", null);
        assertForbidden(publisher, HttpMethod.POST, "/api/v1/admin/provisioned-devices",
                Map.of("externalRef", "VP-RUNNER-0001"));
        // Und selbst die volle RELEASE-Liste ist zu: sie traegt jedes Manifest
        // und den Urheber jedes Eintrags - mehr, als Registrieren braucht.
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/edge-releases", null);

        // (4) Und es sieht keine KUNDENDATEN. Das Konto traegt keinen
        // tenant_id-Anspruch und ist kein platform-admin, also bleibt der
        // Mandanten-Kontext leer -> RLS ist default-deny. Der
        // Umschalter-Header hilft ihm nicht: den ehrt TenantFilter NUR fuer
        // platform-admin-Token.
        ResponseEntity<List<Map<String, Object>>> sites = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/sites"), HttpMethod.GET, new HttpEntity<>(bearer(publisher)),
                new ParameterizedTypeReference<>() {});
        assertThat(sites.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(sites.getBody()).as("kein Mandant => keine Zeilen").isEmpty();

        ResponseEntity<List<Map<String, Object>>> switched = com.voltpilot.api.SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/sites"), HttpMethod.GET,
                new HttpEntity<>(withTenant(bearer(publisher),
                        "00000000-0000-0000-0000-000000000001")),
                new ParameterizedTypeReference<>() {});
        assertThat(switched.getBody())
                .as("der Mandanten-Umschalter gilt nur fuer platform-admin").isEmpty();

        // (5) Der Plattform-Admin bleibt unangetastet - er kann alles, was er
        // vorher konnte, inklusive der neuen next-seq-Route.
        assertThat(rest.exchange(url("/api/v1/admin/edge-releases/next-seq"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(listReleases(admin)).extracting(r -> r.get("version")).contains(version);

        // (6) Und ein KUNDE erreicht die Veroeffentlichungs-Routen nicht.
        String customer = token("demo", "demo");
        assertForbidden(customer, HttpMethod.GET, "/api/v1/admin/edge-releases/next-seq", null);
        assertThat(postRelease(customer, Map.of("version", "edge-2028.02.0")).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/edge-releases/next-seq"), HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /**
     * Das Vertrauens-Set: hochgeladen von beiden Rollen, öffentlich BYTEGENAU
     * ausgeliefert - und die Publisher-Rolle wird dadurch kein Stück mächtiger.
     *
     * <p>Der Endpunkt existiert, weil eine NEUE Box beim Einrichten in die
     * Vertrauenskette kommen muss, ohne dass jemand zwei Dateien von Hand
     * kopiert (der erste Live-Rollout scheiterte genau daran). Die
     * VERTRAUENSGRENZE steht in {@code EdgeTrustSetController}: die
     * Installation ist ein sanktionierter TOFU-Moment, die Box prüft die
     * Root-Signatur weiterhin selbst - und eine LAUFENDE Box holt sich nie
     * eines über das Netz.
     */
    @Test
    void theTrustSetIsUploadedByBothRolesAndServedByteExactToAnAnonymousInstaller() {
        String admin = token("admin", "admin");
        String publisher = serviceToken("voltpilot-release-publisher",
                "voltpilot-release-publisher-dev-secret");

        // Bewusst „unaufgeräumte" Bytes: Einrückung, Leerzeilen, ein
        // abschliessender Zeilenumbruch. Genau darüber geht die Signatur der
        // kalten Wurzel - wer hier normalisiert, macht sie lautlos unprüfbar.
        String set = "{\n  \"schema_version\" : \"1.0\",\n\n  \"generated_at\": "
                + "\"2026-08-04T10:00:00Z\",\n  \"keys\": [\n    {\n"
                + "      \"key_id\": \"rel-2026-a\",\n      \"alg\": \"ed25519\",\n"
                + "      \"public_key\": \"" + b64(32) + "\"\n    }\n  ]\n}\n";
        String sig = "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\","
                + "\"key_id\":\"root-2026-a\",\"domain\":\"trust-set\","
                + "\"signature\":\"" + b64(64) + "\"}\n";

        // (1) Der Plattform-Admin lädt hoch.
        assertThat(putTrustSet(admin, Map.of("trustSet", set, "signature", sig))
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        // (2) Und das Veröffentlichungs-Konto darf es AUCH - das Set entsteht
        // in derselben Zeremonie wie ein Release-Schlüssel, die Automatik soll
        // es aktuell halten können, ohne dass ein Admin-Token in CI liegt.
        String set2 = set.replace("rel-2026-a", "rel-2026-b");
        assertThat(putTrustSet(publisher, Map.of("trustSet", set2, "signature", sig))
                .getStatusCode()).as("der Publisher darf hochladen").isEqualTo(HttpStatus.OK);

        // (3) Der ÖFFENTLICHE Abruf - ANONYM, wie eine Box, die gerade
        // eingerichtet wird und noch kein Token hat. Und Zeichen für Zeichen
        // dasselbe, was hochgeladen wurde: der Installer schreibt schlicht,
        // was er lädt.
        ResponseEntity<String> file = rest.exchange(url("/api/v1/edge/trust-set/trust-set.json"),
                HttpMethod.GET, new HttpEntity<>(new HttpHeaders()), String.class);
        assertThat(file.getStatusCode()).as("anonym erreichbar").isEqualTo(HttpStatus.OK);
        assertThat(file.getBody()).as("BYTEGENAU zurück").isEqualTo(set2);
        ResponseEntity<String> sigFile = rest.exchange(
                url("/api/v1/edge/trust-set/trust-set.json.sig"), HttpMethod.GET,
                new HttpEntity<>(new HttpHeaders()), String.class);
        assertThat(sigFile.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(sigFile.getBody()).isEqualTo(sig);

        // (4) Die Betreiber-Sicht leitet die Anzeige-Felder ab, ohne die
        // Bytes anzufassen.
        ResponseEntity<Map<String, Object>> view = rest.exchange(
                url("/api/v1/admin/edge-trust-set"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), new ParameterizedTypeReference<>() {});
        assertThat(view.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(view.getBody().get("keyIds")).isEqualTo("rel-2026-b");
        assertThat(view.getBody().get("signingKeyId")).isEqualTo("root-2026-a");
        assertThat(view.getBody().get("generatedAt")).isEqualTo("2026-08-04T10:00:00Z");
        assertThat(view.getBody().get("trustSet")).isEqualTo(set2);

        // (5) FORM-Prüfungen. Die api prüft die Signatur NICHT (das Gerät ist
        // der einzige Verifizierer, auf den es ankommt) - aber ein formal
        // kaputtes Set würde die Box nur mit einem Umweg erreichen.
        assertTrustSetRefused(admin, set, sig.replace("\"domain\":\"trust-set\"",
                "\"domain\":\"release\""), "nicht fuer ein Trust-Set");
        assertTrustSetRefused(admin, set, sig.replace("ed25519", "ed448"),
                "akzeptiert wird ausschliesslich ed25519");
        // DER Invariant: die WURZEL gehört nie ins Set - sonst könnte ein
        // Trust-Set die Wurzel erweitern. (Beim Release ist es umgekehrt:
        // dort MÜSSEN Manifest und Signatur denselben Schlüssel nennen.)
        assertTrustSetRefused(admin, set.replace("rel-2026-a", "root-2026-a"), sig,
                "steht selbst im Trust-Set");
        assertTrustSetRefused(admin, "{\"schema_version\":\"1.0\",\"keys\":[]}", sig,
                "keinen einzigen Schluessel");
        assertTrustSetRefused(admin, set.replace(b64(32), b64(31)), sig, "statt 32 Bytes");
        assertTrustSetRefused(admin, "kein json", sig, "kein gueltiges JSON");

        // (6) Und die Rollen-Grenze bleibt, wie sie war: hochladen ja, alles
        // andere nein. Ein KUNDE erreicht beides nicht.
        assertForbidden(publisher, HttpMethod.GET, "/api/v1/admin/edge-trust-set", null);
        // ⚠ Der Rumpf ist bewusst GÜLTIG: Bean-Validation läuft VOR
        // @PreAuthorize, ein krummer ergäbe 400 statt 403.
        assertForbidden(publisher, HttpMethod.POST, "/api/v1/admin/rollouts",
                Map.of("releaseSeq", 1, "devices", List.of(UUID.randomUUID().toString())));
        String customer = token("demo", "demo");
        assertThat(putTrustSet(customer, Map.of("trustSet", set, "signature", sig))
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertForbidden(customer, HttpMethod.GET, "/api/v1/admin/edge-trust-set", null);
        assertThat(rest.exchange(url("/api/v1/admin/edge-trust-set"), HttpMethod.PUT,
                new HttpEntity<>(Map.of("trustSet", set, "signature", sig), new HttpHeaders()),
                String.class).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** Base64 von n Null-Bytes - Form statt Kryptografie (die api prüft keine Signatur). */
    private static String b64(int n) {
        return java.util.Base64.getEncoder().encodeToString(new byte[n]);
    }

    private ResponseEntity<Map<String, Object>> putTrustSet(String token, Map<String, ?> body) {
        return rest.exchange(url("/api/v1/admin/edge-trust-set"), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
    }

    /** Ein formal kaputtes Set wird mit einem DEUTSCHEN Grund abgelehnt. */
    private void assertTrustSetRefused(String token, String set, String sig, String reason) {
        ResponseEntity<Map<String, Object>> res =
                putTrustSet(token, Map.of("trustSet", set, "signature", sig));
        assertThat(res.getStatusCode()).as(reason).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(String.valueOf(res.getBody().get("message"))).contains(reason);
    }

    /** Eine Route, die dieses Token NICHT erreichen darf. */
    private void assertForbidden(String token, HttpMethod method, String path, Object body) {
        assertThat(rest.exchange(url(path), method,
                new HttpEntity<>(body, bearer(token)), String.class).getStatusCode())
                .as(method + " " + path).isEqualTo(HttpStatus.FORBIDDEN);
    }

    /**
     * client_credentials-Token eines Dienstkontos (kein Benutzer, kein
     * Passwort-Grant) - genau der Weg, den der CI-Lauf geht.
     */
    private String serviceToken(String clientId, String clientSecret) {
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "client_credentials");
        form.add("client_id", clientId);
        form.add("client_secret", clientSecret);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = keycloakRest().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("client_credentials for " + clientId).containsKey("access_token");
        return (String) body.get("access_token");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> listReleases(String adminToken) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/admin/edge-releases"), HttpMethod.GET,
                new HttpEntity<>(bearer(adminToken)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private ResponseEntity<Map<String, Object>> postRelease(String token, Map<String, ?> body) {
        return rest.exchange(url("/api/v1/admin/edge-releases"), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
    }

    private Map<String, Object> createRelease(String adminToken, Map<String, ?> body) {
        ResponseEntity<Map<String, Object>> res = postRelease(adminToken, body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    /** Die ganze Flotten-Antwort (Zeilen PLUS Release-Register). */
    private Map<String, Object> fleetBody(String adminToken) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/fleet"), HttpMethod.GET, new HttpEntity<>(bearer(adminToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    /** Der Flotten-Puls, als Liste von Zeilen. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> fleet(String adminToken) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/fleet"), HttpMethod.GET, new HttpEntity<>(bearer(adminToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("sites");
    }

    /** 14 bewertete Tage mit konstantem normiertem Fehler (Superuser-Seed). */
    private static void seedForecastAccuracy(String tenantId, UUID siteId, String model,
            String kind, double nmaePct) {
        exec("INSERT INTO forecast_accuracy (day, tenant_id, site_id, model, kind, mae_kw, "
                + "nmae_pct, n_slots) SELECT current_date - g, '" + tenantId + "', '" + siteId
                + "', '" + model + "', '" + kind + "', 1.0, " + nmaePct
                + ", 96 FROM generate_series(1, 10) g");
    }

    private Map<String, Object> createTenant(String token, String name, String segment) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/tenants"), HttpMethod.POST,
                new HttpEntity<>(Map.of("name", name, "segment", segment), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    @Autowired
    com.voltpilot.api.admin.KeycloakAdminClient keycloakAdmin;

    private Map<String, Object> createUser(String token, String tenantId, String username,
            String email, String password) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                url("/api/v1/admin/tenants/" + tenantId + "/users"), HttpMethod.POST,
                new HttpEntity<>(Map.of("username", username, "email", email), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Map<String, Object> konto = (Map<String, Object>) res.getBody().get("benutzer");
        String sub = (String) konto.get("sub");
        // Bestandsprüfungen setzen nach dem Pflichtwechsel an; der volle Weg steht im IP-14-Test.
        keycloakAdmin.resetPassword(sub, password, false);
        return Map.of("id", sub, "username", username, "email", email, "tenantId", tenantId, "enabled", true);
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

    /** Scalar numeric query as the Postgres superuser (sees all tenants' rows). */
    private static double queryDouble(String sql) {
        try (Connection c = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getDouble(1);
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
