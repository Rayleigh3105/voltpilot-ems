package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.components.ComponentAdoptionRunner;
import com.voltpilot.api.components.ComponentConnectionReceipts;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityStatusListener;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.resttestclient.TestRestTemplate;
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
 * Live-Fall „Zuhause“ (05.11.2026): nach der Übernahme des Shelly als Heizstab bleibt die gemeldete
 * Quelle „Nicht übernommen“ und der Heizstab ohne Pin. Dieser Test geht den echten Weg
 * (Anlegen über {@code POST …/components}, Herzschlag der Box mit {@code local_setup}) und fragt,
 * ob und wann die Komponente an ihre Quelle gebunden ist.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
@org.springframework.context.annotation.Import(HeizstabErstbindungApiTest.RecordingPublisherConfig.class)
class HeizstabErstbindungApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";
    private static final String DEYE = "builtin:deye:sun-30k-sg01hp3";
    private static final String SHELLY = "builtin:shelly:shelly_http";

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
    EntityRegistryService entityRegistry;

    @Autowired
    EntityRegistryRepository entityRepo;

    @Autowired
    BoxFaehigkeiten faehigkeiten;

    @Autowired
    ComponentAdoptionRunner runner;

    @Autowired
    EntityObservedRepository observed;

    @Autowired
    ComponentApplyRepository applyRepo;

    @Autowired
    com.voltpilot.api.components.ComponentRebindService rebindService;

    @Autowired
    DeviceRepository devices;

    private final ObjectMapper json = new ObjectMapper();

    @org.springframework.boot.test.context.TestConfiguration
    static class RecordingPublisherConfig {
        static final List<byte[]> PUSHES = new java.util.concurrent.CopyOnWriteArrayList<>();

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

    /** Die Verbindung des Captains: ein Pro 3, drei Phasen, Stern mit N, 2 kW je Element. */
    private static Map<String, Object> pro3() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.178.43");
        c.put("port", 80);
        c.put("channels", List.of(0, 1, 2));
        c.put("output_kw", List.of(2.0, 2.0, 2.0));
        c.put("stages", List.of(1, 2, 3));
        c.put("rotation", "daily");
        c.put("anschluss", "stern_mit_n");
        return c;
    }

    private static Map<String, Object> deyeConnection() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("ip", "192.168.0.28");
        c.put("port", 8899);
        c.put("serial", "2985159064");
        c.put("mb_slave_id", 1);
        return c;
    }

    /** Was die Box nach dem Push in {@code local_setup} meldet: die Quelle des Stabs (sources.json). */
    private static String localSetup() {
        return """
                [{"id":"src-7q7pdrwh","kind":"source","role":"consumer","brand":"shelly",
                  "model":"shelly_http","label":"Heizstab","family":"shelly_http",
                  "communication":"shelly_http",
                  "connection":{"ip":"192.168.178.43","port":80,"channels":[0,1,2]}}]""";
    }

    private void heartbeat(UUID site, UUID device, String localSetup) {
        EntityStatusListener listener = new EntityStatusListener("tcp://unused", "", "",
                devices, observed, applyRepo);
        // Wie im Betrieb: der Zuhörer trägt die Erstbindung im Herzschlag (Spring verdrahtet sie dort selbst).
        listener.erstbindung(rebindService);
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "entities":{"revision":"r-ist","count":1,"ids":[],"local_setup":%s}}"""
                .formatted(TENANT_A, site, device, localSetup);
        listener.handle("ems/%s/%s/%s/status".formatted(TENANT_A, site, device),
                payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private String edgeSourceIdOf(UUID site, String customer, UUID id) throws Exception {
        JsonNode list = getJson("/api/v1/sites/" + site + "/components", customer);
        for (JsonNode row : list.get("components")) {
            if (id.toString().equals(row.path("id").asText())) {
                return row.path("edgeSourceId").asText(null);
            }
        }
        throw new AssertionError("keine Komponente " + id);
    }

    /**
     * DER Befund (Live-Fall „Zuhause“, 05.11.2026): bis zum nächsten Takt der Bestands-Übernahme (5 min)
     * trug der Heizstab keinen Pin - die Quelle stand als „Nicht übernommen“ daneben, der Heizstab
     * „wartete auf die ersten Daten“ und „Dieser Verbraucher ist noch nicht verbunden“. Die Meldung der
     * Box bindet jetzt sofort.
     */
    @Test
    void derHeizstabHaengtSofortNachDerMeldungDerBoxAnSeinerQuelle() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Zuhause");
        try {
            UUID id = legeZuhauseAn(customer, site, "edge-heizstab-01");
            UUID box = anyDeviceOf(site);
            assertThat(edgeSourceIdOf(site, customer, id)).as("frisch angelegt: kein Pin").isNull();
            String override = "/api/v1/sites/" + site + "/consumers/" + id + "/override";
            Map<String, Object> ein = Map.of("action", "start", "durationMinutes", 30);
            ResponseEntity<String> vorher = post(override, customer, ein);
            assertThat(vorher.getStatusCode()).as("ohne Pin: %s", vorher.getBody()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(vorher.getBody()).contains("noch nicht verbunden");

            heartbeat(site, box, localSetup());

            assertThat(edgeSourceIdOf(site, customer, id))
                    .as("ein Herzschlag genügt, kein Takt nötig").isEqualTo("src-7q7pdrwh");
            ResponseEntity<String> nachher = post(override, customer, ein);
            assertThat(nachher.getStatusCode()).as("mit Pin: %s", nachher.getBody()).isNotEqualTo(HttpStatus.CONFLICT);
            // Ein zweiter Herzschlag ändert nichts (eine lebende Bindung wird nie angefasst).
            heartbeat(site, box, localSetup());
            assertThat(edgeSourceIdOf(site, customer, id)).isEqualTo("src-7q7pdrwh");
        } finally {
            deleteSite(customer, site);
        }
    }

    /**
     * Handeingriff je Phase (D1-A, 05.11.2026): der Kunde schaltet L1 und L3; die Wahl liegt mit dem Sollwert
     * der Stufe im Eingriff, ohne eigene Dauer endet er nach zwei Stunden, und eine falsche Wahl schreibt nichts.
     */
    @Test
    void derHandeingriffMerktSichDieGewaehltenPhasen() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Zuhause");
        try {
            UUID id = legeZuhauseAn(customer, site, "edge-heizstab-03");
            heartbeat(site, anyDeviceOf(site), localSetup());
            String override = "/api/v1/sites/" + site + "/consumers/" + id + "/override";

            ResponseEntity<String> falsch = post(override, customer, Map.of("action", "start", "ausgaenge", List.of(5)));
            assertThat(falsch.getStatusCode()).as(falsch.getBody()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(getJson("/api/v1/sites/" + site + "/consumer-overrides", customer)).isEmpty();

            Instant vorher = Instant.now();
            ResponseEntity<String> l1l3 = post(override, customer, Map.of("action", "start", "ausgaenge", List.of(2, 0)));
            assertThat(l1l3.getStatusCode()).as(l1l3.getBody()).isEqualTo(HttpStatus.OK);
            JsonNode antwort = json.readTree(l1l3.getBody());
            assertThat(antwort.path("effectivePowerKw").decimalValue()).isEqualByComparingTo("4.0");
            assertThat(antwort.has("phasenGenau")).as("Phasen-Wahl: das Feld ist da").isTrue();

            JsonNode aktiv = getJson("/api/v1/sites/" + site + "/consumer-overrides", customer);
            assertThat(aktiv).hasSize(1);
            assertThat(aktiv.get(0).path("targetOutputs").toString()).isEqualTo("[0,2]");
            assertThat(aktiv.get(0).path("targetValue").decimalValue()).isEqualByComparingTo("4.0");
            Instant ende = Instant.parse(aktiv.get(0).path("endsAt").asText());
            assertThat(ende).isBetween(vorher.plusSeconds(7200 - 5), Instant.now().plusSeconds(7200 + 5));

            // Eine Stufe ohne Wahl löscht die Wahl wieder (eine Zeile je Verbraucher).
            post(override, customer, Map.of("action", "start", "durationMinutes", 30, "stufe", 3));
            JsonNode stufe = getJson("/api/v1/sites/" + site + "/consumer-overrides", customer);
            assertThat(stufe.get(0).has("targetOutputs")).as(stufe.toString()).isFalse();
        } finally {
            deleteSite(customer, site);
        }
    }

    @Test
    void eineFremdeQuelleBindetDenHeizstabNicht() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Zuhause");
        try {
            UUID id = legeZuhauseAn(customer, site, "edge-heizstab-02");
            UUID box = anyDeviceOf(site);
            // Ein einzelner Ausgang desselben Shelly ist nie der Stab.
            heartbeat(site, box, localSetup().replace("\"channels\":[0,1,2]", "\"channel\":0"));
            assertThat(edgeSourceIdOf(site, customer, id)).isNull();
        } finally {
            deleteSite(customer, site);
        }
    }

    /** Die Anlage des Captains: Box mit {@code heizstab_regler}, Deye-Wechselrichter, Heizstab (Pro 3). */
    private UUID legeZuhauseAn(String customer, UUID site, String boxRef) throws Exception {
        claim(customer, site, boxRef);
        UUID box = anyDeviceOf(site);
        // Die Box meldet den Regler - ohne das lehnt der Anlege-Weg den Stab mit 409 ab. Die
        // Meldung schreibt unter RLS, also unter dem Mandanten der Box (wie der MQTT-Zuhörer).
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            faehigkeiten.record(box, Instant.now(), List.of("data_sources", "heizstab_regler"));
        } finally {
            TenantContext.clear();
        }

        receipts.record(site, DEYE, 1, deyeConnection());
        ResponseEntity<String> wr = post("/api/v1/sites/" + site + "/components", customer,
                saveBody(DEYE, "inverter", deyeConnection(), null));
        assertThat(wr.getStatusCode()).as("Wechselrichter: %s", wr.getBody()).isEqualTo(HttpStatus.OK);

        Map<String, Object> conn = pro3();
        receipts.record(site, SHELLY, 1, conn);
        ResponseEntity<String> created = post("/api/v1/sites/" + site + "/components", customer,
                saveBody(SHELLY, "consumer", conn, "heating-rod"));
        assertThat(created.getStatusCode()).as("Heizstab anlegen: %s", created.getBody())
                .isEqualTo(HttpStatus.OK);
        JsonNode row = byRole(json.readTree(created.getBody()), "consumer");
        assertThat(row.path("entityType").asText()).isEqualTo("heating-rod");
        return UUID.fromString(row.get("id").asText());
    }

    /** Zahlen auf double, damit 6 und 6.0 gleich sind - die Datenbank schreibt jsonb, der Vektor Klartext. */
    private JsonNode normalisiert(JsonNode n) {
        if (n == null || n.isNull()) {
            return json.nullNode();
        }
        if (n.isNumber()) {
            return json.getNodeFactory().numberNode(n.doubleValue());
        }
        if (n.isArray()) {
            ArrayNode out = json.createArrayNode();
            n.forEach(x -> out.add(normalisiert(x)));
            return out;
        }
        if (n.isObject()) {
            ObjectNode out = json.createObjectNode();
            List<String> keys = new ArrayList<>();
            n.fieldNames().forEachRemaining(keys::add);
            java.util.Collections.sort(keys);
            for (String k : keys) {
                out.set(k, normalisiert(n.get(k)));
            }
            return out;
        }
        return n;
    }

    private Path dumpPush(JsonNode push, String name) throws Exception {
        Path dir = Path.of("target", "heizstab-push");
        Files.createDirectories(dir);
        Path file = dir.resolve(name + ".json");
        Files.writeString(file, json.writerWithDefaultPrettyPrinter().writeValueAsString(push));
        return file.toAbsolutePath();
    }

    private static JsonNode entityOf(JsonNode push, UUID entityId) {
        for (JsonNode e : push.get("entities")) {
            if (entityId.toString().equals(e.path("entity_id").asText())) {
                return e;
            }
        }
        return null;
    }

    private JsonNode pushJson(UUID siteId) throws Exception {
        RecordingPublisherConfig.PUSHES.clear();
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            entityRegistry.pushRegistryBestEffort(siteId);
        } finally {
            TenantContext.clear();
        }
        assertThat(RecordingPublisherConfig.PUSHES).as("ein Push wurde veröffentlicht").isNotEmpty();
        return json.readTree(RecordingPublisherConfig.PUSHES.get(RecordingPublisherConfig.PUSHES.size() - 1));
    }

    private UUID anyDeviceOf(UUID siteId) {
        TenantContext.set(UUID.fromString(TENANT_A));
        try {
            List<UUID> ids = entityRepo.siteDeviceIds(siteId);
            assertThat(ids).as("die Anlage hat eine Box").isNotEmpty();
            return ids.get(0);
        } finally {
            TenantContext.clear();
        }
    }

    private static Map<String, Object> saveBody(String templateRef, String role,
            Map<String, Object> connection, String consumerType) {
        Map<String, Object> body = new HashMap<>();
        body.put("templateRef", templateRef);
        body.put("role", role);
        body.put("connection", connection);
        if (consumerType != null) {
            body.put("consumerType", consumerType);
            body.put("label", "Heizstab");
        }
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

    private static JsonNode entityById(JsonNode entities, UUID id) {
        for (JsonNode e : entities.get("entities")) {
            if (id.toString().equals(e.path("id").asText())) {
                return e;
            }
        }
        throw new AssertionError("keine Entität " + id);
    }

    private void claim(String customerToken, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", TestKennung.box(ref), "siteId", siteId.toString(),
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

    private ResponseEntity<String> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)), String.class);
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
        ResponseEntity<Map<String, Object>> res = rest.exchange(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                HttpMethod.POST, new HttpEntity<>(form, headers),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("access_token");
    }
}
