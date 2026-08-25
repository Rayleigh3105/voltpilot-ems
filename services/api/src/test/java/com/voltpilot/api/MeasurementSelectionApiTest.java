package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
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

/** End-to-end proof of selection revisions, idempotency and the HTTP tenant fence. */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class MeasurementSelectionApiTest {

    private static final UUID DEVICE_A =
            UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID DEVICE_B =
            UUID.fromString("10000000-0000-0000-0000-000000000003");
    private static final String POINT = "deye.hybrid_1p.battery.battery-current";

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
        registry.add("spring.datasource.username", () -> "voltpilot_app");
        registry.add("spring.datasource.password", () -> "voltpilot_app_test_pw");
        registry.add("spring.flyway.url", POSTGRES::getJdbcUrl);
        registry.add("spring.flyway.user", POSTGRES::getUsername);
        registry.add("spring.flyway.password", POSTGRES::getPassword);
        registry.add("spring.flyway.placeholders.appDbUser", () -> "voltpilot_app");
        registry.add("spring.flyway.placeholders.appDbPassword", () -> "voltpilot_app_test_pw");
        registry.add("spring.flyway.placeholders.adminDbUser", () -> "voltpilot_admin");
        registry.add("spring.flyway.placeholders.adminDbPassword",
                () -> "voltpilot_admin_test_pw");
        registry.add("voltpilot.admin-datasource.username", () -> "voltpilot_admin");
        registry.add("voltpilot.admin-datasource.password", () -> "voltpilot_admin_test_pw");

        String realm = KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot";
        registry.add("voltpilot.security.oidc.enabled", () -> "true");
        registry.add("spring.security.oauth2.resourceserver.jwt.issuer-uri", () -> realm);
        registry.add("spring.security.oauth2.resourceserver.jwt.jwk-set-uri",
                () -> realm + "/protocol/openid-connect/certs");
    }

    @LocalServerPort
    int port;

    private final TestRestTemplate rest = new TestRestTemplate();

    @Test
    void desiredSelectionIsNoBackfillRevisionedIdempotentAndNeverPretendsApplied() {
        String demo = token("demo", "demo");
        String demo2 = token("demo2", "demo2");

        ResponseEntity<Map<String, Object>> catalog = get(demo,
                path(DEVICE_A) + "/catalog?q=holding:0x00bf&limit=10");
        assertThat(catalog.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(catalog.getBody()).containsEntry("customPointActionLabel",
                "Eigenen Messwert hinzufügen");
        assertThat((List<?>) catalog.getBody().get("points")).isNotEmpty();
        assertThat((List<?>) catalog.getBody().get("semanticStatuses")).isNotEmpty();

        ResponseEntity<Map<String, Object>> estimate = get(demo,
                path(DEVICE_A) + "/estimate?pointKey=" + POINT + "&cadenceS=60");
        assertThat(estimate.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(estimate.getBody()).containsEntry("rawRetentionDays", 90);
        assertThat(estimate.getBody()).containsEntry("hardRejected", false);

        UUID enableKey = UUID.randomUUID();
        Map<String, Object> enable = Map.of("expectedRevision", 0, "idempotencyKey",
                enableKey.toString(), "enabled", true, "cadenceS", 60);
        ResponseEntity<Map<String, Object>> enabled = put(demo, DEVICE_A, POINT, enable);
        assertThat(enabled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(enabled.getBody()).containsEntry("desiredRevision", 1);
        assertThat(enabled.getBody()).containsEntry("status", "pending_edge");
        assertThat((String) enabled.getBody().get("statusReason")).contains("wartet");
        Map<String, Object> selected = first(enabled, "selections");
        assertThat(selected).containsEntry("enabled", true)
                .containsEntry("applyStatus", "pending_edge")
                .containsEntry("appliedAt", null)
                .containsEntry("rawRetentionDays", 90);
        assertThat(selected.get("enabledAt")).isNotNull();
        assertThat((String) enabled.getBody().get("activationNotice"))
                .contains("frühere Werte werden nicht ergänzt");
        assertThat(first(enabled, "events")).containsEntry("actorName", "demo")
                .containsEntry("eventKind", "selection_requested")
                .containsEntry("applyStatus", "pending_edge")
                .containsEntry("disabledAt", null)
                .containsEntry("appliedAt", null);
        assertThat(first(enabled, "events").get("enabledAt")).isNotNull();

        // Same key + same payload is a true replay even though expectedRevision
        // is now stale: no new revision/event is created.
        ResponseEntity<Map<String, Object>> replay = put(demo, DEVICE_A, POINT, enable);
        assertThat(replay.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(replay.getBody()).containsEntry("desiredRevision", 1);
        assertThat((List<?>) replay.getBody().get("events")).hasSize(1);

        ResponseEntity<Map<String, Object>> stale = put(demo, DEVICE_A, POINT,
                Map.of("expectedRevision", 0, "idempotencyKey", UUID.randomUUID().toString(),
                        "enabled", true, "cadenceS", 30));
        assertThat(stale.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Both attack directions are 404: tenant A cannot inspect B's state,
        // tenant B cannot mutate A's point.
        assertThat(get(demo, path(DEVICE_B)).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(put(demo2, DEVICE_A, POINT,
                Map.of("expectedRevision", 1, "idempotencyKey", UUID.randomUUID().toString(),
                        "enabled", false)).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        ResponseEntity<Map<String, Object>> disabled = put(demo, DEVICE_A, POINT,
                Map.of("expectedRevision", 1, "idempotencyKey", UUID.randomUUID().toString(),
                        "enabled", false));
        assertThat(disabled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(disabled.getBody()).containsEntry("desiredRevision", 2);
        Map<String, Object> deselected = first(disabled, "selections");
        assertThat(deselected).containsEntry("enabled", false);
        assertThat(deselected.get("enabledAt")).isNotNull();
        assertThat(deselected.get("disabledAt")).isNotNull();
        assertThat((List<?>) disabled.getBody().get("events")).hasSize(2);
        assertThat(first(disabled, "events").get("disabledAt")).isNotNull();
        assertThat((String) disabled.getBody().get("disableNotice"))
                .contains("bisherige Werte");

        UUID customKey = UUID.randomUUID();
        Map<String, Object> definition = Map.ofEntries(
                Map.entry("label", "Eigene Einspeiseleistung"),
                Map.entry("sourceKind", "modbus_holding"),
                Map.entry("address", 231),
                Map.entry("selector", "holding:0x00e7"),
                Map.entry("valueType", "uint16"),
                Map.entry("widthBits", 16),
                Map.entry("signed", false),
                Map.entry("endian", "big"),
                Map.entry("scale", 0.1),
                Map.entry("unit", "kW"),
                Map.entry("cadenceS", 60),
                Map.entry("retentionClass", "live_power"),
                Map.entry("readOnly", true),
                Map.entry("estimatedRequestMs", 400));
        ResponseEntity<Map<String, Object>> customEstimate = rest.exchange(
                url(path(DEVICE_A) + "/custom/estimate"), HttpMethod.POST,
                new HttpEntity<>(definition, bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(customEstimate.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(customEstimate.getBody()).containsEntry("hardRejected", false);
        // Preview is side-effect free: create still expects revision 2.
        ResponseEntity<Map<String, Object>> custom = post(demo, DEVICE_A,
                Map.of("expectedRevision", 2, "idempotencyKey", customKey.toString(),
                        "definition", definition));
        assertThat(custom.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(custom.getBody()).containsEntry("desiredRevision", 3);
        assertThat((List<?>) custom.getBody().get("selections")).hasSize(2);

        Map<String, Object> writable = new java.util.LinkedHashMap<>(definition);
        writable.put("readOnly", false);
        ResponseEntity<Map<String, Object>> rejected = post(demo, DEVICE_A,
                Map.of("expectedRevision", 3, "idempotencyKey", UUID.randomUUID().toString(),
                        "definition", writable));
        assertThat(rejected.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) rejected.getBody().get("message")).contains("ausschließlich lesbar");

        Map<String, Object> smuggledWrite = new java.util.LinkedHashMap<>(definition);
        smuggledWrite.put("writeFunction", "fc6");
        ResponseEntity<Map<String, Object>> unknownWrite = post(demo, DEVICE_A,
                Map.of("expectedRevision", 3,
                        "idempotencyKey", UUID.randomUUID().toString(),
                        "definition", smuggledWrite));
        assertThat(unknownWrite.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> unsafeBudget = new java.util.LinkedHashMap<>(definition);
        unsafeBudget.put("address", 232);
        unsafeBudget.put("selector", "holding:0x00e8");
        unsafeBudget.put("cadenceS", 1);
        ResponseEntity<Map<String, Object>> overBudget = post(demo, DEVICE_A,
                Map.of("expectedRevision", 3,
                        "idempotencyKey", UUID.randomUUID().toString(),
                        "definition", unsafeBudget));
        assertThat(overBudget.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat((String) overBudget.getBody().get("message"))
                .contains("Messwertbudget");
        assertThat(get(demo, path(DEVICE_A)).getBody()).containsEntry("desiredRevision", 3);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> first(ResponseEntity<Map<String, Object>> response,
            String key) {
        return (Map<String, Object>) ((List<?>) response.getBody().get(key)).get(0);
    }

    private ResponseEntity<Map<String, Object>> get(String token, String path) {
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<Map<String, Object>> put(String token, UUID device, String point,
            Map<String, Object> body) {
        return rest.exchange(url(path(device) + "/" + point), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
    }

    private ResponseEntity<Map<String, Object>> post(String token, UUID device,
            Map<String, Object> body) {
        return rest.exchange(url(path(device) + "/custom"), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
    }

    private static String path(UUID device) {
        return "/api/v1/devices/" + device + "/measurement-selection";
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
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
        Map<String, Object> response = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(response).containsKey("access_token");
        return (String) response.get("access_token");
    }
}
