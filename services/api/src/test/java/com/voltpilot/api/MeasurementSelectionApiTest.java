package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.sql.Connection;
import java.sql.Statement;
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
    void desiredSelectionIsNoBackfillRevisionedIdempotentAndNeverPretendsApplied() throws Exception {
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
                Map.entry("readOnly", true));
        ResponseEntity<Map<String, Object>> customEstimate = rest.exchange(
                url(path(DEVICE_A) + "/custom/estimate"), HttpMethod.POST,
                new HttpEntity<>(definition, bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(customEstimate.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(customEstimate.getBody()).containsEntry("hardRejected", false);
        Map<String, Object> previewPollGroup = (Map<String, Object>)
                ((List<?>) customEstimate.getBody().get("pollGroups")).get(0);
        assertThat(previewPollGroup).containsEntry("serverRequestCostMs", 2000);
        Map<String, Object> clientCost = new java.util.LinkedHashMap<>(definition);
        clientCost.put("estimatedRequestMs", 400);
        ResponseEntity<Map<String, Object>> clientCostRejected = rest.exchange(
                url(path(DEVICE_A) + "/custom/estimate"), HttpMethod.POST,
                new HttpEntity<>(clientCost, bearer(demo)), new ParameterizedTypeReference<>() {});
        assertThat(clientCostRejected.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        // Preview is side-effect free: create still expects revision 2.
        ResponseEntity<Map<String, Object>> custom = post(demo, DEVICE_A,
                Map.of("expectedRevision", 2, "idempotencyKey", customKey.toString(),
                        "definition", definition));
        assertThat(custom.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(custom.getBody()).containsEntry("desiredRevision", 3);
        assertThat((List<?>) custom.getBody().get("selections")).hasSize(2);
        Map<String, Object> customSelection = ((List<Map<String, Object>>)
                custom.getBody().get("selections")).stream()
                .filter(s -> s.get("pointKey").toString().startsWith("custom."))
                .findFirst().orElseThrow();
        assertThat((Map<String, Object>) customSelection.get("customDefinition"))
                .containsEntry("requestCostMs", 2000);
        String customPointKey = "custom." + customKey.toString().replace("-", "");
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_sample "
                    + "(time,received_at,tenant_id,site_id,device_id,point_key,raw_numeric,"
                    + "decoded_numeric,quality,catalog_version,edge_sequence,aggregation_kind,"
                    + "long_term_cadence_s,gap,dropped_samples) VALUES (now()-interval '1 minute',now(),"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','"
                    + customPointKey + "',123,12.3,'good','2026.08.26.1',82001,'gauge',300,false,0)");
        }
        ResponseEntity<Map<String, Object>> customHistory = get(demo,
                path(DEVICE_A) + "/" + customPointKey + "/history?range=24h");
        assertThat(customHistory.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((Map<String, Object>) customHistory.getBody().get("meta"))
                .containsEntry("label", "Eigene Einspeiseleistung")
                .containsEntry("unit", "kW")
                .containsEntry("aggregationKind", "gauge");

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

    @Test
    void pointHistoryAggregatesDecodedGaugesMarksGapsAndExportsMetadata() throws Exception {
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_sample "
                    + "(time,received_at,tenant_id,site_id,device_id,point_key,raw_numeric,"
                    + "decoded_numeric,quality,catalog_version,edge_sequence,aggregation_kind,"
                    + "long_term_cadence_s,gap,dropped_samples) VALUES "
                    + "(date_trunc('hour',now())-interval '1 hour'+interval '1 minute',now(),"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + POINT
                    + "',10,1,'good','2026.08.26.1',81001,'gauge',300,false,0),"
                    + "(date_trunc('hour',now())-interval '1 hour'+interval '2 minutes',now(),"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + POINT
                    + "',20,2,'good','2026.08.26.1',81002,'gauge',300,true,3) "
                    + "ON CONFLICT DO NOTHING");
        }
        String demo = token("demo", "demo");
        ResponseEntity<Map<String, Object>> history = get(demo,
                path(DEVICE_A) + "/" + POINT + "/history?range=24h&representation=decoded");
        assertThat(history.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> meta = (Map<String, Object>) history.getBody().get("meta");
        assertThat(meta).containsEntry("pointKey", POINT)
                .containsEntry("aggregationKind", "gauge")
                .containsEntry("representation", "decoded")
                .containsEntry("rawAvailable", true);
        Map<String, Object> bucket = (Map<String, Object>)
                ((List<?>) history.getBody().get("data")).get(0);
        assertThat(((Number) bucket.get("value")).doubleValue()).isEqualTo(1.5);
        assertThat(((Number) bucket.get("minimum")).doubleValue()).isEqualTo(1.0);
        assertThat(((Number) bucket.get("maximum")).doubleValue()).isEqualTo(2.0);
        assertThat(bucket).containsEntry("gap", true).containsEntry("sampleCount", 2);

        ResponseEntity<String> csv = rest.exchange(url(path(DEVICE_A) + "/" + POINT
                        + "/export?range=24h&representation=raw"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class);
        assertThat(csv.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(csv.getHeaders().getContentDisposition().getFilename()).contains("messwert-");
        assertThat(csv.getBody()).contains("# point_key=", "# aggregation=", "# representation=\"raw\"");
    }

    @Test
    void reviewHistoryUsesDurableRollupsGoodQualityHistoricalSiteAndCompleteMarkers()
            throws Exception {
        String gauge = "deye.hybrid_1p.battery.battery-voltage";
        String counter = "deye.hybrid_1p.meter.total-production";
        String statePoint = "deye.hybrid_1p.control.device-state";
        UUID historicalSite = UUID.fromString("00000000-0000-0000-0000-000000000099");
        UUID entity = UUID.fromString("00000000-0000-0000-0000-000000000098");
        UUID sameFamilyEntity = UUID.fromString("00000000-0000-0000-0000-000000000095");
        UUID foreignDevice = UUID.fromString("00000000-0000-0000-0000-000000000097");
        UUID foreignEntity = UUID.fromString("00000000-0000-0000-0000-000000000096");
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO site(id,tenant_id,name,bidding_zone) VALUES ('"
                    + historicalSite + "','00000000-0000-0000-0000-000000000001',"
                    + "'Historischer Standort','DE-LU') ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO device_measurement_rollup_15m(bucket,tenant_id,site_id,"
                    + "device_id,point_key,aggregation_kind,first_numeric,last_numeric,min_numeric,"
                    + "max_numeric,avg_numeric,positive_delta,counter_reset_count,first_text,last_text,"
                    + "change_count,sample_count,catalog_version) VALUES (now()-interval '120 days',"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + gauge
                    + "','gauge',48,52,48,52,50,NULL,0,NULL,NULL,0,12,'2026.08.26.2'),"
                    + "(now()-interval '60 days','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + gauge
                    + "','gauge',38,42,38,42,40,NULL,0,NULL,NULL,0,12,'2026.08.26.2') "
                    + "ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO device_measurement_sample(time,received_at,tenant_id,"
                    + "site_id,device_id,point_key,raw_numeric,decoded_numeric,quality,catalog_version,"
                    + "edge_sequence,aggregation_kind,long_term_cadence_s,gap,dropped_samples) VALUES "
                    + "(date_trunc('hour',now())-interval '3 hours'+interval '1 minute',now(),"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + gauge
                    + "',100,10,'good','2026.08.26.2',83001,'gauge',300,false,0),"
                    + "(date_trunc('hour',now())-interval '3 hours'+interval '2 minutes',now(),"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + gauge
                    + "',10000,1000,'invalid','2026.08.26.2',83002,'gauge',300,false,0),"
                    + "(now()-interval '1 hour',now(),'00000000-0000-0000-0000-000000000001','"
                    + historicalSite + "','" + DEVICE_A + "','" + counter
                    + "',100,100,'good','2026.08.26.2',83101,'counter',900,false,0),"
                    + "(now()-interval '59 minutes',now(),'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + counter
                    + "',110,110,'good','2026.08.26.2',83102,'counter',900,false,0),"
                    + "(now()-interval '58 minutes',now(),'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + counter
                    + "',115,115,'good','2026.08.26.2',83103,'counter',900,false,0) "
                    + "ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO device_measurement_event(occurred_at,tenant_id,site_id,"
                    + "device_id,point_key,event_kind,previous_numeric,value_numeric,previous_text,"
                    + "value_text,catalog_version,edge_sequence,details) VALUES "
                    + "(now()-interval '20 minutes','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + statePoint
                    + "','state_change',1,2,NULL,NULL,'2026.08.26.2',83201,'{}'),"
                    + "(now()-interval '19 minutes','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + statePoint
                    + "','error_change',NULL,NULL,'good','device_error','2026.08.26.2',83202,'{}') "
                    + "ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,label,family,"
                    + "device_id) VALUES ('" + entity + "','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','battery-hybrid','Deye',"
                    + "'hybrid_1p','" + DEVICE_A + "'),('" + sameFamilyEntity
                    + "','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','pv-inverter','Deye 2',"
                    + "'hybrid_1p','" + DEVICE_A + "') ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO device(id,tenant_id,site_id,external_ref,kind,status) VALUES ('"
                    + foreignDevice + "','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','review-foreign-component',"
                    + "'inverter','claimed') ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,label,family,"
                    + "device_id) VALUES ('" + foreignEntity
                    + "','00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','pv-inverter','Fremde Box',"
                    + "'micro','" + foreignDevice + "') ON CONFLICT DO NOTHING");
            statement.execute("INSERT INTO component_change_event(tenant_id,site_id,entity_id,revision,"
                    + "event_type,effective_at,from_value,to_value) VALUES "
                    + "('00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + entity
                    + "',2,'family_changed',now()-interval '18 minutes','string','hybrid_1p'),"
                    + "('00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + sameFamilyEntity
                    + "',2,'family_changed',now()-interval '17 minutes','micro','hybrid_1p'),"
                    + "('00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + foreignEntity
                    + "',2,'family_changed',now()-interval '17 minutes','string','micro')");
        }
        String demo = token("demo", "demo");
        ResponseEntity<Map<String, Object>> year = get(demo,
                path(DEVICE_A) + "/" + gauge + "/history?range=year");
        assertThat((List<?>) year.getBody().get("data")).anySatisfy(row ->
                assertThat(((Map<?, ?>) row).get("value")).isEqualTo(50.0));
        ResponseEntity<Map<String, Object>> ninetyDays = get(demo,
                path(DEVICE_A) + "/" + gauge + "/history?range=90d");
        assertThat((List<?>) ninetyDays.getBody().get("data")).anySatisfy(row ->
                assertThat(((Map<?, ?>) row).get("value")).isEqualTo(40.0));

        ResponseEntity<Map<String, Object>> quality = get(demo,
                path(DEVICE_A) + "/" + gauge + "/history?range=24h");
        assertThat((List<Map<String, Object>>) quality.getBody().get("data")).anySatisfy(row ->
                assertThat(((Number) row.get("value")).doubleValue()).isEqualTo(10.0));

        ResponseEntity<Map<String, Object>> currentCounter = get(demo,
                path(DEVICE_A) + "/" + counter + "/history?range=24h&siteId="
                        + "00000000-0000-0000-0000-000000000002");
        List<Map<String, Object>> currentRows =
                (List<Map<String, Object>>) currentCounter.getBody().get("data");
        assertThat(currentRows).isNotEmpty().allSatisfy(row ->
                assertThat(((Number) row.get("value")).doubleValue()).isLessThanOrEqualTo(5.0));
        ResponseEntity<Map<String, Object>> oldCounter = get(demo,
                path(DEVICE_A) + "/" + counter + "/history?range=24h&siteId=" + historicalSite);
        List<Map<String, Object>> oldRows =
                (List<Map<String, Object>>) oldCounter.getBody().get("data");
        assertThat(oldRows).isNotEmpty().allSatisfy(row ->
                assertThat(((Number) row.get("value")).doubleValue()).isZero());

        ResponseEntity<Map<String, Object>> markers = get(demo,
                path(DEVICE_A) + "/" + statePoint + "/history?range=24h&entityId=" + entity);
        List<Map<String, Object>> markerRows =
                (List<Map<String, Object>>) markers.getBody().get("markers");
        assertThat(markerRows).extracting(row -> row.get("kind"))
                .contains("state_change", "error_change", "family_changed");
        assertThat(markerRows).extracting(row -> row.get("label"))
                .noneMatch(label -> label.toString().contains("micro"));
        assertThat(((Map<?, ?>) markers.getBody().get("meta")).get("entityId"))
                .isEqualTo(entity.toString());
    }

    @Test
    void exportNeutralizesSpreadsheetFormulaPrefixes() throws Exception {
        String statePoint = "deye.hybrid_1p.control.device-state";
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_sample(time,received_at,tenant_id,site_id,"
                    + "device_id,point_key,raw_text,decoded_text,quality,catalog_version,edge_sequence,"
                    + "aggregation_kind,long_term_cadence_s,gap,dropped_samples) VALUES (now()-interval "
                    + "'5 minutes',now(),'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + statePoint
                    + "','=HYPERLINK(\"https://example.invalid\")','=HYPERLINK(\"https://example.invalid\")',"
                    + "'good','2026.08.26.2',83301,'state',NULL,false,0) ON CONFLICT DO NOTHING");
        }
        ResponseEntity<String> csv = rest.exchange(url(path(DEVICE_A) + "/" + statePoint
                        + "/export?range=24h"), HttpMethod.GET,
                new HttpEntity<>(bearer(token("demo", "demo"))), String.class);
        assertThat(csv.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(csv.getBody()).contains("\"'=HYPERLINK(\"\"https://example.invalid\"\")\"")
                .doesNotContain(",\"=HYPERLINK");
    }

    @Test
    void stateHistorySurvivesRawRetentionAndSeedsTheStateAtTheWindowBoundary()
            throws Exception {
        String statePoint = "deye.hybrid_1p.info.device-rated-phase";
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_sample(time,received_at,tenant_id,"
                    + "site_id,device_id,point_key,raw_numeric,decoded_text,quality,catalog_version,"
                    + "edge_sequence,aggregation_kind,long_term_cadence_s,gap,dropped_samples) VALUES "
                    + "(now()-interval '380 days',now(),'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + statePoint
                    + "',1,'Single-Phase','good','2026.08.26.3',88401,'state',900,false,0),"
                    + "(now()-interval '120 days',now(),'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + statePoint
                    + "',3,'Three-Phase','good','2026.08.26.3',88402,'state',900,false,0) "
                    + "ON CONFLICT DO NOTHING");
            statement.execute("CALL refresh_device_measurement_rollup("
                    + "'device_measurement_rollup_15m'::regclass,interval '15 minutes',"
                    + "now()-interval '400 days')");
            statement.execute("DELETE FROM device_measurement_sample WHERE device_id='" + DEVICE_A
                    + "' AND edge_sequence IN (88401,88402)");
        }
        ResponseEntity<Map<String, Object>> history = get(token("demo", "demo"),
                path(DEVICE_A) + "/" + statePoint + "/history?range=year");
        List<Map<String, Object>> rows =
                (List<Map<String, Object>>) history.getBody().get("data");
        assertThat(rows).isNotEmpty();
        assertThat(rows.get(0)).containsEntry("text", "Single-Phase")
                .containsEntry("sampleCount", 0);
        assertThat(rows).anySatisfy(row -> assertThat(row.get("text")).isEqualTo("Three-Phase"));
        assertThat(rows).allSatisfy(row -> assertThat(row.get("value")).isNull());
    }

    @Test
    void historyAndCsvKeepNumericPrecisionBeyondJavascriptSafeIntegers() throws Exception {
        String point = "deye.hybrid_1p.info.device-rated-power";
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_sample(time,received_at,tenant_id,"
                    + "site_id,device_id,point_key,raw_numeric,decoded_numeric,quality,catalog_version,"
                    + "edge_sequence,aggregation_kind,long_term_cadence_s,gap,dropped_samples) VALUES "
                    + "(now()-interval '5 minutes',now(),"
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + point
                    + "',9007199254740993,9007199254740993,'good','2026.08.26.3',88501,"
                    + "'gauge',300,false,0) ON CONFLICT DO NOTHING");
        }
        String demo = token("demo", "demo");
        ResponseEntity<String> json = rest.exchange(url(path(DEVICE_A) + "/" + point
                        + "/history?range=24h&representation=decoded"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class);
        assertThat(json.getBody()).contains("\"value\":9007199254740993")
                .doesNotContain("9007199254740992");
        ResponseEntity<String> csv = rest.exchange(url(path(DEVICE_A) + "/" + point
                        + "/export?range=24h&representation=decoded"), HttpMethod.GET,
                new HttpEntity<>(bearer(demo)), String.class);
        assertThat(csv.getBody()).contains(",9007199254740993,")
                .doesNotContain("9007199254740992");
    }

    @Test
    void catalogReadsBoundedMaterializedPointStateInsteadOfRawHistory() throws Exception {
        String point = "deye.hybrid_1p.battery.battery-temperature";
        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_sample(time,received_at,tenant_id,site_id,"
                    + "device_id,point_key,raw_numeric,decoded_numeric,quality,catalog_version,"
                    + "edge_sequence,aggregation_kind,long_term_cadence_s,gap,dropped_samples) VALUES "
                    + "(now()-interval '10 minutes',now(),'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + point
                    + "',250,25,'good','2026.08.26.2',83401,'gauge',300,false,0) "
                    + "ON CONFLICT DO NOTHING");
        }
        String demo = token("demo", "demo");
        ResponseEntity<Map<String, Object>> before = get(demo,
                path(DEVICE_A) + "/catalog?q=battery-temperature&recorded=true&limit=10");
        assertThat(before.getBody()).containsEntry("total", 0);

        try (Connection connection = POSTGRES.createConnection("");
                Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO device_measurement_point_state(tenant_id,site_id,device_id,"
                    + "point_key,first_read_at,last_read_at,edge_sequence,raw_numeric,decoded_numeric,"
                    + "quality,gap,dropped_samples,catalog_version) VALUES ("
                    + "'00000000-0000-0000-0000-000000000001',"
                    + "'00000000-0000-0000-0000-000000000002','" + DEVICE_A + "','" + point
                    + "',now()-interval '10 minutes',now()-interval '10 minutes',83401,250,25,"
                    + "'good',false,0,'2026.08.26.2')");
        }
        ResponseEntity<Map<String, Object>> after = get(demo,
                path(DEVICE_A) + "/catalog?q=battery-temperature&recorded=true&limit=10");
        assertThat(after.getBody()).containsEntry("total", 1);
        Map<String, Object> row = (Map<String, Object>)
                ((List<?>) after.getBody().get("points")).get(0);
        assertThat(row).containsEntry("recorded", true).containsEntry("decodedValue", "25");
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
