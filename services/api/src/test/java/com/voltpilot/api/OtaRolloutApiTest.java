package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.ota.RolloutStates;
import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.ota.UpdateStatusListener;
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

    @Autowired
    com.voltpilot.api.repo.DeviceRepository deviceRepo;

    @Autowired
    com.voltpilot.api.repo.UpdateStatusRepository updateStatusRepo;

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
    /**
     * Die gepackte Lieferung eines Edge-Light-"Programms" für den Test: 1,3 MB
     * kaum packbarer Bytes, damit das Hochladen mehrere Teile braucht.
     */
    private static final byte[] LIGHT_GZ = lightGz();
    private static final String LIGHT_GZ_SHA = sha256Hex(LIGHT_GZ);

    /** Ein Edge-Light-Manifest in der Form, die {@code vp-ota manifest --binary} erzeugt. */
    private static final String LIGHT_MANIFEST = """
            {
              "schema_version": "1.0",
              "release": "edge-light-2026.10.1",
              "release_seq": 41,
              "target_commit": "3bf8c038a1b2",
              "artifacts": [
                {
                  "type": "binary",
                  "name": "vp-edge-light",
                  "arch": "linux/mipsle",
                  "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
                  "size": 14614743,
                  "gz_sha256": "%s",
                  "gz_size": %d
                }
              ],
              "min_from_seq": 0,
              "allow_downgrade": false,
              "state_schema": 1,
              "compat": {
                "backends": ["light"]
              },
              "signing_key_id": "rel-2026-a"
            }
            """.formatted(LIGHT_GZ_SHA, LIGHT_GZ.length);

    private static byte[] lightGz() {
        byte[] roh = new byte[1_300_000];
        new java.util.Random(4711).nextBytes(roh);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        try (java.util.zip.GZIPOutputStream gz = new java.util.zip.GZIPOutputStream(out)) {
            gz.write(roh);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
        return out.toByteArray();
    }

    private static String sha256Hex(byte[] b) {
        try {
            return java.util.HexFormat.of().formatHex(
                    java.security.MessageDigest.getInstance("SHA-256").digest(b));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static final String SIGNATURE =
            "{\"schema_version\":\"1.0\",\"alg\":\"ed25519\",\"key_id\":\"rel-2026-a\","
                    + "\"domain\":\"release\",\"signature\":\"AAAA\"}\n";


    @Test
    @Order(1)
    void oneStepUpdatesEveryChosenDeviceAndOnlyASignedReleaseTravels() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");

        String refA = TestKennung.box("ota-a-" + UUID.randomUUID().toString().substring(0, 8));
        String refB = TestKennung.box("ota-b-" + UUID.randomUUID().toString().substring(0, 8));
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
        assertThat(page.get("rollouts").get(0).get("total").asInt()).isEqualTo(2);

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
        assertThat(page.get("rollouts").get(0).get("state").asText()).isEqualTo("active");

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
        assertThat(page.get("rollouts").get(0).get("failed").asInt()).isEqualTo(1);
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

        UUID one = claim(customer, TestKennung.box("ota-x-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID two = claim(customer, TestKennung.box("ota-y-" + UUID.randomUUID().toString().substring(0, 8)));

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
        UUID crossed = claim(customer, TestKennung.box("ota-t1-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID open = claim(customer, TestKennung.box("ota-t2-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID silent = claim(customer, TestKennung.box("ota-t3-" + UUID.randomUUID().toString().substring(0, 8)));

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
        String edgeRef = TestKennung.box("ota-inv-" + UUID.randomUUID().toString().substring(0, 8));
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

    /**
     * Die Box-Art (Edge Light Stufe 2, Teilaufgabe A3): eine Edge-Light-Box
     * bekommt kein Docker-Release und eine Docker-Box kein Edge-Light-Release -
     * auf BEIDEN Schreibwegen 409 mit deutschem Grund, und ein Auftrag mit einem
     * unpassenden Gerät schreibt gar nichts.
     */
    @Test
    @Order(6)
    void aReleaseOnlyReachesBoxesOfItsOwnKind() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        UUID docker = claim(customer, TestKennung.box("ota-bd-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID light = claim(customer, TestKennung.box("ota-bl-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID silent = claim(customer, TestKennung.box("ota-bs-" + UUID.randomUUID().toString().substring(0, 8)));
        reportBox(docker, "compose", "edge-2026.09.1-3bf8c038a1b2");
        // Die Pilot-Box heute: der Core meldet noch fest `compose`, erkennbar
        // ist Edge Light nur am Stempel.
        reportBox(light, "compose", "edge-light-g2d2bca1b6");

        registerRelease(admin, "edge-2026.10.0", 40,
                MANIFEST.replace("edge-2026.08.0", "edge-2026.10.0").replace(":12", ":40"),
                SIGNATURE);
        // Ein Edge-Light-Release unter seinem Namen edge-light-JJJJ.MM.N und in
        // der Form des Vertrags (das Register liest Edge Light streng).
        registerRelease(admin, "edge-light-2026.10.1", 41, LIGHT_MANIFEST, SIGNATURE);

        // ── Die Leserouten tragen die Box-Art ─────────────────────────────
        JsonNode page = readModel(admin);
        assertThat(fieldOf(page, docker, "boxArt")).isEqualTo("docker");
        assertThat(fieldOf(page, light, "boxArt")).isEqualTo("light");
        assertThat(fieldOf(page, silent, "boxArt"))
                .as("ohne Meldung ist die Box-Art unbekannt, nie still Docker").isNull();
        assertThat(releaseBoxArt(page, 40)).isEqualTo("docker");
        assertThat(releaseBoxArt(page, 41)).isEqualTo("light");
        JsonNode inventory = json.readTree(rest.exchange(url("/api/v1/admin/devices"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class).getBody())
                .get("devices");
        assertThat(inventoryRow(inventory, light).get("boxArt").asText()).isEqualTo("light");

        // ── Einzelzuweisung: Docker-Release → Edge Light = 409 ────────────
        ResponseEntity<Map<String, Object>> single = post(
                "/api/v1/admin/devices/" + light + "/update-target", admin,
                Map.of("releaseSeq", 40));
        assertThat(single.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) single.getBody().get("message"))
                .contains("edge-2026.10.0")
                .contains("diese Box ist eine Edge Light");

        // ── Rollout mit einem unpassenden Gerät: 409, NICHTS zugewiesen ───
        int rolloutsBefore = readModel(admin).get("rollouts").size();
        ResponseEntity<Map<String, Object>> mixed = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 40, "devices", List.of(docker.toString(), light.toString())));
        assertThat(mixed.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) mixed.getBody().get("message"))
                .contains("passt nicht zu einem der gewählten Geräte")
                .contains("es wurde nichts zugewiesen");
        page = readModel(admin);
        assertThat(sollOf(page, docker)).as("auch das passende Gerät bekam nichts").isNull();
        assertThat(sollOf(page, light)).isNull();
        assertThat(page.get("rollouts").size()).isEqualTo(rolloutsBefore);

        // ── Edge-Light-Release → Docker-Box und unbekannte Box = 409 ──────
        ResponseEntity<Map<String, Object>> lightOnDocker = post(
                "/api/v1/admin/devices/" + docker + "/update-target", admin,
                Map.of("releaseSeq", 41));
        assertThat(lightOnDocker.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) lightOnDocker.getBody().get("message"))
                .contains("diese Box ist eine Docker-Box");
        ResponseEntity<Map<String, Object>> lightOnUnknown = post("/api/v1/admin/rollouts",
                admin, Map.of("releaseSeq", 41, "devices", List.of(silent.toString())));
        assertThat(lightOnUnknown.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) lightOnUnknown.getBody().get("message"))
                .contains("Box-Art dieses Geräts ist unbekannt");

        // ── Stufe 1 (Geräte & Updates S0): ohne gekreuztes Vertrauen nimmt die
        // Edge-Light-Box nichts aus dem Portal an - gesperrt VOR dem Senden, auf
        // beiden Schreibwegen, statt als „fehlgeschlagen ⚠" auf der Box zu enden.
        ResponseEntity<Map<String, Object>> stufe1 = post(
                "/api/v1/admin/devices/" + light + "/update-target", admin, Map.of("releaseSeq", 41));
        assertThat(stufe1.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) stufe1.getBody().get("message"))
                .contains("diese Box hat Stufe 1").contains("nachrüsten");
        ResponseEntity<Map<String, Object>> stufe1Auftrag = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 41, "devices", List.of(light.toString())));
        assertThat(stufe1Auftrag.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) stufe1Auftrag.getBody().get("message")).contains("diese Box hat Stufe 1");
        assertThat(sollOf(readModel(admin), light)).isNull();
        // Nachgerüstet: Wurzel und geprüftes Vertrauens-Set gemeldet (Stufe 2).
        kreuzeVertrauen(light);

        // ── Edge Light: erst verteilbar, wenn die Programme im Portal liegen ─
        ResponseEntity<Map<String, Object>> ohneProgramm = post(
                "/api/v1/admin/devices/" + light + "/update-target", admin, Map.of("releaseSeq", 41));
        assertThat(ohneProgramm.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) ohneProgramm.getBody().get("message"))
                .contains("noch nicht verteilbar").contains("linux/mipsle");
        assertThat(rest.getForEntity(url("/api/v1/edge/light-programm/" + LIGHT_GZ_SHA), byte[].class)
                .getStatusCode()).as("vor dem Hochladen gibt es nichts").isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(putTeil(admin, "edge-2026.10.0", "linux/mipsle", 0, new byte[] {1}).getStatusCode())
                .as("ein Docker-Release hat keine Programme").isEqualTo(HttpStatus.CONFLICT);
        assertThat(putTeil(admin, "edge-light-2026.10.1", "linux/arm64", 0, new byte[] {1}).getStatusCode())
                .as("eine Plattform, die das Manifest nicht nennt").isEqualTo(HttpStatus.NOT_FOUND);

        // Eine falsche Lieferung in voller Länge wird am Ende verworfen.
        byte[] falsch = LIGHT_GZ.clone();
        falsch[falsch.length - 1] ^= 1;
        ResponseEntity<Map<String, Object>> verworfen = hochladen(admin, falsch);
        assertThat(verworfen.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) verworfen.getBody().get("message")).contains("Pruefsumme");
        // Ein Teil an der falschen Stelle passt nicht.
        assertThat(putTeil(admin, "edge-light-2026.10.1", "linux/mipsle", 0,
                java.util.Arrays.copyOfRange(LIGHT_GZ, 0, 1000)).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(putTeil(admin, "edge-light-2026.10.1", "linux/mipsle", 5000,
                java.util.Arrays.copyOfRange(LIGHT_GZ, 5000, 6000)).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);

        // Die richtige Lieferung, in Teilen von 512 KiB: fertig erst mit dem letzten.
        ResponseEntity<Map<String, Object>> fertig = hochladen(admin, LIGHT_GZ);
        assertThat(fertig.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(fertig.getBody()).containsEntry("fertig", true);
        assertThat(((Number) fertig.getBody().get("empfangen")).longValue()).isEqualTo(LIGHT_GZ.length);
        // Ein wiederholter Lauf ändert nichts.
        assertThat(putTeil(admin, "edge-light-2026.10.1", "linux/mipsle", 0, new byte[] {9}).getBody())
                .containsEntry("fertig", true);
        JsonNode stand = json.readTree(rest.exchange(url("/api/v1/admin/edge-releases/edge-light-2026.10.1/programme"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class).getBody());
        assertThat(stand.get(0).get("arch").asText()).isEqualTo("linux/mipsle");
        assertThat(stand.get(0).get("fertig").asBoolean()).isTrue();

        // Offen abrufbar, ohne Token, Byte für Byte.
        ResponseEntity<byte[]> abruf = rest.getForEntity(url("/api/v1/edge/light-programm/" + LIGHT_GZ_SHA),
                byte[].class);
        assertThat(abruf.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(abruf.getHeaders().getContentType().toString()).isEqualTo("application/gzip");
        assertThat(abruf.getBody()).isEqualTo(LIGHT_GZ);
        assertThat(rest.getForEntity(url("/api/v1/edge/light-programm/" + "0".repeat(64)), byte[].class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.getForEntity(url("/api/v1/edge/light-programm/nicht-hex"), byte[].class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // ── Passende Zuweisungen gehen durch ──────────────────────────────
        assertThat(post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 40, "devices", List.of(docker.toString(), silent.toString())))
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(post("/api/v1/admin/devices/" + light + "/update-target", admin,
                Map.of("releaseSeq", 41)).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        page = readModel(admin);
        assertThat(sollOf(page, docker)).isEqualTo("edge-2026.10.0");
        assertThat(sollOf(page, silent)).isEqualTo("edge-2026.10.0");
        assertThat(sollOf(page, light)).isEqualTo("edge-light-2026.10.1");

        // ── Geräte & Updates S0: jede Box wird an IHRER Linie gemessen ──────
        // Das neueste Release über beide Linien ist edge-light-2026.10.1 (41);
        // eine Docker-Box auf edge-2026.10.0 (40) ist trotzdem aktuell, und der
        // Kunde liest nie „neuerer Stand edge-light-…".
        reportBox(docker, "compose", "edge-2026.10.0-3bf8c038a1b2");
        reportBox(light, "compose", "edge-light-2026.10.1-9b37439a02c1");
        List<Map<String, Object>> kunde = SichtbareListenTestLeser.lesen(rest,
                url("/api/v1/edge-versions"), HttpMethod.GET, new HttpEntity<>(bearer(customer)),
                new ParameterizedTypeReference<List<Map<String, Object>>>() {}).getBody();
        Map<String, Object> dockerStand = kundenStand(kunde, docker);
        assertThat(dockerStand.get("newestRelease")).isEqualTo("edge-2026.10.0");
        assertThat(dockerStand.get("upToDate")).isEqualTo(Boolean.TRUE);
        Map<String, Object> lightStand = kundenStand(kunde, light);
        assertThat(lightStand.get("newestRelease")).isEqualTo("edge-light-2026.10.1");
        assertThat(lightStand.get("upToDate")).isEqualTo(Boolean.TRUE);

        // Die Betreiber-Seite trägt dieselbe Sicht je Linie (additiv: die KPI
        // älterer Portale bleibt das neueste Release über beide Linien).
        page = readModel(admin);
        JsonNode dockerLinie = linie(page, "docker");
        assertThat(dockerLinie.get("newestRelease").asText()).isEqualTo("edge-2026.10.0");
        assertThat(dockerLinie.get("newestReleaseSeq").asLong()).isEqualTo(40);
        assertThat(dockerLinie.get("upToDate").asInt()).isPositive();
        assertThat(dockerLinie.get("devices").asInt()).isGreaterThanOrEqualTo(dockerLinie.get("upToDate").asInt());
        JsonNode lightLinie = linie(page, "light");
        assertThat(lightLinie.get("newestRelease").asText()).isEqualTo("edge-light-2026.10.1");
        assertThat(lightLinie.get("devices").asInt()).isEqualTo(1);
        assertThat(lightLinie.get("known").asInt()).isEqualTo(1);
        assertThat(lightLinie.get("upToDate").asInt()).isEqualTo(1);
        assertThat(page.get("lines").get(0).get("boxArt").asText()).isEqualTo("docker");
        assertThat(page.get("kpi").get("newestRelease").asText()).isEqualTo("edge-light-2026.10.1");
    }

    /**
     * Geräte &amp; Updates G1/G2: die Linien-Sicht, die drei Fakten mit EIGENEN
     * Zeitpunkten über den ECHTEN Ingest (UpdateStatusListener), die Eignung je
     * Box und Release, und eine zurückgezogene Anfrage hält ihren Lauf nicht mehr
     * offen.
     */
    @Test
    @Order(7)
    void linienFaktenEignungUndZurueckgezogen() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        UUID a = claim(customer, TestKennung.box("ota-ga-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID b = claim(customer, TestKennung.box("ota-gb-" + UUID.randomUUID().toString().substring(0, 8)));
        UpdateStatusListener ingest = new UpdateStatusListener("tcp://localhost:1883", "", "",
                deviceRepo, updateStatusRepo);
        herzschlag(ingest, a, "edge-2026.10.0-3bf8c038a1b2", null, null, "idle");
        herzschlag(ingest, b, "edge-2026.10.0-3bf8c038a1b2", null, null, "idle");
        registerRelease(admin, "edge-2026.10.2", 42,
                MANIFEST.replace("edge-2026.08.0", "edge-2026.10.2").replace(":12", ":42"), SIGNATURE);

        // ── Eignung (G1): bereit; die Edge-Light-Box zählt nur als andere Linie ─
        JsonNode eignung = getJson(admin, "/api/v1/admin/edge-updates/eignung?releaseSeq=42");
        assertThat(eignung.get("boxArt").asText()).isEqualTo("docker");
        assertThat(eignungOf(eignung, a).get("gruppe").asText()).isEqualTo("bereit");
        assertThat(eignung.get("andereLinie").asInt()).as("die Edge-Light-Box aus Fall 6").isPositive();
        assertThat(rest.exchange(url("/api/v1/admin/edge-updates/eignung?releaseSeq=11"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .as("nicht signiert").isEqualTo(HttpStatus.CONFLICT);
        assertThat(rest.exchange(url("/api/v1/admin/edge-updates/eignung?releaseSeq=42"),
                HttpMethod.GET, new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // ── Angefragt (Portal) ─────────────────────────────────────────────
        ResponseEntity<Map<String, Object>> lauf = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 42, "devices", List.of(a.toString(), b.toString())));
        assertThat(lauf.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        UUID rolloutId = UUID.fromString((String) lauf.getBody().get("rolloutId"));
        JsonNode fakten = rowOf(readModel(admin), a).get("fakten");
        assertThat(fakten.get("angefragt").get("release").asText()).isEqualTo("edge-2026.10.2");
        assertThat(fakten.get("angefragt").get("am").isNull()).isFalse();
        assertThat(fakten.get("angefragt").get("von").asText()).isNotBlank();
        assertThat(fakten.get("angenommen").get("stand").asText()).isEqualTo("offen");
        assertThat(fakten.get("bestaetigt").get("stand").asText()).isEqualTo("offen");

        // ── Angenommen (Box) mit Zeitpunkt, dann der Zwischenschritt ───────
        herzschlag(ingest, a, "edge-2026.10.0-3bf8c038a1b2", "edge-2026.10.2", "ok", "downloading");
        fakten = rowOf(readModel(admin), a).get("fakten");
        assertThat(fakten.get("angenommen").get("stand").asText()).isEqualTo("ja");
        assertThat(fakten.get("angenommen").get("am").isNull()).as("Serverzeit des Wechsels").isFalse();
        assertThat(fakten.get("bestaetigt").get("stand").asText()).isEqualTo("laeuft");
        assertThat(fakten.get("bestaetigt").get("schritt").asText()).isEqualTo("laedt");

        // ── Bestätigt (Box) mit dem Zeitpunkt des Versionswechsels ─────────
        herzschlag(ingest, a, "edge-2026.10.2-9b37439a02c1", "edge-2026.10.2", "ok", "succeeded");
        JsonNode page = readModel(admin);
        JsonNode zeileA = rowOf(page, a);
        assertThat(zeileA.get("fakten").get("bestaetigt").get("stand").asText()).isEqualTo("ja");
        assertThat(zeileA.get("fakten").get("bestaetigt").get("am").isNull()).isFalse();
        assertThat(zeileA.get("istSeit").isNull()).isFalse();
        assertThat(zeileA.get("istRelease").asText()).isEqualTo("edge-2026.10.2");
        assertThat(zeileA.get("linie").asText()).isEqualTo("docker");
        assertThat(zeileA.get("stand").asText()).isEqualTo("aktuell");
        assertThat(zeileA.get("releasesDahinter").asInt()).isZero();
        assertThat(zeileA.get("lastSeenAt").isNull()).isFalse();
        JsonNode zeileB = rowOf(page, b);
        assertThat(zeileB.get("stand").asText()).as("angefragt, noch nicht angenommen").isEqualTo("laeuft");
        assertThat(zeileB.get("releasesDahinter").asInt()).isEqualTo(1);
        assertThat(zeileB.get("istSeit").isNull()).as("die erste Meldung sagt nicht, seit wann").isTrue();

        // ── Linien-Sicht (G1) ──────────────────────────────────────────────
        JsonNode docker = linie(page, "docker");
        assertThat(docker.get("newestRelease").asText()).isEqualTo("edge-2026.10.2");
        assertThat(docker.get("releases").asInt()).isGreaterThanOrEqualTo(2);
        assertThat(docker.get("stand").get("aktuell").asInt()).isPositive();
        assertThat(docker.get("stand").get("laeuft").asInt()).isPositive();
        assertThat(versionOf(docker, "edge-2026.10.2").get("releaseSeq").asLong()).isEqualTo(42);
        assertThat(versionOf(docker, "edge-2026.10.2").get("devices").toString()).contains(a.toString());
        assertThat(versionOf(docker, "edge-2026.10.0").get("devices").toString()).contains(b.toString());

        // ── Eignung danach: A ist aktuell und kann kein älteres Release ─────
        assertThat(eignungOf(getJson(admin, "/api/v1/admin/edge-updates/eignung?releaseSeq=42"), a)
                .get("gruppe").asText()).isEqualTo("aktuell");
        JsonNode aelter = eignungOf(getJson(admin, "/api/v1/admin/edge-updates/eignung?releaseSeq=40"), a);
        assertThat(aelter.get("gruppe").asText()).isEqualTo("kann_nicht");
        assertThat(aelter.get("grund").asText()).contains("Läuft schon edge-2026.10.2");

        // ── Zurückgezogen: der Lauf hält nicht mehr auf B und wird mit A fertig ─
        assertThat(post("/api/v1/admin/devices/" + b + "/update-target/revert", admin, Map.of())
                .getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        rollouts.reconcile(Instant.now());
        page = readModel(admin);
        JsonNode r = rolloutOf(page, rolloutId);
        assertThat(r.get("state").asText()).isEqualTo("done");
        assertThat(rolloutDeviceState(r, b)).isEqualTo("zurueckgezogen");
        assertThat(rolloutDeviceState(r, a)).isEqualTo("bestaetigt");
        assertThat(rowOf(page, b).get("fakten").isNull()).as("keine Anfrage mehr").isTrue();

        // ── Verlauf je Box (G3): Portal-Handlungen und Box-Meldungen, neueste zuerst.
        // Den Box-Teil hat der Trigger auf device_update_status beim ECHTEN Ingest
        // (App-Rolle, RLS) angehängt.
        JsonNode verlaufA = getJson(admin, "/api/v1/admin/devices/" + a + "/verlauf").get("eintraege");
        assertThat(arten(verlaufA)).containsExactly("box:stand", "box:angenommen", "portal:angefragt",
                "box:stand");
        assertThat(verlaufA.get(0).get("release").asText()).isEqualTo("edge-2026.10.2-9b37439a02c1");
        assertThat(verlaufA.get(0).get("vorher").asText()).isEqualTo("edge-2026.10.0-3bf8c038a1b2");
        assertThat(verlaufA.get(1).get("release").asText()).isEqualTo("edge-2026.10.2");
        assertThat(verlaufA.get(2).get("release").asText()).isEqualTo("edge-2026.10.2");
        assertThat(verlaufA.get(2).get("von").asText()).isNotBlank();
        assertThat(verlaufA.get(3).get("vorher").isNull()).as("erste Meldung").isTrue();
        JsonNode verlaufB = getJson(admin, "/api/v1/admin/devices/" + b + "/verlauf").get("eintraege");
        assertThat(arten(verlaufB)).containsExactly("portal:zurueckgezogen", "portal:angefragt", "box:stand");
        assertThat(getJson(admin, "/api/v1/admin/devices/" + a + "/verlauf?limit=1").get("eintraege").size())
                .isEqualTo(1);
        assertThat(rest.exchange(url("/api/v1/admin/devices/" + UUID.randomUUID() + "/verlauf"),
                HttpMethod.GET, new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(rest.exchange(url("/api/v1/admin/devices/" + a + "/verlauf"), HttpMethod.GET,
                new HttpEntity<>(bearer(customer)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
    }

    /**
     * Geräte &amp; Updates G4: „Was ist neu" reist mit dem Register-Eintrag (CI) und
     * lässt sich durch einen wiederholten Tag-Lauf NACHTRAGEN, nie überschreiben;
     * die Release-Seite zeigt Inhalt aus dem Manifest, Programme im Portal, wo es
     * läuft und die Änderungen.
     */
    @Test
    @Order(8)
    void releaseSeiteUndWasIstNeu() throws Exception {
        String admin = token("admin", "admin");
        String manifest43 = MANIFEST.replace("edge-2026.08.0", "edge-2026.10.3").replace(":12", ":43");
        ResponseEntity<Map<String, Object>> neu = post("/api/v1/admin/edge-releases", admin, Map.of(
                "version", "edge-2026.10.3", "releaseSeq", 43, "manifest", manifest43,
                "signature", SIGNATURE, "aenderungen", List.of("Core: Heizstab je Phase (#1693) (ef19aec51)",
                        "  ", "Node-RED: Fronius-Block (#1690) (abc1234)")));
        assertThat(neu.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(neu.getBody().get("aenderungen")).as("getrimmt, leere Zeilen fallen weg")
                .isEqualTo(List.of("Core: Heizstab je Phase (#1693) (ef19aec51)",
                        "Node-RED: Fronius-Block (#1690) (abc1234)"));

        JsonNode seite = getJson(admin, "/api/v1/admin/edge-updates/releases/43");
        assertThat(seite.get("version").asText()).isEqualTo("edge-2026.10.3");
        assertThat(seite.get("boxArt").asText()).isEqualTo("docker");
        assertThat(seite.get("signed").asBoolean()).isTrue();
        assertThat(seite.get("aenderungen").size()).isEqualTo(2);
        assertThat(seite.get("boxenDerLinie").asInt()).isPositive();
        assertThat(seite.get("erlaubtRueckschritt").asBoolean()).isFalse();

        // Ein wiederholter Tag-Lauf (bytegleich) trägt nach, wo keine Angabe steht:
        // die LEERE Liste ist die Aussage „keine Änderung an der Box".
        String manifest42 = MANIFEST.replace("edge-2026.08.0", "edge-2026.10.2").replace(":12", ":42");
        ResponseEntity<Map<String, Object>> nachtrag = post("/api/v1/admin/edge-releases", admin, Map.of(
                "version", "edge-2026.10.2", "releaseSeq", 42, "manifest", manifest42,
                "signature", SIGNATURE, "aenderungen", List.of()));
        assertThat(nachtrag.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(nachtrag.getBody().get("aenderungen")).isEqualTo(List.of());
        ResponseEntity<Map<String, Object>> ueber = post("/api/v1/admin/edge-releases", admin, Map.of(
                "version", "edge-2026.10.2", "releaseSeq", 42, "manifest", manifest42,
                "signature", SIGNATURE, "aenderungen", List.of("anders")));
        assertThat(ueber.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ueber.getBody().get("aenderungen")).as("nie überschrieben").isEqualTo(List.of());

        // Edge Light (Fall 6): Inhalt aus dem Manifest, Programme fertig im Portal,
        // läuft auf der Edge-Light-Box; vor G4 registriert = keine Angabe.
        JsonNode light = getJson(admin, "/api/v1/admin/edge-updates/releases/41");
        assertThat(light.get("boxArt").asText()).isEqualTo("light");
        JsonNode teil = light.get("inhalt").get(0);
        assertThat(teil.get("typ").asText()).isEqualTo("binary");
        assertThat(teil.get("arch").asText()).isEqualTo("linux/mipsle");
        assertThat(teil.get("gzGroesse").asLong()).isEqualTo(LIGHT_GZ.length);
        JsonNode programm = light.get("programme").get(0);
        assertThat(programm.get("arch").asText()).isEqualTo("linux/mipsle");
        assertThat(programm.get("fertig").asBoolean()).isTrue();
        assertThat(programm.get("empfangen").asLong()).isEqualTo(LIGHT_GZ.length);
        assertThat(light.get("laeuftAuf").size()).isPositive();
        assertThat(light.get("aenderungen").isNull()).isTrue();

        assertThat(rest.exchange(url("/api/v1/admin/edge-updates/releases/9999"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * Geräte &amp; Updates G8: die Box meldet ihr Gerät im Update-Block (echter
     * Ingest); der Loader-Stand macht die Stufe sicher - eine Edge-Light-Box mit
     * gekreuztem Vertrauen, deren Loader nur die Flash-Fassung startet, ist
     * Stufe 1 und bekommt kein Release, bis sie nachgerüstet ist.
     */
    @Test
    @Order(9)
    void geraetUndLoaderAusDemHerzschlag() throws Exception {
        String admin = token("admin", "admin");
        String customer = token("demo", "demo");
        UUID mango = claim(customer, TestKennung.box("ota-gm-" + UUID.randomUUID().toString().substring(0, 8)));
        UUID pi = claim(customer, TestKennung.box("ota-gp-" + UUID.randomUUID().toString().substring(0, 8)));
        UpdateStatusListener ingest = new UpdateStatusListener("tcp://localhost:1883", "", "",
                deviceRepo, updateStatusRepo);
        String trust = ",\"trust\":{\"root_key_ids\":[\"root-2026-a\"],\"trust_set_key_ids\":[\"rel-2026-a\"]}";
        herzschlagRoh(ingest, mango, "edge-light-2026.10.1-9b37439a02c1",
                "{\"backend\":\"light\",\"current\":\"edge-light-2026.10.1-9b37439a02c1\",\"state\":\"idle\""
                        + trust + ",\"geraet\":{\"modell\":\"GL.iNet GL-MT300N-V2\",\"arch\":\"mipsle\","
                        + "\"loader\":\"flash\"}}");
        herzschlagRoh(ingest, pi, "edge-2026.10.2-9b37439a02c1",
                "{\"backend\":\"compose\",\"current\":\"edge-2026.10.2-9b37439a02c1\",\"state\":\"idle\","
                        + "\"geraet\":{\"modell\":\"Raspberry Pi 4 Model B Rev 1.4\",\"arch\":\"arm64\"}}");

        JsonNode page = readModel(admin);
        JsonNode zeile = rowOf(page, mango);
        assertThat(zeile.get("geraetModell").asText()).isEqualTo("GL.iNet GL-MT300N-V2");
        assertThat(zeile.get("geraetArch").asText()).isEqualTo("mipsle");
        assertThat(zeile.get("loader").asText()).isEqualTo("flash");
        assertThat(zeile.get("stufe1").asBoolean()).as("gekreuzt, aber der Loader kennt keine Updates").isTrue();
        assertThat(zeile.get("stand").asText()).isEqualTo("hand");
        JsonNode zeilePi = rowOf(page, pi);
        assertThat(zeilePi.get("geraetModell").asText()).isEqualTo("Raspberry Pi 4 Model B Rev 1.4");
        assertThat(zeilePi.get("geraetArch").asText()).isEqualTo("arm64");
        assertThat(zeilePi.get("loader").isNull()).isTrue();
        JsonNode inventar = json.readTree(rest.exchange(url("/api/v1/admin/devices"), HttpMethod.GET,
                new HttpEntity<>(bearer(admin)), String.class).getBody()).get("devices");
        assertThat(inventoryRow(inventar, pi).get("geraetModell").asText())
                .isEqualTo("Raspberry Pi 4 Model B Rev 1.4");

        // Stufe 1 am Loader: 409 mit dem Loader-Satz, im Dialog „kann nicht".
        ResponseEntity<Map<String, Object>> gesperrt = post("/api/v1/admin/devices/" + mango + "/update-target",
                admin, Map.of("releaseSeq", 41));
        assertThat(gesperrt.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) gesperrt.getBody().get("message")).contains("ihr Loader startet immer die Fassung aus dem Flash");
        ResponseEntity<Map<String, Object>> gesperrtAuftrag = post("/api/v1/admin/rollouts", admin,
                Map.of("releaseSeq", 41, "devices", List.of(mango.toString())));
        assertThat(gesperrtAuftrag.getStatusCode()).as("auch die Verteilung").isEqualTo(HttpStatus.CONFLICT);
        assertThat((String) gesperrtAuftrag.getBody().get("message"))
                .contains("ihr Loader startet immer die Fassung aus dem Flash");
        JsonNode eignung = eignungOf(getJson(admin, "/api/v1/admin/edge-updates/eignung?releaseSeq=41"), mango);
        assertThat(eignung.get("gruppe").asText()).isEqualTo("kann_nicht");

        // Nachgerüstet: der neue Loader kennt Updates - die Zuweisung geht durch.
        herzschlagRoh(ingest, mango, "edge-light-2026.10.1-9b37439a02c1",
                "{\"backend\":\"light\",\"current\":\"edge-light-2026.10.1-9b37439a02c1\",\"state\":\"idle\""
                        + trust + ",\"geraet\":{\"modell\":\"GL.iNet GL-MT300N-V2\",\"arch\":\"mipsle\","
                        + "\"loader\":\"update\"}}");
        assertThat(rowOf(readModel(admin), mango).get("stufe1").asBoolean()).isFalse();
        assertThat(post("/api/v1/admin/devices/" + mango + "/update-target", admin,
                Map.of("releaseSeq", 41)).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        // Ein Bericht OHNE Block (Sofort-Bericht, ältere Box) lässt die Angabe stehen.
        herzschlagRoh(ingest, pi, "edge-2026.10.2-9b37439a02c1",
                "{\"backend\":\"compose\",\"current\":\"edge-2026.10.2-9b37439a02c1\",\"state\":\"idle\"}");
        assertThat(rowOf(readModel(admin), pi).get("geraetArch").asText()).isEqualTo("arm64");

        // Gerät und Loader sind kein Verlauf (G3): der Trigger auf device_update_status
        // schreibt nur Stand, Urteil und Zustand - auch der Wechsel flash -> update nicht.
        assertThat(arten(getJson(admin, "/api/v1/admin/devices/" + pi + "/verlauf").get("eintraege")))
                .as("zwei Meldungen derselben Fassung, eine davon ohne Block").containsExactly("box:stand");
        assertThat(arten(getJson(admin, "/api/v1/admin/devices/" + mango + "/verlauf").get("eintraege")))
                .containsExactly("portal:angefragt", "box:stand");
    }

    /** Ein Status-Herzschlag mit beliebigem Update-Block durch den ECHTEN Ingest. */
    private void herzschlagRoh(UpdateStatusListener ingest, UUID deviceId, String version, String update) {
        String payload = "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT_A
                + "\",\"site_id\":\"" + BERLIN_SITE + "\",\"device_id\":\"" + deviceId
                + "\",\"online\":true,\"ts\":\"" + Instant.now() + "\",\"version\":\"" + version
                + "\",\"update\":" + update + "}";
        ingest.handle("ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/status",
                payload.getBytes(StandardCharsets.UTF_8));
    }

    /** „quelle:art" je Verlauf-Eintrag, in der gelieferten Reihenfolge. */
    private static List<String> arten(JsonNode eintraege) {
        List<String> out = new java.util.ArrayList<>();
        for (JsonNode e : eintraege) {
            out.add(e.get("quelle").asText() + ":" + e.get("art").asText());
        }
        return out;
    }

    /** Ein Status-Herzschlag mit Update-Block durch den ECHTEN Ingest. */
    private void herzschlag(UpdateStatusListener ingest, UUID deviceId, String laeuft, String ziel,
            String urteil, String zustand) {
        String update = "{\"backend\":\"compose\",\"current\":\"" + laeuft + "\",\"state\":\""
                + zustand + "\"" + (ziel == null ? "" : ",\"target\":\"" + ziel + "\"")
                + (urteil == null ? "" : ",\"target_verdict\":\"" + urteil + "\"") + "}";
        String payload = "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT_A
                + "\",\"site_id\":\"" + BERLIN_SITE + "\",\"device_id\":\"" + deviceId
                + "\",\"online\":true,\"ts\":\"" + Instant.now() + "\",\"version\":\"" + laeuft
                + "\",\"update\":" + update + "}";
        ingest.handle("ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/status",
                payload.getBytes(StandardCharsets.UTF_8));
    }

    private JsonNode getJson(String token, String path) throws Exception {
        ResponseEntity<String> res = rest.exchange(url(path), HttpMethod.GET,
                new HttpEntity<>(bearer(token)), String.class);
        assertThat(res.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        return json.readTree(res.getBody());
    }

    private static JsonNode rowOf(JsonNode page, UUID deviceId) {
        for (JsonNode row : page.get("fleet")) {
            if (deviceId.toString().equals(row.get("deviceId").asText())) {
                return row;
            }
        }
        throw new AssertionError("Gerät " + deviceId + " fehlt in der Flotte");
    }

    private static JsonNode eignungOf(JsonNode eignung, UUID deviceId) {
        for (JsonNode box : eignung.get("boxen")) {
            if (deviceId.toString().equals(box.get("deviceId").asText())) {
                return box;
            }
        }
        throw new AssertionError("Gerät " + deviceId + " fehlt in der Eignung");
    }

    private static JsonNode versionOf(JsonNode linie, String version) {
        for (JsonNode v : linie.get("versions")) {
            if (version.equals(v.get("version").asText())) {
                return v;
            }
        }
        throw new AssertionError("Version " + version + " fehlt in der Leiter");
    }

    private static JsonNode rolloutOf(JsonNode page, UUID rolloutId) {
        for (JsonNode r : page.get("rollouts")) {
            if (rolloutId.toString().equals(r.get("id").asText())) {
                return r;
            }
        }
        throw new AssertionError("Lauf " + rolloutId + " fehlt");
    }

    private static String rolloutDeviceState(JsonNode rollout, UUID deviceId) {
        for (JsonNode d : rollout.get("devices")) {
            if (deviceId.toString().equals(d.get("deviceId").asText())) {
                return d.get("state").asText();
            }
        }
        throw new AssertionError("Gerät " + deviceId + " fehlt im Lauf");
    }

    private static Map<String, Object> kundenStand(List<Map<String, Object>> stande, UUID deviceId) {
        return stande.stream().filter(r -> deviceId.toString().equals(r.get("deviceId")))
                .findFirst().orElseThrow(() -> new AssertionError("Gerät " + deviceId + " fehlt"));
    }

    private static JsonNode linie(JsonNode page, String boxArt) {
        for (JsonNode l : page.get("lines")) {
            if (boxArt.equals(l.get("boxArt").asText())) {
                return l;
            }
        }
        throw new AssertionError("Linie " + boxArt + " fehlt");
    }

    /** Wurzel und geprüftes Vertrauens-Set setzen, ohne den gemeldeten Stand zu berühren. */
    private void kreuzeVertrauen(UUID deviceId) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("UPDATE device_update_status SET root_key_ids = 'root-2026-a', "
                    + "trust_set_key_ids = 'rel-2026-a' WHERE device_id = '" + deviceId + "'");
        }
    }

    /** Backend und Stempel einer Box direkt setzen (Ingest: UpdateStatusListenerTest). */
    private void reportBox(UUID deviceId, String backend, String version) throws Exception {
        try (Connection c = superuser(); Statement st = c.createStatement()) {
            st.execute("""
                    INSERT INTO device_update_status (device_id, tenant_id, site_id, version,
                            backend, current_version, state, reported_at)
                    VALUES ('%s', '%s', '%s', %s, %s, %s, 'idle', now())
                    ON CONFLICT (device_id) DO UPDATE SET version = EXCLUDED.version,
                            backend = EXCLUDED.backend,
                            current_version = EXCLUDED.current_version
                    """.formatted(deviceId, TENANT_A, BERLIN_SITE, sql(version), sql(backend),
                    sql(version)));
        }
    }

    private static String releaseBoxArt(JsonNode page, long releaseSeq) {
        for (JsonNode r : page.get("releases")) {
            if (r.get("releaseSeq").asLong() == releaseSeq) {
                return r.get("boxArt").asText();
            }
        }
        throw new AssertionError("Release " + releaseSeq + " fehlt im Register");
    }

    private static JsonNode inventoryRow(JsonNode rows, UUID deviceId) {
        for (JsonNode r : rows) {
            if (deviceId.toString().equals(r.path("deviceId").asText())) {
                return r;
            }
        }
        throw new AssertionError("Gerät " + deviceId + " fehlt im Inventar");
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

    /** Ein Teil einer Edge-Light-Lieferung hochladen. */
    private ResponseEntity<Map<String, Object>> putTeil(String token, String version, String arch, long ab,
            byte[] teil) {
        HttpHeaders h = bearer(token);
        h.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        return rest.exchange(url("/api/v1/admin/edge-releases/" + version + "/programme/" + arch + "?ab=" + ab),
                HttpMethod.PUT, new HttpEntity<>(teil, h), new ParameterizedTypeReference<>() {});
    }

    /** Die ganze Lieferung so hochladen wie der Release-Lauf: 512 KiB je Teil, ab 0. */
    private ResponseEntity<Map<String, Object>> hochladen(String token, byte[] gz) {
        ResponseEntity<Map<String, Object>> last = null;
        for (int ab = 0; ab < gz.length; ab += 512 * 1024) {
            last = putTeil(token, "edge-light-2026.10.1", "linux/mipsle", ab,
                    java.util.Arrays.copyOfRange(gz, ab, Math.min(gz.length, ab + 512 * 1024)));
            if (!last.getStatusCode().is2xxSuccessful()) {
                return last;
            }
            if (ab + 512 * 1024 < gz.length) {
                assertThat(last.getBody()).containsEntry("fertig", false);
            }
        }
        return last;
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
