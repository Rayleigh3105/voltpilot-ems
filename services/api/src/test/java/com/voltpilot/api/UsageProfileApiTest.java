package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import dasniko.testcontainers.keycloak.KeycloakContainer;
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
 * End-to-end proof of the AE7 Nutzungsprofil surface (contract
 * docs/contracts/v2/usage-profile.md) against a REAL Keycloak + TimescaleDB:
 *
 * <ul>
 *   <li>the profile is DERIVED from the site's money master data (plant_kind,
 *       Leistungspreis) and the emphasis map follows it;</li>
 *   <li>an explicit override wins and is clearable;</li>
 *   <li>node governance: the gated strategy nodes and per-site enablement;</li>
 *   <li>auto-start seeds the profile's starter-flow draft, idempotently.</li>
 * </ul>
 * Auto-skips without Docker.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class UsageProfileApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String ADMIN_USER = "voltpilot_admin";
    private static final String ADMIN_PW = "voltpilot_admin_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK =
            new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
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
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
    void profileDerivesFromMasterDataAndOverrideWinsAndClears() {
        String demo = token("demo", "demo");

        // A Direktvermarktung site derives arbitrage (money prominent).
        String dvSite = createSite(demo, "AE7 DV", "direktvermarktung");
        JsonNode arb = getProfile(demo, dvSite, null);
        assertThat(arb.path("usageProfile").asText()).isEqualTo("arbitrage");
        assertThat(arb.path("derivedProfile").asText()).isEqualTo("arbitrage");
        assertThat(arb.path("override").isNull()).isTrue();
        assertThat(arb.path("emphasis").path("money").asText()).isEqualTo("prominent");
        assertThat(arb.path("emphasis").path("peak").asText()).isEqualTo("hidden");
        assertThat(arb.path("signals").path("plantKind").asText()).isEqualTo("direktvermarktung");

        // An Eigenverbrauch site with no market/peak derives private (flow prominent).
        String evSite = createSite(demo, "AE7 EV", "eigenverbrauch");
        JsonNode priv = getProfile(demo, evSite, null);
        assertThat(priv.path("usageProfile").asText()).isEqualTo("private");
        assertThat(priv.path("emphasis").path("money").asText()).isEqualTo("minimal");
        assertThat(priv.path("emphasis").path("flow").asText()).isEqualTo("prominent");

        // An explicit override wins over the derived default.
        JsonNode over = putOverride(demo, evSite, Map.of("override", "peak"));
        assertThat(over.path("usageProfile").asText()).isEqualTo("peak");
        assertThat(over.path("override").asText()).isEqualTo("peak");
        assertThat(over.path("derivedProfile").asText()).isEqualTo("private");
        assertThat(over.path("emphasis").path("peak").asText()).isEqualTo("prominent");
        // The override echoes on the SiteDto too.
        assertThat(siteDtoField(demo, evSite, "usageProfileOverride")).isEqualTo("peak");

        // Clearing (null) reverts to auto-derive.
        JsonNode cleared = putOverride(demo, evSite, java.util.Collections.singletonMap("override",
                null));
        assertThat(cleared.path("usageProfile").asText()).isEqualTo("private");
        assertThat(cleared.path("override").isNull()).isTrue();

        // A bogus override is refused.
        ResponseEntity<JsonNode> bad = exchange("/api/v1/sites/" + evSite + "/profile",
                HttpMethod.PUT, demo, null, Map.of("override", "grey"));
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void configuredLeistungspreisDerivesPeak() {
        String demo = token("demo", "demo");
        String admin = token("admin", "admin");
        String site = createSite(demo, "AE7 Peak", "eigenverbrauch");

        // Admin turns on the peak-shaving module (Leistungspreis) via the switcher.
        ResponseEntity<JsonNode> cfg = exchange(
                "/api/v1/admin/sites/" + site + "/optimizer-config", HttpMethod.PUT, admin,
                TENANT_A, Map.of("leistungspreisEurKw", 120.0, "abrechnungLeistung", "jahr"));
        assertThat(cfg.getStatusCode()).isEqualTo(HttpStatus.OK);

        JsonNode profile = getProfile(demo, site, null);
        assertThat(profile.path("usageProfile").asText()).isEqualTo("peak");
        assertThat(profile.path("signals").path("hasLeistungspreis").asBoolean()).isTrue();
        assertThat(profile.path("emphasis").path("peak").asText()).isEqualTo("prominent");
    }

    @Test
    void foreignSiteProfileIsNotFound() {
        String demo = token("demo", "demo");
        String demo2 = token("demo2", "demo2");
        String site = createSite(demo, "AE7 Foreign", "eigenverbrauch");
        // Tenant B cannot read tenant A's profile (RLS -> 404, not 403).
        ResponseEntity<JsonNode> res = exchange("/api/v1/sites/" + site + "/profile",
                HttpMethod.GET, demo2, null, null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void nodeGovernanceAndAutoStart() {
        String admin = token("admin", "admin");

        // Bootstrap the pilot entities so BERLIN has a battery-hybrid.
        exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/v2-entities/bootstrap",
                HttpMethod.POST, admin, TENANT_A, Map.of());

        // Governance: the gated nodes (three strategies + the vp.price.current
        // data node, #519 H3-c), all disabled by default.
        JsonNode gov = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.GET, admin, TENANT_A, null).getBody();
        assertThat(gov.path("gatedNodes").size()).isEqualTo(4);
        for (JsonNode n : gov.path("gatedNodes")) {
            assertThat(n.path("gated").asBoolean()).isTrue();
            assertThat(n.path("enabled").asBoolean()).isFalse();
        }

        // Enable the market node.
        JsonNode enabled = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance",
                HttpMethod.PUT, admin, TENANT_A,
                Map.of("enablements",
                        java.util.List.of(Map.of("nodeType", "vp.strategy.market", "enabled",
                                true)))).getBody();
        boolean marketEnabled = false;
        for (JsonNode n : enabled.path("gatedNodes")) {
            if ("vp.strategy.market".equals(n.path("type").asText())) {
                marketEnabled = n.path("enabled").asBoolean();
            }
        }
        assertThat(marketEnabled).isTrue();

        // An unknown/non-gated node type is refused.
        ResponseEntity<JsonNode> badGov = exchange(
                "/api/v1/admin/sites/" + BERLIN_SITE + "/flow-node-governance", HttpMethod.PUT,
                admin, TENANT_A,
                Map.of("enablements",
                        java.util.List.of(Map.of("nodeType", "vp.entity.control", "enabled",
                                true))));
        assertThat(badGov.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        // Auto-start: BERLIN is eigenverbrauch with a battery -> private starter.
        ResponseEntity<JsonNode> seeded = exchange(
                "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/auto-start", HttpMethod.POST, admin,
                TENANT_A, null);
        assertThat(seeded.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(seeded.getBody().path("created").asBoolean()).isTrue();
        assertThat(seeded.getBody().path("profile").asText()).isEqualTo("private");
        assertThat(seeded.getBody().path("flowId").isNull()).isFalse();

        // Idempotent: a second call is a no-op (already_has_flow).
        ResponseEntity<JsonNode> again = exchange(
                "/api/v1/admin/sites/" + BERLIN_SITE + "/flows/auto-start", HttpMethod.POST, admin,
                TENANT_A, null);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody().path("created").asBoolean()).isFalse();
        assertThat(again.getBody().path("reason").asText()).isEqualTo("already_has_flow");

        // The seeded draft is a valid Eigenverbrauch starter (validates clean).
        JsonNode flows = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows", HttpMethod.GET,
                admin, TENANT_A, null).getBody();
        String flowId = flows.get(0).path("flowId").asText();
        JsonNode validation = exchange("/api/v1/admin/sites/" + BERLIN_SITE + "/flows/" + flowId
                + "/versions/1/validate", HttpMethod.POST, admin, TENANT_A, Map.of()).getBody();
        assertThat(validation.path("valid").asBoolean())
                .as("starter validates: " + validation.path("findings")).isTrue();
    }

    // ---- helpers -------------------------------------------------------------

    private String createSite(String token, String name, String plantKind) {
        ResponseEntity<JsonNode> res = exchange("/api/v1/sites", HttpMethod.POST, token, null,
                Map.of("name", name, "biddingZone", "DE-LU", "plantKind", plantKind));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody().path("id").asText();
    }

    private JsonNode getProfile(String token, String siteId, String tenant) {
        ResponseEntity<JsonNode> res = exchange("/api/v1/sites/" + siteId + "/profile",
                HttpMethod.GET, token, tenant, null);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private JsonNode putOverride(String token, String siteId, Map<String, Object> body) {
        ResponseEntity<JsonNode> res = exchange("/api/v1/sites/" + siteId + "/profile",
                HttpMethod.PUT, token, null, body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private String siteDtoField(String token, String siteId, String field) {
        JsonNode sites = exchange("/api/v1/sites", HttpMethod.GET, token, null, null).getBody();
        for (JsonNode s : sites) {
            if (siteId.equals(s.path("id").asText())) {
                return s.path(field).asText();
            }
        }
        return null;
    }

    private ResponseEntity<JsonNode> exchange(String path, HttpMethod method, String token,
            String tenant, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (tenant != null) {
            headers.add("X-Tenant-Id", tenant);
        }
        HttpEntity<?> entity = body != null ? new HttpEntity<>(body, headers)
                : new HttpEntity<>(headers);
        return rest.exchange("http://localhost:" + port + path, method, entity,
                new ParameterizedTypeReference<JsonNode>() {});
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
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
