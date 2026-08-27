package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.components.ComponentAuthority;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
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
 * Einheitsmodell Stufe 1 „Ein Anlege-Weg im Portal" gegen echtes TimescaleDB +
 * Keycloak.
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li><b>Der Bestand bleibt unangetastet.</b> Die Demo-Anlagen sind
 *       box-verwaltet, ihr Push trägt KEINE Autorität, und die Schreibwege
 *       lehnen dort ehrlich ab - genau die Betriebs-Auflage dieses PRs.</li>
 *   <li><b>Eine NEUE Anlage ist portal-verwaltet</b> und ihr Push sagt es.</li>
 *   <li><b>Verbindungstest-PFLICHT:</b> ohne Beleg kein Speichern (422), und
 *       ein Beleg gilt nur für GENAU diese Anlage + Vorlage + Verbindung.</li>
 *   <li><b>Fassungen + Rollback:</b> jede Änderung ist eine neue Fassung, der
 *       Rollback SCHREIBT die alte zurück und löscht keine Historie.</li>
 *   <li><b>0-1 Netz-Zähler serverseitig</b> - bis hierher prüfte das nur das
 *       Frontend der Box.</li>
 *   <li><b>RLS:</b> eine fremde Anlage ist 404, bevor irgendetwas geschrieben
 *       wird.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@org.springframework.context.annotation.Import(ComponentApiTest.RecordingPublisherConfig.class)
class ComponentApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEYE = "builtin:deye:sun-30k-sg01hp3";
    private static final String FRONIUS = "builtin:fronius_sunspec:fronius-eco-27-3-s";
    private static final String GENERIC = "builtin:generic_modbus:sunspec";
    private static final String BATTERY_CURRENT_POINT =
            "deye.hybrid_1p.battery.battery-current";

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
    ComponentConnectionReceipts receipts;

    @Autowired
    ComponentApplyRepository applyRepo;

    @Autowired
    EntityRegistryService entityRegistry;

    @Autowired
    EntityRegistryRepository entityRepo;

    private final ObjectMapper json = new ObjectMapper();

    /**
     * Zeichnet jeden Registry-Push auf, damit der Test die BYTES prüfen kann,
     * die wirklich auf den Draht gingen (das {@code ConsumerApiTest}-Muster).
     * Ohne diese Bohne ist der Provider leer und die Nutzlast wird ungeprüft
     * verworfen.
     */
    @org.springframework.boot.test.context.TestConfiguration
    static class RecordingPublisherConfig {
        static final java.util.List<byte[]> PUSHES =
                new java.util.concurrent.CopyOnWriteArrayList<>();

        @org.springframework.context.annotation.Bean
        com.voltpilot.api.entities.EntityRegistryPublisher entityRegistryPublisher() {
            var pub = org.mockito.Mockito.mock(
                    com.voltpilot.api.entities.EntityRegistryPublisher.class);
            org.mockito.Mockito.when(pub.publishRegistry(org.mockito.Mockito.any(),
                    org.mockito.Mockito.any(), org.mockito.Mockito.any(),
                    org.mockito.Mockito.any())).thenAnswer(inv -> {
                        PUSHES.add(inv.getArgument(3));
                        return true;
                    });
            return pub;
        }
    }

    private static Map<String, Object> deyeConnection() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.0.28");
        c.put("port", 8899);
        c.put("serial", "2985159064");
        c.put("mb_slave_id", 1);
        return c;
    }

    /**
     * Die BETRIEBS-AUFLAGE: eine heute laufende Anlage ändert ihr Verhalten
     * durch diesen PR nicht.
     */
    @Test
    void anExistingPlantStaysBoxManagedAndItsPushCarriesNoAuthority() throws Exception {
        String customer = token("demo", "demo");
        UUID berlin = UUID.fromString(BERLIN_SITE);

        JsonNode list = getJson("/api/v1/sites/" + BERLIN_SITE + "/components", customer);
        assertThat(list.get("componentAuthority").asText())
                .as("die Migration setzt jede beim Deploy existierende Anlage auf box")
                .isEqualTo(ComponentAuthority.BOX);

        // Und der Schreibweg lehnt dort mit dem ehrlichen Grund ab, statt ein
        // Soll zu speichern, das die Box nie anwenden würde.
        receipts.record(berlin, DEYE, deyeConnection());
        ResponseEntity<String> refused = post("/api/v1/sites/" + BERLIN_SITE + "/components",
                customer, saveBody(DEYE, "inverter", deyeConnection()));
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(refused.getBody()).contains("direkt am Gerät");

        // Der Push der box-verwalteten Anlage trägt das Feld GAR NICHT - ein
        // älterer Cloud-Stand und diese Anlage sind auf dem Draht identisch.
        assertThat(pushJson(berlin).has("component_authority"))
                .as("abwesend heißt box; ein gesetztes Feld wäre eine Übernahme")
                .isFalse();
    }

    /**
     * Der ganze Weg auf einer NEUEN Anlage: portal-verwaltet, Verbindungstest,
     * Anlegen, Fassungen, Rollback - und der Push trägt die Autorität.
     */
    @Test
    void aNewPlantIsPortalManagedAndTheAssistantWritesVersionedDefinitions() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Stufe-1-Anlage");
        try {
            // Ohne beanspruchtes Gerät gibt es kein Gateway - und damit keinen
            // Push. Genau so entsteht eine Anlage auch beim Kunden.
            claim(customer, site, "edge-stufe1-01");

            JsonNode before = getJson("/api/v1/sites/" + site + "/components", customer);
            assertThat(before.get("componentAuthority").asText())
                    .as("eine NEUE Anlage bekommt den Spalten-Default")
                    .isEqualTo(ComponentAuthority.PORTAL);

            // --- Verbindungstest-PFLICHT ---------------------------------
            Map<String, Object> conn = deyeConnection();
            ResponseEntity<String> blind = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(FRONIUS, "pv-generation", conn));
            assertThat(blind.getStatusCode())
                    .as("ohne Beleg wird kein Blind-Soll gespeichert")
                    .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(blind.getBody()).contains("Verbindung");

            // Ein Beleg für eine ANDERE Verbindung zählt nicht.
            Map<String, Object> andere = new LinkedHashMap<>(conn);
            andere.put("ip", "192.168.0.99");
            receipts.record(site, FRONIUS, andere);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(FRONIUS, "pv-generation", conn)).getStatusCode())
                    .as("der Beleg hängt an GENAU dieser Verbindung")
                    .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

            // --- Anlegen --------------------------------------------------
            receipts.record(site, FRONIUS, conn);
            ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(FRONIUS, "pv-generation", conn));
            assertThat(created.getStatusCode()).isEqualTo(HttpStatus.OK);

            JsonNode after = json.readTree(created.getBody());
            JsonNode erzeuger = byRole(after, "pv-generation");
            assertThat(erzeuger.get("brand").asText())
                    .as("Marke/Modell kommen aus der VORLAGE, nie aus dem Rumpf")
                    .isEqualTo("fronius_sunspec");
            assertThat(erzeuger.get("communication").asText()).isEqualTo("fronius_sunspec");
            assertThat(erzeuger.get("templateRef").asText()).isEqualTo(FRONIUS);
            assertThat(erzeuger.get("sourceKind").asText()).isEqualTo("builtin");
            assertThat(erzeuger.get("definitionVersion").asInt()).isEqualTo(2);
            assertThat(erzeuger.get("connection").get("ip").asText()).isEqualTo("192.168.0.28");
            assertThat(erzeuger.get("syncStatus").asText())
                    .as("die Box hat sich nicht geäußert: unbekannt, nie „nicht angekommen\"")
                    .isEqualTo("unreported");

            UUID entityId = UUID.fromString(erzeuger.get("id").asText());

            // --- Der Push trägt jetzt Autorität UND Verbindung -------------
            JsonNode push = pushJson(site);
            assertThat(push.get("component_authority").asText())
                    .isEqualTo(ComponentAuthority.PORTAL);
            JsonNode driver = driverOf(push, entityId);
            assertThat(driver).as("der Registry-Push trägt den Lesepfad").isNotNull();
            assertThat(driver.get("communication").asText()).isEqualTo("fronius_sunspec");
            assertThat(driver.get("connection").get("ip").asText()).isEqualTo("192.168.0.28");

            // --- Ändern = eine neue Fassung, die alte bleibt ----------------
            Map<String, Object> neu = new LinkedHashMap<>(conn);
            neu.put("ip", "192.168.0.55");
            receipts.record(site, FRONIUS, neu);
            Map<String, Object> edit = saveBody(FRONIUS, "pv-generation", neu);
            edit.put("expectedRevision", erzeuger.get("definitionVersion").asInt());
            ResponseEntity<String> updated = put(
                    "/api/v1/sites/" + site + "/components/" + entityId, customer,
                    edit);
            assertThat(updated.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(byRole(json.readTree(updated.getBody()), "pv-generation")
                    .get("definitionVersion").asInt()).isEqualTo(3);
            assertThat(byRole(json.readTree(updated.getBody()), "pv-generation")
                    .get("id").asText()).as("Bearbeiten prägt niemals eine neue Identität")
                    .isEqualTo(entityId.toString());

            Map<String, Object> stale = saveBody(FRONIUS, "pv-generation", neu);
            stale.put("expectedRevision", 2);
            assertThat(put("/api/v1/sites/" + site + "/components/" + entityId,
                    customer, stale).getStatusCode())
                    .as("ein zweiter Tab darf die neuere Fassung nicht still überschreiben")
                    .isEqualTo(HttpStatus.CONFLICT);

            JsonNode versions = getJson(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/versions", customer);
            assertThat(versions.size()).as("neueste zuerst").isEqualTo(2);
            assertThat(versions.get(0).get("version").asInt()).isEqualTo(3);
            assertThat(versions.get(1).get("connection").get("ip").asText())
                    .isEqualTo("192.168.0.28");

            // --- Rollback SCHREIBT zurück, es löscht nichts -----------------
            ResponseEntity<String> back = post(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/versions/2/rollback",
                    customer, Map.of("expectedRevision", 3));
            assertThat(back.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode rolled = byRole(json.readTree(back.getBody()), "pv-generation");
            assertThat(rolled.get("connection").get("ip").asText()).isEqualTo("192.168.0.28");
            assertThat(rolled.get("definitionVersion").asInt())
                    .as("der Weg zurück ist derselbe Weg wie jede Änderung")
                    .isEqualTo(4);
            JsonNode after4 = getJson(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/versions", customer);
            assertThat(after4.size()).as("Historie ist append-only").isEqualTo(3);
            assertThat(after4.get(0).get("note").asText()).contains("Zurück auf Fassung 2");
            JsonNode events = getJson(
                    "/api/v1/sites/" + site + "/components/" + entityId + "/events", customer);
            assertThat(events.toString()).contains("\"eventType\":\"edited\"",
                    "\"eventType\":\"rolled_back\"");

            // Eine Fassung, die es nicht gibt, ist 404 - nie ein Zufallstreffer.
            assertThat(post("/api/v1/sites/" + site + "/components/" + entityId
                    + "/versions/99/rollback", customer, Map.of("expectedRevision", 4)).getStatusCode())
                    .isEqualTo(HttpStatus.NOT_FOUND);
        } finally {
            deleteSite(customer, site);
        }
    }

    /** Höchstens EIN Netz-Zähler je Anlage - serverseitig, nicht nur im Frontend. */
    @Test
    void atMostOneGridMeterPerPlantIsEnforcedByTheServer() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Netz-Regel-Anlage");
        try {
            Map<String, Object> c1 = Map.of("ip", "192.168.0.60", "port", 502, "unit_id", 3);
            receipts.record(site, GENERIC, c1);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(GENERIC, "grid-meter", c1)).getStatusCode())
                    .isEqualTo(HttpStatus.OK);

            Map<String, Object> c2 = Map.of("ip", "192.168.0.61", "port", 502, "unit_id", 4);
            receipts.record(site, GENERIC, c2);
            ResponseEntity<String> second = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(GENERIC, "grid-meter", c2));
            assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(second.getBody()).contains("nur einer");

            // Die erste hat GENAU EINE Netz-Zeile erzeugt, keine zweite.
            JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
            long meters = 0;
            for (JsonNode row : list.get("components")) {
                if ("grid-meter".equals(row.path("role").asText())) {
                    meters++;
                }
            }
            assertThat(meters).isEqualTo(1);
        } finally {
            deleteSite(customer, site);
        }
    }

    /** Eine unbekannte Vorlage / Rolle wird abgelehnt, bevor irgendetwas entsteht. */
    @Test
    void anUnknownTemplateOrRoleIsRefusedBeforeAnythingIsWritten() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Ablehnungs-Anlage");
        try {
            Map<String, Object> conn = Map.of("ip", "192.168.0.70");
            receipts.record(site, "builtin:gibt:esnicht", conn);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody("builtin:gibt:esnicht", "pv-generation", conn)).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);

            receipts.record(site, GENERIC, conn);
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(GENERIC, "wallbox", conn)).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);

            assertThat(getJson("/api/v1/sites/" + site + "/components", customer)
                    .get("components").size())
                    .as("keine der Ablehnungen hat eine Zeile hinterlassen")
                    .isZero();
        } finally {
            deleteSite(customer, site);
        }
    }

    @Test
    void aMissingExactTemplateVersionMasksARealCustomSecretInsteadOfFallingBack() throws Exception {
        String customer = token("demo", "demo");
        String templateRef = "builtin:test:versioned-mask";
        String customSecret = "credential-only-version-two";
        UUID site = createSite(customer, "Vorlagen-Fassung-Maske");
        try {
            claim(customer, site, "edge-template-mask-01");
            Map<String, Object> conn = deyeConnection();
            receipts.record(site, FRONIUS, conn);
            ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(FRONIUS, "pv-generation", conn));
            assertThat(created.getStatusCode()).isEqualTo(HttpStatus.OK);
            UUID entityId = UUID.fromString(byRole(json.readTree(created.getBody()),
                    "pv-generation").get("id").asText());

            try (Connection c = superuser()) {
                try (var insert = c.prepareStatement(
                        "INSERT INTO component_template (kind, template_ref, version, brand, "
                                + "brand_label, model, model_label, family, family_label, "
                                + "communication, communication_label, transport_schema, "
                                + "certification_status, created_by, withdrawn_at, withdrawn_by, "
                                + "device_type) VALUES ('builtin', ?, ?, 'probe', 'Probe', ?, ?, "
                                + "NULL, NULL, 'modbus_tcp', 'Modbus TCP', ?::jsonb, 'builtin', "
                                + "'component-api-test', ?, ?, 'inverter')")) {
                    insert.setString(1, templateRef);
                    insert.setInt(2, 1);
                    insert.setString(3, "v1");
                    insert.setString(4, "Version 1");
                    insert.setString(5, "[{\"key\":\"ip\",\"type\":\"text\"}]");
                    insert.setNull(6, java.sql.Types.TIMESTAMP_WITH_TIMEZONE);
                    insert.setNull(7, java.sql.Types.VARCHAR);
                    insert.executeUpdate();

                    insert.setString(1, templateRef);
                    insert.setInt(2, 2);
                    insert.setString(3, "v2");
                    insert.setString(4, "Version 2");
                    insert.setString(5, "[{\"key\":\"customCredential\",\"type\":\"text\","
                            + "\"secret\":true}]");
                    insert.setObject(6, java.sql.Timestamp.from(Instant.now()));
                    insert.setString(7, "component-api-test");
                    insert.executeUpdate();
                }
                try (var update = c.prepareStatement(
                        "UPDATE measurement_point SET template_ref = ?, template_version = 2, "
                                + "connection_json = jsonb_build_object('ip', '192.0.2.44', "
                                + "'customCredential', ?) WHERE id = ?")) {
                    update.setString(1, templateRef);
                    update.setString(2, customSecret);
                    update.setObject(3, entityId);
                    assertThat(update.executeUpdate()).isEqualTo(1);
                }
                try (var update = c.prepareStatement(
                        "UPDATE component_definition SET template_ref = ?, template_version = 2, "
                                + "connection_json = jsonb_build_object('ip', '192.0.2.44', "
                                + "'customCredential', ?) WHERE entity_id = ?")) {
                    update.setString(1, templateRef);
                    update.setString(2, customSecret);
                    update.setObject(3, entityId);
                    assertThat(update.executeUpdate()).isGreaterThan(0);
                }
            }

            JsonNode current = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "pv-generation");
            assertThat(current.path("connection").path("customCredential").asText())
                    .isEqualTo(com.voltpilot.api.components.ComponentSecrets.MASK);
            assertThat(current.toString()).doesNotContain(customSecret);

            JsonNode history = getJson("/api/v1/sites/" + site + "/components/" + entityId
                    + "/versions", customer);
            assertThat(history.get(0).path("connection").path("customCredential").asText())
                    .isEqualTo(com.voltpilot.api.components.ComponentSecrets.MASK);
            assertThat(history.toString()).doesNotContain(customSecret);
        } finally {
            deleteSite(customer, site);
            try (Connection c = superuser(); var delete = c.prepareStatement(
                    "DELETE FROM component_template WHERE template_ref = ?")) {
                delete.setString(1, templateRef);
                delete.executeUpdate();
            }
        }
    }

    /** RLS ist der Zaun: eine fremde Anlage ist 404, bevor etwas geschrieben wird. */
    @Test
    void aForeignPlantIs404OnEveryRoute() throws Exception {
        String other = token("demo2", "demo2");
        Map<String, Object> conn = deyeConnection();
        String base = "/api/v1/sites/" + BERLIN_SITE;

        assertThat(rest.exchange(url(base + "/components"), HttpMethod.GET,
                new HttpEntity<>(bearer(other)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        // Auch MIT gültigem Beleg des fremden Mandanten - der Zaun ist die DB.
        receipts.record(UUID.fromString(BERLIN_SITE), DEYE, conn);
        assertThat(post(base + "/components", other, saveBody(DEYE, "inverter", conn))
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(post(base + "/component-test", other,
                Map.of("templateRef", DEYE, "connection", conn)).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // Anonym erreicht die Fläche gar nicht.
        assertThat(rest.getForEntity(url(base + "/components"), String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /**
     * Der gemeldete Anwende-Stand der Box erreicht die Kunden-Route - und eine
     * Ablehnung steht NEBEN der laufenden Fassung, nie an ihrer Stelle.
     */
    @Test
    void theBoxReportedApplyStateReachesTheCustomerRouteWithoutOverwritingIt() throws Exception {
        String customer = token("demo", "demo");
        UUID berlin = UUID.fromString(BERLIN_SITE);
        UUID device = anyDeviceOf(berlin);

        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            applyRepo.upsert(device, UUID.fromString(TENANT_A), berlin,
                    ComponentAuthority.PORTAL, "r5", Instant.parse("2026-08-16T10:00:00Z"),
                    "r6", "Wechselrichter \"x\": Unbekannte Marke.",
                    Instant.parse("2026-08-16T10:05:00Z"));
        } finally {
            TenantContext.clear();
        }

        JsonNode list = getJson("/api/v1/sites/" + BERLIN_SITE + "/components", customer);
        assertThat(list.get("appliedRevision").asText()).isEqualTo("r5");
        assertThat(list.get("refusedRevision").asText()).isEqualTo("r6");
        assertThat(list.get("refusedReason").asText()).contains("Unbekannte Marke");
    }

    /** D8: Standortwechsel ist ein eigener, revisionierter In-place-Vorgang. */
    @Test
    void movingADeviceKeepsItsIdentityAndHistoricalTelemetry() throws Exception {
        String customer = token("demo", "demo");
        String otherTenant = token("demo2", "demo2");
        UUID source = createSite(customer, "Umzug Quelle");
        UUID target = createSite(customer, "Umzug Ziel");
        try {
            claim(customer, source, "edge-location-move-01");
            UUID deviceId = anyDeviceOf(source);
            ResponseEntity<String> selected = put(
                    "/api/v1/devices/" + deviceId + "/measurement-selection/"
                            + BATTERY_CURRENT_POINT,
                    customer, Map.of("expectedRevision", 0,
                            "idempotencyKey", UUID.randomUUID().toString(),
                            "enabled", true, "cadenceS", 60));
            assertThat(selected.getStatusCode()).isEqualTo(HttpStatus.OK);
            // Stufe 3b: a second selection of the SAME register, bound to a
            // component of the SOURCE site that carries no device_id - the
            // shape a location move must survive without a transient FK break.
            UUID movedComponent = UUID.randomUUID();
            try (Connection c = superuser(); Statement st = c.createStatement()) {
                st.execute("INSERT INTO measurement_point(id,tenant_id,site_id,role,label,family) "
                        + "VALUES ('" + movedComponent + "','" + TENANT_A + "','" + source
                        + "','pv-inverter','Umzug Komponente','hybrid_1p')");
            }
            assertThat(put("/api/v1/devices/" + deviceId + "/measurement-selection/"
                            + BATTERY_CURRENT_POINT + "?entityId=" + movedComponent,
                    customer, Map.of("expectedRevision", 1,
                            "idempotencyKey", UUID.randomUUID().toString(),
                            "enabled", true, "cadenceS", 60)).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            Instant sampleTime = Instant.parse("2026-08-24T10:00:00Z");
            try (Connection c = superuser(); var statement = c.prepareStatement(
                    "INSERT INTO telemetry (time, received_at, tenant_id, site_id, device_id, "
                            + "power_kw, payload) VALUES (?, ?, ?::uuid, ?::uuid, ?::uuid, 1.25, '{}'::jsonb)")) {
                statement.setObject(1, java.sql.Timestamp.from(sampleTime));
                statement.setObject(2, java.sql.Timestamp.from(sampleTime));
                statement.setString(3, TENANT_A);
                statement.setString(4, source.toString());
                statement.setString(5, deviceId.toString());
                statement.executeUpdate();
            }
            try (Connection c = superuser()) {
                try (var statement = c.prepareStatement(
                        "INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, "
                                + "site_id, connected, last_seen, updated_at) "
                                + "VALUES (?, 'CP-MOVE', ?::uuid, ?::uuid, true, ?, ?)")) {
                    statement.setObject(1, deviceId);
                    statement.setString(2, TENANT_A);
                    statement.setString(3, source.toString());
                    statement.setObject(4, java.sql.Timestamp.from(sampleTime));
                    statement.setObject(5, java.sql.Timestamp.from(sampleTime));
                    statement.executeUpdate();
                }
                try (var statement = c.prepareStatement(
                        "INSERT INTO ocpp_protocol_event (occurred_at, event_id, tenant_id, "
                                + "site_id, device_id, charge_point_id, direction, message_type, "
                                + "action, payload) VALUES (?, ?, ?::uuid, ?::uuid, ?, "
                                + "'CP-MOVE', 'station_to_csms', 'Call', 'Heartbeat', '{}'::jsonb)")) {
                    statement.setObject(1, java.sql.Timestamp.from(sampleTime));
                    statement.setObject(2, UUID.randomUUID());
                    statement.setString(3, TENANT_A);
                    statement.setString(4, source.toString());
                    statement.setObject(5, deviceId);
                    statement.executeUpdate();
                }
                try (var statement = c.prepareStatement(
                        "INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                                + "site_id, device_id, point_key, raw_numeric, quality, catalog_version, "
                                + "edge_sequence, aggregation_kind, long_term_cadence_s) "
                                + "VALUES (?, ?, ?::uuid, ?::uuid, ?, ?, 7.5, 'good', "
                                + "'move-regression', 1, 'gauge', 300)")) {
                    statement.setObject(1, java.sql.Timestamp.from(sampleTime));
                    statement.setObject(2, java.sql.Timestamp.from(sampleTime));
                    statement.setString(3, TENANT_A);
                    statement.setString(4, source.toString());
                    statement.setObject(5, deviceId);
                    statement.setString(6, BATTERY_CURRENT_POINT);
                    statement.executeUpdate();
                }
                try (var statement = c.prepareStatement(
                        "INSERT INTO device_measurement_event (occurred_at, tenant_id, site_id, "
                                + "device_id, point_key, event_kind, value_text, catalog_version, "
                                + "edge_sequence) VALUES (?, ?::uuid, ?::uuid, ?, ?, "
                                + "'state_change', 'before-move', 'move-regression', 1)")) {
                    statement.setObject(1, java.sql.Timestamp.from(sampleTime));
                    statement.setString(2, TENANT_A);
                    statement.setString(3, source.toString());
                    statement.setObject(4, deviceId);
                    statement.setString(5, BATTERY_CURRENT_POINT);
                    statement.executeUpdate();
                }
            }

            JsonNode preview = getJson("/api/v1/devices/" + deviceId + "/move-preview", customer);
            assertThat(preview.get("revision").asInt()).isEqualTo(1);
            assertThat(preview.get("targets")).anySatisfy(option -> {
                assertThat(option.get("siteId").asText()).isEqualTo(target.toString());
                assertThat(option.get("allowed").asBoolean()).isTrue();
            });

            ResponseEntity<String> moved = post("/api/v1/devices/" + deviceId + "/move",
                    customer, Map.of("targetSiteId", target, "expectedRevision", 1,
                            "effectiveAt", Instant.now().toString()));
            assertThat(moved.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode movedDevice = json.readTree(moved.getBody());
            assertThat(movedDevice.get("id").asText()).isEqualTo(deviceId.toString());
            assertThat(movedDevice.get("siteId").asText()).isEqualTo(target.toString());
            assertThat(rest.exchange(url("/api/v1/devices/" + deviceId
                            + "/measurement-selection"), HttpMethod.GET,
                    new HttpEntity<>(bearer(otherTenant)), String.class).getStatusCode())
                    .as("der verschobene Pollplan bleibt für den anderen Tenant unsichtbar")
                    .isEqualTo(HttpStatus.NOT_FOUND);

            assertThat(post("/api/v1/devices/" + deviceId + "/move", customer,
                    Map.of("targetSiteId", source, "expectedRevision", 1,
                            "effectiveAt", Instant.now().toString())).getStatusCode())
                    .as("eine veraltete Standortfassung überschreibt den Umzug nicht")
                    .isEqualTo(HttpStatus.CONFLICT);

            try (Connection c = superuser(); Statement st = c.createStatement()) {
                st.execute("INSERT INTO device_measurement_sample (time, received_at, tenant_id, "
                        + "site_id, device_id, point_key, raw_numeric, quality, catalog_version, "
                        + "edge_sequence, aggregation_kind, long_term_cadence_s) VALUES ("
                        + "'2026-08-24T10:00:30Z', '2026-08-24T10:00:30Z', '" + TENANT_A
                        + "', '" + target + "', '" + deviceId + "', '" + BATTERY_CURRENT_POINT
                        + "', 8.5, 'good', 'move-regression', 2, 'gauge', 300)");
                st.execute("CALL refresh_device_measurement_rollup("
                        + "'device_measurement_rollup_5m', interval '5 minutes', "
                        + "'2026-08-24T10:00:00Z')");
                try (var rs = st.executeQuery("SELECT count(*), min(site_id::text) FROM telemetry "
                        + "WHERE device_id = '" + deviceId + "'")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getInt(1)).isEqualTo(1);
                    assertThat(rs.getString(2)).as("alte Samples behalten ihren damaligen Standort")
                            .isEqualTo(source.toString());
                }
                try (var rs = st.executeQuery("SELECT site_id::text, count(*) FROM "
                        + "device_measurement_sample WHERE device_id = '" + deviceId
                        + "' GROUP BY site_id ORDER BY site_id::text")) {
                    Map<String, Integer> sites = new java.util.HashMap<>();
                    while (rs.next()) sites.put(rs.getString(1), rs.getInt(2));
                    assertThat(sites).as("Rohmessungen bleiben am historischen Standort")
                            .containsExactlyInAnyOrderEntriesOf(Map.of(
                                    source.toString(), 1, target.toString(), 1));
                }
                try (var rs = st.executeQuery("SELECT site_id::text, value_text FROM "
                        + "device_measurement_event WHERE device_id = '" + deviceId + "'")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).as("Messereignisse wandern nicht mit")
                            .isEqualTo(source.toString());
                    assertThat(rs.getString(2)).isEqualTo("before-move");
                    assertThat(rs.next()).isFalse();
                }
                try (var rs = st.executeQuery("SELECT site_id::text, sample_count FROM "
                        + "device_measurement_rollup_5m WHERE device_id = '" + deviceId
                        + "' AND point_key = '" + BATTERY_CURRENT_POINT + "'")) {
                    Map<String, Long> sites = new java.util.HashMap<>();
                    while (rs.next()) sites.put(rs.getString(1), rs.getLong(2));
                    assertThat(sites).as("ein Umzug innerhalb eines Buckets überschreibt kein Standort-Rollup")
                            .containsExactlyInAnyOrderEntriesOf(Map.of(
                                    source.toString(), 1L, target.toString(), 1L));
                }
                try (var rs = st.executeQuery("SELECT count(*) FROM device_site_assignment "
                        + "WHERE device_id = '" + deviceId + "' AND from_site_id = '" + source
                        + "' AND to_site_id = '" + target + "'")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getInt(1)).isEqualTo(1);
                }
                try (var rs = st.executeQuery("SELECT site_id::text, tenant_id::text, enabled, "
                        + "entity_id::text FROM device_measurement_selection WHERE device_id = '"
                        + deviceId + "' AND point_key = '" + BATTERY_CURRENT_POINT
                        + "' ORDER BY entity_id NULLS FIRST")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).as("der aktuelle Pollplan folgt dem Gerät")
                            .isEqualTo(target.toString());
                    assertThat(rs.getString(2)).isEqualTo(TENANT_A);
                    assertThat(rs.getBoolean(3)).isTrue();
                    assertThat(rs.getString(4)).as("die Box-Zeile bleibt ungebunden").isNull();
                    // The component stayed at the SOURCE site (it carries no
                    // device_id, so a move never takes it along) - which is
                    // exactly why the entity FK binds tenant only.
                    assertThat(rs.next()).as("die komponentenweise Auswahl überlebt den Umzug")
                            .isTrue();
                    assertThat(rs.getString(1)).isEqualTo(target.toString());
                    assertThat(rs.getString(4)).isEqualTo(movedComponent.toString());
                    assertThat(rs.next()).isFalse();
                }
                try (var rs = st.executeQuery("SELECT site_id::text, tenant_id::text, "
                        + "requested_enabled, event_kind, entity_id::text FROM "
                        + "device_measurement_selection_event WHERE device_id = '" + deviceId
                        + "' AND point_key = '" + BATTERY_CURRENT_POINT
                        + "' ORDER BY entity_id NULLS FIRST")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).as("das unveränderliche Ereignis behält seinen damaligen Standort")
                            .isEqualTo(source.toString());
                    assertThat(rs.getString(2)).isEqualTo(TENANT_A);
                    assertThat(rs.getBoolean(3)).isTrue();
                    assertThat(rs.getString(4)).isEqualTo("selection_requested");
                    assertThat(rs.getString(5)).isNull();
                    // Its component-bound twin is a second, equally immutable
                    // row - the paper trail keeps the site where it happened.
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).isEqualTo(source.toString());
                    assertThat(rs.getString(4)).isEqualTo("selection_requested");
                    assertThat(rs.getString(5)).isEqualTo(movedComponent.toString());
                    assertThat(rs.next()).isFalse();
                }
                try (var rs = st.executeQuery("SELECT site_id::text, tenant_id::text, connected "
                        + "FROM ocpp_station WHERE device_id = '" + deviceId
                        + "' AND charge_point_id = 'CP-MOVE'")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).as("der aktuelle OCPP-Zustand folgt dem Gerät")
                            .isEqualTo(target.toString());
                    assertThat(rs.getString(2)).isEqualTo(TENANT_A);
                    assertThat(rs.getBoolean(3)).isTrue();
                }
                try (var rs = st.executeQuery("SELECT site_id::text, tenant_id::text FROM "
                        + "ocpp_protocol_event WHERE device_id = '" + deviceId
                        + "' AND charge_point_id = 'CP-MOVE'")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).as("das OCPP-Journal behält den Ereignisstandort")
                            .isEqualTo(source.toString());
                    assertThat(rs.getString(2)).isEqualTo(TENANT_A);
                    assertThat(rs.next()).isFalse();
                }
            }
        } finally {
            deleteSite(customer, source);
            deleteSite(customer, target);
        }
    }

    @Test
    void concurrentMovesSerializeOnTheTargetTopologyLock() throws Exception {
        String customer = token("demo", "demo");
        UUID source = createSite(customer, "Concurrent Move Source");
        UUID target = createSite(customer, "Concurrent Move Target");
        try {
            claim(customer, source, "edge-location-concurrent-01");
            UUID deviceId = anyDeviceOf(source);
            Map<String, Object> body = Map.of("targetSiteId", target, "expectedRevision", 1,
                    "effectiveAt", Instant.now().toString());
            CompletableFuture<ResponseEntity<String>> first = CompletableFuture.supplyAsync(
                    () -> post("/api/v1/devices/" + deviceId + "/move", customer, body));
            CompletableFuture<ResponseEntity<String>> second = CompletableFuture.supplyAsync(
                    () -> post("/api/v1/devices/" + deviceId + "/move", customer, body));
            List<Integer> statuses = List.of(first.join().getStatusCode().value(), second.join().getStatusCode().value());
            assertThat(statuses).contains(HttpStatus.OK.value()).contains(HttpStatus.CONFLICT.value());
        } finally {
            deleteSite(customer, source);
            deleteSite(customer, target);
        }
    }

    @Test
    void moveAndClaimAgainstOneTargetKeepTheTopologyLockUntilClaimCommit() throws Exception {
        String customer = token("demo", "demo");
        UUID source = createSite(customer, "Move Claim Source");
        UUID target = createSite(customer, "Move Claim Target");
        CompletableFuture<ResponseEntity<String>> claimFuture = null;
        CompletableFuture<ResponseEntity<String>> moveFuture = null;
        try {
            claim(customer, source, "edge-location-move-claim-01");
            UUID deviceId = anyDeviceOf(source);
            Map<String, Object> moveBody = Map.of("targetSiteId", target, "expectedRevision", 1,
                    "effectiveAt", Instant.now().toString());
            installClaimInsertGate();
            ResponseEntity<String> moved;
            ResponseEntity<String> claimed;
            try (Connection topologyBlocker = superuser(); Connection insertBlocker = superuser()) {
                topologyBlocker.setAutoCommit(false);
                insertBlocker.setAutoCommit(false);
                holdAdvisoryLock(topologyBlocker, "site-topology:" + target);
                holdAdvisoryLock(insertBlocker, "component-api:claim-insert-gate");

                // Queue the claim first behind the exact topology lock used by
                // production. Only after PostgreSQL reports that waiter do we
                // queue the move. A test-only INSERT trigger then pauses the
                // claim AFTER it acquired the topology lock. With the controller
                // transaction intact, the move must still be waiting there.
                claimFuture = CompletableFuture.supplyAsync(
                        () -> post("/api/v1/devices/claim", customer,
                                Map.of("externalRef", "edge-location-move-claim-02",
                                        "siteId", target.toString(), "kind", "inverter")));
                awaitAdvisoryWaiters(1);
                moveFuture = CompletableFuture.supplyAsync(
                        () -> post("/api/v1/devices/" + deviceId + "/move", customer, moveBody));
                awaitAdvisoryWaiters(2);
                topologyBlocker.commit();

                awaitAdvisoryQuery("INSERT INTO device");
                awaitAdvisoryWaiters(2);
                assertThat(claimFuture.isDone()).as("der Claim steht kontrolliert im INSERT")
                        .isFalse();
                assertThat(moveFuture.isDone()).as("der Move wartet bis zum Claim-COMMIT")
                        .isFalse();

                insertBlocker.commit();
                claimed = claimFuture.join();
                moved = moveFuture.join();
            }

            HttpStatus moveStatus = (HttpStatus) moved.getStatusCode();
            HttpStatus claimStatus = (HttpStatus) claimed.getStatusCode();
            assertThat(claimStatus).as("der eindeutige neue Claim schreibt genau einmal")
                    .isEqualTo(HttpStatus.CREATED);
            assertThat(moveStatus).as("der danach laufende Move sieht die belegte Topologie")
                    .isEqualTo(HttpStatus.CONFLICT);

            try (Connection c = superuser(); Statement st = c.createStatement()) {
                String movedSite;
                String claimedSite;
                try (var rs = st.executeQuery("SELECT external_ref, site_id::text FROM device "
                        + "WHERE external_ref IN ('edge-location-move-claim-01', "
                        + "'edge-location-move-claim-02') ORDER BY external_ref")) {
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).isEqualTo("edge-location-move-claim-01");
                    movedSite = rs.getString(2);
                    assertThat(rs.next()).isTrue();
                    assertThat(rs.getString(1)).isEqualTo("edge-location-move-claim-02");
                    claimedSite = rs.getString(2);
                    assertThat(rs.next()).isFalse();
                }
                assertThat(claimedSite).isEqualTo(target.toString());
                long assignments;
                try (var rs = st.executeQuery("SELECT count(*) FROM device_site_assignment "
                        + "WHERE device_id = '" + deviceId + "' AND from_site_id = '" + source
                        + "' AND to_site_id = '" + target + "'")) {
                    assertThat(rs.next()).isTrue();
                    assignments = rs.getLong(1);
                }
                assertThat(movedSite).as("der abgelehnte Move bleibt vollständig an der Quelle")
                        .isEqualTo(source.toString());
                assertThat(assignments).isZero();
            }
        } finally {
            if (claimFuture != null) claimFuture.join();
            if (moveFuture != null) moveFuture.join();
            removeClaimInsertGate();
            deleteSite(customer, source);
            deleteSite(customer, target);
        }
    }

    /**
     * Der AUSWEG aus der Sackgasse (Live-Fall Muehlfeldweg 2, 21.08.2026): eine
     * Deye-Anlage mit Eigenbau-Batterie, deren BMS nicht gekoppelt ist, meldet
     * dauerhaft SoC 0. Der Verbindungstest lehnt richtig ab - aber das Geraet
     * hat GEANTWORTET, und alles ausser dem Ladestand ist messbar.
     *
     * <p>Der Test faehrt die ganze Strecke serverseitig: ohne Zustimmung 422,
     * mit einer Zustimmung zum FALSCHEN Kanal 422, mit der richtigen gespeichert
     * - samt dem Opt-in, das die Box braucht, und dem Beleg, der dauerhaft an
     * der Komponente steht. Und die Steuerung dieser Anlage bleibt aus.
     */
    @Test
    void aPlantWhoseBmsReportsNoSocIsSavedOnlyWithAnExplicitAcceptanceAndStaysUncontrollable()
            throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Muehlfeldweg 2");
        try {
            claim(customer, site, "edge-muehlfeld-01");
            // Der Speicher-Stammsatz ist PFLICHT: aus ihm komponiert die
            // Plattform die battery-hybrid-Zeile, in die der Assistent die
            // Anbindung des Wechselrichters schreibt.
            saveBattery(customer, site);
            Map<String, Object> conn = deyeConnection();

            // Der HALBE Beleg entsteht serverseitig aus dem Testergebnis der Box
            // (hier direkt hinterlegt - der Probe-Kanal selbst hat seine eigenen
            // Tests); der Client kann ihn nicht behaupten.
            receipts.recordOverridable(site, DEYE, conn, "soc_pct");

            // 1 · Ohne ausdrueckliche Zustimmung wird NICHTS gespeichert.
            ResponseEntity<String> ohne = post("/api/v1/sites/" + site + "/components",
                    customer, saveBody(DEYE, "inverter", conn));
            assertThat(ohne.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
            assertThat(ohne.getBody()).contains("Ladestand");

            // 2 · Eine Zustimmung zu einem ANDEREN Kanal gilt nicht - sonst waere
            // sie ein Freibrief statt einer benannten Ausnahme.
            Map<String, Object> falsch = saveBody(DEYE, "inverter", conn);
            falsch.put("acceptMissingChannel", "pv_power_kw");
            assertThat(post("/api/v1/sites/" + site + "/components", customer, falsch)
                    .getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

            // 3 · Mit der richtigen Zustimmung wird gespeichert.
            Map<String, Object> ok = saveBody(DEYE, "inverter", conn);
            ok.put("acceptMissingChannel", "soc_pct");
            assertThat(post("/api/v1/sites/" + site + "/components", customer, ok)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);

            // Die komponierte Zeile behaelt ihre Rolle `battery-hybrid` - der
            // Assistent FUELLT sie, er legt keine zweite an.
            JsonNode row = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid");
            JsonNode stored = row.get("connection");
            // Das Opt-in, das die Box WIRKLICH braucht - ohne es verwirft ihr
            // Decoder jede Lesung und die Anlage bliebe fuer immer stumm.
            assertThat(stored.path("allow_missing_soc").asBoolean()).isTrue();
            // ... und der BELEG daneben: wer, wann, welcher Kanal.
            assertThat(stored.path("reading_override").path("channel").asText())
                    .isEqualTo("soc_pct");
            assertThat(stored.path("reading_override").path("origin").asText())
                    .as("die Herkunft kommt aus den Realm-Rollen, nie aus dem Rumpf")
                    .isEqualTo("kunde");
            assertThat(stored.path("reading_override").path("accepted_at").asText()).isNotBlank();
            assertThat(stored.path("reading_override").path("accepted_by").asText()).isNotBlank();

            // Die Historie kopiert die TATSAECHLICH komponierte Datenbankrolle,
            // nicht die Assistentenrolle `inverter`. Ein Rollback derselben
            // vollständigen Fassung darf die battery-hybrid-Entität deshalb
            // weder umdeuten noch verschwinden lassen.
            UUID entityId = UUID.fromString(row.get("id").asText());
            JsonNode versions = getJson("/api/v1/sites/" + site + "/components/"
                    + entityId + "/versions", customer);
            assertThat(versions.get(0).path("role").asText()).isEqualTo("battery-hybrid");
            ResponseEntity<String> composedRollback = post("/api/v1/sites/" + site
                    + "/components/" + entityId + "/versions/2/rollback", customer,
                    Map.of("expectedRevision", row.get("definitionVersion").asInt()));
            assertThat(composedRollback.getStatusCode()).isEqualTo(HttpStatus.OK);
            row = byRole(json.readTree(composedRollback.getBody()), "battery-hybrid");
            assertThat(row.get("id").asText()).isEqualTo(entityId.toString());
            assertThat(row.get("definitionVersion").asInt()).isEqualTo(3);

            // Er reist mit zur Box: der Registry-Push traegt das Opt-in.
            JsonNode push = pushJson(site);
            boolean gefunden = false;
            for (JsonNode e : push.path("entities")) {
                JsonNode c = e.path("driver").path("connection");
                if (c.path("allow_missing_soc").asBoolean()) {
                    gefunden = true;
                }
            }
            assertThat(gefunden).as("die Box muss das Opt-in bekommen").isTrue();

            // 4 · Die STEUERUNG dieser Anlage bleibt aus - und sagt warum.
            String admin = token("admin", "admin");
            UUID device = anyDeviceOf(site);
            ResponseEntity<String> arm = post(
                    "/api/v1/admin/devices/" + device + "/control-activation", admin,
                    Map.of("note", "Versuch"));
            assertThat(arm.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(arm.getBody()).contains("Steuerung nicht möglich");
            assertThat(arm.getBody()).contains("Ladestand");
            assertThat(arm.getBody()).contains("Sobald das BMS gekoppelt ist");

            // 5 · Der WEG ZURUECK: ein vollstaendiger Test loescht die Ausnahme -
            // niemand muss ein Flag zuruecksetzen.
            receipts.record(site, DEYE, conn);
            Map<String, Object> edit = saveBody(DEYE, "inverter", conn);
            edit.put("expectedRevision", row.get("definitionVersion").asInt());
            assertThat(put("/api/v1/sites/" + site + "/components/" + row.get("id").asText(),
                    customer, edit)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode danach = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid");
            assertThat(danach.get("connection").has("reading_override")).isFalse();
            assertThat(danach.get("connection").has("allow_missing_soc")).isFalse();
            assertThat(post("/api/v1/admin/devices/" + device + "/control-activation", admin,
                    Map.of()).getStatusCode())
                    .as("ohne die Ausnahme ist die Anlage wieder scharfschaltbar")
                    .isIn(HttpStatus.OK, HttpStatus.NO_CONTENT);
        } finally {
            deleteSite(customer, site);
        }
    }

    /**
     * Die SCHAETZUNG (Ladestand aus der Batteriespannung) macht aus dem Ausweg
     * eine brauchbare Anlage - und aendert an der SICHERHEIT nichts.
     *
     * <p>Das ist der eigentliche Punkt dieses Tests: die zwei Eckpunkte reisen
     * zur Box, aber der Verbindungstest weist den fehlenden Kanal unveraendert
     * aus - die Komponente braucht also weiterhin die ausdrueckliche Zustimmung,
     * behaelt ihren {@code reading_override}-Stempel und die Anlage bleibt fuer
     * die Batterie-Steuerung GESPERRT. Eine grobe Schaetzung darf die SoC-Klemme
     * von {@code guards.Clamp} nie scharfschalten.
     *
     * <p>Und ein unsinniges Paar wird beim NAMEN genannt, bevor irgendetwas
     * geschrieben wird.
     */
    @Test
    void theVoltageEstimateReachesTheBoxButNeverUnlocksBatteryControl() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Muehlfeldweg 2 (Schaetzung)");
        try {
            claim(customer, site, "edge-muehlfeld-02");
            saveBattery(customer, site);

            // 1 · Ein Paar, das gar keine Batterie sein kann, wird VOR jedem
            //     Schreibvorgang abgelehnt - und nennt den Grund, nicht das
            //     Folgeproblem ("Bitte pruefen Sie zuerst die Verbindung").
            Map<String, Object> kaputt = deyeConnection();
            kaputt.put("soc_from_voltage", Map.of("v_empty", 700, "v_full", 600));
            Map<String, Object> kaputtBody = saveBody(DEYE, "inverter", kaputt);
            kaputtBody.put("acceptMissingChannel", "soc_pct");
            ResponseEntity<String> abgelehnt =
                    post("/api/v1/sites/" + site + "/components", customer, kaputtBody);
            assertThat(abgelehnt.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(abgelehnt.getBody()).contains("100 %");
            assertThat(getJson("/api/v1/sites/" + site + "/components", customer)
                    .get("components"))
                    .as("eine abgelehnte Eingabe schreibt NICHTS")
                    .allSatisfy(row -> assertThat(row.path("connection").has("soc_from_voltage"))
                            .isFalse());

            // 2 · Mit brauchbaren Eckpunkten wird gespeichert - aber NUR mit
            //     derselben ausdruecklichen Zustimmung wie ohne sie. Die
            //     Schaetzung ersetzt die Ausnahme nicht, sie ergaenzt sie.
            Map<String, Object> conn = deyeConnection();
            conn.put("soc_from_voltage", Map.of("v_empty", 600, "v_full", 700));
            receipts.recordOverridable(site, DEYE, conn, "soc_pct");
            assertThat(post("/api/v1/sites/" + site + "/components", customer,
                    saveBody(DEYE, "inverter", conn)).getStatusCode())
                    .as("ohne Zustimmung wird auch mit Schaetzung nichts gespeichert")
                    .isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);

            Map<String, Object> ok = saveBody(DEYE, "inverter", conn);
            ok.put("acceptMissingChannel", "soc_pct");
            assertThat(post("/api/v1/sites/" + site + "/components", customer, ok)
                    .getStatusCode()).isEqualTo(HttpStatus.OK);

            // 3 · Die Eckpunkte stehen an der Komponente - und der Stempel, der
            //     die Steuerung sperrt, steht UNVERAENDERT daneben.
            JsonNode row = byRole(getJson("/api/v1/sites/" + site + "/components", customer),
                    "battery-hybrid");
            JsonNode stored = row.get("connection");
            assertThat(stored.path("soc_from_voltage").path("v_empty").asDouble()).isEqualTo(600.0);
            assertThat(stored.path("soc_from_voltage").path("v_full").asDouble()).isEqualTo(700.0);
            assertThat(stored.path("allow_missing_soc").asBoolean()).isTrue();
            assertThat(stored.path("reading_override").path("channel").asText())
                    .isEqualTo("soc_pct");

            // 4 · Sie reisen zur BOX - ohne diesen Weg waere die Einstellung
            //     wirkungslos, denn das SoC-Tor sitzt im Decoder.
            JsonNode push = pushJson(site);
            boolean gefunden = false;
            for (JsonNode e : push.path("entities")) {
                JsonNode c = e.path("driver").path("connection");
                if (c.path("soc_from_voltage").path("v_full").asDouble() == 700.0
                        && c.path("allow_missing_soc").asBoolean()) {
                    gefunden = true;
                }
            }
            assertThat(gefunden).as("die Box muss die Eckpunkte bekommen").isTrue();

            // 5 · DIE SICHERHEITS-AUSSAGE: die Steuerung bleibt gesperrt, und die
            //     Ablehnung nennt weiterhin den fehlenden Wert.
            String admin = token("admin", "admin");
            UUID device = anyDeviceOf(site);
            ResponseEntity<String> arm = post(
                    "/api/v1/admin/devices/" + device + "/control-activation", admin,
                    Map.of("note", "Versuch mit Schaetzung"));
            assertThat(arm.getStatusCode())
                    .as("eine Schaetzung darf die SoC-Klemme nie scharfschalten")
                    .isEqualTo(HttpStatus.CONFLICT);
            assertThat(arm.getBody()).contains("Ladestand");
        } finally {
            deleteSite(customer, site);
        }
    }

    // ---- Helfer ------------------------------------------------------------

    private static Map<String, Object> saveBody(String templateRef, String role,
            Map<String, Object> connection) {
        Map<String, Object> body = new HashMap<>();
        body.put("templateRef", templateRef);
        body.put("role", role);
        body.put("connection", connection);
        return body;
    }

    private static JsonNode byRole(JsonNode response, String role) {
        for (JsonNode row : response.get("components")) {
            if (role.equals(row.path("role").asText())) {
                return row;
            }
        }
        throw new AssertionError("keine Komponente mit Rolle " + role);
    }

    /**
     * Die BYTES des zuletzt wirklich veröffentlichten Registry-Pushes dieser
     * Anlage - erzeugt über den echten Pfad, nicht über einen Test-Nachbau.
     */
    private JsonNode pushJson(UUID siteId) throws Exception {
        RecordingPublisherConfig.PUSHES.clear();
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            entityRegistry.pushRegistryBestEffort(siteId);
        } finally {
            TenantContext.clear();
        }
        assertThat(RecordingPublisherConfig.PUSHES).as("ein Push wurde veröffentlicht")
                .isNotEmpty();
        return json.readTree(
                RecordingPublisherConfig.PUSHES.get(RecordingPublisherConfig.PUSHES.size() - 1));
    }

    private static JsonNode driverOf(JsonNode push, UUID entityId) {
        for (JsonNode e : push.get("entities")) {
            if (entityId.toString().equals(e.path("entity_id").asText())) {
                return e.get("driver");
            }
        }
        return null;
    }

    /** Irgendein Gerät dieser Anlage - der Push braucht ein Gateway. */
    private UUID anyDeviceOf(UUID siteId) {
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            List<UUID> ids = entityRepo.siteDeviceIds(siteId);
            assertThat(ids).as("die Demo-Anlage hat ein Gerät").isNotEmpty();
            return ids.get(0);
        } finally {
            TenantContext.clear();
        }
    }

    /** Die Eckdaten des Speichers - ohne sie gibt es keine battery-hybrid-Zeile. */
    private void saveBattery(String customerToken, UUID siteId) {
        ResponseEntity<String> res = rest.exchange(url("/api/v1/sites/" + siteId + "/battery"),
                HttpMethod.PUT,
                new HttpEntity<>(Map.of("capacityKwh", 30, "maxChargeKw", 15,
                        "maxDischargeKw", 15), bearer(customerToken)), String.class);
        assertThat(res.getStatusCode()).as("Speicher speichern").isEqualTo(HttpStatus.OK);
    }

    private void claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", ref, "siteId", siteId.toString(),
                        "kind", "inverter"), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isIn(HttpStatus.OK, HttpStatus.CREATED);
    }

    private UUID createSite(String customerToken, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    /** Aufräumen per Superuser - die Testanlagen dürfen die Demo-Flotte nicht verschieben. */
    private void deleteSite(String customerToken, UUID siteId) {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DELETE FROM site WHERE id = '" + siteId + "'");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private Connection superuser() throws SQLException {
        return java.sql.DriverManager.getConnection(POSTGRES.getJdbcUrl(),
                POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private void installClaimInsertGate() throws SQLException {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("CREATE OR REPLACE FUNCTION component_api_claim_insert_gate() "
                    + "RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                    + "IF NEW.external_ref = 'edge-location-move-claim-02' THEN "
                    + "PERFORM pg_advisory_xact_lock(hashtextextended("
                    + "'component-api:claim-insert-gate', 0)); END IF; RETURN NEW; END $$");
            st.execute("DROP TRIGGER IF EXISTS component_api_claim_insert_gate ON device");
            st.execute("CREATE TRIGGER component_api_claim_insert_gate BEFORE INSERT ON device "
                    + "FOR EACH ROW EXECUTE FUNCTION component_api_claim_insert_gate()");
        }
    }

    private void removeClaimInsertGate() {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("DROP TRIGGER IF EXISTS component_api_claim_insert_gate ON device");
            st.execute("DROP FUNCTION IF EXISTS component_api_claim_insert_gate()");
        } catch (SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void holdAdvisoryLock(Connection c, String key) throws SQLException {
        try (var lock = c.prepareStatement(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))")) {
            lock.setString(1, key);
            lock.executeQuery().close();
        }
    }

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), String.class);
    }

    private ResponseEntity<String> put(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.PUT,
                new HttpEntity<>(body, bearer(token)), String.class);
    }

    private void awaitAdvisoryWaiters(int expected) throws SQLException {
        Instant deadline = Instant.now().plusSeconds(5);
        int actual = 0;
        while (Instant.now().isBefore(deadline)) {
            try (Connection c = superuser(); Statement st = c.createStatement();
                    var rs = st.executeQuery("SELECT count(*) FROM pg_stat_activity "
                            + "WHERE datname = current_database() AND wait_event = 'advisory'")) {
                assertThat(rs.next()).isTrue();
                actual = rs.getInt(1);
            }
            if (actual >= expected) return;
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("waiting for advisory-lock contention was interrupted", e);
            }
        }
        assertThat(actual).as("HTTP-Transaktionen warten gemeinsam auf dem Topologie-Lock")
                .isGreaterThanOrEqualTo(expected);
    }

    private void awaitAdvisoryQuery(String fragment) throws SQLException {
        Instant deadline = Instant.now().plusSeconds(5);
        boolean found = false;
        while (Instant.now().isBefore(deadline)) {
            try (Connection c = superuser(); var ps = c.prepareStatement(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() "
                            + "AND wait_event = 'advisory' AND query ILIKE ?)")) {
                ps.setString(1, "%" + fragment + "%");
                try (var rs = ps.executeQuery()) {
                    assertThat(rs.next()).isTrue();
                    found = rs.getBoolean(1);
                }
            }
            if (found) return;
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("waiting for the controlled INSERT gate was interrupted", e);
            }
        }
        assertThat(found).as("der Claim wartet nach dem Topologie-Lock im INSERT").isTrue();
    }

    private JsonNode getJson(String path, String token) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
        assertThat(res.getStatusCode()).as("GET %s", path).isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
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
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
