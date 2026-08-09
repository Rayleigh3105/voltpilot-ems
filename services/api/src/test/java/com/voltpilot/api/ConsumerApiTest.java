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
 * End-to-end test of the steuerbare-Verbraucher surface (Increment 1) against a
 * REAL TimescaleDB + Keycloak: consumer CRUD, the capability intersection (§16),
 * optimistic versioning, the DELETE-while-connected guard, policy draft
 * versioning + validation, and RLS isolation (tenant A cannot read/write tenant
 * B). Auto-skips without Docker. The BERLIN dev-seed site (tenant A) has a
 * battery asset, so {@code consumer-options.hasStorage} is true there.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ConsumerApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
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

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Test
    void optionsAreCapabilityAndContextFiltered() {
        Map<String, Object> options = getMap("/api/v1/sites/" + BERLIN_SITE + "/consumer-options",
                token("demo", "demo"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> types = (List<Map<String, Object>>) options.get("types");
        assertThat(types).extracting(t -> t.get("type"))
                .contains("wallbox", "heating-rod", "pump", "generic-load")
                .doesNotContain("battery-hybrid", "grid-meter", "house-load");
        // generic-load has no setpoint_kw -> only on_off (never stepped/continuous).
        Map<String, Object> generic = types.stream()
                .filter(t -> "generic-load".equals(t.get("type"))).findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        List<String> genericKinds = (List<String>) generic.get("controlKinds");
        assertThat(genericKinds).containsExactly("on_off");
        Map<String, Object> wallbox = types.stream()
                .filter(t -> "wallbox".equals(t.get("type"))).findFirst().orElseThrow();
        @SuppressWarnings("unchecked")
        List<String> wallboxKinds = (List<String>) wallbox.get("controlKinds");
        assertThat(wallboxKinds).contains("continuous");
        assertThat((List<?>) options.get("signals")).isNotEmpty();
        assertThat((List<?>) options.get("intents")).hasSize(4);
        assertThat(options.get("hasStorage")).isEqualTo(Boolean.TRUE);
    }

    @Test
    void draftConsumerNeverClaimsALiveState() {
        String tok = token("demo", "demo");
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "name", "Heizstab Keller",
                "ratedPowerKw", 3.0, "controlKind", "on_off"));
        assertThat(c.get("connection")).isEqualTo("disconnected");
        assertThat(c.get("controlActivation")).isEqualTo("not_activated");
        assertThat(c.get("typeLabel")).isEqualTo("Heizstab");
        assertThat(c.get("version")).isEqualTo(1);
        assertThat(c.get("hasDraftPolicy")).isEqualTo(Boolean.FALSE);
        // An unconnected draft is deletable (returns the site to its prior state).
        String id = (String) c.get("id");
        assertThat(delete(tok, id).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
    }

    @Test
    void aCustomerValueCannotWidenTheHardwareCapability() {
        // generic-load cannot do continuous (no setpoint_kw) -> 422, never silently allowed.
        ResponseEntity<Map<String, Object>> res = post(token("demo", "demo"),
                "/api/v1/sites/" + BERLIN_SITE + "/consumers",
                Map.of("type", "generic-load", "ratedPowerKw", 2.0, "controlKind", "continuous"));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat((String) res.getBody().get("message")).contains("Regelart");
    }

    @Test
    void connectedConsumerIsGuardedAgainstDeletion() {
        String tok = token("demo", "demo");
        Map<String, Object> c = create(tok, Map.of(
                "type", "wallbox", "name", "Wallbox verbunden", "ratedPowerKw", 11.0,
                "controlKind", "continuous", "edgeSourceId", "edge-src-conn-1"));
        assertThat(c.get("connection")).isEqualTo("connected");
        ResponseEntity<Map<String, Object>> del = delete(tok, (String) c.get("id"));
        assertThat(del.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) del.getBody().get("message")).contains("verbunden");
    }

    @Test
    void patchIsOptimisticOverVersion() {
        String tok = token("demo", "demo");
        Map<String, Object> c = create(tok, Map.of(
                "type", "pump", "name", "Stallpumpe", "ratedPowerKw", 2.2, "controlKind", "on_off"));
        String id = (String) c.get("id");
        // A stale expectedVersion is refused.
        assertThat(patch(tok, id, Map.of("name", "Neu", "expectedVersion", 99)).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        // The current version succeeds and bumps.
        ResponseEntity<Map<String, Object>> ok = patch(tok, id,
                Map.of("name", "Stallpumpe Hof", "expectedVersion", 1));
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getBody().get("version")).isEqualTo(2);
        assertThat(ok.getBody().get("name")).isEqualTo("Stallpumpe Hof");
    }

    @Test
    void policyDraftsValidateAndVersion() {
        String tok = token("demo", "demo");
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "name", "Heizstab Regel", "ratedPowerKw", 3.0,
                "controlKind", "on_off"));
        String id = (String) c.get("id");
        String base = "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id + "/policy";

        // No policy yet -> 204.
        assertThat(rest.exchange(url(base), HttpMethod.GET, new HttpEntity<>(bearer(tok)),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        // A valid heater policy stores draft v1; the entity_id is stamped from the path.
        Map<String, Object> req = Map.of("document", heaterPolicy("ignored-entity"));
        ResponseEntity<Map<String, Object>> v1 = put(tok, base, req);
        assertThat(v1.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(v1.getBody().get("version")).isEqualTo(1);
        assertThat(v1.getBody().get("lifecycle")).isEqualTo("draft");
        assertThat((String) v1.getBody().get("contentHash")).startsWith("sha256:");
        @SuppressWarnings("unchecked")
        Map<String, Object> stored = (Map<String, Object>) v1.getBody().get("document");
        assertThat(stored.get("entity_id")).isEqualTo(id);

        // Saving again creates a NEW draft version.
        ResponseEntity<Map<String, Object>> v2 = put(tok, base, req);
        assertThat(v2.getBody().get("version")).isEqualTo(2);

        // GET returns the latest, and the consumer now advertises a draft policy.
        Map<String, Object> latest = getMap(base, tok);
        assertThat(latest.get("version")).isEqualTo(2);
        assertThat(getMap("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id, tok)
                .get("hasDraftPolicy")).isEqualTo(Boolean.TRUE);
    }

    @Test
    void anInvalidPolicyIsRejectedWithAGermanMessage() {
        String tok = token("demo", "demo");
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "ratedPowerKw", 3.0, "controlKind", "on_off"));
        String base = "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + c.get("id") + "/policy";
        // must_run + grid_energy_policy=forbid is invalid (§10, E2).
        Map<String, Object> bad = Map.of("document", Map.of(
                "schema_version", "1.0", "entity_id", "x",
                "requirements", List.of(Map.of(
                        "id", "r", "kind", "fixed_window", "enforcement", "must_run",
                        "grid_energy_policy", "forbid",
                        "recurrence", Map.of("days", "daily", "from", "13:00", "to", "14:00"),
                        "target", Map.of("kind", "on_off", "value", true)))));
        ResponseEntity<Map<String, Object>> res = put(tok, base, bad);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) res.getBody().get("message")).isNotBlank();
    }

    @Test
    void consumersAreTenantScoped() {
        String tokA = token("demo", "demo");
        Map<String, Object> mine = create(tokA, Map.of(
                "type", "wallbox", "name", "Nur meine", "ratedPowerKw", 11.0,
                "controlKind", "continuous"));
        String id = (String) mine.get("id");

        String tokB = token("demo2", "demo2");
        // Tenant B cannot even see tenant A's site (RLS => 404 on every route).
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumers"), HttpMethod.GET,
                new HttpEntity<>(bearer(tokB)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id),
                HttpMethod.GET, new HttpEntity<>(bearer(tokB)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        ResponseEntity<Map<String, Object>> spoof = post(tokB,
                "/api/v1/sites/" + BERLIN_SITE + "/consumers",
                Map.of("type", "wallbox", "ratedPowerKw", 11.0));
        assertThat(spoof.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // Tenant A still sees its own consumer.
        assertThat(getMap("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id, tokA).get("name"))
                .isEqualTo("Nur meine");
    }

    @Test
    void consumerScheduleServesTheNewestRunTenantScopedWithHonestEmptyState() throws Exception {
        String tokA = token("demo", "demo");
        // 1. Honest empty state: no stored run -> a well-formed empty document,
        // never a 404 and never fabricated slots (the normal production state
        // while VOLTPILOT_V2_PLAN_SITES is empty).
        Map<String, Object> empty = getMap(
                "/api/v1/sites/" + BERLIN_SITE + "/consumer-schedule", tokA);
        assertThat(empty.get("planId")).isNull();
        assertThat(empty.get("generatedAt")).isNull();
        assertThat((List<?>) empty.get("entities")).isEmpty();

        // 2. A consumer entity (its label feeds the response) + two runs seeded
        // as the optimizer's trusted backend role (superuser, tenant stamped -
        // the weather-collector pattern the shadow writer uses).
        Map<String, Object> c = create(tokA, Map.of(
                "type", "pump", "name", "Stallpumpe", "ratedPowerKw", 2.2,
                "controlKind", "on_off"));
        String entityId = (String) c.get("id");
        String tenantA = "00000000-0000-0000-0000-000000000001";
        java.util.UUID oldPlan = java.util.UUID.randomUUID();
        java.util.UUID newPlan = java.util.UUID.randomUUID();
        java.time.Instant oldRun = java.time.Instant.parse("2026-08-10T11:45:00Z");
        java.time.Instant newRun = java.time.Instant.parse("2026-08-10T12:00:00Z");
        java.time.Instant slot0 = java.time.Instant.parse("2026-08-10T12:00:00Z");
        java.time.Instant slot1 = java.time.Instant.parse("2026-08-10T12:15:00Z");
        try (java.sql.Connection conn = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = conn.createStatement()) {
            for (Object[] run : new Object[][] {
                    {oldPlan, oldRun}, {newPlan, newRun}}) {
                st.executeUpdate("INSERT INTO site_plan_run (plan_id, tenant_id, site_id, "
                        + "generated_at, horizon_slots, slot_minutes) VALUES ('" + run[0]
                        + "', '" + tenantA + "', '" + BERLIN_SITE + "', '" + run[1]
                        + "', 96, 15)");
            }
            // The superseded run says OFF; the newest run says ON - the
            // endpoint must serve ONLY the newest.
            st.executeUpdate("INSERT INTO entity_plan_slot (time, tenant_id, site_id, "
                    + "plan_id, generated_at, entity_id, command, target_value, reason_code, "
                    + "requirement_id) VALUES ('" + slot0 + "', '" + tenantA + "', '"
                    + BERLIN_SITE + "', '" + oldPlan + "', '" + oldRun + "', '" + entityId
                    + "', 'on_off', 0, NULL, NULL)");
            st.executeUpdate("INSERT INTO entity_plan_slot (time, tenant_id, site_id, "
                    + "plan_id, generated_at, entity_id, command, target_value, reason_code, "
                    + "requirement_id) VALUES ('" + slot0 + "', '" + tenantA + "', '"
                    + BERLIN_SITE + "', '" + newPlan + "', '" + newRun + "', '" + entityId
                    + "', 'on_off', 1, 'fixed_window', 'pump-daily'), ('" + slot1 + "', '"
                    + tenantA + "', '" + BERLIN_SITE + "', '" + newPlan + "', '" + newRun
                    + "', '" + entityId + "', 'on_off', 1, 'optimizer_selected_low_cost', "
                    + "'pump-daily')");
        }

        // 3. The newest run, whole - label joined, slots ordered, reasons machine-readable.
        Map<String, Object> schedule = getMap(
                "/api/v1/sites/" + BERLIN_SITE + "/consumer-schedule", tokA);
        assertThat(schedule.get("planId")).isEqualTo(newPlan.toString());
        assertThat(schedule.get("slotMinutes")).isEqualTo(15);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> entities = (List<Map<String, Object>>) schedule.get("entities");
        assertThat(entities).hasSize(1);
        assertThat(entities.get(0).get("entityId")).isEqualTo(entityId);
        assertThat(entities.get(0).get("name")).isEqualTo("Stallpumpe");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> slots = (List<Map<String, Object>>) entities.get(0).get("slots");
        assertThat(slots).hasSize(2);
        assertThat(slots.get(0).get("command")).isEqualTo("on_off");
        assertThat(slots.get(0).get("reasonCode")).isEqualTo("fixed_window");
        assertThat(slots.get(1).get("reasonCode")).isEqualTo("optimizer_selected_low_cost");
        assertThat(slots.get(1).get("requirementId")).isEqualTo("pump-daily");

        // 4. RLS: tenant B gets 404 on the same route, never data.
        assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumer-schedule"),
                HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))),
                String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // --- helpers -------------------------------------------------------------

    private Map<String, Object> heaterPolicy(String entityId) {
        return Map.of(
                "schema_version", "1.0", "entity_id", entityId, "timezone", "Europe/Berlin",
                "requirements", List.of(
                        Map.of("id", "heater-noon", "kind", "fixed_window", "enforcement", "must_run",
                                "recurrence", Map.of("days", "daily", "from", "13:00", "to", "14:00"),
                                "target", Map.of("kind", "on_off", "value", true)),
                        Map.of("id", "heater-cheap", "kind", "reactive", "enforcement", "must_run",
                                "condition", Map.of("signal", "market.spot_price_ct_kwh",
                                        "operator", "lt", "value", 5),
                                "target", Map.of("kind", "on_off", "value", true))));
    }

    private Map<String, Object> create(String token, Map<String, Object> body) {
        ResponseEntity<Map<String, Object>> res = post(token,
                "/api/v1/sites/" + BERLIN_SITE + "/consumers", body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return res.getBody();
    }

    private ResponseEntity<Map<String, Object>> post(String token, String path,
            Map<String, Object> body) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<Map<String, Object>> put(String token, String path,
            Map<String, Object> body) {
        return rest.exchange(url(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<Map<String, Object>> patch(String token, String id,
            Map<String, Object> body) {
        // The default TestRestTemplate uses HttpURLConnection, which refuses PATCH;
        // the JDK HttpClient-based factory supports it (AdminApiTest precedent).
        TestRestTemplate patchRest = new TestRestTemplate();
        patchRest.getRestTemplate().setRequestFactory(new JdkClientHttpRequestFactory());
        return patchRest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id),
                HttpMethod.PATCH, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<Map<String, Object>> delete(String token, String id) {
        return rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id),
                HttpMethod.DELETE, new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private Map<String, Object> getMap(String path, String token) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
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
        @SuppressWarnings("unchecked")
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
