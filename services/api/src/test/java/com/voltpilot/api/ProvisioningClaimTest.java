package com.voltpilot.api;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dasniko.testcontainers.keycloak.KeycloakContainer;
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
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
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
 * Zero-touch onboarding, api side (contract:
 * docs/contracts/mqtt-provisioning.schema.json): when a customer claims a
 * device, the api publishes the retained {@code provision/{ref}/config} so a
 * device that booted BEFORE it was claimed ("claim-later") receives its identity
 * the moment the claim succeeds - proven here against a real EMQX, TimescaleDB
 * and Keycloak. Also proves the config is retained (re-provision on subscribe).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("local")
class ProvisioningClaimTest {

    private static final String APP_USER = "voltpilot_app";
    private static final String APP_PW = "voltpilot_app_test_pw";
    private static final String BERLIN_SITE = "00000000-0000-0000-0000-000000000002";
    private static final String TENANT_A = "00000000-0000-0000-0000-000000000001";

    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("timescale/timescaledb:2.17.2-pg16")
                    .asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("voltpilot")
            .withUsername("voltpilot")
            .withPassword("voltpilot_dev_pw");

    @Container
    static final KeycloakContainer KEYCLOAK = new KeycloakContainer("quay.io/keycloak/keycloak:26.0.5")
            .withRealmImportFile("keycloak/voltpilot-realm.json");

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(DockerImageName.parse("emqx/emqx:5.8.3"))
            .withExposedPorts(1883)
            .waitingFor(Wait.forLogMessage(".*is running now.*", 1).withStartupTimeout(Duration.ofMinutes(2)));

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
        // Device-initiated data purge: the listener consumes purge_request
        // messages from the status topic (docs/contracts/mqtt-data-purge.schema.json).
        registry.add("voltpilot.purge.mqtt-listener-enabled", () -> "true");
    }

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void claimPublishesRetainedProvisioningConfig() throws Exception {
        String ref = "zero-touch-" + UUID.randomUUID().toString().substring(0, 8);

        // The device booted first ("claim-later"): it is already subscribed to its
        // config topic and waiting - no hello retry needed once the claim lands.
        MqttClient device = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "device-" + ref, new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        device.connect(options);
        BlockingQueue<String> configs = new ArrayBlockingQueue<>(4);
        device.subscribe("provision/" + ref + "/config", 1,
                (topic, msg) -> configs.add(new String(msg.getPayload())));

        // Customer claims the ref in the portal (only site + ref, no IDs).
        HttpHeaders headers = bearer(token("demo", "demo"));
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String deviceId = (String) claim.getBody().get("id");

        // The waiting device receives its identity, pushed at claim time.
        String config = configs.poll(15, TimeUnit.SECONDS);
        assertThat(config).as("config pushed on claim").isNotNull();
        JsonNode node = mapper.readTree(config);
        assertThat(node.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(node.get("ref").asText()).isEqualTo(ref);
        assertThat(node.get("tenant_id").asText()).isEqualTo(TENANT_A);
        assertThat(node.get("site_id").asText()).isEqualTo(BERLIN_SITE);
        assertThat(node.get("device_id").asText()).isEqualTo(deviceId);
        device.disconnect();

        // Re-provision after restart: the config was published RETAINED, so a
        // fresh subscribe (device reboot) receives it again immediately.
        MqttClient rebooted = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "device-reboot-" + ref, new MemoryPersistence());
        rebooted.connect(options);
        BlockingQueue<String> retained = new ArrayBlockingQueue<>(4);
        rebooted.subscribe("provision/" + ref + "/config", 1,
                (topic, msg) -> retained.add(new String(msg.getPayload())));
        String replay = retained.poll(10, TimeUnit.SECONDS);
        assertThat(replay).as("retained config on re-subscribe").isNotNull();
        assertThat(mapper.readTree(replay).get("device_id").asText()).isEqualTo(deviceId);
        rebooted.disconnect();
    }

    /**
     * The manufacturing-registry gate composes with zero-touch onboarding:
     * a registered sticker Geräte-ID (VP- prefix) passes the claim gate and the
     * waiting device still receives its retained config - on the CANONICAL
     * uppercase topic (the ref as printed on the sticker), even when the
     * customer typed it lowercase in the portal.
     */
    @Test
    void registeredStickerRefClaimPublishesRetainedProvisioningConfig() throws Exception {
        String canonicalRef = "VP-ZTP-77AA";

        // Manufacturing registers the produced sticker ID (admin API, lowercase
        // on purpose - the endpoint canonicalizes like the claim path).
        HttpHeaders admin = bearer(token("admin", "admin"));
        ResponseEntity<Map<String, Object>> provisioned = rest.exchange(
                url("/api/v1/admin/provisioned-devices"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("externalRef", "vp-ztp-77aa", "kind", "inverter"), admin),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(provisioned.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(provisioned.getBody()).containsEntry("externalRef", canonicalRef);

        // The physical device knows only its printed (uppercase) ref: it is
        // already subscribed to that config topic ("claim-later").
        MqttClient device = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "device-" + canonicalRef, new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        device.connect(options);
        BlockingQueue<String> configs = new ArrayBlockingQueue<>(4);
        device.subscribe("provision/" + canonicalRef + "/config", 1,
                (topic, msg) -> configs.add(new String(msg.getPayload())));

        // The customer types the sticker ID sloppily; the gate lets the
        // registered ID through and the claim canonicalizes it.
        HttpHeaders customer = bearer(token("demo", "demo"));
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", "  vp-ztp-77aa "),
                        customer),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(claim.getBody()).containsEntry("externalRef", canonicalRef);
        String deviceId = (String) claim.getBody().get("id");

        // Zero-touch converges: the waiting device receives its identity.
        String config = configs.poll(15, TimeUnit.SECONDS);
        assertThat(config).as("config pushed on gated sticker claim").isNotNull();
        JsonNode node = mapper.readTree(config);
        assertThat(node.get("ref").asText()).isEqualTo(canonicalRef);
        assertThat(node.get("tenant_id").asText()).isEqualTo(TENANT_A);
        assertThat(node.get("site_id").asText()).isEqualTo(BERLIN_SITE);
        assertThat(node.get("device_id").asText()).isEqualTo(deviceId);
        device.disconnect();
    }

    /**
     * The unclaim MQTT cleanup: deleting a device clears the RETAINED
     * {@code provision/{ref}/config} (a rebooting device no longer receives a
     * stale identity - it falls back to hello retries) and the ref is claimable
     * again; a fresh claim then re-publishes the retained config with the NEW
     * device identity. claim -> unclaim -> re-claim, end to end.
     */
    @Test
    void unclaimClearsRetainedConfigAndReclaimRepublishesIt() throws Exception {
        String ref = "recycle-" + UUID.randomUUID().toString().substring(0, 8);
        HttpHeaders headers = bearer(token("demo", "demo"));

        // Claim: the retained config exists on the broker.
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(claim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String firstDeviceId = (String) claim.getBody().get("id");
        assertThat(pollRetainedConfig(ref, 15)).as("retained config after claim").isNotNull();

        // Unclaim: 204, and the retained config is GONE - a fresh subscribe
        // (device reboot) receives nothing instead of a stale identity.
        ResponseEntity<String> deleted = rest.exchange(
                url("/api/v1/devices/" + firstDeviceId),
                org.springframework.http.HttpMethod.DELETE, new HttpEntity<>(headers), String.class);
        assertThat(deleted.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(pollRetainedConfig(ref, 3)).as("retained config after unclaim").isNull();

        // Re-claim the freed ref: a NEW device row, and the retained config is
        // back with the new identity.
        ResponseEntity<Map<String, Object>> reclaim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(reclaim.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String secondDeviceId = (String) reclaim.getBody().get("id");
        assertThat(secondDeviceId).isNotEqualTo(firstDeviceId);
        String replayed = pollRetainedConfig(ref, 15);
        assertThat(replayed).as("retained config after re-claim").isNotNull();
        assertThat(mapper.readTree(replayed).get("device_id").asText()).isEqualTo(secondDeviceId);
    }

    /**
     * Portal-triggered data purge, MQTT side (contract:
     * docs/contracts/mqtt-data-purge.schema.json): the purge publishes the
     * RETAINED {@code purge_data} command on the device's command topic, so
     * even a device that was OFFLINE during the purge receives it on its next
     * connect and wipes its local buffers before replaying anything.
     */
    @Test
    void purgePublishesRetainedPurgeCommandThatAnOfflineDeviceReceivesOnReconnect() throws Exception {
        String ref = "purge-cmd-" + UUID.randomUUID().toString().substring(0, 8);
        HttpHeaders headers = bearer(token("demo", "demo"));
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        String deviceId = (String) claim.getBody().get("id");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "('2026-01-05T10:00:00Z', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + deviceId + "', 2.0)");

        // Purge while NO device is connected (the offline case).
        ResponseEntity<Map<String, Object>> purge = rest.exchange(
                url("/api/v1/devices/" + deviceId + "/purge-data"),
                org.springframework.http.HttpMethod.POST, new HttpEntity<>(headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(purge.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(purge.getBody()).containsEntry("deviceNotified", true);
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + deviceId + "'")).isZero();

        // A device connecting AFTER the purge receives the retained command.
        String topic = "ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/command";
        MqttClient device = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "device-" + ref, new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        device.connect(options);
        BlockingQueue<String> commands = new ArrayBlockingQueue<>(4);
        device.subscribe(topic, 1, (t, msg) -> commands.add(new String(msg.getPayload())));
        String command = commands.poll(15, TimeUnit.SECONDS);
        assertThat(command).as("retained purge command on reconnect").isNotNull();
        JsonNode node = mapper.readTree(command);
        assertThat(node.get("type").asText()).isEqualTo("purge_data");
        assertThat(node.get("device_id").asText()).isEqualTo(deviceId);
        assertThat(node.get("purged_before").asText()).isNotEmpty();
        device.disconnect();
    }

    /**
     * Device-initiated data purge ("Datenaufzeichnungen löschen" on the edge's
     * local web app): the device publishes a {@code purge_request} on its OWN
     * status topic; the api's listener runs the exact same purge - telemetry
     * gone, watermark stamped, retained purge command back as confirmation. A
     * request whose payload identity does not match the topic is ignored.
     */
    @Test
    void deviceInitiatedPurgeRequestPurgesItsOwnDataOnly() throws Exception {
        String ref = "purge-req-" + UUID.randomUUID().toString().substring(0, 8);
        HttpHeaders headers = bearer(token("demo", "demo"));
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", BERLIN_SITE, "externalRef", ref), headers),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        String deviceId = (String) claim.getBody().get("id");
        exec("INSERT INTO telemetry (time, tenant_id, site_id, device_id, power_kw) VALUES "
                + "('2026-01-06T10:00:00Z', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + deviceId + "', 2.0), "
                + "('2026-01-06T10:15:00Z', '" + TENANT_A + "', '" + BERLIN_SITE + "', '" + deviceId + "', 3.0)");

        MqttClient device = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "device-" + ref, new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        device.connect(options);
        BlockingQueue<String> commands = new ArrayBlockingQueue<>(4);
        device.subscribe("ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/command", 1,
                (t, msg) -> commands.add(new String(msg.getPayload())));

        // A spoofed request (payload identity != topic identity) is ignored.
        String statusTopic = "ems/" + TENANT_A + "/" + BERLIN_SITE + "/" + deviceId + "/status";
        String spoofed = "{\"schema_version\":\"1.0\",\"type\":\"purge_request\","
                + "\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE + "\","
                + "\"device_id\":\"" + UUID.randomUUID() + "\"}";
        device.publish(statusTopic, spoofed.getBytes(), 1, false);

        // The legitimate request (a regular heartbeat alongside proves the
        // type-less status messages are ignored cheaply).
        device.publish(statusTopic, ("{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT_A
                + "\",\"site_id\":\"" + BERLIN_SITE + "\",\"device_id\":\"" + deviceId
                + "\",\"online\":true}").getBytes(), 1, false);
        String request = "{\"schema_version\":\"1.0\",\"type\":\"purge_request\","
                + "\"tenant_id\":\"" + TENANT_A + "\",\"site_id\":\"" + BERLIN_SITE + "\","
                + "\"device_id\":\"" + deviceId + "\",\"ts\":\"2026-01-06T11:00:00Z\"}";
        device.publish(statusTopic, request.getBytes(), 1, false);

        // The purge ran: telemetry gone, watermark stamped, confirmation command
        // received by the (still subscribed) device.
        String command = commands.poll(20, TimeUnit.SECONDS);
        assertThat(command).as("purge confirmation command").isNotNull();
        JsonNode node = mapper.readTree(command);
        assertThat(node.get("type").asText()).isEqualTo("purge_data");
        assertThat(node.get("device_id").asText()).isEqualTo(deviceId);
        assertThat(queryLong("SELECT count(*) FROM telemetry WHERE device_id = '" + deviceId + "'")).isZero();
        assertThat(queryLong("SELECT count(*) FROM device WHERE id = '" + deviceId
                + "' AND data_purged_before IS NOT NULL")).isEqualTo(1);
        device.disconnect();
    }

    /**
     * E1a registry push: the admin bootstrap publishes the site's v2 entity set
     * as ONE RETAINED message on ems/{t}/{s}/{gateway}/v2/entities (contract
     * docs/contracts/v2/edge-entity-config.md §1) - a late-subscribing edge
     * converges from retention alone, exactly like the provisioning config.
     */
    @Test
    void v2EntityBootstrapPublishesTheRetainedRegistryPush() throws Exception {
        // Fresh site + claimed gateway + battery asset in tenant A (the demo
        // Berlin site's rows stay untouched for the other tests).
        HttpHeaders customer = bearer(token("demo", "demo"));
        String siteId = (String) rest.exchange(
                url("/api/v1/sites"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("name", "V2 Rig", "biddingZone", "DE-LU"), customer),
                new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {})
                .getBody().get("id");
        exec("INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                + "max_discharge_kw, roundtrip_efficiency_pct) VALUES ('" + TENANT_A + "', '"
                + siteId + "', 'battery', 65, 30, 30, 92)");
        String ref = "v2-rig-" + UUID.randomUUID().toString().substring(0, 8);
        ResponseEntity<Map<String, Object>> claim = rest.exchange(
                url("/api/v1/devices/claim"), org.springframework.http.HttpMethod.POST,
                new HttpEntity<>(Map.of("siteId", siteId, "externalRef", ref), customer),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        String deviceId = (String) claim.getBody().get("id");

        HttpHeaders admin = bearer(token("admin", "admin"));
        admin.set("X-Tenant-Id", TENANT_A);
        ResponseEntity<Map<String, Object>> boot = rest.exchange(
                url("/api/v1/admin/sites/" + siteId + "/v2-entities/bootstrap"),
                org.springframework.http.HttpMethod.POST, new HttpEntity<>(admin),
                new org.springframework.core.ParameterizedTypeReference<>() {});
        assertThat(boot.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> push = (Map<String, Object>) boot.getBody().get("push");
        assertThat(push.get("published")).isEqualTo(true);
        assertThat(push.get("deviceId")).isEqualTo(deviceId);

        // A LATE subscriber (the edge reconnecting) receives the set retained.
        String topic = "ems/" + TENANT_A + "/" + siteId + "/" + deviceId + "/v2/entities";
        String payload = pollRetained(topic, 15);
        assertThat(payload).as("retained registry push on " + topic).isNotNull();
        JsonNode pushNode = mapper.readTree(payload);
        assertThat(pushNode.get("schema_version").asText()).isEqualTo("1.0");
        assertThat(pushNode.get("tenant_id").asText()).isEqualTo(TENANT_A);
        assertThat(pushNode.get("site_id").asText()).isEqualTo(siteId);
        assertThat(pushNode.get("device_id").asText()).isEqualTo(deviceId);
        assertThat(pushNode.get("revision").asText()).isNotBlank();
        assertThat(pushNode.get("entities")).hasSize(1);
        JsonNode battery = pushNode.get("entities").get(0);
        assertThat(battery.get("entity_type").asText()).isEqualTo("battery-hybrid");
        assertThat(battery.get("guards").get("failsafe").get("behavior").asText())
                .isEqualTo("self-consumption");
        // D-8: the fresh site has netzladen_erlaubt = FALSE.
        assertThat(battery.get("guards").get("limits").get("charge_from_grid_allowed").asBoolean())
                .isFalse();
    }

    /** Fresh subscriber on an arbitrary topic: the retained payload, or null. */
    private String pollRetained(String topic, int timeoutSeconds) throws Exception {
        MqttClient probe = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "probe-" + UUID.randomUUID().toString().substring(0, 8), new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        probe.connect(options);
        try {
            BlockingQueue<String> received = new ArrayBlockingQueue<>(4);
            probe.subscribe(topic, 1, (t, msg) -> received.add(new String(msg.getPayload())));
            return received.poll(timeoutSeconds, TimeUnit.SECONDS);
        } finally {
            probe.disconnect();
        }
    }

    /** Fresh subscriber: the retained config payload, or null if none arrives. */
    private String pollRetainedConfig(String ref, int timeoutSeconds) throws Exception {
        MqttClient probe = new MqttClient(
                "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883),
                "probe-" + UUID.randomUUID().toString().substring(0, 8), new MemoryPersistence());
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        probe.connect(options);
        try {
            BlockingQueue<String> received = new ArrayBlockingQueue<>(4);
            probe.subscribe("provision/" + ref + "/config", 1,
                    (topic, msg) -> received.add(new String(msg.getPayload())));
            return received.poll(timeoutSeconds, TimeUnit.SECONDS);
        } finally {
            probe.disconnect();
        }
    }

    // ---- helpers ------------------------------------------------------------

    /** Run a statement as the Postgres superuser (bypasses RLS) to seed rows. */
    private static void exec(String sql) {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement()) {
            st.execute(sql);
        } catch (Exception e) {
            throw new IllegalStateException("seed failed: " + sql, e);
        }
    }

    /** Scalar count query as the Postgres superuser (sees all tenants' rows). */
    private static long queryLong(String sql) {
        try (java.sql.Connection c = java.sql.DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
                java.sql.Statement st = c.createStatement();
                java.sql.ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        } catch (Exception e) {
            throw new IllegalStateException("query failed: " + sql, e);
        }
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    private static HttpHeaders bearer(String token) {
        HttpHeaders h = new HttpHeaders();
        h.setBearerAuth(token);
        h.setContentType(MediaType.APPLICATION_JSON);
        return h;
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
