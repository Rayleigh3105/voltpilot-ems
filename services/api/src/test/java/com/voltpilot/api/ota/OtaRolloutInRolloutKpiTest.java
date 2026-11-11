package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.TestKennung;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
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
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Geräte &amp; Updates G1-Folgefund: {@code kpi.inRollout} zählte bisher jedes
 * Gerät, das in einem der letzten Rollouts VORKOMMT - auch ein längst
 * bestätigtes, fehlgeschlagenes oder abgelöstes. Eigener, leerer Container-Satz
 * statt Anhängen an {@code OtaRolloutApiTest}: die dortige Reihenfolge teilt
 * EINE Datenbank über neun Tests, und das Fenster der letzten fünf Rollouts
 * (Geräte &amp; Updates S0) würde die hier geprüfte Zahl mit fremden,
 * absichtlich offen gelassenen Zuweisungen vermischen.
 */
@Testcontainers(disabledWithoutDocker = true)
@AutoConfigureTestRestTemplate
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
// Das Release-Register ist GLOBAL und MONOTON (wie in OtaRolloutApiTest) - die
// drei Tests teilen den einen Container-Satz der Klasse und müssen deshalb in
// aufsteigender releaseSeq-Reihenfolge laufen.
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class OtaRolloutInRolloutKpiTest {

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
        // Der Wächter wird von HAND getaktet (reconcile mit gesetztem `now`).
        registry.add("voltpilot.ota.mqtt-listener-enabled", () -> "false");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    RolloutService rollouts;

    private final ObjectMapper json = new ObjectMapper();

    private static final String MANIFEST_TEMPLATE = """
            {
              "schema_version" : "1.0",
              "release": "%s",
              "release_seq" : %d,
              "target_commit": "3bf8c038a1b2",
              "signing_key_id": "rel-2026-a"
            }
            """;
    private static final String SIGNATURE =
            "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\",\"key_id\":\"rel-2026-a\","
                    + "\"domain\":\"release\",\"signature\":\"AAAA\"}\n";

    /**
     * Die Kern-Reproduktion: ein Rollout an drei Geräte, alle drei bestätigt -
     * {@code inRollout} muss 0 sein (vorher: 3, weil das Fenster jede
     * Anwesenheit zählte statt nur das wirklich Offene).
     */
    @Test
    @Order(1)
    void dreiBestaetigteGeraeteZaehlenNichtMehrAlsImRollout() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.11.0", 50);

        UUID x = claim(customer, TestKennung.box("kpi-x-" + UUID.randomUUID()));
        UUID y = claim(customer, TestKennung.box("kpi-y-" + UUID.randomUUID()));
        UUID z = claim(customer, TestKennung.box("kpi-z-" + UUID.randomUUID()));

        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 50, "devices", List.of(x.toString(), y.toString(), z.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // Alle drei melden den Soll-Stand - der Rollout ist durch.
        reportRunning(x, "edge-2026.11.0", "idle", "ok");
        reportRunning(y, "edge-2026.11.0", "idle", "ok");
        reportRunning(z, "edge-2026.11.0", "idle", "ok");
        rollouts.reconcile(Instant.now());

        JsonNode page = readModel(admin);
        assertThat(stateOf(page, x)).isEqualTo("bestaetigt");
        assertThat(stateOf(page, y)).isEqualTo("bestaetigt");
        assertThat(stateOf(page, z)).isEqualTo("bestaetigt");
        assertThat(page.get("kpi").get("inRollout").asInt())
                .as("drei bestätigte Geräte laufen nicht mehr").isEqualTo(0);
    }

    /**
     * Die Mischfälle desselben Folgefunds: ausstehend zählt, fehlgeschlagen
     * zählt in {@code failed} statt {@code inRollout}, und eine NEUERE
     * Zuweisung an ein Gerät mit älterem bestätigtem Rollout zählt wieder -
     * unter der neuesten Zuweisung, nicht doppelt.
     */
    @Test
    @Order(2)
    void gemischteFaelleZaehlenNurDasWirklichOffene() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.11.1", 51);
        registerRelease(admin, "edge-2026.11.2", 52);

        UUID ausstehend = claim(customer, TestKennung.box("kpi-p-" + UUID.randomUUID()));
        UUID fehlgeschlagen = claim(customer, TestKennung.box("kpi-f-" + UUID.randomUUID()));
        UUID umgehaengt = claim(customer, TestKennung.box("kpi-r-" + UUID.randomUUID()));

        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 51,
                        "devices", List.of(ausstehend.toString(), fehlgeschlagen.toString(),
                                umgehaengt.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // Angefragt/angenommen, aber noch nicht bestätigt: läuft noch.
        reportRunning(ausstehend, "edge-2026.10.9", "idle", "ok");
        // Fehlgeschlagen zählt in `failed`, nicht in `inRollout`.
        reportRunning(fehlgeschlagen, "edge-2026.10.9", "failed", "ok");
        // Bereits bestätigt.
        reportRunning(umgehaengt, "edge-2026.11.1", "idle", "ok");
        rollouts.reconcile(Instant.now());

        JsonNode page = readModel(admin);
        assertThat(stateOf(page, ausstehend)).isEqualTo("ausstehend");
        assertThat(stateOf(page, fehlgeschlagen)).isEqualTo("fehlgeschlagen");
        assertThat(stateOf(page, umgehaengt)).as("bereits bestätigt").isEqualTo("bestaetigt");
        assertThat(page.get("kpi").get("inRollout").asInt())
                .as("nur das ausstehende Gerät läuft noch").isEqualTo(1);
        assertThat(page.get("kpi").get("failed").asInt()).isEqualTo(1);

        // Eine zweite, neuere Welle hängt das längst bestätigte Gerät um - es
        // zählt wieder, aber nur EINMAL, unter der neuesten Zuweisung.
        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 52, "devices", List.of(umgehaengt.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        rollouts.reconcile(Instant.now());

        page = readModel(admin);
        assertThat(sollOf(page, umgehaengt)).isEqualTo("edge-2026.11.2");
        assertThat(stateOf(page, umgehaengt)).isEqualTo("ausstehend");
        assertThat(page.get("kpi").get("inRollout").asInt())
                .as("das umgehängte Gerät läuft wieder, das ausstehende weiterhin")
                .isEqualTo(2);
    }

    /**
     * Ein Gerät, das mitten im Anwenden verstummt ist, steht schon in
     * {@code failed} (wie der Zeilen-Zähler es behandelt) - es darf nicht
     * ZUSÄTZLICH als „im Rollout" laufend erscheinen. Vorher (der eigene,
     * noch offene Rest der Geräte aus Test 2) gemessen statt gegen 0: das
     * Fenster der letzten fünf Rollouts trägt deren ausstehende Geräte
     * weiter mit, und das ist hier nicht der Punkt.
     */
    @Test
    @Order(3)
    void imUpdateVerstummtZaehltNurInFailedNichtInInRollout() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        int inRolloutVorher = readModel(admin).get("kpi").get("inRollout").asInt();
        int failedVorher = readModel(admin).get("kpi").get("failed").asInt();
        registerRelease(admin, "edge-2026.11.3", 53);

        UUID verstummt = claim(customer, TestKennung.box("kpi-v-" + UUID.randomUUID()));
        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 53, "devices", List.of(verstummt.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        reportRunning(verstummt, "edge-2026.10.9", "applying", "ok",
                Instant.now().minus(Duration.ofMinutes(30)));
        rollouts.reconcile(Instant.now());

        JsonNode page = readModel(admin);
        assertThat(stateOf(page, verstummt)).isEqualTo("im_update_verstummt");
        assertThat(page.get("kpi").get("inRollout").asInt())
                .as("ein verstummtes Gerät zählt nicht zusätzlich als laufend")
                .isEqualTo(inRolloutVorher);
        assertThat(page.get("kpi").get("failed").asInt()).isEqualTo(failedVorher + 1);
    }

    // ── Helfer (Muster OtaRolloutApiTest) ───────────────────────────────────

    private UUID claim(String customerToken, String ref) {
        ResponseEntity<Map<String, Object>> claim = rest.exchange(url("/api/v1/devices/claim"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref),
                        bearer(customerToken)),
                new ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return UUID.fromString((String) claim.getBody().get("id"));
    }

    private void registerRelease(String admin, String version, long seq) {
        String manifest = MANIFEST_TEMPLATE.formatted(version, seq);
        ResponseEntity<Map<String, Object>> res = post("/api/v1/admin/edge-releases", admin,
                Map.of("version", version, "releaseSeq", seq, "manifest", manifest,
                        "signature", SIGNATURE));
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    /** Das gemeldete IST eines Geräts direkt setzen, wie {@code OtaRolloutApiTest}. */
    private void reportRunning(UUID deviceId, String version, String state, String verdict)
            throws Exception {
        reportRunning(deviceId, version, state, verdict, Instant.now());
    }

    private void reportRunning(UUID deviceId, String version, String state, String verdict,
            Instant reportedAt) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("""
                    INSERT INTO device_update_status (device_id, tenant_id, site_id, version,
                            backend, current_version, target_version, state, target_verdict,
                            reported_at)
                    VALUES ('%s', '%s', '%s', '%s', 'compose', '%s', '%s', '%s', '%s', '%s')
                    ON CONFLICT (device_id) DO UPDATE SET version = EXCLUDED.version,
                            current_version = EXCLUDED.current_version, state = EXCLUDED.state,
                            target_verdict = EXCLUDED.target_verdict,
                            reported_at = EXCLUDED.reported_at
                    """.formatted(deviceId, TENANT_A, BERLIN_SITE, version, version, version,
                    state, verdict, reportedAt));
        }
    }

    private Connection superuser() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(),
                POSTGRES.getPassword());
    }

    private JsonNode readModel(String admin) throws Exception {
        ResponseEntity<String> res = rest.exchange(url("/api/v1/admin/edge-updates"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private static String stateOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                return row.get("state").asText();
            }
        }
        return null;
    }

    private static String sollOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                return row.get("soll").isNull() ? null : row.get("soll").asText();
            }
        }
        return null;
    }

    private ResponseEntity<Map<String, Object>> post(String path, String token, Object body) {
        return rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)),
                new ParameterizedTypeReference<>() {});
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        return headers;
    }

    private String token(String username, String password) {
        String tokenUrl = KEYCLOAK.getAuthServerUrl()
                + "/realms/voltpilot/protocol/openid-connect/token";
        MultiValueMap<String, String> form = new LinkedMultiValueMap<>();
        form.add("grant_type", "password");
        form.add("client_id", "voltpilot-frontend");
        form.add("username", username);
        form.add("password", password);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_FORM_URLENCODED);
        ResponseEntity<Map<String, Object>> res = rest.exchange(tokenUrl, HttpMethod.POST,
                new HttpEntity<>(form, headers), new ParameterizedTypeReference<>() {});
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("access_token");
    }
}
