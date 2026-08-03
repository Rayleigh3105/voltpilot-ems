package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
    void theWholeRolloutStateMachineHoldsItsGuarantees() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");

        // ── Vorbereitung: zwei Geräte an der Demo-Anlage ──────────────────
        String canaryRef = "ota-canary-" + UUID.randomUUID().toString().substring(0, 8);
        String fleetRef = "ota-fleet-" + UUID.randomUUID().toString().substring(0, 8);
        UUID canary = claim(customer, canaryRef);
        UUID fleet = claim(customer, fleetRef);

        // Ein Gerät hört bereits zu - so wie eine Box, die vor dem Rollout
        // online war.
        BlockingQueue<byte[]> assignments = subscribe(canary);

        // ── 1. Ein UNSIGNIERTES Release wird nicht verteilt ───────────────
        registerRelease(admin, "edge-2026.07.2", 11, null, null);
        ResponseEntity<Map<String, Object>> refused = post(
                "/api/v1/admin/devices/" + canary + "/update-target", admin,
                Map.of("releaseSeq", 11, "channel", "canary"));
        assertThat(refused.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) refused.getBody().get("message")).contains("nicht signiert");
        assertThat(assignments).as("nichts darf hinausgegangen sein").isEmpty();

        // ── 2. Ein SIGNIERTES Release geht retained hinaus - bytegenau ────
        registerRelease(admin, "edge-2026.08.0", 12, MANIFEST, SIGNATURE);
        ResponseEntity<Map<String, Object>> assigned = post(
                "/api/v1/admin/devices/" + canary + "/update-target", admin,
                Map.of("releaseSeq", 12, "channel", "canary"));
        assertThat(assigned.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        byte[] raw = assignments.poll(15, TimeUnit.SECONDS);
        assertThat(raw).as("die Zuweisung muss beim Geraet ankommen").isNotNull();
        JsonNode env = json.readTree(raw);
        assertThat(env.get("type").asText()).isEqualTo("update_target");
        assertThat(env.get("device_id").asText()).isEqualTo(canary.toString());
        assertThat(env.get("channel").asText()).isEqualTo("canary");
        // DIE Eigenschaft: die Bytes, ueber die der Owner unterschrieben hat,
        // kommen unveraendert an. Jede Umformatierung auf dem Weg machte die
        // Signatur lautlos unpruefbar.
        assertThat(new String(Base64.getDecoder().decode(env.get("manifest_b64").asText()),
                StandardCharsets.UTF_8)).isEqualTo(MANIFEST);
        assertThat(new String(Base64.getDecoder().decode(env.get("signature_b64").asText()),
                StandardCharsets.UTF_8)).isEqualTo(SIGNATURE);

        // Und die Einzelzuweisung wieder zuruecknehmen: die retained Nachricht
        // wird geleert, damit auf dem Broker keine Anweisung ohne Verantwortung
        // liegen bleibt.
        assertThat(post("/api/v1/admin/devices/" + canary + "/update-target/revert", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        byte[] cleared = assignments.poll(15, TimeUnit.SECONDS);
        assertThat(cleared).isNotNull();
        assertThat(cleared).as("eine leere retained Nachricht nimmt die Zuweisung zurueck")
                .isEmpty();

        // ── 3. Ein Rollout in zwei Wellen (Canary = eine Box, dann der Rest)
        ResponseEntity<Map<String, Object>> created = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 12, "channel", "stable", "waves", List.of(
                        Map.of("name", "Canary", "devices", List.of(canary.toString())),
                        Map.of("name", "Flotte", "devices", List.of(fleet.toString())))));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        UUID rolloutId = UUID.fromString((String) created.getBody().get("rolloutId"));

        // Die erste Welle ist sofort zugewiesen; die zweite NICHT (hand-advanced).
        JsonNode page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt()).isEqualTo(1);
        assertThat(page.get("activeRollout").get("canPromote").asBoolean()).isFalse();
        assertThat(page.get("activeRollout").get("promoteBlockedReason").asText()).isNotBlank();
        assertThat(sollOf(page, fleet)).as("Welle 2 ist noch nicht zugewiesen").isNull();
        assertThat(sollOf(page, canary)).isEqualTo("edge-2026.08.0");

        // ── 4. Die Welle ist SERVER-seitig gesperrt, nicht nur im Knopf ────
        ResponseEntity<Map<String, Object>> tooEarly =
                post("/api/v1/admin/rollouts/" + rolloutId + "/promote", admin, null);
        assertThat(tooEarly.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) tooEarly.getBody().get("message")).contains("noch nicht bestätigt");

        // Der Canary meldet den neuen Stand - aber erst seit gerade eben.
        reportRunning(canary, "edge-2026.08.0", "succeeded", "ok", Instant.now());
        rollouts.reconcile(Instant.now());
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/promote", admin, null)
                .getStatusCode())
                .as("24 h sind noch nicht um").isEqualTo(HttpStatus.CONFLICT);

        // 26 h spaeter (die Bestaetigung liegt entsprechend zurueck): frei.
        backdateSince(rolloutId, canary, Duration.ofHours(26));
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("canPromote").asBoolean()).isTrue();
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/promote", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt()).isEqualTo(2);
        assertThat(sollOf(page, fleet)).isEqualTo("edge-2026.08.0");

        // ── 5. Pause / Fortsetzen ─────────────────────────────────────────
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/pause", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(readModel(admin).get("activeRollout").get("state").asText())
                .isEqualTo("paused");
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/resume", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        // ── 6. Ein OFFLINE gegangenes Geraet haelt NICHTS an ──────────────
        reportRunning(fleet, "edge-2026.07.2", "deferred", "ok",
                Instant.now().minus(Duration.ofHours(3)));
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("state").asText())
                .as("offline ist der Normalfall hinter NAT, kein Vorfall").isEqualTo("active");
        assertThat(stateOf(page, fleet)).isEqualTo("offline_holt_nach");

        // ── 7. Ein gemeldetes `failed` haelt AUTOMATISCH an (D4) ──────────
        reportRunning(fleet, "edge-2026.07.2", "failed", "ok", Instant.now());
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("state").asText()).isEqualTo("halted");
        assertThat(page.get("activeRollout").get("haltedReason").asText())
                .contains("Automatisch angehalten");
        assertThat(stateOf(page, fleet)).isEqualTo("fehlgeschlagen");
        // Bestehende Zuweisungen BLEIBEN - sie zurueckzunehmen schickte eine
        // halb aktualisierte Flotte auf einen dritten Stand.
        assertThat(sollOf(page, canary)).isEqualTo("edge-2026.08.0");

        // Und die Papier-Spur nennt Urheber und Ereignis.
        JsonNode journal = page.get("journal");
        assertThat(eventActors(journal, "rollout_auto_halted")).containsExactly("system");
        assertThat(eventActors(journal, "rollout_created")).hasSize(1);
        assertThat(eventActors(journal, "wave_released")).hasSize(2);
        // Ein Automatismus, der sich als Mensch ausgibt, machte das Journal
        // wertlos - der Rollout-Start kam von einem echten Subject.
        assertThat(eventActors(journal, "rollout_created").get(0)).isNotEqualTo("system");

        // Ein eingefrorener Rollout gibt nichts mehr frei.
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/promote", admin, null)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // ── 8. Unclaim raeumt die Zuweisung ab ────────────────────────────
        BlockingQueue<byte[]> canaryTopic = subscribe(canary);
        assertThat(canaryTopic.poll(10, TimeUnit.SECONDS))
                .as("die retained Zuweisung liegt bereit").isNotNull();
        ResponseEntity<Void> unclaimed = rest.exchange(url("/api/v1/devices/" + canary),
                HttpMethod.DELETE, new HttpEntity<>(bearer(customer)), Void.class);
        assertThat(unclaimed.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        byte[] afterUnclaim = canaryTopic.poll(15, TimeUnit.SECONDS);
        assertThat(afterUnclaim).as("der retained Slot wird geleert").isNotNull();
        assertThat(afterUnclaim).isEmpty();
        assertThat(sollOf(readModel(admin), canary)).as("und die Zeile ist weg").isNull();

        // ── 9. Die Rollen-Grenze ──────────────────────────────────────────
        assertThat(rest.exchange(url("/api/v1/admin/edge-updates"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/edge-updates"), HttpMethod.GET,
                HttpEntity.EMPTY, String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(post("/api/v1/admin/devices/" + fleet + "/update-target", customer,
                Map.of("releaseSeq", 12)).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    @Order(2)
    void aPinnedDeviceIsSkippedByARolloutInsteadOfBeingOverwritten() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.09.0", 30, MANIFEST.replace("edge-2026.08.0",
                "edge-2026.09.0").replace(":12", ":30"), SIGNATURE);
        registerRelease(admin, "edge-2026.09.1", 31, MANIFEST.replace("edge-2026.08.0",
                "edge-2026.09.1").replace(":12", ":31"), SIGNATURE);

        UUID pinned = claim(customer, "ota-pin-" + UUID.randomUUID().toString().substring(0, 8));
        assertThat(post("/api/v1/admin/devices/" + pinned + "/update-target", admin,
                Map.of("releaseSeq", 30, "pinned", true)).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        ResponseEntity<Map<String, Object>> created = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 31, "waves", List.of(
                        Map.of("name", "Alle", "devices", List.of(pinned.toString())))));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        JsonNode page = readModel(admin);
        // Ein Pin ist die Ansage „dieses Geraet bleibt, wo es ist". Ihn
        // stillschweigend zu ueberfahren machte ihn wertlos - also bleibt das
        // Ziel stehen und das Uebergehen ist SICHTBAR.
        assertThat(sollOf(page, pinned)).isEqualTo("edge-2026.09.0");
        assertThat(pinnedOf(page, pinned)).isTrue();
        // Das Uebergehen ist im WELLEN-Board sichtbar - mit seinem Grund. Die
        // Flotten-Matrix beantwortet dagegen „was meldet dieses Geraet", und
        // das ist hier ehrlich „unbekannt" (es hat nie gemeldet).
        JsonNode waveDevice = page.get("activeRollout").get("waves").get(0).get("devices").get(0);
        assertThat(waveDevice.get("state").asText()).isEqualTo("zurueckgestellt");
        assertThat(waveDevice.get("reason").asText()).contains("festgenagelt");
        assertThat(stateOf(page, pinned)).isEqualTo("unbekannt");
        assertThat(eventActors(page.get("journal"), "device_pinned_skipped")).hasSize(1);

        halt(admin, page.get("activeRollout").get("id").asText());
    }

    @Test
    @Order(3)
    void aSecondLiveRolloutIsRefused() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.10.0", 40, MANIFEST.replace("edge-2026.08.0",
                "edge-2026.10.0").replace(":12", ":40"), SIGNATURE);
        UUID a = claim(customer, "ota-x-" + UUID.randomUUID().toString().substring(0, 8));
        UUID b = claim(customer, "ota-y-" + UUID.randomUUID().toString().substring(0, 8));

        ResponseEntity<Map<String, Object>> first = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 40, "waves",
                        List.of(Map.of("name", "W1", "devices", List.of(a.toString())))));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);

        // Zwei gleichzeitige Verteilungen koennten demselben Geraet
        // verschiedene Ziele zuweisen - und ein Auto-Halt waere nicht mehr
        // zuzuordnen.
        ResponseEntity<Map<String, Object>> second = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 40, "waves",
                        List.of(Map.of("name", "W1", "devices", List.of(b.toString())))));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // Ein Geraet in ZWEI Wellen desselben Rollouts ist ebenfalls ein Fehler.
        halt(admin, (String) first.getBody().get("rolloutId"));
        ResponseEntity<Map<String, Object>> dup = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 40, "waves", List.of(
                        Map.of("name", "W1", "devices", List.of(a.toString())),
                        Map.of("name", "W2", "devices", List.of(a.toString())))));
        assertThat(dup.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * OTA Stufe 4 „Politur": die Wellen-AUTOMATIK als Option - und die
     * Ehrlichkeit, dass sie nichts lockert.
     *
     * <p>Der Beweis besteht aus drei Teilen, die zusammen die Zusage tragen:
     * (a) sie gibt erst frei, wenn dasselbe Bake-Kriterium erfüllt ist, das die
     * Hand-Freigabe erfüllen müsste; (b) ein Auto-Halt schlägt sie - eine
     * angehaltene Verteilung kann nie von selbst weiterlaufen; und (c) OHNE den
     * Schalter verhält sich alles zeichengleich wie nach Stufe 3.
     */
    @Test
    @Order(4)
    void theWaveAutomationAdvancesOnlyOnTheSameBakeAndNeverPastAHalt() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.11.0", 50, MANIFEST.replace("edge-2026.08.0",
                "edge-2026.11.0").replace(":12", ":50"), SIGNATURE);

        UUID w1 = claim(customer, "ota-a1-" + UUID.randomUUID().toString().substring(0, 8));
        UUID w2 = claim(customer, "ota-a2-" + UUID.randomUUID().toString().substring(0, 8));
        UUID w3 = claim(customer, "ota-a3-" + UUID.randomUUID().toString().substring(0, 8));

        ResponseEntity<Map<String, Object>> created = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 50, "autoAdvance", true, "waves", List.of(
                        Map.of("name", "Canary", "devices", List.of(w1.toString())),
                        Map.of("name", "Welle 2", "devices", List.of(w2.toString())),
                        Map.of("name", "Welle 3", "devices", List.of(w3.toString())))));
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String rolloutId = (String) created.getBody().get("rolloutId");

        JsonNode page = readModel(admin);
        assertThat(page.get("activeRollout").get("autoAdvance").asBoolean()).isTrue();
        assertThat(page.get("activeRollout").get("advanceNote").asText())
                .as("die Fläche sagt, in welchem Modus der Rollout läuft")
                .contains("Automatischer Vorschub");

        // ── (a) Das Bake-Kriterium gilt UNVERÄNDERT ───────────────────────
        // Der Canary hat gerade erst bestätigt: 24 h sind nicht um, also passiert
        // beim Wächter-Durchlauf NICHTS.
        reportRunning(w1, "edge-2026.11.0", "succeeded", "ok", Instant.now());
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt())
                .as("die Automatik überspringt das Bake-Fenster nicht").isEqualTo(1);
        assertThat(page.get("activeRollout").get("advanceNote").asText()).contains("Offen:");
        assertThat(sollOf(page, w2)).as("Welle 2 hat noch nichts bekommen").isNull();

        // 26 h später gibt derselbe Wächter-Durchlauf frei - ohne eine Hand.
        backdateSince(UUID.fromString(rolloutId), w1, Duration.ofHours(26));
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt()).isEqualTo(2);
        assertThat(sollOf(page, w2)).isEqualTo("edge-2026.11.0");
        // Und die Papier-Spur nennt den Wächter als Urheber, nie einen Menschen.
        assertThat(eventActors(page.get("journal"), "wave_auto_released"))
                .containsExactly("system");
        assertThat(eventActors(page.get("journal"), "wave_released"))
                .as("auch die Freigabe selbst kommt vom System").contains("system");

        // ── (b) Ein Auto-Halt schlägt die Automatik ───────────────────────
        reportRunning(w2, "edge-2026.11.0", "failed", "ok", Instant.now());
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("state").asText()).isEqualTo("halted");
        assertThat(page.get("activeRollout").get("advanceNote").asText())
                .contains("Eingefroren");

        // Selbst wenn die angehaltene Welle ihr Bake nachträglich erfüllt:
        // eine eingefrorene Verteilung läuft NIE von selbst weiter.
        reportRunning(w2, "edge-2026.11.0", "succeeded", "ok", Instant.now());
        backdateSince(UUID.fromString(rolloutId), w2, Duration.ofHours(26));
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt())
                .as("nach dem Not-Aus gibt es keinen automatischen Vorschub mehr")
                .isEqualTo(2);
        assertThat(sollOf(page, w3)).isNull();
    }

    /**
     * Der Schalter ist nachträglich umlegbar - UND ohne ihn verhält sich alles
     * zeichengleich wie nach Stufe 3.
     */
    @Test
    @Order(5)
    void handAdvanceStaysTheDefaultAndTheSwitchIsReversible() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        registerRelease(admin, "edge-2026.12.0", 60, MANIFEST.replace("edge-2026.08.0",
                "edge-2026.12.0").replace(":12", ":60"), SIGNATURE);
        UUID a = claim(customer, "ota-b1-" + UUID.randomUUID().toString().substring(0, 8));
        UUID b = claim(customer, "ota-b2-" + UUID.randomUUID().toString().substring(0, 8));

        // KEIN autoAdvance im Rumpf - der Vorgabefall (D4).
        ResponseEntity<Map<String, Object>> created = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 60, "waves", List.of(
                        Map.of("name", "W1", "devices", List.of(a.toString())),
                        Map.of("name", "W2", "devices", List.of(b.toString())))));
        String rolloutId = (String) created.getBody().get("rolloutId");
        assertThat(readModel(admin).get("activeRollout").get("autoAdvance").asBoolean())
                .as("Hand-Vorschub bleibt die Vorgabe").isFalse();

        // Bake erfüllt - und trotzdem passiert ohne Hand nichts.
        reportRunning(a, "edge-2026.12.0", "succeeded", "ok", Instant.now());
        rollouts.reconcile(Instant.now());
        backdateSince(UUID.fromString(rolloutId), a, Duration.ofHours(26));
        rollouts.reconcile(Instant.now());
        JsonNode page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt()).isEqualTo(1);
        assertThat(page.get("activeRollout").get("canPromote").asBoolean()).isTrue();
        assertThat(page.get("activeRollout").get("advanceNote").asText())
                .contains("Hand-Vorschub");

        // Umschalten - und derselbe Durchlauf gibt frei.
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/auto-advance", admin,
                Map.of("enabled", true)).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        assertThat(page.get("activeRollout").get("currentWave").asInt()).isEqualTo(2);
        assertThat(eventActors(page.get("journal"), "auto_advance_on")).hasSize(1);
        assertThat(eventActors(page.get("journal"), "auto_advance_on").get(0))
                .as("das Umlegen ist eine MENSCHLICHE Entscheidung").isNotEqualTo("system");

        // Und zurück - ein eingefrorener Rollout lässt sich nicht umschalten.
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/auto-advance", admin,
                Map.of("enabled", false)).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        halt(admin, rolloutId);
        assertThat(post("/api/v1/admin/rollouts/" + rolloutId + "/auto-advance", admin,
                Map.of("enabled", true)).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    /**
     * OTA Stufe 4: die VERTRAUENS-IDENTITÄT erreicht die Flotten-Matrix - und
     * die drei Zustände bleiben unterscheidbar.
     */
    @Test
    @Order(6)
    void theTrustIdentityReachesTheFleetMatrixAndAbsenceIsNeverAFinding() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        UUID gekreuzt = claim(customer, "ota-t1-" + UUID.randomUUID().toString().substring(0, 8));
        UUID offen = claim(customer, "ota-t2-" + UUID.randomUUID().toString().substring(0, 8));
        UUID alt = claim(customer, "ota-t3-" + UUID.randomUUID().toString().substring(0, 8));

        reportTrust(gekreuzt, "root-2026-a", "rel-2026-a", "2026-09-01T10:00:00Z", null);
        reportTrust(offen, "", "", null, "Diesem Stand ist kein Vertrauensanker eingebacken.");
        // `alt` meldet nur seine Version - ein älterer Edge-Stand.
        reportRunning(alt, "665d59b80000", "idle", null, Instant.now());

        JsonNode page = readModel(admin);
        JsonNode t1 = trustOf(page, gekreuzt);
        assertThat(t1.get("rootKeyIds").get(0).asText()).isEqualTo("root-2026-a");
        assertThat(t1.get("trustSetKeyIds").get(0).asText()).isEqualTo("rel-2026-a");
        assertThat(t1.get("trustSetGeneratedAt").asText()).isEqualTo("2026-09-01T10:00:00Z");

        // Ein Image OHNE Wurzel ist ein BELEGTER Befund (Crossover offen) -
        // eine leere Liste, kein fehlender Block.
        JsonNode t2 = trustOf(page, offen);
        assertThat(t2.get("rootKeyIds").isArray()).isTrue();
        assertThat(t2.get("rootKeyIds")).isEmpty();
        assertThat(t2.get("trustSetError").asText()).contains("Vertrauensanker");

        // Ein ÄLTERER Stand meldet nichts - und das bleibt „unbekannt", nie
        // „nicht gekreuzt". Genau diese Unterscheidung trägt die Verfolgung.
        assertThat(trustOf(page, alt)).isNull();
    }

    /**
     * Der dokumentarische gitops-Spiegel (D2): ein EXPORT, kein Deploy - und
     * er bleibt hinter derselben Rollen-Grenze wie alles andere hier.
     */
    @Test
    @Order(7)
    void theJournalIsExportableAsMarkdownAndStaysRoleGated() {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");

        ResponseEntity<String> md = rest.exchange(url("/api/v1/admin/rollout-journal.md"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class);
        assertThat(md.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(md.getBody()).contains("# VoltPilot Edge-Rollouts - Audit-Journal");
        assertThat(md.getBody())
                .as("die Datei sagt selbst, dass sie NICHT die Autorität ist")
                .contains("Die Autorität ist die Portal-DB, nicht diese Datei");
        assertThat(md.getBody()).contains("Rollout gestartet");

        // Deterministisch: ein wiederholter Spiegel-Lauf erzeugt keinen Commit.
        assertThat(rest.exchange(url("/api/v1/admin/rollout-journal.md"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getBody())
                .isEqualTo(md.getBody());

        assertThat(rest.exchange(url("/api/v1/admin/rollout-journal.md"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/v1/admin/rollout-journal.md"), HttpMethod.GET,
                HttpEntity.EMPTY, String.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ── Helfer ───────────────────────────────────────────────────────────

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

    private static JsonNode trustOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (row.get("deviceId").asText().equals(deviceId.toString())) {
                JsonNode t = row.get("trust");
                return t == null || t.isNull() ? null : t;
            }
        }
        throw new AssertionError("Gerät " + deviceId + " fehlt in der Flotten-Matrix");
    }

    private void halt(String admin, String rolloutId) {
        post("/api/v1/admin/rollouts/" + rolloutId + "/halt", admin,
                Map.of("reason", "Testende"));
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

    private static Boolean pinnedOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                return row.get("pinned").asBoolean();
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
