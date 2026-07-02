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

    // ---- helpers ------------------------------------------------------------

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
