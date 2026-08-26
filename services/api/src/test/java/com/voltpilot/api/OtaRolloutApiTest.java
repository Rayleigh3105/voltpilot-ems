package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.ota.RolloutStates;
import com.voltpilot.api.ota.RolloutService;
import dasniko.testcontainers.keycloak.KeycloakContainer;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
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
 * OTA Stufe 2 „Verteilen" von der Cloud-Seite, gegen echtes TimescaleDB +
 * Keycloak + EMQX: der Zustandsautomat der Verteilung und - der eigentliche
 * Punkt - <b>die Grenzen, die er nicht überschreiten darf</b>.
 *
 * <p>Was hier bewiesen wird, in dieser Reihenfolge:
 * <ol>
 *   <li>Ein UNSIGNIERTES Release wird nicht verteilt. Ohne Manifest-Bytes hat
 *       ein Gerät nichts, was es gegen seine eingebackene Wurzel prüfen kann -
 *       eine Anweisung ohne Beleg ist genau das, was die ganze Kette
 *       verhindert.</li>
 *   <li>Eine Zuweisung geht RETAINED hinaus, und die Manifest-Bytes kommen
 *       BYTE FÜR BYTE beim Gerät an (die Signatur geht über genau sie).</li>
 *   <li>Die Wellen-Freigabe ist SERVER-seitig gesperrt, solange das
 *       Bake-Kriterium offen ist - nicht nur ein ausgegrauter Knopf.</li>
 *   <li>Ein gemeldetes {@code failed} hält die Verteilung AUTOMATISCH an (D4),
 *       und ein OFFLINE gegangenes Gerät tut das ausdrücklich NICHT.</li>
 *   <li>Beim Unclaim verschwindet die Zuweisung - Zeile UND retained
 *       Nachricht.</li>
 *   <li>Die Rollen-Grenze: ein Kunde bekommt 403, anonym 401.</li>
 * </ol>
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
// Das Release-Register ist GLOBAL und MONOTON - eine Sequenznummer, die kleiner
// ist als die höchste vergebene, wird (richtigerweise) abgelehnt. Die
// Reihenfolge der Testmethoden ist damit Teil der Vorbedingung, und JUnits
// Vorgabe (Hash-Ordnung) würde sie beim nächsten Umbenennen still ändern.
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class OtaRolloutApiTest {

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
        // Der Wächter wird in diesem Test von HAND getaktet (reconcile mit
        // einem gesetzten `now`) - ein Hintergrund-Takt würde die Uhr des
        // Tests unterlaufen und die Zeitpunkte unbeobachtbar machen.
        registry.add("voltpilot.ota.mqtt-listener-enabled", () -> "false");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    RolloutService rollouts;

    private final ObjectMapper json = new ObjectMapper();

    /** Ein Manifest, dessen Bytes bewusst „unaufgeräumt" sind. */
    private static final String MANIFEST = """
            {
              "schema_version" : "1.0",
              "release": "edge-2026.08.0",
              "release_seq" :12,
              "target_commit": "3bf8c038a1b2",
              "signing_key_id": "rel-2026-a"
            }
            """;
    private static final String SIGNATURE =
            "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\",\"key_id\":\"rel-2026-a\","
                    + "\"domain\":\"release\",\"signature\":\"AAAA\"}\n";


    @Test
    @Order(1)
    void oneStepUpdatesEveryChosenDeviceAndOnlyASignedReleaseTravels() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");

        String refA = "ota-a-" + UUID.randomUUID().toString().substring(0, 8);
        String refB = "ota-b-" + UUID.randomUUID().toString().substring(0, 8);
        UUID a = claim(customer, refA);
        UUID b = claim(customer, refB);

        // Ein Geraet hoert bereits zu - so wie eine Box, die vor der
        // Aktualisierung online war.
        BlockingQueue<byte[]> assignments = subscribe(a);

        // ── 1. Ein UNSIGNIERTES Release wird nicht verteilt ───────────────
        registerRelease(admin, "edge-2026.07.2", 11, null, null);
        ResponseEntity<Map<String, Object>> refused = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 11, "devices", List.of(a.toString())));
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) refused.getBody().get("message")).contains("nicht signiert");
        assertThat(assignments).as("nichts darf hinausgegangen sein").isEmpty();

        // ── 2. EIN Schritt: Release + Geraete → alle sind zugewiesen ──────
        registerRelease(admin, "edge-2026.08.0", 12, MANIFEST, SIGNATURE);
        ResponseEntity<Map<String, Object>> created = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 12, "devices", List.of(a.toString(), b.toString())));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        JsonNode page = readModel(admin);
        assertThat(sollOf(page, a)).isEqualTo("edge-2026.08.0");
        assertThat(sollOf(page, b))
                .as("es gibt keine zweite Welle mehr - BEIDE sind sofort dran")
                .isEqualTo("edge-2026.08.0");
        assertThat(page.get("activeRollout").get("total").asInt()).isEqualTo(2);

        // ── 3. Die Manifest-Bytes kommen BYTE FUER BYTE an ────────────────
        byte[] raw = assignments.poll(15, TimeUnit.SECONDS);
        assertThat(raw).as("die Zuweisung muss beim Geraet ankommen").isNotNull();
        JsonNode env = json.readTree(raw);
        assertThat(env.get("type").asText()).isEqualTo("update_target");
        assertThat(env.get("device_id").asText()).isEqualTo(a.toString());
        assertThat(env.has("channel")).as("der Ring ist entfallen").isFalse();
        assertThat(new String(Base64.getDecoder().decode(env.get("manifest_b64").asText()),
                StandardCharsets.UTF_8)).isEqualTo(MANIFEST);
        assertThat(new String(Base64.getDecoder().decode(env.get("signature_b64").asText()),
                StandardCharsets.UTF_8)).isEqualTo(SIGNATURE);

        // ── 4. Ein OFFLINE gegangenes Geraet ist kein Vorfall ─────────────
        reportRunning(b, "edge-2026.07.2", "deferred", "ok",
                Instant.now().minus(Duration.ofHours(3)));
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(stateOf(page, b)).isEqualTo("offline_holt_nach");
        assertThat(page.get("activeRollout").get("state").asText()).isEqualTo("active");

        // ── 5. Ein gemeldetes `failed` haelt NICHTS mehr an ───────────────
        //
        // Das ist die Kern-Aenderung gegenueber dem Auto-Halt (D4): ein
        // Fehlschlag ist INFORMATION. Die Zeile wird rot und traegt ihren
        // Grund, die uebrigen Geraete laufen weiter - und die Zuweisungen
        // bleiben stehen.
        reportRunning(b, "edge-2026.07.2", "failed", "ok", Instant.now());
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(stateOf(page, b)).isEqualTo("fehlgeschlagen");
        assertThat(page.get("activeRollout").get("failed").asInt()).isEqualTo(1);
        assertThat(sollOf(page, a)).as("die Zuweisung des anderen Geraets bleibt")
                .isEqualTo("edge-2026.08.0");

        // Die Papier-Spur nennt Urheber und Ereignis; ein Automatismus gibt
        // sich nie als Mensch aus.
        JsonNode journal = page.get("journal");
        assertThat(eventActors(journal, "rollout_created")).hasSize(1);
        assertThat(eventActors(journal, "rollout_created").get(0)).isNotEqualTo("system");

        // ── 6. Unclaim raeumt die Zuweisung ab ────────────────────────────
        BlockingQueue<byte[]> topicA = subscribe(a);
        assertThat(topicA.poll(10, TimeUnit.SECONDS))
                .as("die retained Zuweisung liegt bereit").isNotNull();
        ResponseEntity<Void> unclaimed = rest.exchange(url("/api/v1/devices/" + a),
                HttpMethod.DELETE, new HttpEntity<>(bearer(customer)), Void.class);
        assertThat(unclaimed.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        byte[] afterUnclaim = topicA.poll(15, TimeUnit.SECONDS);
        assertThat(afterUnclaim).as("der retained Slot wird geleert").isNotNull();
        assertThat(afterUnclaim).isEmpty();
        assertThat(sollOf(readModel(admin), a)).as("und die Zeile ist weg").isNull();

        // ── 7. Die Rollen-Grenze ──────────────────────────────────────────
        assertThat(rest.exchange(url("/api/v1/admin/edge-updates"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/edge-updates"), HttpMethod.GET,
                HttpEntity.EMPTY, String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(post("/api/v1/admin/rollouts", customer,
                Map.of("releaseSeq", 12, "devices", List.of(b.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    /**
     * Der frueher verbotene Fall: eine ZWEITE Aktualisierung, waehrend die
     * erste noch laeuft.
     *
     * <p>Der „hoechstens einer bewegt die Flotte"-Riegel war genau die Sorte
     * Tor, die die Order abgeschafft hat - er blockierte einen legitimen
     * zweiten Auftrag. Eindeutig ist, was zaehlt: je GERAET eine Zuweisung, und
     * die zweite gewinnt.
     */
    @Test
    @Order(2)
    void aSecondUpdateMayRunAlongsideTheFirstAndReassigningIsAllowed() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.09.0", 30,
                MANIFEST.replace("edge-2026.08.0", "edge-2026.09.0").replace(":12", ":30"),
                SIGNATURE);
        registerRelease(admin, "edge-2026.09.1", 31,
                MANIFEST.replace("edge-2026.08.0", "edge-2026.09.1").replace(":12", ":31"),
                SIGNATURE);

        UUID one = claim(customer, "ota-x-" + UUID.randomUUID().toString().substring(0, 8));
        UUID two = claim(customer, "ota-y-" + UUID.randomUUID().toString().substring(0, 8));

        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 30, "devices", List.of(one.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        // Kein 409 mehr - der zweite Auftrag laeuft daneben.
        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 31, "devices", List.of(two.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);

        JsonNode page = readModel(admin);
        assertThat(sollOf(page, one)).isEqualTo("edge-2026.09.0");
        assertThat(sollOf(page, two)).isEqualTo("edge-2026.09.1");

        // Und dasselbe Geraet darf umgehaengt werden - kein Pin haelt es fest.
        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 31, "devices", List.of(one.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(sollOf(readModel(admin), one)).isEqualTo("edge-2026.09.1");

        // Formfehler werden benannt und schreiben nichts.
        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 31, "devices", List.of(UUID.randomUUID().toString())))
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * Die Vertrauens-Identitaet (OTA Stufe 4) reist unveraendert mit - und
     * ABWESENHEIT ist nie ein Befund.
     */
    @Test
    @Order(3)
    void theTrustIdentityReachesTheFleetMatrixAndAbsenceIsNeverAFinding() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        UUID crossed = claim(customer, "ota-t1-" + UUID.randomUUID().toString().substring(0, 8));
        UUID open = claim(customer, "ota-t2-" + UUID.randomUUID().toString().substring(0, 8));
        UUID silent = claim(customer, "ota-t3-" + UUID.randomUUID().toString().substring(0, 8));

        reportTrust(crossed, "root-2026-a", "rel-2026-a,rel-2026-b", "2026-08-04T10:00:00Z", null);
        reportTrust(open, "", "", null, null);

        JsonNode page = readModel(admin);
        JsonNode t1 = trustOf(page, crossed);
        assertThat(t1).isNotNull();
        assertThat(t1.get("rootKeyIds").get(0).asText()).isEqualTo("root-2026-a");
        assertThat(t1.get("trustSetKeyIds")).hasSize(2);

        JsonNode t2 = trustOf(page, open);
        assertThat(t2).isNotNull();
        assertThat(t2.get("rootKeyIds")).as("ein Image OHNE Wurzel ist ein BELEGTER Befund")
                .isEmpty();

        assertThat(trustOf(page, silent))
                .as("ein aelterer Stand meldet nichts - das ist NICHT 'nicht gekreuzt'")
                .isNull();
    }

    /**
     * Das Geraete-Inventar vereinigt Aufkleber-Registry und echte Flotte -
     * und eine gedruckte, nie verbundene ID traegt KEINEN Zustand.
     */
    @Test
    @Order(4)
    void theDeviceInventoryUnitesTheStickerRegistryWithTheRealFleet() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        String edgeRef = "ota-inv-" + UUID.randomUUID().toString().substring(0, 8);
        UUID device = claim(customer, edgeRef);
        String printed = "VP-INV-" + UUID.randomUUID().toString().substring(0, 4).toUpperCase();
        assertThat(post("/api/v1/admin/provisioned-devices", admin,
                Map.of("externalRef", printed)).getStatusCode())
                .isIn(HttpStatus.CREATED, HttpStatus.OK);

        ResponseEntity<String> resp = rest.exchange(url("/api/v1/admin/devices"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode rows = json.readTree(resp.getBody()).get("devices");

        JsonNode real = deviceRow(rows, edgeRef);
        assertThat(real).isNotNull();
        assertThat(real.get("deviceId").asText()).isEqualTo(device.toString());
        assertThat(real.get("provisioned").asBoolean())
                .as("eine selbst erzeugte edge-Referenz kam nie aus der Registry").isFalse();

        JsonNode paper = deviceRow(rows, printed);
        assertThat(paper).isNotNull();
        assertThat(paper.get("deviceId").isNull()).isTrue();
        assertThat(paper.get("state").isNull())
                .as("ueber eine ID, die nie ein Geraet war, ist nichts abzuleiten").isTrue();
    }

    /** Das Journal bleibt exportierbar und rollen-gegated. */
    @Test
    @Order(5)
    void theJournalIsExportableAsMarkdownAndStaysRoleGated() {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        ResponseEntity<String> md = rest.exchange(url("/api/v1/admin/rollout-journal.md"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class);
        assertThat(md.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(md.getBody()).contains("# ");
        assertThat(md.getBody()).as("deterministisch - kein Erzeugungs-Zeitstempel")
                .doesNotContain("erzeugt am");

        assertThat(rest.exchange(url("/api/v1/admin/rollout-journal.md"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    /** Die gemeldete Vertrauens-Identität eines Geräts direkt setzen. */
    private void reportTrust(UUID deviceId, String rootKeyIds, String trustSetKeyIds,
            String generatedAt, String error) throws Exception {
        reportRunning(deviceId, "edge-2026.08.0", "idle", null, Instant.now());
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("""
                    UPDATE device_update_status SET root_key_ids = %s, trust_set_key_ids = %s,
                            trust_set_generated_at = %s, trust_set_error = %s
                     WHERE device_id = '%s'
                    """.formatted(sql(rootKeyIds), sql(trustSetKeyIds), sql(generatedAt),
                    sql(error), deviceId));
        }
    }

    private static String sql(String v) {
        return v == null ? "NULL" : "'" + v.replace("'", "''") + "'";
    }

    /** Die Sperre, die eine Box meldet - der Name UND ihr deutscher Grund. */
    private void reportBlocker(UUID deviceId, String blocker, String reason) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("UPDATE device_update_status SET blocker = " + sql(blocker)
                    + ", reason = " + sql(reason) + " WHERE device_id = '" + deviceId + "'");
        }
    }

    /** Eine Zeile des Inventars anhand ihrer Referenz, sonst {@code null}. */
    private static JsonNode deviceRow(JsonNode rows, String externalRef) {
        for (JsonNode r : rows) {
            if (externalRef.equals(r.get("externalRef").asText())) {
                return r;
            }
        }
        return null;
    }

    /** Ein beliebiges Feld einer Flotten-Zeile - {@code null} bleibt null. */
    private static String fieldOf(JsonNode page, UUID deviceId, String field) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                JsonNode v = row.get(field);
                return v == null || v.isNull() ? null : v.asText();
            }
        }
        return null;
    }

    private static JsonNode trustOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (row.get("deviceId").asText().equals(deviceId.toString())) {
                JsonNode t = row.get("trust");
                return t == null || t.isNull() ? null : t;
            }
        }
        throw new AssertionError("Gerät " + deviceId + " fehlt in der Flotten-Matrix");
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

    private void registerRelease(String admin, String version, long seq, String manifest,
            String signature) {
        Map<String, Object> body = manifest == null
                ? Map.of("version", version, "releaseSeq", seq)
                : Map.of("version", version, "releaseSeq", seq, "manifest", manifest,
                        "signature", signature);
        ResponseEntity<Map<String, Object>> res = post("/api/v1/admin/edge-releases", admin, body);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }

    private BlockingQueue<byte[]> subscribe(UUID deviceId) throws Exception {
        MqttClient device = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "dev-" + UUID.randomUUID(), new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        device.connect(options);
        BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(8);
        device.subscribe("ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/v2/update", 1,
                (topic, msg) -> queue.add(msg.getPayload()));
        return queue;
    }

    /**
     * Das gemeldete IST eines Geräts direkt setzen - der Ingest-Pfad ist von
     * {@code UpdateStatusListenerTest} abgedeckt; hier geht es um den
     * Zustandsautomaten, der DARAUF reagiert.
     */
    private void reportRunning(UUID deviceId, String version, String state, String verdict,
            Instant reportedAt) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("""
                    INSERT INTO device_update_status (device_id, tenant_id, site_id, version,
                            backend, current_version, target_version, state, target_verdict,
                            reported_at)
                    VALUES ('%s', '%s', '%s', '%s', 'compose', '%s', 'edge-2026.08.0', '%s',
                            '%s', '%s')
                    ON CONFLICT (device_id) DO UPDATE SET version = EXCLUDED.version,
                            current_version = EXCLUDED.current_version, state = EXCLUDED.state,
                            target_verdict = EXCLUDED.target_verdict,
                            reported_at = EXCLUDED.reported_at
                    """.formatted(deviceId, TENANT_A, BERLIN_SITE, version, version, state,
                    verdict, reportedAt));
        }
    }

    /** Die Bestätigung zurückdatieren - das Bake-Fenster hängt an {@code since}. */
    private void backdateSince(UUID rolloutId, UUID deviceId, Duration by) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("UPDATE rollout_device SET since = now() - interval '" + by.toHours()
                    + " hours' WHERE rollout_id = '" + rolloutId + "' AND device_id = '"
                    + deviceId + "'");
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

    private static String sollOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                return row.get("soll").isNull() ? null : row.get("soll").asText();
            }
        }
        return null;
    }

    private static String stateOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                return row.get("state").asText();
            }
        }
        return null;
    }


    private static List<String> eventActors(JsonNode journal, String event) {
        return java.util.stream.StreamSupport.stream(journal.spliterator(), false)
                .filter(e -> event.equals(e.get("event").asText()))
                .map(e -> e.get("actor").asText())
                .toList();
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
