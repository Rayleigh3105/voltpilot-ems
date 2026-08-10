package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
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
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Das PLATTFORM-Gedächtnis der Steuerungs-Freigabe gegen echtes TimescaleDB +
 * Keycloak + EMQX (Captain-Order 10.08.2026).
 *
 * <p>Was hier bewiesen wird - und zwar in genau der Reihenfolge, in der der
 * Captain es beschrieben hat:
 * <ol>
 *   <li>Die schon erteilte Deye-Freigabe ist als ERSTBESTAND im Register - die
 *       Plattform hat sie sich gemerkt.</li>
 *   <li>Eine Anlage scharfzuschalten ist EIN Klick, und das Dokument kommt
 *       retained beim Gerät an - mit Register UND Scharfschaltung.</li>
 *   <li>Das Register ALLEIN steuert nichts: ohne den Klick trägt das Dokument
 *       {@code activated:false}.</li>
 *   <li>Die Zurücknahme wirkt sofort, und beim Unclaim wird der retained Slot
 *       geleert.</li>
 *   <li>Die Rollen-Grenze: ein Kunde bekommt 403, anonym 401 - auf JEDER
 *       Route.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ControlCertificationApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
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

    @Container
    static final GenericContainer<?> EMQX =
            new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
                    .withExposedPorts(1883)
                    .waitingFor(Wait.forLogMessage(".*is running now.*", 1)
                            .withStartupTimeout(Duration.ofMinutes(2)));

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

        registry.add("voltpilot.provisioning.enabled", () -> "true");
        registry.add("voltpilot.provisioning.broker-url",
                () -> "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883));
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    private final ObjectMapper json = new ObjectMapper();

    @Test
    void thePlatformRemembersACertifiedModelAndOneClickArmsThePlant() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");

        // (1) Der Erstbestand: die Freigabe, die der Captain am Prüfstand schon
        // erteilt hat, steht im Register - genau das „merken" der Order.
        JsonNode register = getJson("/api/v1/admin/control-certifications", admin);
        JsonNode deye = findModel(register, "sun-30k-sg01hp3");
        assertThat(deye).as("die bereits erteilte Deye-Freigabe als Erstbestand").isNotNull();
        assertThat(deye.get("family").asText()).isEqualTo("hybrid_3p");
        assertThat(deye.get("controlPath").asText()).isEqualTo("remote");
        // ⚠ Die Vorzeichenfrage wurde am Prüfstand nicht als Register-Aussage
        // festgehalten - NULL heißt genau das, und false wäre eine Behauptung.
        assertThat(deye.get("invertControlSign").isNull()).isTrue();

        UUID device = claim(customer, "edge-cert-e2e-01");
        BlockingQueue<byte[]> mailbox = subscribe(device);

        // (2) EIN Klick schaltet die Anlage scharf, und das Dokument geht raus.
        ResponseEntity<Map<String, Object>> armed = post(
                "/api/v1/admin/devices/" + device + "/control-activation", admin,
                Map.of("note", "Kunde Mienbach, gleicher Wechselrichter wie Pilsting"));
        assertThat(armed.getStatusCode()).isEqualTo(HttpStatus.OK);

        JsonNode doc = awaitDocument(mailbox);
        assertThat(doc.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(doc.get("device_id").asText()).isEqualTo(device.toString());
        assertThat(doc.get("activated").asBoolean()).isTrue();
        assertThat(modelNames(doc)).contains("sun-30k-sg01hp3");

        // (3) Ein ZWEITES Modell einzutragen erreicht dieselbe Box, ohne dass
        // dort irgendjemand etwas tun müsste - das ist das flottenweite
        // Gedächtnis in Aktion.
        ResponseEntity<Map<String, Object>> second = post("/api/v1/admin/control-certifications",
                admin, Map.of("brand", "deye", "model", "SUN-12K-SG04LP3-EU",
                        "family", "hybrid_3p", "controlPath", "remote",
                        "note", "Prüfstand 10.08."));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode grown = awaitDocument(mailbox);
        assertThat(modelNames(grown)).contains("sun-30k-sg01hp3", "sun-12k-sg04lp3-eu");
        // Normalisiert gespeichert: derselbe Eintrag ein zweites Mal ist ein
        // KONFLIKT, keine stille Aktualisierung (zwei Wahrheiten über dasselbe
        // Produkt könnten auseinanderlaufen).
        ResponseEntity<Map<String, Object>> dupe = post("/api/v1/admin/control-certifications",
                admin, Map.of("brand", "DEYE", "model", "sun-12k-sg04lp3-eu",
                        "family", "hybrid_3p"));
        assertThat(dupe.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(dupe.getBody().get("message").toString()).contains("Register");

        // (4) Zurücknehmen wirkt sofort: dasselbe Dokument, activated=false.
        ResponseEntity<Void> off = rest.exchange(
                url("/api/v1/admin/devices/" + device + "/control-activation"),
                HttpMethod.DELETE, new HttpEntity<>(bearer(admin)), Void.class);
        assertThat(off.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        JsonNode disarmed = awaitDocument(mailbox);
        assertThat(disarmed.get("activated").asBoolean())
                .as("die Zurücknahme erreicht das Gerät sofort").isFalse();
        // Das Register bleibt - „Modell zertifiziert, Anlage nicht scharf" ist
        // ein eigener, ehrlicher Zustand.
        assertThat(modelNames(disarmed)).contains("sun-30k-sg01hp3");

        // (5) Unclaim leert den retained Slot (ein Gerät ohne Besitzer darf
        // keine Freigabe auf dem Broker liegen lassen).
        post("/api/v1/admin/devices/" + device + "/control-activation", admin, Map.of());
        awaitDocument(mailbox);
        rest.exchange(url("/api/v1/devices/" + device), HttpMethod.DELETE,
                new HttpEntity<>(bearer(customer)), Void.class);
        byte[] cleared = mailbox.poll(10, TimeUnit.SECONDS);
        assertThat(cleared).as("retained clear beim Unclaim").isNotNull();
        assertThat(cleared).isEmpty();
    }

    /**
     * Die Rollen-Grenze. Sie ist der Grund, warum die Scharfschaltung heute
     * admin-only ist: es geht um SCHREIBZUGRIFF auf den Wechselrichter eines
     * Kunden, und der Kunde hatte diesen Hebel nie.
     */
    @Test
    void everyRouteIsPlatformAdminOnly() {
        String customer = token("demo", "demo");
        UUID any = UUID.randomUUID();

        for (String path : new String[] {
                "/api/v1/admin/control-certifications",
                "/api/v1/admin/control-activations" }) {
            assertThat(rest.exchange(url(path), HttpMethod.GET,
                    new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                    .as("customer GET " + path).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(rest.exchange(url(path), HttpMethod.GET, HttpEntity.EMPTY, String.class)
                    .getStatusCode()).as("anonymous GET " + path)
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
        }
        // Ein KUNDE kann seine eigene Anlage nicht scharfschalten. Der Rumpf ist
        // absichtlich GÜLTIG - Bean-Validation läuft vor @PreAuthorize, ein
        // krummer Rumpf ergäbe 400 und bewiese nichts über die Rolle.
        assertThat(post("/api/v1/admin/devices/" + any + "/control-activation", customer,
                Map.of("note", "bitte")).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(post("/api/v1/admin/control-certifications", customer,
                Map.of("brand", "deye", "model", "x", "family", "hybrid_3p")).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    /** Ein unbekanntes Gerät wird abgelehnt, nie stillschweigend angelegt. */
    @Test
    void anUnknownDeviceCannotBeArmed() {
        String admin = token("admin", "admin");
        ResponseEntity<Map<String, Object>> res = post(
                "/api/v1/admin/devices/" + UUID.randomUUID() + "/control-activation", admin,
                Map.of());
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("message").toString()).contains("Gerät");
    }

    // ── Helfer ────────────────────────────────────────────────────────────

    private JsonNode awaitDocument(BlockingQueue<byte[]> mailbox) throws Exception {
        byte[] raw = mailbox.poll(15, TimeUnit.SECONDS);
        assertThat(raw).as("das Zertifizierungs-Dokument erreicht das Gerät").isNotNull();
        assertThat(raw).isNotEmpty();
        return json.readTree(new String(raw, StandardCharsets.UTF_8));
    }

    private static java.util.List<String> modelNames(JsonNode doc) {
        return java.util.stream.StreamSupport
                .stream(doc.get("certified_models").spliterator(), false)
                .map(m -> m.get("model").asText()).toList();
    }

    private static JsonNode findModel(JsonNode register, String model) {
        for (JsonNode c : register) {
            if (model.equals(c.get("model").asText())) {
                return c;
            }
        }
        return null;
    }

    private BlockingQueue<byte[]> subscribe(UUID deviceId) throws Exception {
        MqttClient device = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "dev-" + UUID.randomUUID(), new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        device.connect(options);
        BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(16);
        device.subscribe("ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId
                + "/v2/control-certification", 1, (topic, msg) -> queue.add(msg.getPayload()));
        return queue;
    }

    private UUID claim(String customerToken, String ref) {
        ResponseEntity<Map<String, Object>> claim = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref),
                        bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) claim.getBody().get("id"));
    }

    private JsonNode getJson(String path, String token) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private ResponseEntity<Map<String, Object>> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
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
