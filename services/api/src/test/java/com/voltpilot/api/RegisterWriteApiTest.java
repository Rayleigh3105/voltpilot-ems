package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentApplyRepository;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityStatusListener;
import com.voltpilot.api.repo.DeviceRepository;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
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
 * Die Zwei-Schritt-Strecke „Register schreiben" gegen echtes TimescaleDB +
 * Keycloak + EMQX (Konzept {@code vp-reg-schreib-konzept-p8}, Stufe 1).
 *
 * <p>Was hier bewiesen wird:
 * <ol>
 *   <li>Die vollständige Reise: Vorschau → Bestätigen → Beleg, vertragsförmig
 *       auf dem EIGENEN Topic des Geräts, mit Roh- UND skaliertem Wert.</li>
 *   <li>Die Papier-Spur ist BEWEISBAR: Herkunft aus dem Token, die getippten
 *       Begriffe VERBATIM, Anforderung und Quittung als zwei Zeilen.</li>
 *   <li>Die Notiz ist bei {@code netz_compliance} PFLICHT (D5) - und eine
 *       Ablehnung erreicht das Gerät NIE und hinterlässt KEINE Zeile.</li>
 *   <li>Eine Vorschau hinterlässt keine Spur - sie ändert nichts.</li>
 *   <li>Schweigen heißt {@code unbekannt}, nie „nicht geschrieben" - und die
 *       später eintreffende Quittung landet trotzdem im Journal.</li>
 *   <li>Der vierte Strom {@code register} trägt dieselben Zeilen in den
 *       Kommando-Verlauf, ohne sie ein zweites Mal zu speichern.</li>
 *   <li>Der Mandanten-Zaun: fremde Anlage 404, anonym 401 - das Gerät wird
 *       dabei nie gefragt; ein Admit über den Umschalter ist als
 *       {@code voltpilot} kenntlich.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class RegisterWriteApiTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";

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
        // Kurze Fristen: der Testlauf soll die Schweigen-Regel beweisen, nicht
        // 45 Sekunden lang warten.
        registry.add("voltpilot.register-write.read-timeout", () -> "PT3S");
        registry.add("voltpilot.register-write.write-timeout", () -> "PT3S");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    // Der ECHTE Zuhörer wird im Test von Hand gebaut (er hängt sonst an einem
    // Broker, den dieser Test nicht braucht) - mit den ECHTEN Repositories.
    @Autowired
    DeviceRepository deviceRepo;

    @Autowired
    EntityObservedRepository observedRepo;

    @Autowired
    ComponentApplyRepository componentApplyRepo;

    private final ObjectMapper json = new ObjectMapper();

    /**
     * Der komplette Anwendungsfall: 0x00E7 von 33,0 auf 70,0 kW, ohne SSH.
     *
     * <p><b>⚠ Die kW-Zahl hängt an der gemeldeten FAMILIE</b> (Stufe 2): erst
     * der Herzschlag sagt der Cloud, dass hier ein dreiphasiger Deye antwortet -
     * ohne ihn bliebe die vorsichtige Warnung, aber ohne Namen und ohne
     * Umrechnung.
     */
    @Test
    void theTwoStepJourneyWritesTheRegisterAndLeavesAProvableTrail() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Register-Anlage");
        UUID device = claim(customer, site, "edge-regwrite-e2e-01");
        // Die Box meldet ihre Einrichtung - erst DARAUS weiß die Cloud, welche
        // Register-Familie hier antwortet, und damit, was 0x00E7 bedeutet.
        heartbeat(site, device);

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> {
                String id = req.get("request_id").asText();
                boolean write = "schreiben".equals(req.get("mode").asText());
                return "{\"schema_version\":\"1.0\",\"type\":\"register_write_result\""
                        + ",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + site + "\""
                        + ",\"device_id\":\"" + device + "\",\"request_id\":\"" + id + "\""
                        + ",\"answered_at\":\"2026-08-19T14:02:49Z\""
                        + ",\"mode\":\"" + req.get("mode").asText() + "\",\"ok\":true"
                        + ",\"before_raw\":3300"
                        + (write ? ",\"after_raw\":7000,\"wrote\":true,\"adopted\":true" : "")
                        + ",\"target_label\":\"Deye SUN-30K-SG01HP3 · 192.168.0.28 · Unit 1\""
                        + ",\"message\":\"" + (write ? "Übernommen." : "Gelesen.") + "\"}";
            });

            // --- Schritt 1: den Ist-Wert lesen -------------------------------
            ResponseEntity<Map<String, Object>> preview = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7"));
            assertThat(preview.getStatusCode()).isEqualTo(HttpStatus.OK);

            JsonNode asked = stub.awaitRequest();
            assertThat(stub.lastTopic).isEqualTo(
                    "ems/" + TENANT_A + "/" + site + "/" + device + "/v2/register-write");
            assertThat(asked.get("type").asText()).isEqualTo("register_write_request");
            assertThat(asked.get("mode").asText()).isEqualTo("lesen");
            assertThat(asked.get("register").get("address").asInt()).isEqualTo(231);
            assertThat(asked.get("target").get("kind").asText()).isEqualTo("primary");
            // Die Vorschau schreibt nichts - der Umschlag trägt weder Wert noch
            // Bestätigung.
            assertThat(asked.has("value")).isFalse();
            assertThat(asked.has("confirm")).isFalse();
            // requested_at ist die zweite Hälfte von „nicht retained".
            assertThat(asked.get("requested_at").asText()).isNotBlank();

            Map<String, Object> p = preview.getBody();
            assertThat(p.get("beforeRaw")).isEqualTo(3300);
            assertThat(((Number) p.get("beforeScaled")).doubleValue()).isEqualTo(33.0);
            assertThat(p.get("registerClass")).isEqualTo("netz_compliance");
            assertThat(p.get("noteRequired")).isEqualTo(true);
            assertThat(p.get("outcome")).isEqualTo("gelesen");

            // --- Schritt 2: bestätigen ---------------------------------------
            ResponseEntity<Map<String, Object>> write = post(
                    "/api/v1/sites/" + site + "/register-write", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7",
                            "value", "7000", "expectedBefore", 3300,
                            "note", "Freigabe des Netzbetreibers vom 18.08."));
            assertThat(write.getStatusCode()).isEqualTo(HttpStatus.OK);

            JsonNode order = stub.awaitRequest();
            assertThat(order.get("mode").asText()).isEqualTo("schreiben");
            assertThat(order.get("value").asInt()).isEqualTo(7000);
            assertThat(order.get("expected_before").asInt())
                    .as("der Wächter reist automatisch mit").isEqualTo(3300);
            assertThat(order.get("confirm").asText())
                    .as("die Bestätigung nennt Register UND Wert").isEqualTo("0X00E7=7000");

            Map<String, Object> w = write.getBody();
            assertThat(w.get("outcome")).isEqualTo("uebernommen");
            assertThat(w.get("adopted")).isEqualTo(true);
            assertThat(w.get("afterRaw")).isEqualTo(7000);
            assertThat(((Number) w.get("afterScaled")).doubleValue()).isEqualTo(70.0);
            assertThat((String) w.get("targetLabel")).contains("192.168.0.28");

            // --- Der Beleg: EIN gefalteter Vorgang mit beweisbarer Herkunft ---
            List<Map<String, Object>> trail = history(customer, site);
            assertThat(trail).hasSize(1);
            Map<String, Object> e = trail.get(0);
            assertThat(e.get("origin")).isEqualTo("kunde");
            assertThat(e.get("source")).isEqualTo("portal");
            assertThat(e.get("actorName")).isEqualTo("demo");
            assertThat(e.get("viaTenantSwitcher")).isEqualTo(false);
            // Die VERBATIM getippten Begriffe - nicht unsere Normalisierung.
            // ⚠ Ein Vorgang der PRIMÄREN Lane trägt KEINE Komponente: er gehört
            // dem Schreibweg der Box, und ihn einem einzelnen Gerät dahinter
            // anzulasten wäre eine erfundene Zuordnung (Anlagen-Zentrale Stufe 1).
            assertThat(e.get("entityId")).isNull();
            assertThat(e.get("addressInput")).isEqualTo("0x00E7");
            assertThat(e.get("valueInput")).isEqualTo("7000");
            assertThat(e.get("note")).isEqualTo("Freigabe des Netzbetreibers vom 18.08.");
            assertThat(e.get("address")).isEqualTo(231);
            assertThat(e.get("addressHex")).isEqualTo("0x00e7");
            assertThat(e.get("registerClass")).isEqualTo("netz_compliance");
            assertThat(e.get("beforeRaw")).isEqualTo(3300);
            assertThat(e.get("afterRaw")).isEqualTo(7000);
            assertThat(e.get("adopted")).isEqualTo(true);
            assertThat(e.get("outcome")).isEqualTo("uebernommen");
            assertThat(e.get("deviceRef")).isEqualTo("edge-regwrite-e2e-01");

            // --- Der vierte Strom trägt dieselbe Zeile, ohne sie zu kopieren --
            ResponseEntity<Map<String, Object>> hist = get(
                    "/api/v1/sites/" + site + "/command-history", customer);
            assertThat(hist.getStatusCode()).isEqualTo(HttpStatus.OK);
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> entries =
                    (List<Map<String, Object>>) hist.getBody().get("entries");
            List<Map<String, Object>> register = entries.stream()
                    .filter(x -> "register".equals(x.get("stream"))).toList();
            assertThat(register).hasSize(1);
            assertThat(register.get(0).get("kind")).isEqualTo("ereignis");
            assertThat(register.get(0).get("eventKind")).isEqualTo("register_geschrieben");
            assertThat(register.get(0).get("source")).isEqualTo("portal");
            @SuppressWarnings("unchecked")
            Map<String, Object> nested = (Map<String, Object>) register.get(0).get("register");
            assertThat(nested.get("requestId")).isEqualTo(e.get("requestId"));
            assertThat(nested.get("outcome")).isEqualTo("uebernommen");
        }
    }

    /**
     * D5: bei einem Register der Netz-Anmeldung ist die Notiz PFLICHT - und die
     * Ablehnung fällt, BEVOR irgendetwas das Haus verlässt.
     */
    @Test
    void theNetzComplianceNoteIsMandatoryAndNothingLeavesTheHouseWithoutIt() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Notiz-Anlage");
        UUID device = claim(customer, site, "edge-regwrite-e2e-note");

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> null); // zeichnet auf, antwortet nie

            ResponseEntity<Map<String, Object>> refused = post(
                    "/api/v1/sites/" + site + "/register-write", customer,
                    Map.of("deviceId", device.toString(), "address", "231", "value", "7000"));
            assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(refused.getBody().get("message").toString())
                    .contains("Netz-Anmeldung");

            assertThat(stub.seen.poll(1, TimeUnit.SECONDS))
                    .as("eine abgewiesene Anfrage erreicht das Gerät nie").isNull();
            assertThat(history(customer, site))
                    .as("und hinterlässt keine Zeile, die eine Anforderung behauptet").isEmpty();

            // Ein unbekanntes Register verlangt KEINE Notiz - die Pflicht hängt
            // an der Klasse, nicht am Feature.
            ResponseEntity<Map<String, Object>> other = post(
                    "/api/v1/sites/" + site + "/register-write", customer,
                    Map.of("deviceId", device.toString(), "address", "1234", "value", "1"));
            assertThat(other.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(stub.awaitRequest().get("register").get("address").asInt())
                    .isEqualTo(1234);
        }
    }

    /**
     * Schweigen ist NIE „nicht geschrieben" - und eine Sekunden später
     * eintreffende Quittung ist trotzdem aktenkundig.
     */
    @Test
    void silenceIsUnknownAndALateReceiptStillLands() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Stumme Register-Anlage");
        UUID device = claim(customer, site, "edge-regwrite-e2e-silent");

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> null);

            ResponseEntity<Map<String, Object>> write = post(
                    "/api/v1/sites/" + site + "/register-write", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7", "value", "7000",
                            "note", "Netzbetreiber-Freigabe liegt vor"));
            assertThat(write.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(write.getBody().get("outcome")).isEqualTo("unbekannt");
            assertThat(write.getBody().get("errorCode")).isEqualTo("timeout");
            assertThat(write.getBody().get("message").toString()).contains("unbekannt");

            List<Map<String, Object>> trail = history(customer, site);
            assertThat(trail).hasSize(1);
            assertThat(trail.get(0).get("outcome")).isEqualTo("unbekannt");
            assertThat(trail.get(0).get("adopted"))
                    .as("ohne Quittung gibt es keine Aussage über die Übernahme").isNull();

            // Die verspätete Quittung: der Zuhörer persistiert sie UNABHÄNGIG
            // vom längst aufgegebenen Request-Thread.
            String requestId = (String) trail.get(0).get("requestId");
            stub.publish("ems/" + TENANT_A + "/" + site + "/" + device
                            + "/v2/register-write-result",
                    "{\"schema_version\":\"1.0\",\"type\":\"register_write_result\""
                            + ",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + site + "\""
                            + ",\"device_id\":\"" + device + "\""
                            + ",\"request_id\":\"" + requestId + "\""
                            + ",\"answered_at\":\"2026-08-19T14:09:00Z\""
                            + ",\"mode\":\"schreiben\",\"ok\":true,\"before_raw\":3300"
                            + ",\"after_raw\":7000,\"wrote\":true,\"adopted\":true}");

            Map<String, Object> folded = awaitOutcome(customer, site, "uebernommen");
            assertThat(folded.get("adopted")).isEqualTo(true);
            assertThat(folded.get("afterRaw")).isEqualTo(7000);
            assertThat(folded.get("requestId")).isEqualTo(requestId);
        }
    }

    /**
     * ⚠ DER PRODUKTIONSVORFALL VOM 20.08.2026, als Test: das Gerät antwortet -
     * nur LANGSAMER als das Budget der Cloud.
     *
     * <p>Die Ursache war Arithmetik: die Box bindet EINEN Bus-Rundlauf an 30 s
     * (sie muss hinter der EINEN Warteschlange je Ziel erst den laufenden Poll
     * abwarten), die Vorschau wartete aber nur 20 s. Auf einer belegten Anlage
     * kam die api damit strukturell zu spät - und weil beide Ausgänge DENSELBEN
     * Satz trugen, war „hat nie geantwortet" von „hat zu spät geantwortet" nicht
     * zu unterscheiden. Hier ist beides getrennt: der erste Anlauf nennt das
     * stumme Gerät, der zweite nennt die Verspätung - und nur beim zweiten hilft
     * „erneut versuchen".
     */
    @Test
    void aLateAnswerIsRecognisedAndTheNextAttemptSaysSoInsteadOfBlamingThePlant()
            throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Langsame Register-Anlage");
        UUID device = claim(customer, site, "edge-regwrite-e2e-late");

        try (DeviceStub stub = new DeviceStub()) {
            AtomicInteger seen = new AtomicInteger();
            CountDownLatch answered = new CountDownLatch(1);
            stub.answerWith(req -> {
                if (seen.incrementAndGet() > 1) {
                    return null; // der zweite Anlauf bleibt stumm
                }
                String topic = stub.lastTopic;
                String rid = req.get("request_id").asText();
                // NACH dem Budget (PT3S) - auf einem eigenen Faden, damit der
                // Stellvertreter weiter zustellen kann.
                Thread t = new Thread(() -> {
                    try {
                        Thread.sleep(4500);
                        stub.publish(topic + "-result",
                                "{\"schema_version\":\"1.0\""
                                        + ",\"type\":\"register_write_result\""
                                        + ",\"tenant_id\":\"" + TENANT_A + "\""
                                        + ",\"site_id\":\"" + site + "\""
                                        + ",\"device_id\":\"" + device + "\""
                                        + ",\"request_id\":\"" + rid + "\""
                                        + ",\"answered_at\":\"2026-08-20T07:35:05Z\""
                                        + ",\"mode\":\"lesen\",\"ok\":true"
                                        + ",\"before_raw\":3300}");
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    } finally {
                        answered.countDown();
                    }
                });
                t.setDaemon(true);
                t.start();
                return null;
            });

            ResponseEntity<Map<String, Object>> first = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7"));
            assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(first.getBody().get("errorCode")).isEqualTo("timeout");
            // Erster Anlauf: noch KEIN Beleg für eine Verspätung - also wird auch
            // keine behauptet.
            assertThat(first.getBody().get("message").toString())
                    .doesNotContain("zu spät");

            assertThat(answered.await(15, TimeUnit.SECONDS))
                    .as("die verspätete Antwort wurde abgeschickt").isTrue();
            Thread.sleep(500); // der Zuhörer darf sie noch einordnen

            ResponseEntity<Map<String, Object>> second = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7"));
            assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(second.getBody().get("errorCode")).isEqualTo("timeout");
            assertThat(second.getBody().get("message").toString())
                    .as("die verspätete Antwort ist der Grund, und sie wird genannt")
                    .contains("zu spät")
                    .contains("erneut versuchen");
            // ⚠ Und die Anlage wird NICHT beschuldigt, sich nicht zu melden.
            assertThat(second.getBody().get("message").toString())
                    .doesNotContain("noch nie bei VoltPilot gemeldet");

            // Eine Vorschau bleibt spurlos - auch die verspätete Antwort auf eine.
            assertThat(history(customer, site)).isEmpty();
        }
    }

    /** Eine Vorschau ändert nichts - und hinterlässt deshalb auch keine Spur. */
    @Test
    void aPreviewLeavesNoTrail() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Vorschau-Anlage");
        UUID device = claim(customer, site, "edge-regwrite-e2e-preview");

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> "{\"schema_version\":\"1.0\""
                    + ",\"type\":\"register_write_result\",\"tenant_id\":\"" + TENANT_A + "\""
                    + ",\"site_id\":\"" + site + "\",\"device_id\":\"" + device + "\""
                    + ",\"request_id\":\"" + req.get("request_id").asText() + "\""
                    + ",\"answered_at\":\"2026-08-19T14:02:49Z\",\"mode\":\"lesen\""
                    + ",\"ok\":true,\"before_raw\":3300}");

            post("/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7"));
            post("/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x00E7"));

            assertThat(history(customer, site))
                    .as("ein Protokoll der Lesungen würde die Schreibvorgänge begraben")
                    .isEmpty();
        }
    }

    /** Der Mandanten-Zaun - und die Herkunft eines Admins ist kenntlich. */
    @Test
    void theTenantFenceHoldsAndAnAdminsOriginIsNamed() throws Exception {
        String owner = token("demo", "demo");
        UUID site = createSite(owner, "Zaun-Anlage");
        UUID device = claim(owner, site, "edge-regwrite-e2e-fence");

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> "{\"schema_version\":\"1.0\""
                    + ",\"type\":\"register_write_result\",\"tenant_id\":\"" + TENANT_A + "\""
                    + ",\"site_id\":\"" + site + "\",\"device_id\":\"" + device + "\""
                    + ",\"request_id\":\"" + req.get("request_id").asText() + "\""
                    + ",\"answered_at\":\"2026-08-19T14:02:49Z\""
                    + ",\"mode\":\"" + req.get("mode").asText() + "\",\"ok\":true"
                    + ",\"before_raw\":3300,\"after_raw\":7000,\"wrote\":true,\"adopted\":true}");

            // Fremder Kunde: 404 (nie 403 - RLS macht die Anlage unsichtbar).
            String stranger = token("demo2", "demo2");
            ResponseEntity<Map<String, Object>> foreign = post(
                    "/api/v1/sites/" + site + "/register-write/preview", stranger,
                    Map.of("address", "0x00E7"));
            assertThat(foreign.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

            ResponseEntity<String> anonymous = rest.exchange(
                    url("/api/v1/sites/" + site + "/register-write/preview"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("address", "0x00E7"), jsonHeaders()), String.class);
            assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

            assertThat(stub.seen.poll(1, TimeUnit.SECONDS))
                    .as("ein abgewiesener Aufrufer erreicht das Gerät nie").isNull();

            // Der Admin über den Umschalter: dieselbe Route, aber die Herkunft
            // steht als voltpilot in der Papier-Spur.
            String admin = token("admin", "admin");
            ResponseEntity<Map<String, Object>> byAdmin = rest.exchange(
                    url("/api/v1/sites/" + site + "/register-write"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("deviceId", device.toString(), "address", "0x00E7",
                            "value", "7000", "note", "Anhebung nach Netzbetreiber-Freigabe"),
                            switcher(admin)),
                    new ParameterizedTypeReference<>() {});
            assertThat(byAdmin.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(byAdmin.getBody().get("outcome")).isEqualTo("uebernommen");

            List<Map<String, Object>> trail = history(owner, site);
            assertThat(trail).hasSize(1);
            assertThat(trail.get(0).get("origin")).isEqualTo("voltpilot");
            assertThat(trail.get(0).get("actorRole")).isEqualTo("platform-admin");
            assertThat(trail.get(0).get("viaTenantSwitcher")).isEqualTo(true);
        }
    }

    /** Welches Gerät geschrieben wird, wird nie geraten. */
    @Test
    void theTargetDeviceIsResolvedOrNamed() {
        String customer = token("demo", "demo");
        UUID empty = createSite(customer, "Anlage ohne Gerät");
        ResponseEntity<Map<String, Object>> none = post(
                "/api/v1/sites/" + empty + "/register-write/preview", customer,
                Map.of("address", "0x00E7"));
        assertThat(none.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        UUID site = createSite(customer, "Anlage mit zwei Geräten");
        claim(customer, site, "edge-regwrite-e2e-x");
        claim(customer, site, "edge-regwrite-e2e-y");
        ResponseEntity<Map<String, Object>> ambiguous = post(
                "/api/v1/sites/" + site + "/register-write/preview", customer,
                Map.of("address", "0x00E7"));
        assertThat(ambiguous.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(ambiguous.getBody().get("message").toString()).contains("mehrere Geräte");

        // Eine unlesbare Adresse fällt sofort, ohne Broker-Runde.
        ResponseEntity<Map<String, Object>> garbage = post(
                "/api/v1/sites/" + empty + "/register-write/preview", customer,
                Map.of("address", "E7"));
        assertThat(garbage.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * STUFE 2: der Geräte-Picker, das Register-Wissen JE FAMILIE, die
     * Komponenten-Lane und der Schreibzähler - in einer Reise, weil sie
     * zusammen die eine Frage beantworten, die Schritt 1 stellt: „auf welches
     * Gerät schreibe ich hier eigentlich, und was ist das für ein Register?"
     */
    @Test
    void thePickerNamesEveryDeviceAndTheKnowledgeSpeaksPerFamily() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Register-Anlage Stufe 2");
        UUID device = claim(customer, site, "edge-regwrite-s2-01");

        // Vor dem Herzschlag weiß die Cloud NICHTS über die Einrichtung - das
        // Ziel bleibt trotzdem wählbar (die primäre Lane nennt keinen Endpunkt).
        List<Map<String, Object>> before = targets(customer, site);
        assertThat(before).hasSize(1);
        assertThat(before.get(0).get("lane")).isEqualTo("primary");
        assertThat(before.get(0).get("family")).as("keine erfundene Familie").isNull();
        assertThat(before.get(0).get("writable")).isEqualTo(true);

        heartbeat(site, device);

        List<Map<String, Object>> after = targets(customer, site);
        Map<String, Object> primary = after.stream()
                .filter(t -> "primary".equals(t.get("lane"))).findFirst().orElseThrow();
        assertThat(primary.get("family")).isEqualTo("hybrid_3p");
        assertThat(primary.get("host")).isEqualTo("192.168.0.28");
        assertThat(primary.get("writable")).isEqualTo(true);
        // Die go-e-Wallbox wird GENANNT - mit Grund, nie verschwiegen.
        Map<String, Object> wallbox = after.stream()
                .filter(t -> "goe_http_api".equals(t.get("communication"))).findFirst()
                .orElseThrow();
        assertThat(wallbox.get("writable")).isEqualTo(false);
        assertThat(wallbox.get("reason").toString()).contains("Modbus");

        // Das Verzeichnis ist DATEN und spricht je Familie.
        ResponseEntity<List<Map<String, Object>>> knowledge = rest.exchange(
                url("/api/v1/sites/" + site + "/register-write/register-knowledge"),
                HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                new ParameterizedTypeReference<>() {});
        assertThat(knowledge.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(knowledge.getBody()).extracting(f -> f.get("family"))
                .contains("hybrid_3p", "hybrid_1p");

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> ok(site, device, req, 3300, null));

            // ⚠ Die Klasse folgt der FAMILIE: 0x008D ist auf hybrid_3p bekannt.
            ResponseEntity<Map<String, Object>> known = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x008D"));
            stub.awaitRequest();
            assertThat(known.getBody().get("registerClass")).isEqualTo("bekannt");
            assertThat(known.getBody().get("registerLabel").toString()).contains("Energie-Muster");
            assertThat(known.getBody().get("noteRequired")).isEqualTo(false);
            // Und die Vorschau nennt Roh UND skaliert, wo eine Skala bekannt ist.
            ResponseEntity<Map<String, Object>> limit = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "231"));
            stub.awaitRequest();
            assertThat(limit.getBody().get("beforeRaw")).isEqualTo(3300);
            assertThat(limit.getBody().get("beforeScaled")).isEqualTo(33.0);
            assertThat(limit.getBody().get("scaleUnit")).isEqualTo("kW");
            assertThat(limit.getBody().get("noteRequired")).isEqualTo(true);
            assertThat(limit.getBody().get("writesToday")).isEqualTo(0);
        }
    }

    /**
     * Die zwei NEUEN Lanes reisen bis auf den Draht - und die Cloud nennt bei
     * der Komponente NUR die Kennung, damit ein Auftrag nie auf einen fremden
     * Host umgelenkt werden kann.
     */
    @Test
    void theTwoNewLanesReachTheDeviceAndTheWriteCounterIsHonest() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Register-Anlage Lanes");
        UUID device = claim(customer, site, "edge-regwrite-s2-02");
        UUID entity = UUID.randomUUID();

        try (DeviceStub stub = new DeviceStub()) {
            stub.answerWith(req -> ok(site, device, req, 0, 1));

            // --- Lane „lan": der Endpunkt reist, weil es keinen anderen Weg gibt
            ResponseEntity<Map<String, Object>> lan = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "lane", "lan",
                            "host", "192.168.0.44", "port", 1502, "unitId", 3,
                            "registerKind", "coil", "address", "3"));
            assertThat(lan.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode asked = stub.awaitRequest();
            assertThat(asked.path("target").path("kind").asText()).isEqualTo("lan");
            assertThat(asked.path("target").path("host").asText()).isEqualTo("192.168.0.44");
            assertThat(asked.path("target").path("port").asInt()).isEqualTo(1502);
            assertThat(asked.path("target").path("unit_id").asInt()).isEqualTo(3);
            assertThat(asked.path("register").path("kind").asText()).isEqualTo("coil");
            // ⚠ Ein fremdes Gerät hat keine Familie - also KEIN Name, nie ein
            // Deye-Etikett auf einem Kunden-Modbus-Gerät.
            assertThat(lan.getBody().get("registerLabel")).isNull();
            assertThat(lan.getBody().get("registerClass")).isEqualTo("unbekannt");

            // --- Lane „entity": es reist NUR die Kennung
            ResponseEntity<Map<String, Object>> comp = post(
                    "/api/v1/sites/" + site + "/register-write", customer,
                    Map.of("deviceId", device.toString(), "lane", "entity",
                            "entityId", entity.toString(),
                            "registerKind", "coil", "address", "3", "value", "1"));
            assertThat(comp.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode order = stub.awaitRequest();
            assertThat(order.path("target").path("kind").asText()).isEqualTo("entity");
            assertThat(order.path("target").path("entity_id").asText())
                    .isEqualTo(entity.toString());
            assertThat(order.path("target").has("host"))
                    .as("die Cloud nennt bei einer Komponente NIE einen Host").isFalse();
            assertThat(order.path("confirm").asText()).isEqualTo("0X0003=1");

            // ⚠ Die KOMPONENTE steht im Journal (Anlagen-Zentrale Stufe 1): sie
            // ist die einzige Zuordnung, mit der sich ein Vorgang einem Gerät
            // HINTER der Box zuschreiben lässt. Ein Vorgang der primären Lane
            // trägt sie NICHT - er gehört dem Schreibweg der Box, und ihn einem
            // einzelnen Gerät anzulasten wäre eine erfundene Zuordnung.
            List<Map<String, Object>> journal = history(customer, site);
            assertThat(journal.stream()
                    .filter(r -> "entity".equals(r.get("lane")))
                    .map(r -> r.get("entityId")))
                    .containsOnly(entity.toString());
            assertThat(journal).as("nur der Schreibvorgang, nie eine Vorschau").hasSize(1);

            // Der Schreibzähler zählt ANFORDERUNGEN dieses Registers - und nur
            // dieses: die Vorschau oben hat NICHTS protokolliert.
            ResponseEntity<Map<String, Object>> again = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "lane", "entity",
                            "entityId", entity.toString(),
                            "registerKind", "coil", "address", "3"));
            stub.awaitRequest();
            assertThat(again.getBody().get("writesToday"))
                    .as("heute bereits einmal geschrieben").isEqualTo(1);
            ResponseEntity<Map<String, Object>> other = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", device.toString(), "address", "0x1234"));
            stub.awaitRequest();
            assertThat(other.getBody().get("writesToday"))
                    .as("ein anderes Register hat seinen eigenen Zähler").isEqualTo(0);
        }

        // Eine Lane ohne ihre Pflichtangabe ist eine kaputte Anfrage - und sie
        // fällt, BEVOR irgendetwas den Broker erreicht.
        assertThat(post("/api/v1/sites/" + site + "/register-write/preview", customer,
                Map.of("deviceId", device.toString(), "lane", "entity", "address", "1"))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post("/api/v1/sites/" + site + "/register-write/preview", customer,
                Map.of("deviceId", device.toString(), "lane", "lan", "address", "1"))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post("/api/v1/sites/" + site + "/register-write/preview", customer,
                Map.of("deviceId", device.toString(), "lane", "mond", "address", "1"))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ── Helfer ────────────────────────────────────────────────────────────

    /** Eine Quittung in der Form des Kontrakts. */
    private String ok(UUID site, UUID device, JsonNode req, int before, Integer after) {
        boolean write = "schreiben".equals(req.get("mode").asText());
        return "{\"schema_version\":\"1.0\",\"type\":\"register_write_result\""
                + ",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + site + "\""
                + ",\"device_id\":\"" + device + "\",\"request_id\":\""
                + req.get("request_id").asText() + "\""
                + ",\"answered_at\":\"2026-08-19T14:02:49Z\""
                + ",\"mode\":\"" + req.get("mode").asText() + "\",\"ok\":true"
                + ",\"before_raw\":" + before
                + (write && after != null
                        ? ",\"after_raw\":" + after + ",\"wrote\":true,\"adopted\":true" : "")
                + ",\"message\":\"ok\"}";
    }

    /**
     * Schickt einen Herzschlag durch den ECHTEN Zuhörer - also über genau die
     * Form, die auf dem Draht liegt, statt über einen Test-Nachbau des Ingests.
     */
    /**
     * DIE ADRESSE IST NICHT DAS ZIEL - die Herzogau-Form, mit der
     * ANTI-KOINZIDENZ-REGEL (Produktionsvorfall 20.08.2026).
     *
     * <p>Der Auftrag reist auf dem Pfad EINER Geräte-Kennung, und dort hört
     * genau der Core zu, der sich unter ihr angemeldet hat. Landet er auf einer
     * Geräte-Zeile ohne Core, ist er NICHT-retained und damit spurlos weg: kein
     * Abonnent, keine Ablehnung, keine Zeile in irgendeinem Protokoll - auf
     * beiden Seiten. Genau diese Stille hat zwei Untersuchungsrunden gekostet.
     *
     * <p><b>⚠ WARUM ES BISHER KEIN TEST SAH:</b> der Stellvertreter oben
     * abonniert die WILDCARD {@code ems/+/+/+/v2/register-write} und antwortet
     * auf dem Topic, das ankam - er hätte einen Auftrag auf JEDER Kennung
     * beantwortet. Auf der Go-Seite ruft {@code agent/register_write_test.go}
     * den Handler DIREKT auf, das Abonnement des Cloud-Links kommt dort gar
     * nicht vor. Und die einzige Anlage im Test hatte GENAU EIN Gerät, also
     * fielen richtige und falsche Antwort ohnehin zusammen. <b>Dieser Test hält
     * deshalb drei Kennungen AUSEINANDER</b> (die meldende Box, eine zweite
     * Geräte-Zeile, die sich nie gemeldet hat, und die Entitäts-Kennung des
     * Ziels) und lässt den Stellvertreter NUR auf dem Pfad der Box zuhören.
     */
    @Test
    void theOrderIsAddressedToTheREPORTINGBoxAndNeverToASilentDeviceRow() throws Exception {
        String customer = token("demo", "demo");
        UUID site = createSite(customer, "Herzogau-Adressierung");
        // Die BOX: sie meldet ihre Einrichtung UND hat Telemetrie geschickt -
        // hinter dieser Zeile steckt nachweislich ein Core.
        UUID box = claim(customer, site, "edge-regwrite-addr-box");
        heartbeat(site, box);
        markAsReporting(site, box);
        // Eine ZWEITE Geräte-Zeile derselben Anlage, die sich NIE gemeldet hat.
        UUID silent = claim(customer, site, "edge-regwrite-addr-silent");
        assertThat(silent).isNotEqualTo(box);

        String boxRequestTopic = "ems/" + TENANT_A + "/" + site + "/" + box + "/v2/register-write";

        try (DeviceStub stub = new DeviceStub()) {
            // NUR das Topic der Box - kein Echo, keine Wildcard.
            stub.answerOnlyOn(boxRequestTopic, boxRequestTopic + "-result", req ->
                    "{\"schema_version\":\"1.0\",\"type\":\"register_write_result\""
                            + ",\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + site + "\""
                            + ",\"device_id\":\"" + box + "\""
                            + ",\"request_id\":\"" + req.get("request_id").asText() + "\""
                            + ",\"mode\":\"lesen\",\"ok\":true,\"before_raw\":3300"
                            + ",\"message\":\"Gelesen.\"}");

            // --- (1) Das Ziel gewinnt über die Angabe des Aufrufers ----------
            // Der Aufrufer benennt die STILLE Zeile, das gewählte Ziel ist aber
            // die Wallbox, die die BOX meldet. Vor dem Fix landete der Auftrag
            // auf dem Pfad der stillen Zeile - niemand hörte zu.
            ResponseEntity<Map<String, Object>> viaTarget = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", silent.toString(), "lane", "lan",
                            "host", "192.168.0.50", "address", "0x00E7"));
            assertThat(viaTarget.getStatusCode()).isEqualTo(HttpStatus.OK);
            stub.awaitRequest();
            assertThat(stub.lastTopic).as("der Auftrag liegt auf dem Pfad der MELDENDEN Box")
                    .isEqualTo(boxRequestTopic);
            assertThat(viaTarget.getBody().get("beforeRaw")).isEqualTo(3300);

            // --- (2) Auf der primären Lane trägt die Adresse der Aufrufer ----
            // Dort gibt es kein meldendes Gerät, aus dem sie sich ableiten
            // ließe. Der Auftrag geht trotzdem hinaus - Schweigen ist eine
            // Lücke, kein Beweis -, aber der Verwechslungs-Verdacht steht im
            // Schweige-Grund und nennt die Box, die sich wirklich meldet.
            ResponseEntity<Map<String, Object>> dead = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", silent.toString(), "address", "0x00E7"));
            assertThat(dead.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(dead.getBody().get("outcome")).isEqualTo("unbekannt");
            assertThat((String) dead.getBody().get("message"))
                    .contains("noch nie bei VoltPilot gemeldet")
                    .contains("edge-regwrite-addr-box");
            assertThat(stub.sawNothing())
                    .as("die Box hört auf diesem Pfad nicht zu").isTrue();

            // --- (3) Der Normalfall bleibt, was er war ----------------------
            ResponseEntity<Map<String, Object>> normal = post(
                    "/api/v1/sites/" + site + "/register-write/preview", customer,
                    Map.of("deviceId", box.toString(), "address", "0x00E7"));
            assertThat(normal.getStatusCode()).isEqualTo(HttpStatus.OK);
            JsonNode asked = stub.awaitRequest();
            assertThat(stub.lastTopic).isEqualTo(boxRequestTopic);
            assertThat(asked.get("device_id").asText())
                    .as("Topic und Nutzlast nennen dasselbe Gerät").isEqualTo(box.toString());
            assertThat(asked.get("target").get("kind").asText()).isEqualTo("primary");
        }
    }

    /**
     * Macht aus einer Geräte-Zeile eine BOX: eine angekommene Telemetrie-Zeile
     * ist der Beleg, dass hinter ihr ein Core läuft (die
     * {@code received_at}-Regel des Hauses - ANKUNFT, nie Beobachtungszeit).
     * Geschrieben als Superuser, weil das im Betrieb der Writer tut.
     */
    private void markAsReporting(UUID site, UUID device) throws Exception {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.PreparedStatement ps = c.prepareStatement(
                        "INSERT INTO telemetry (time, tenant_id, site_id, device_id, received_at) "
                                + "VALUES (now(), ?::uuid, ?::uuid, ?::uuid, now())")) {
            ps.setString(1, TENANT_A);
            ps.setString(2, site.toString());
            ps.setString(3, device.toString());
            ps.executeUpdate();
        }
    }

    private void heartbeat(UUID site, UUID device) {
        EntityStatusListener listener = new EntityStatusListener("tcp://unused", "", "",
                deviceRepo, observedRepo, componentApplyRepo);
        String localSetup = """
                [{"id":"inverter","kind":"inverter","role":"inverter","brand":"deye",
                  "model":"sun-30k-sg01hp3","label":"Deye SUN-30K","family":"hybrid_3p",
                  "communication":"solarman_v5",
                  "connection":{"ip":"192.168.0.28","port":8899,"serial":"2985159064",
                                "mb_slave_id":1}},
                 {"id":"src-goe-1","kind":"source","role":"consumer","brand":"go-e",
                  "model":"charger","label":"Wallbox Hof","communication":"goe_http_api",
                  "connection":{"ip":"192.168.0.50"}}]""";
        String payload = """
                {"schema_version":"1.0","tenant_id":"%s","site_id":"%s","device_id":"%s",
                 "entities":{"revision":"r-ist","count":0,"ids":[],"local_setup":%s}}"""
                .formatted(TENANT_A, site, device, localSetup);
        listener.handle("ems/%s/%s/%s/status".formatted(TENANT_A, site, device),
                payload.getBytes(StandardCharsets.UTF_8));
    }

    private List<Map<String, Object>> targets(String token, UUID site) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/register-write/targets"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }


    private Map<String, Object> awaitOutcome(String token, UUID site, String outcome)
            throws Exception {
        for (int i = 0; i < 40; i++) {
            List<Map<String, Object>> trail = history(token, site);
            if (!trail.isEmpty() && outcome.equals(trail.get(0).get("outcome"))) {
                return trail.get(0);
            }
            Thread.sleep(150);
        }
        throw new AssertionError("die verspätete Quittung erreichte das Journal nie");
    }

    /** Ein Gerät, das auf seinem eigenen Register-Topic zuhört und quittiert. */
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
            client.subscribe("ems/+/+/+/v2/register-write", 1, (topic, msg) -> {
                JsonNode req = json.readTree(new String(msg.getPayload(), StandardCharsets.UTF_8));
                lastTopic = topic;
                seen.offer(req);
                String answer = fn.answer(req);
                if (answer != null) {
                    publish(topic + "-result", answer);
                }
            });
        }

        /**
         * Ein Gerät, das GENAU EIN Topic abonniert und auf SEINEM eigenen
         * antwortet - die einzige Form, in der ein Stellvertreter die ADRESSE
         * überhaupt prüfen kann.
         *
         * <p><b>⚠ Die Wildcard-Variante darüber kann das NICHT</b>
         * (Produktionsvorfall 20.08.2026): sie hört auf jedem Geräte-Pfad zu und
         * echot auf den, der ankam - ein Auftrag, der auf der Kennung eines
         * ANDEREN Geräts landet, wird dort also beantwortet und der Test bleibt
         * grün. Die echte Box abonniert exakt ihr eigenes Topic
         * ({@code edge-app/core/internal/cloud} {@code Link.topic}); ein
         * NICHT-retainter Auftrag daneben ist spurlos weg.
         */
        void answerOnlyOn(String requestTopic, String resultTopic, AnswerFn fn) throws Exception {
            client.subscribe(requestTopic, 1, (topic, msg) -> {
                JsonNode req = json.readTree(new String(msg.getPayload(), StandardCharsets.UTF_8));
                lastTopic = topic;
                seen.offer(req);
                String answer = fn.answer(req);
                if (answer != null) {
                    publish(resultTopic, answer);
                }
            });
        }

        boolean sawNothing() throws Exception {
            return seen.poll(1, TimeUnit.SECONDS) == null;
        }

        void publish(String topic, String payload) {
            try {
                MqttMessage out = new MqttMessage(payload.getBytes(StandardCharsets.UTF_8));
                out.setQos(1);
                out.setRetained(false);
                client.publish(topic, out);
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        }

        JsonNode awaitRequest() throws Exception {
            JsonNode req = seen.poll(15, TimeUnit.SECONDS);
            assertThat(req).as("die Anfrage erreicht das Gerät").isNotNull();
            return req;
        }

        @Override
        public void close() {
            try {
                client.disconnect();
                client.close();
            } catch (Exception ignored) {
                // ein verschwindender Stellvertreter ist kein Testfehler
            }
        }
    }

    @FunctionalInterface
    private interface AnswerFn {
        String answer(JsonNode request) throws Exception;
    }

    private List<Map<String, Object>> history(String token, UUID site) {
        ResponseEntity<List<Map<String, Object>>> res = rest.exchange(
                url("/api/v1/sites/" + site + "/register-write/history"), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
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

    private ResponseEntity<Map<String, Object>> get(String path, String token) {
        return rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(bearer(token)),
                new ParameterizedTypeReference<>() {});
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

    private static HttpHeaders switcher(String adminToken) {
        HttpHeaders headers = bearer(adminToken);
        headers.set("X-Tenant-Id", TENANT_A);
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
