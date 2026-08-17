package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import com.voltpilot.api.consumers.ConsumerRuntimeStatusListener;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.tenant.TenantContext;
import java.util.UUID;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
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

    @Autowired
    DeviceRepository deviceRepository;

    @Autowired
    ConsumerRuntimeStatusRepository runtimeStatusRepository;

    @Autowired
    com.voltpilot.api.consumers.ConsumerRequirementLedgerWriter ledgerWriter;

    @Autowired
    com.voltpilot.api.rules.RuleEventWriter ruleEventWriter;

    @Autowired
    com.voltpilot.api.command.CommandLogWriter commandLogWriter;

    @Autowired
    com.voltpilot.api.repo.ConsumerRequirementStateRepository requirementStateRepository;

    @Autowired
    org.springframework.jdbc.core.JdbcTemplate jdbc;

    /**
     * Records every registry push so the test can assert the cycle-guard
     * limits actually ride it (D-9). Without this bean the provider is empty
     * and composePush's payload is discarded unchecked.
     */
    @TestConfiguration
    static class RecordingPublisherConfig {
        static final List<byte[]> PUSHES = new CopyOnWriteArrayList<>();

        @Bean
        EntityRegistryPublisher entityRegistryPublisher() {
            EntityRegistryPublisher pub = Mockito.mock(EntityRegistryPublisher.class);
            Mockito.when(pub.publishRegistry(Mockito.any(), Mockito.any(), Mockito.any(),
                    Mockito.any())).thenAnswer(inv -> {
                        PUSHES.add(inv.getArgument(3));
                        return true;
                    });
            return pub;
        }
    }

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

    @Test
    void consumersHeartbeatIsIngestedTenantScopedAndCycleLimitsRideTheRegistryPush() {
        String tok = token("demo", "demo");
        String device = "00000000-0000-0000-0000-000000000003"; // BERLIN seed inverter
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "name", "Heizstab Statusbad",
                "ratedPowerKw", 3.0, "controlKind", "on_off",
                "minOnSeconds", 120, "minOffSeconds", 180, "maxStartsPerDay", 8));
        String id = (String) c.get("id");
        try {
            // The CRUD echoes the cycle-guard bounds ...
            assertThat(c.get("minOnSeconds")).isEqualTo(120);
            assertThat(c.get("minOffSeconds")).isEqualTo(180);
            assertThat(c.get("maxStartsPerDay")).isEqualTo(8);
            // ... and they ride the registry push as guards.limits (D-9), so
            // the edge's temporal cycle guard learns them.
            assertThat(RecordingPublisherConfig.PUSHES).isNotEmpty();
            String push = new String(RecordingPublisherConfig.PUSHES
                    .get(RecordingPublisherConfig.PUSHES.size() - 1), StandardCharsets.UTF_8);
            assertThat(push).contains(id)
                    .contains("\"min_on_seconds\":120")
                    .contains("\"min_off_seconds\":180")
                    .contains("\"max_starts_per_day\":8");

            // Honest empty state before any heartbeat: empty list, 204 single.
            ResponseEntity<List<Map<String, Object>>> empty = rest.exchange(
                    url("/api/v1/sites/" + BERLIN_SITE + "/consumer-status"), HttpMethod.GET,
                    new HttpEntity<>(bearer(tok)), new ParameterizedTypeReference<>() {});
            assertThat(empty.getBody()).isEmpty();
            assertThat(rest.exchange(
                    url("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id + "/status"),
                    HttpMethod.GET, new HttpEntity<>(bearer(tok)), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

            // A heartbeat consumers block arrives (the pure listener parse +
            // the MQTT transport are proven elsewhere; here the REAL repos +
            // RLS carry it): known entity kept, a foreign id and an unknown
            // state word discarded.
            ConsumerRuntimeStatusListener listener = new ConsumerRuntimeStatusListener(
                    "tcp://localhost:1883", "", "", deviceRepository, runtimeStatusRepository,
                    ledgerWriter, ruleEventWriter, commandLogWriter);
            String topic = "ems/00000000-0000-0000-0000-000000000001/" + BERLIN_SITE + "/"
                    + device + "/status";
            String hb = "{\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                    + "\"site_id\":\"" + BERLIN_SITE + "\",\"device_id\":\"" + device + "\","
                    + "\"ts\":\"2026-08-10T12:00:00Z\",\"consumers\":{"
                    + "\"" + id + "\":{\"state\":\"waiting\",\"reason_code\":\"guard_min_off\","
                    + "\"requirement_progress\":{\"runtime_seconds_today\":600,\"starts_today\":2}},"
                    + "\"99999999-0000-0000-0000-000000000009\":{\"state\":\"waiting\"}}}";
            listener.handle(topic, hb.getBytes(StandardCharsets.UTF_8));

            ResponseEntity<List<Map<String, Object>>> list = rest.exchange(
                    url("/api/v1/sites/" + BERLIN_SITE + "/consumer-status"), HttpMethod.GET,
                    new HttpEntity<>(bearer(tok)), new ParameterizedTypeReference<>() {});
            assertThat(list.getBody()).hasSize(1);
            Map<String, Object> st = list.getBody().get(0);
            assertThat(st.get("entityId")).isEqualTo(id);
            assertThat(st.get("state")).isEqualTo("waiting");
            assertThat(st.get("reasonCode")).isEqualTo("guard_min_off");
            assertThat(st.get("confirmed")).isNull(); // tri-state: no evidence
            assertThat(st.get("runtimeSecondsToday")).isEqualTo(600);
            assertThat(st.get("startsToday")).isEqualTo(2);

            // Wholesale replace: the next heartbeat's truth wins outright.
            String hb2 = hb.replace("\"state\":\"waiting\",\"reason_code\":\"guard_min_off\",",
                    "\"state\":\"running_optimized\",\"actual_kw\":2.9,\"confirmed\":true,");
            listener.handle(topic, hb2.getBytes(StandardCharsets.UTF_8));
            Map<String, Object> st2 = getMap(
                    "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id + "/status", tok);
            assertThat(st2.get("state")).isEqualTo("running_optimized");
            assertThat(st2.get("reasonCode")).isNull();
            assertThat(st2.get("actualKw")).isEqualTo(2.9);
            assertThat(st2.get("confirmed")).isEqualTo(Boolean.TRUE);

            // RLS: tenant B gets 404 on the same routes, never data.
            assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumer-status"),
                    HttpMethod.GET, new HttpEntity<>(bearer(token("demo2", "demo2"))),
                    String.class).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            delete(tok, id);
        }
    }

    @Test
    void theDeadlineDutyRidesTheRegistryPushAndPauseDropsIt() {
        // Verbrauchssteuerung Inkrement 6 (D-20): the ACTIVE policy's
        // required_by_deadline duty rides the registry push as the additive
        // flex_requirements block - resolved power + command included - and a
        // PAUSED consumer drops out (the edge fallback must never self-start a
        // paused device). Real DB: proves the compose SQL + the lifecycle
        // re-push wiring.
        String tok = token("demo", "demo");
        UUID tenantA = UUID.fromString("00000000-0000-0000-0000-000000000001");
        Map<String, Object> c = create(tok, Map.of(
                "type", "generic-load", "name", "Stallpumpe Fallback",
                "ratedPowerKw", 2.2, "controlKind", "on_off"));
        String id = (String) c.get("id");
        String base = "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id;
        try {
            patch(tok, id, Map.of("enabled", true));
            put(tok, base + "/policy", Map.of("document", Map.of(
                    "schema_version", "1.0", "entity_id", id, "timezone", "Europe/Berlin",
                    "requirements", List.of(Map.of(
                            "id", "pump-daily-hour", "kind", "flexible_task",
                            "enforcement", "required_by_deadline",
                            "recurrence", Map.of("days", "daily", "from", "00:00", "to", "24:00"),
                            "demand", Map.of("runtime_minutes", 60, "contiguous", true),
                            "target", Map.of("kind", "on_off", "value", true))))));
            // A DRAFT policy never reaches the push (only ACTIVE composes).
            patch(tok, id, Map.of("minOffSeconds", 45));
            assertThat(lastPush()).contains(id).doesNotContain("flex_requirements");

            // Activation is flag-gated in this context; make the policy ACTIVE
            // the ledger-test way, then re-push via another profile touch.
            TenantContext.set(tenantA);
            try {
                jdbc.update("UPDATE consumer_policy SET lifecycle='active' WHERE entity_id = ?",
                        UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }
            patch(tok, id, Map.of("minOffSeconds", 60));
            assertThat(lastPush()).contains("\"flex_requirements\"")
                    .contains("\"id\":\"pump-daily-hour\"")
                    .contains("\"days\":\"daily\"")
                    .contains("\"from\":\"00:00\"")
                    .contains("\"to\":\"24:00\"")
                    .contains("\"runtime_minutes\":60")
                    .contains("\"power_kw\":2.2")
                    .contains("\"command\":\"on_off\"")
                    .contains("\"timezone\":\"Europe/Berlin\"");

            // PAUSE re-pushes on its own (Inkrement 6) and the paused
            // consumer's duty drops out of the compose (enabled=false).
            assertThat(post(tok, base + "/pause", Map.of()).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            assertThat(lastPush()).contains(id).doesNotContain("flex_requirements");
        } finally {
            delete(tok, id);
        }
    }

    private String lastPush() {
        assertThat(RecordingPublisherConfig.PUSHES).isNotEmpty();
        return new String(RecordingPublisherConfig.PUSHES
                .get(RecordingPublisherConfig.PUSHES.size() - 1), StandardCharsets.UTF_8);
    }

    @Test
    void fulfilmentLedgerIsDerivedFromConfirmedTelemetryAndReadPerConsumer() {
        String tok = token("demo", "demo");
        UUID tenantA = UUID.fromString("00000000-0000-0000-0000-000000000001");
        String device = "00000000-0000-0000-0000-000000000003"; // BERLIN seed inverter
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "name", "Heizstab Ledger", "ratedPowerKw", 3.0,
                "controlKind", "on_off"));
        String id = (String) c.get("id");
        try {
            // Enable it + a DAILY flexible 60-min task, then make the policy
            // ACTIVE and give it a relay confirmation channel directly (activation
            // is flag-gated; the ledger only needs an active policy).
            patch(tok, id, Map.of("enabled", true));
            put(tok, "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id + "/policy", Map.of(
                    "document", Map.of("schema_version", "1.0", "entity_id", id,
                            "timezone", "Europe/Berlin", "requirements", List.of(Map.of(
                                    "id", "rod-daily-hour", "kind", "flexible_task",
                                    "enforcement", "required_by_deadline",
                                    "recurrence", Map.of("days", "daily", "from", "00:00",
                                            "to", "24:00"),
                                    "demand", Map.of("runtime_minutes", 60, "contiguous", true),
                                    "target", Map.of("kind", "on_off", "value", true))))));
            TenantContext.set(tenantA);
            try {
                jdbc.update("UPDATE consumer_policy SET lifecycle='active' WHERE entity_id = ?",
                        UUID.fromString(id));
                jdbc.update("UPDATE consumer_profile SET confirmation_channel='relay_state' "
                        + "WHERE entity_id = ?", UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }

            // Honest empty state before any evidence.
            @SuppressWarnings("unchecked")
            Map<String, Object> before = getMap("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id
                    + "/fulfillment", tok);
            assertThat((List<?>) before.get("tasks")).isEmpty();

            // A heartbeat with 90 min of CONFIRMED relay runtime -> fulfilled by
            // runtime, energy ASSUMED (Nennleistung × Zeit = 3.0 kW × 1.5 h).
            ConsumerRuntimeStatusListener listener = new ConsumerRuntimeStatusListener(
                    "tcp://localhost:1883", "", "", deviceRepository, runtimeStatusRepository,
                    ledgerWriter, ruleEventWriter, commandLogWriter);
            String topic = "ems/" + tenantA + "/" + BERLIN_SITE + "/" + device + "/status";
            String hb = "{\"tenant_id\":\"" + tenantA + "\",\"site_id\":\"" + BERLIN_SITE + "\","
                    + "\"device_id\":\"" + device + "\",\"ts\":\"2026-08-10T12:00:00Z\","
                    + "\"consumers\":{\"" + id + "\":{\"state\":\"running_optimized\","
                    + "\"confirmed\":true,\"requirement_progress\":"
                    + "{\"runtime_seconds_today\":5400,\"starts_today\":1}}}}";
            listener.handle(topic, hb.getBytes(StandardCharsets.UTF_8));

            @SuppressWarnings("unchecked")
            Map<String, Object> after = getMap("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id
                    + "/fulfillment", tok);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> tasks = (List<Map<String, Object>>) after.get("tasks");
            assertThat(tasks).hasSize(1);
            Map<String, Object> t = tasks.get(0);
            assertThat(t.get("requirementId")).isEqualTo("rod-daily-hour");
            assertThat(t.get("state")).isEqualTo("fulfilled");
            assertThat(t.get("energyConfirmation")).isEqualTo("assumed");
            assertThat(t.get("actualRuntimeSeconds")).isEqualTo(5400);
            assertThat(((Number) t.get("actualEnergyKwh")).doubleValue()).isEqualTo(4.5);
            assertThat(t.get("atRisk")).isEqualTo(Boolean.FALSE);

            // RLS: the foreign tenant sees 404, never the fulfilment.
            assertThat(rest.exchange(url("/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id
                            + "/fulfillment"), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            patch(tok, id, Map.of("enabled", false));
            TenantContext.set(tenantA);
            try {
                jdbc.update("DELETE FROM consumer_requirement_state WHERE entity_id = ?",
                        UUID.fromString(id));
                jdbc.update("UPDATE consumer_policy SET lifecycle='retired' WHERE entity_id = ?",
                        UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }
            delete(tok, id);
        }
    }

    @Test
    void manualOverrideIsTtlBoundAuditedAndRlsFenced() {
        String tok = token("demo", "demo");
        UUID tenantA = UUID.fromString("00000000-0000-0000-0000-000000000001");
        UUID device = UUID.fromString("00000000-0000-0000-0000-000000000003");
        Map<String, Object> c = create(tok, Map.of(
                "type", "wallbox", "name", "Wallbox Eingriff", "ratedPowerKw", 11.0,
                "controlKind", "on_off"));
        String id = (String) c.get("id");
        String base = "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id + "/override";
        try {
            // Not connected yet -> 409.
            assertThat(post(tok, base, Map.of("action", "start", "durationMinutes", 30))
                    .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

            // Connect it (set the entity's gateway device directly).
            TenantContext.set(tenantA);
            try {
                jdbc.update("UPDATE measurement_point SET device_id = ? WHERE id = ?", device,
                        UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }

            // Endzeit/Dauer PFLICHT: a start without either is 400.
            assertThat(post(tok, base, Map.of("action", "start")).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);

            // Start with a duration -> recorded, TTL-bound; with the control flag
            // OFF (this context) it is NOT pushed but honestly reported.
            ResponseEntity<Map<String, Object>> start = post(tok, base,
                    Map.of("action", "start", "durationMinutes", 30));
            assertThat(start.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(start.getBody().get("applied")).isEqualTo(Boolean.TRUE);
            assertThat(start.getBody().get("pushed")).isEqualTo(Boolean.FALSE);
            assertThat(start.getBody().get("kind")).isEqualTo("start");
            assertThat(start.getBody().get("endsAt")).isNotNull();

            // The active override is listed.
            ResponseEntity<List<Map<String, Object>>> list = rest.exchange(
                    url("/api/v1/sites/" + BERLIN_SITE + "/consumer-overrides"), HttpMethod.GET,
                    new HttpEntity<>(bearer(tok)), new ParameterizedTypeReference<>() {});
            assertThat(list.getBody()).hasSize(1);
            assertThat(list.getBody().get(0).get("entityId")).isEqualTo(id);

            // "Automatik fortsetzen" clears it.
            ResponseEntity<Map<String, Object>> resume = rest.exchange(url(base),
                    HttpMethod.DELETE, new HttpEntity<>(bearer(tok)),
                    new ParameterizedTypeReference<>() {});
            assertThat(resume.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(resume.getBody().get("kind")).isEqualTo("resume");
            ResponseEntity<List<Map<String, Object>>> gone = rest.exchange(
                    url("/api/v1/sites/" + BERLIN_SITE + "/consumer-overrides"), HttpMethod.GET,
                    new HttpEntity<>(bearer(tok)), new ParameterizedTypeReference<>() {});
            assertThat(gone.getBody()).isEmpty();

            // Audited: override_started + override_cleared exist.
            TenantContext.set(tenantA);
            try {
                Integer events = jdbc.queryForObject(
                        "SELECT count(*) FROM consumer_audit_event WHERE entity_id = ? "
                                + "AND event_type IN ('override_started','override_cleared')",
                        Integer.class, UUID.fromString(id));
                assertThat(events).isEqualTo(2);
            } finally {
                TenantContext.clear();
            }

            // RLS: the foreign tenant sees 404 on the override route.
            assertThat(rest.exchange(url(base), HttpMethod.POST,
                    new HttpEntity<>(Map.of("action", "start", "durationMinutes", 30),
                            bearer(token("demo2", "demo2"))), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            TenantContext.set(tenantA);
            try {
                jdbc.update("DELETE FROM consumer_override WHERE entity_id = ?",
                        UUID.fromString(id));
                jdbc.update("UPDATE measurement_point SET device_id = NULL WHERE id = ?",
                        UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }
            delete(tok, id);
        }
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

    @Test
    void policyLifecycleRoutesAreHonestlyFlagGatedAndRlsFenced() {
        String tok = token("demo", "demo");
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "name", "Heizstab Lifecycle", "ratedPowerKw", 3.0,
                "controlKind", "on_off", "edgeSourceId", "edge-src-lifecycle-1"));
        String id = (String) c.get("id");
        String base = "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id;
        put(tok, base + "/policy", Map.of("document", heaterPolicy("ignored")));

        // This context runs with BOTH Inkrement-4 flags at their default OFF:
        // the options surface says so, and activation refuses HONESTLY (200
        // with activated:false) - the portal keeps "Steuerung noch nicht
        // aktiviert" (§16/§19).
        assertThat(getMap("/api/v1/sites/" + BERLIN_SITE + "/consumer-options", tok)
                .get("policyActivationEnabled")).isEqualTo(Boolean.FALSE);
        ResponseEntity<Map<String, Object>> activate = post(tok, base + "/policy/activate",
                Map.of());
        assertThat(activate.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(activate.getBody().get("activated")).isEqualTo(Boolean.FALSE);
        assertThat(activate.getBody().get("reason")).isEqualTo("activation_disabled");
        assertThat(getMap(base + "/policy", tok).get("lifecycle")).isEqualTo("draft");

        // The STOP paths work regardless of the flags (§16): pause flips the
        // Gesamtschalter off (no broker in this context -> published false)...
        ResponseEntity<Map<String, Object>> pause = post(tok, base + "/pause", Map.of());
        assertThat(pause.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(getMap(base, tok).get("enabled")).isEqualTo(Boolean.FALSE);
        // ...and deactivate answers the honest 409 while nothing is active.
        assertThat(post(tok, base + "/policy/deactivate", Map.of()).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        // resume is a START path and stays flag-gated.
        ResponseEntity<Map<String, Object>> resume = post(tok, base + "/resume", Map.of());
        assertThat(resume.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(resume.getBody().get("activated")).isEqualTo(Boolean.FALSE);

        // RLS: the foreign tenant sees 404 on every lifecycle route.
        String other = token("demo2", "demo2");
        for (String route : new String[] {"/policy/activate", "/policy/deactivate", "/pause",
                "/resume"}) {
            assertThat(post(other, base + route, Map.of()).getStatusCode())
                    .as(route).isEqualTo(HttpStatus.NOT_FOUND);
        }
    }

    /**
     * Das REGEL-PROTOKOLL Ende zu Ende (Einheitsmodell Stufe 5b): aus den
     * Wechseln des Herzschlags wird ein Verlauf, der Zähler steht je Regel, und
     * die Ehrlichkeitsregeln halten gegen die ECHTE Datenbank - die erste
     * Beobachtung erzeugt nichts, ein wiederholter Zustand erzeugt nichts, und
     * ein fremder Mandant sieht 404.
     */
    @Test
    void ruleEventsRecordOnlyTheChangesAndAreTenantScoped() {
        String tok = token("demo", "demo");
        UUID tenantA = UUID.fromString("00000000-0000-0000-0000-000000000001");
        String device = "00000000-0000-0000-0000-000000000003"; // BERLIN seed inverter
        Map<String, Object> c = create(tok, Map.of(
                "type", "heating-rod", "name", "Heizstab Protokoll", "ratedPowerKw", 3.0,
                "controlKind", "on_off"));
        String id = (String) c.get("id");
        String route = "/api/v1/sites/" + BERLIN_SITE + "/rule-events";
        ConsumerRuntimeStatusListener listener = new ConsumerRuntimeStatusListener(
                "tcp://localhost:1883", "", "", deviceRepository, runtimeStatusRepository,
                ledgerWriter, ruleEventWriter, commandLogWriter);
        String topic = "ems/" + tenantA + "/" + BERLIN_SITE + "/" + device + "/status";
        // Das Protokoll gehört der ANLAGE, und diese Klasse teilt sich eine -
        // jeder Herzschlag einer Nachbar-Prüfung schreibt hier mit. Wer
        // handgerechnete Erwartungen hat, RÄUMT den Verlauf vorher ab (die
        // Haus-Disziplin der Preis-Slots), sonst prüft er die Nachbarn mit.
        clearRuleProtocol(tenantA);
        try {
            patch(tok, id, Map.of("enabled", true));
            // Eine AKTIVE Verbraucher-Regel: sie ist die V-5-Zuordnung, über die
            // jedes Ereignis dieser Komponente seine Regel findet.
            put(tok, "/api/v1/sites/" + BERLIN_SITE + "/consumers/" + id + "/policy", Map.of(
                    "document", Map.of("schema_version", "1.0", "entity_id", id,
                            "timezone", "Europe/Berlin", "requirements", List.of(Map.of(
                                    "id", "rod-window", "kind", "flexible_task",
                                    "enforcement", "required_by_deadline",
                                    "recurrence", Map.of("days", "daily", "from", "00:00",
                                            "to", "24:00"),
                                    "demand", Map.of("runtime_minutes", 60, "contiguous", true),
                                    "target", Map.of("kind", "on_off", "value", true))))));
            TenantContext.set(tenantA);
            try {
                jdbc.update("UPDATE consumer_policy SET lifecycle='active' WHERE entity_id = ?",
                        UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }

            // Vor dem ersten Herzschlag: wohlgeformt LEER, kein erfundener Zähler.
            Map<String, Object> leer = getMap(route, tok);
            assertThat((List<?>) leer.get("events")).isEmpty();
            assertThat((List<?>) leer.get("rules")).isEmpty();
            assertThat(leer.get("accuracySeconds")).isEqualTo(15);

            // 1. Herzschlag: die ERSTE Beobachtung ist kein Ereignis - aber der
            // Aufzeichnungs-Beginn wird gesetzt (sonst wäre eine 0 gelogen).
            listener.handle(topic, heartbeat(tenantA, device, id, "waiting",
                    "\"reason_code\":\"guard_min_off\"").getBytes(StandardCharsets.UTF_8));
            Map<String, Object> nachErst = getMap(route, tok);
            assertThat((List<?>) nachErst.get("events")).isEmpty();
            assertThat(nachErst.get("recordingSince")).isNotNull();

            // 2. Herzschlag: derselbe Zustand, nur ein anderer GRUND - kein Wechsel.
            listener.handle(topic, heartbeat(tenantA, device, id, "waiting",
                    "\"reason_code\":\"price_below_threshold\"").getBytes(StandardCharsets.UTF_8));
            assertThat((List<?>) getMap(route, tok).get("events")).isEmpty();

            // 3. Herzschlag: der Lauf beginnt - DAS ist ein Schaltvorgang.
            listener.handle(topic, heartbeat(tenantA, device, id, "running_optimized",
                    "\"actual_kw\":3.0").getBytes(StandardCharsets.UTF_8));
            // 4. Herzschlag: und endet wieder.
            listener.handle(topic, heartbeat(tenantA, device, id, "fulfilled", null)
                    .getBytes(StandardCharsets.UTF_8));

            Map<String, Object> voll = getMap(route, tok);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> events = (List<Map<String, Object>>) voll.get("events");
            assertThat(events).hasSize(2);
            // Neueste zuerst.
            assertThat(events.get(0).get("kind")).isEqualTo("gestoppt");
            assertThat(events.get(1).get("kind")).isEqualTo("gestartet");
            assertThat(events.get(1).get("state")).isEqualTo("running_optimized");
            assertThat(events.get(1).get("previousState")).isEqualTo("waiting");
            assertThat(((Number) events.get(1).get("actualKw")).doubleValue()).isEqualTo(3.0);
            // Die Zuordnung ist der Schnappschuss der aktiven Verbraucher-Regel.
            assertThat(events.get(1).get("ruleKind")).isEqualTo("rezept");
            assertThat(events.get(1).get("ruleRef")).isEqualTo(id);

            @SuppressWarnings("unchecked")
            List<Map<String, Object>> rules = (List<Map<String, Object>>) voll.get("rules");
            assertThat(rules).hasSize(1);
            assertThat(rules.get(0).get("ruleRef")).isEqualTo(id);
            assertThat(rules.get(0).get("lastSwitchedAt")).isNotNull();
            // Der Speicher hat HEUTE zu zeichnen begonnen, also wird der
            // Tageszähler NICHT behauptet - die Fläche sagt „seit HH:MM".
            assertThat(rules.get(0).get("switchedToday")).isNull();
            assertThat(voll.get("countsToday")).isEqualTo(Boolean.FALSE);

            // Ein Speicher, der den Tag ganz gesehen hat, DARF zählen: den
            // Beginn künstlich auf gestern setzen und erneut lesen.
            TenantContext.set(tenantA);
            try {
                jdbc.update("UPDATE rule_event_recording SET started_at = now() - interval '2 days' "
                        + "WHERE site_id = ?", UUID.fromString(BERLIN_SITE));
            } finally {
                TenantContext.clear();
            }
            Map<String, Object> spaeter = getMap(route, tok);
            assertThat(spaeter.get("countsToday")).isEqualTo(Boolean.TRUE);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> gezaehlt =
                    (List<Map<String, Object>>) spaeter.get("rules");
            assertThat(gezaehlt.get(0).get("switchedToday")).isEqualTo(1);

            // RLS: der fremde Mandant sieht 404, nie den Verlauf.
            assertThat(rest.exchange(url(route), HttpMethod.GET,
                    new HttpEntity<>(bearer(token("demo2", "demo2"))), String.class)
                    .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            patch(tok, id, Map.of("enabled", false));
            clearRuleProtocol(tenantA);
            TenantContext.set(tenantA);
            try {
                jdbc.update("DELETE FROM consumer_runtime_status WHERE entity_id = ?",
                        UUID.fromString(id));
                jdbc.update("DELETE FROM consumer_requirement_state WHERE entity_id = ?",
                        UUID.fromString(id));
                jdbc.update("UPDATE consumer_policy SET lifecycle='retired' WHERE entity_id = ?",
                        UUID.fromString(id));
            } finally {
                TenantContext.clear();
            }
            delete(tok, id);
        }
    }

    /** Den Verlauf der geteilten Anlage abräumen (siehe die Notiz oben). */
    private void clearRuleProtocol(UUID tenant) {
        TenantContext.set(tenant);
        try {
            jdbc.update("DELETE FROM rule_event WHERE site_id = ?", UUID.fromString(BERLIN_SITE));
            jdbc.update("DELETE FROM rule_event_recording WHERE site_id = ?",
                    UUID.fromString(BERLIN_SITE));
        } finally {
            TenantContext.clear();
        }
    }

    /** Ein Herzschlag mit genau EINER Verbraucher-Komponente. */
    private static String heartbeat(UUID tenant, String device, String entityId, String state,
            String extra) {
        return "{\"tenant_id\":\"" + tenant + "\",\"site_id\":\"" + BERLIN_SITE + "\","
                + "\"device_id\":\"" + device + "\","
                + "\"consumers\":{\"" + entityId + "\":{\"state\":\"" + state + "\""
                + (extra == null ? "" : "," + extra) + "}}}";
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

    /**
     * The D3 capability chain of the Shelly driver (Bestätigungshierarchie
     * §9.4): a bound edge source that PROVABLY measures power (its reported
     * reading carries load_kw - a metering Shelly 1PM / go-e) yields the
     * power_kw confirmation channel (ledger Stufe 2, energy integrated); a
     * driver-backed source WITHOUT proven measurement (a bare Shelly relay)
     * yields relay_state (Stufe 3, runtime confirmed, energy "angenommen");
     * an unbound draft keeps NULL (never a claimed fulfilment). The
     * consumer-options list carries the honest measuresPower hint per source.
     */
    @org.junit.jupiter.api.Test
    void consumerCreationDerivesTheConfirmationChannelFromTheReportedSource() {
        String tok = token("demo", "demo");
        UUID tenantA = UUID.fromString("00000000-0000-0000-0000-000000000001");
        String device = "00000000-0000-0000-0000-000000000003"; // BERLIN seed inverter
        TenantContext.set(tenantA);
        try {
            jdbc.update("INSERT INTO device_source_status (device_id, source_id, tenant_id, "
                    + "site_id, kind, role, label, brand, load_kw, health, reported_at) VALUES "
                    + "(?::uuid, 'src-sh-pm', ?, ?::uuid, 'source', 'consumer', 'Heizstab PM', "
                    + "'shelly', 2.0, 'ok', now()) ON CONFLICT (device_id, source_id) DO UPDATE "
                    + "SET load_kw = EXCLUDED.load_kw", device, tenantA, BERLIN_SITE);
            jdbc.update("INSERT INTO device_source_status (device_id, source_id, tenant_id, "
                    + "site_id, kind, role, label, brand, load_kw, health, reported_at) VALUES "
                    + "(?::uuid, 'src-sh-bare', ?, ?::uuid, 'source', 'consumer', 'Heizstab ohne "
                    + "Messung', 'shelly', NULL, 'ok', now()) ON CONFLICT (device_id, source_id) "
                    + "DO UPDATE SET load_kw = EXCLUDED.load_kw", device, tenantA, BERLIN_SITE);
        } finally {
            TenantContext.clear();
        }
        String metered = null;
        String bare = null;
        String draft = null;
        try {
            // The assistant sees WHAT each device can do before anything binds.
            Map<String, Object> options = getMap(
                    "/api/v1/sites/" + BERLIN_SITE + "/consumer-options", tok);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> reported =
                    (List<Map<String, Object>>) options.get("reportedSources");
            Map<String, Object> pm = reported.stream()
                    .filter(r -> "src-sh-pm".equals(r.get("sourceId"))).findFirst().orElseThrow();
            Map<String, Object> noMeter = reported.stream()
                    .filter(r -> "src-sh-bare".equals(r.get("sourceId"))).findFirst().orElseThrow();
            assertThat(pm.get("measuresPower")).isEqualTo(Boolean.TRUE);
            assertThat(noMeter.get("measuresPower")).isEqualTo(Boolean.FALSE);

            Map<String, Object> c1 = create(tok, Map.of("type", "heating-rod",
                    "name", "Rod misst", "ratedPowerKw", 3.0, "controlKind", "on_off",
                    "edgeSourceId", "src-sh-pm"));
            metered = (String) c1.get("id");
            assertThat(c1.get("confirmationChannel")).isEqualTo("power_kw");

            Map<String, Object> c2 = create(tok, Map.of("type", "heating-rod",
                    "name", "Rod ohne Messung", "ratedPowerKw", 3.0, "controlKind", "on_off",
                    "edgeSourceId", "src-sh-bare"));
            bare = (String) c2.get("id");
            assertThat(c2.get("confirmationChannel")).isEqualTo("relay_state");

            Map<String, Object> c3 = create(tok, Map.of("type", "heating-rod",
                    "name", "Rod Entwurf", "ratedPowerKw", 3.0, "controlKind", "on_off"));
            draft = (String) c3.get("id");
            assertThat(c3.get("confirmationChannel")).isNull();
        } finally {
            // Unbind (a connected consumer refuses DELETE by design), then clean.
            TenantContext.set(tenantA);
            try {
                jdbc.update("UPDATE measurement_point SET edge_source_id = NULL "
                        + "WHERE site_id = ?::uuid AND edge_source_id IN "
                        + "('src-sh-pm', 'src-sh-bare')", BERLIN_SITE);
                jdbc.update("DELETE FROM device_source_status WHERE device_id = ?::uuid AND "
                        + "source_id IN ('src-sh-pm', 'src-sh-bare')", device);
            } finally {
                TenantContext.clear();
            }
            for (String id : new String[] {metered, bare, draft}) {
                if (id != null) {
                    delete(tok, id);
                }
            }
        }
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
