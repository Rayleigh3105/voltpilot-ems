package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
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
 * Der Probe-Kanal gegen echtes TimescaleDB + Keycloak + EMQX (Einheitsmodell
 * Stufe 0b).
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li>Die Frage erreicht das GERÄT auf seinem eigenen Topic, vertragsförmig -
 *       und die Antwort erreicht den wartenden Kunden mit Roh- UND skaliertem
 *       Wert.</li>
 *   <li>Eine Anlage, die nicht antwortet, ergibt den ehrlichen {@code timeout} -
 *       keinen Fehler und erst recht keinen erfundenen Wert.</li>
 *   <li>Der Mandanten-Zaun: eine fremde Anlage ist 404 (nie 403), anonym 401 -
 *       und das Gerät wird dabei nie gefragt.</li>
 *   <li>Welches Gerät gefragt wird, wird nie geraten: mehrere Geräte ohne
 *       Auswahl sind ein benannter Konflikt, ein fremdes Gerät ist 404.</li>
 *   <li>Die LAN-Adresse des Kunden landet in keinem Protokoll.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ProbeApiTest {

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

    /**
     * Die vollstaendige Reise: Portal fragt -> Geraet bekommt die Frage auf
     * SEINEM Topic -> Antwort erreicht den wartenden Kunden.
     */
    @Test
    void aProbeReachesTheDeviceAndItsAnswerReachesTheWaitingCustomer() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Probe-Anlage");
        UUID device = claim(customer, site, "edge-probe-e2e-01");

        DeviceStub stub = new DeviceStub();
        stub.answerWith(req -> {
            String reqId = req.get("request_id").asText();
            return "{\"schema_version\":\"1.0\",\"type\":\"probe_result\""
                    + ",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + site + "\""
                    + ",\"device_id\":\"" + device + "\",\"request_id\":\"" + reqId + "\""
                    + ",\"answered_at\":\"2026-08-11T09:12:02Z\",\"results\":["
                    + "{\"id\":\"soc\",\"ok\":true,\"raw\":94,\"registers\":[94],\"value\":94},"
                    + "{\"id\":\"temp\",\"ok\":false,\"error_code\":\"no_answer\","
                    + "\"message\":\"Das Gerät antwortet nicht auf diese Anfrage.\"}]}";
        });

        ResponseEntity<Map<String, Object>> res = post("/api/v1/sites/" + site + "/modbus-probe",
                customer, Map.of("ops", List.of(
                        Map.of("id", "soc", "host", "192.168.0.28", "registerKind", "holding",
                                "address", 588, "dataType", "u16"),
                        Map.of("id", "temp", "host", "192.168.0.44", "port", 1502,
                                "unitId", 71, "registerKind", "input", "address", 100,
                                "dataType", "s32", "wordOrder", "little",
                                "scale", 0.1, "offset", -273.15))));

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        // Die Frage, die beim Geraet ankam: auf SEINEM Topic und vertragsfoermig.
        JsonNode asked = stub.awaitRequest();
        assertThat(stub.lastTopic)
                .isEqualTo("ems/" + TENANT_A + "/" + site + "/" + device + "/v2/probe");
        assertThat(asked.get("type").asText()).isEqualTo("probe_request");
        assertThat(asked.get("device_id").asText()).isEqualTo(device.toString());
        // requested_at ist die zweite Haelfte von „nicht retained" - ohne den
        // Stempel koennte eine nachgelieferte Frage nie verfallen.
        assertThat(asked.get("requested_at").asText()).isNotBlank();
        assertThat(asked.get("ops")).hasSize(2);
        JsonNode second = asked.get("ops").get(1);
        assertThat(second.get("port").asInt()).isEqualTo(1502);
        assertThat(second.get("unit_id").asInt()).isEqualTo(71);
        assertThat(second.get("register_kind").asText()).isEqualTo("input");
        assertThat(second.get("word_order").asText()).isEqualTo("little");
        assertThat(second.get("scale").asDouble()).isEqualTo(0.1);

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> results = (List<Map<String, Object>>) res.getBody().get("results");
        assertThat(results).hasSize(2);
        assertThat(results.get(0).get("ok")).isEqualTo(true);
        assertThat(((Number) results.get(0).get("raw")).doubleValue()).isEqualTo(94.0);
        assertThat(((Number) results.get(0).get("value")).doubleValue()).isEqualTo(94.0);
        assertThat(results.get(0).get("registers")).isEqualTo(List.of(94));
        // Die zweite Zeile ist ehrlich gescheitert: benannte Klasse, KEIN Wert.
        assertThat(results.get(1).get("ok")).isEqualTo(false);
        assertThat(results.get(1).get("errorCode")).isEqualTo("no_answer");
        assertThat(results.get(1)).doesNotContainKey("value");
        assertThat(results.get(1)).doesNotContainKey("raw");

        stub.close();
    }

    /**
     * Eine Anlage, die nicht antwortet, ist kein Fehler - sie ist ein ehrlicher
     * Ausgang. Der Assistent zeigt den Satz und laesst den Kunden erneut
     * klicken.
     */
    @Test
    void aSilentPlantYieldsTheHonestTimeoutOutcome() {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Stumme Anlage");
        claim(customer, site, "edge-probe-e2e-silent");

        ResponseEntity<Map<String, Object>> res = post("/api/v1/sites/" + site + "/modbus-probe",
                customer, Map.of("ops", List.of(op())));

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody().get("errorCode")).isEqualTo("timeout");
        assertThat((String) res.getBody().get("message")).isNotBlank();
        assertThat((List<?>) res.getBody().get("results")).isEmpty();
    }

    /**
     * Der Mandanten-Zaun. Ein fremder Kunde bekommt 404 (nie 403 - RLS macht die
     * Anlage unsichtbar, sie ist fuer ihn schlicht nicht da), anonym 401 - und
     * das Geraet wird in beiden Faellen NIE gefragt.
     */
    @Test
    void aForeignPlantIs404AndTheDeviceIsNeverAsked() throws Exception {
        String owner = token("demo", "demo");
        UUID site = createSite(owner, "Fremde Anlage");
        claim(owner, site, "edge-probe-e2e-foreign");

        DeviceStub stub = new DeviceStub();
        stub.answerWith(req -> null); // records, never answers

        String stranger = token("demo2", "demo2");
        ResponseEntity<Map<String, Object>> foreign = post(
                "/api/v1/sites/" + site + "/modbus-probe", stranger,
                Map.of("ops", List.of(op())));
        assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(foreign.getBody().get("message").toString()).contains("Anlage");

        ResponseEntity<String> anonymous = rest.exchange(
                url("/api/v1/sites/" + site + "/modbus-probe"), HttpMethod.POST,
                new HttpEntity<>(Map.of("ops", List.of(op())), jsonHeaders()), String.class);
        assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        assertThat(stub.seen.poll(1, TimeUnit.SECONDS))
                .as("ein abgewiesener Aufrufer erreicht das Geraet nie").isNull();
        stub.close();
    }

    /** Welches Geraet gefragt wird, wird nie geraten. */
    @Test
    void theDeviceIsResolvedOrNamed() {
        String customer = token("demo", "demo");
        UUID empty = createSite(customer, "Anlage ohne Geraet");
        ResponseEntity<Map<String, Object>> none = post("/api/v1/sites/" + empty + "/modbus-probe",
                customer, Map.of("ops", List.of(op())));
        assertThat(none.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(none.getBody().get("message").toString()).contains("keine führende Box");

        UUID site = createSite(customer, "Anlage mit zwei Geraeten");
        UUID first = claim(customer, site, "edge-probe-e2e-a");
        claim(customer, site, "edge-probe-e2e-b");

        ResponseEntity<Map<String, Object>> ambiguous = post(
                "/api/v1/sites/" + site + "/modbus-probe", customer,
                Map.of("ops", List.of(op())));
        assertThat(ambiguous.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(ambiguous.getBody().get("message").toString()).contains("keine führende Box");

        // Ein Geraet einer ANDEREN Anlage ist 404, auch wenn es dem Kunden
        // gehoert - die Frage geht an die Anlage, die er gerade einrichtet.
        ResponseEntity<Map<String, Object>> foreignDevice = post(
                "/api/v1/sites/" + empty + "/modbus-probe", customer,
                Map.of("deviceId", first.toString(), "ops", List.of(op())));
        assertThat(foreignDevice.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Die Form-Pruefung faengt den offensichtlichen Tippfehler sofort ab, statt
     * ihn erst nach einer Broker-Runde vom Geraet zurueckzubekommen.
     */
    @Test
    void anObviouslyBrokenRequestIsRefusedImmediately() {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Form-Anlage");
        claim(customer, site, "edge-probe-e2e-form");
        String path = "/api/v1/sites/" + site + "/modbus-probe";

        assertThat(post(path, customer, Map.of("ops", List.of())).getStatusCode())
                .as("ohne Schritte gibt es nichts zu pruefen").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post(path, customer, Map.of("ops", List.of(
                Map.of("id", "a", "host", "192.168.0.1", "registerKind", "coil",
                        "address", 0, "dataType", "u16")))).getStatusCode())
                .as("Spulen liest dieser Kanal nicht").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post(path, customer, Map.of("ops", List.of(
                Map.of("id", "a", "host", "192.168.0.1", "registerKind", "holding",
                        "address", 0, "dataType", "u64")))).getStatusCode())
                .as("einen unbekannten Datentyp kann niemand lesen")
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post(path, customer, Map.of("ops", List.of(
                Map.of("id", "Kanal 1", "host", "192.168.0.1", "registerKind", "holding",
                        "address", 0, "dataType", "u16")))).getStatusCode())
                .as("die Kennung ordnet die Antwort zu und muss maschinenlesbar sein")
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post(path, customer, Map.of("ops", List.of(
                Map.of("id", "a", "host", "192.168.0.1", "registerKind", "holding",
                        "address", 70000, "dataType", "u16")))).getStatusCode())
                .as("eine Adresse jenseits von 16 Bit gibt es nicht")
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * ⚠ Die LAN-Adresse des Kunden ist Netz-Topologie und landet in KEINEM
     * Protokoll. Sie erscheint auf diesem Pfad in keiner anderen Zeile, und eine
     * Vorschau ist keinen dauerhaften Eintrag darueber wert, wo die Geraete
     * eines Kunden stehen.
     */
    @Test
    void theCustomersLanAddressNeverReachesTheLog() {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Protokoll-Anlage");
        claim(customer, site, "edge-probe-e2e-log");
        String secret = "192.168.77.231";

        LoggerContext context = (LoggerContext) LoggerFactory.getILoggerFactory();
        ch.qos.logback.classic.Logger root = context.getLogger("com.voltpilot.api");
        Level previous = root.getLevel();
        ListAppender<ILoggingEvent> captured = new ListAppender<>();
        captured.setContext(context);
        captured.start();
        root.addAppender(captured);
        root.setLevel(Level.TRACE);
        try {
            post("/api/v1/sites/" + site + "/modbus-probe", customer,
                    Map.of("ops", List.of(Map.of("id", "geheim", "host", secret,
                            "registerKind", "holding", "address", 1, "dataType", "u16"))));
        } finally {
            root.setLevel(previous);
            root.detachAppender(captured);
            captured.stop();
        }

        assertThat(captured.list)
                .as("die Vorschau wurde protokolliert - sonst prueft dieser Test nichts")
                .isNotEmpty();
        assertThat(captured.list.stream().map(ILoggingEvent::getFormattedMessage))
                .as("keine Zeile darf die LAN-Adresse des Kunden tragen")
                .noneMatch(m -> m.contains(secret));
    }

    // ── Helfer ────────────────────────────────────────────────────────────

    /** Ein Geraet, das auf seinem eigenen Probe-Topic zuhoert und antwortet. */
    private final class DeviceStub implements AutoCloseable {
        private final MqttClient client;
        final BlockingQueue<JsonNode> seen = new ArrayBlockingQueue<>(8);
        volatile String lastTopic;

        DeviceStub() throws Exception {
            client = new MqttClient("tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                    "dev-" + UUID.randomUUID(), new MemoryPersistence());
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            client.connect(options);
        }

        void answerWith(AnswerFn fn) throws Exception {
            client.subscribe("ems/+/+/+/v2/probe", 1, (topic, msg) -> {
                JsonNode req = json.readTree(new String(msg.getPayload(), StandardCharsets.UTF_8));
                lastTopic = topic;
                seen.offer(req);
                String answer = fn.answer(req);
                if (answer == null) {
                    return;
                }
                MqttMessage out = new MqttMessage(answer.getBytes(StandardCharsets.UTF_8));
                out.setQos(1);
                out.setRetained(false);
                client.publish(topic + "-result", out);
            });
        }

        JsonNode awaitRequest() throws Exception {
            JsonNode req = seen.poll(10, TimeUnit.SECONDS);
            assertThat(req).as("die Frage erreicht das Geraet").isNotNull();
            return req;
        }

        @Override
        public void close() {
            try {
                client.disconnect();
                client.close();
            } catch (Exception ignored) {
                // a stub going away is not a test failure
            }
        }
    }

    @FunctionalInterface
    private interface AnswerFn {
        String answer(JsonNode request) throws Exception;
    }

    private static Map<String, Object> op() {
        return Map.of("id", "soc", "host", "192.168.0.28", "registerKind", "holding",
                "address", 588, "dataType", "u16");
    }

    private UUID createSite(String token, String name) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/sites"),
                HttpMethod.POST, new HttpEntity<>(Map.of("name", name), bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private UUID claim(String token, UUID siteId, String ref) {
        ResponseEntity<Map<String, Object>> res = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId.toString(), "externalRef", ref),
                        bearer(token)),
                new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) res.getBody().get("id"));
    }

    private ResponseEntity<Map<String, Object>> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST,
                new HttpEntity<>(body, bearer(token)), new ParameterizedTypeReference<>() {});
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders jsonHeaders() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = jsonHeaders();
        headers.setBearerAuth(token);
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
        Map<String, Object> body = new TestRestTemplate().postForObject(
                KEYCLOAK.getAuthServerUrl() + "/realms/voltpilot/protocol/openid-connect/token",
                new HttpEntity<>(form, headers), Map.class);
        assertThat(body).as("token response").containsKey("access_token");
        return (String) body.get("access_token");
    }
}
