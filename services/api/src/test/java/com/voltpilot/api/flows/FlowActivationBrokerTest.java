package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.tenant.TenantContext;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The E2→E3a bridge end to end against a REAL broker: with the flag ON, the
 * REAL {@link FlowCompilerClient} (its HTTP transport faked to return the
 * flowc-produced contract fixture artifact - a JVM test has no Node runtime)
 * compiles the artifact, {@link FlowActivationService} publishes the D-11
 * deployment set, and a device subscribing to {@code …/v2/flows} converges from
 * retention onto exactly that artifact (its flowc content_hash preserved). The
 * sidecar's own graph→artifact→hash proof is the Node {@code serve.test.js}.
 */
@Testcontainers(disabledWithoutDocker = true)
class FlowActivationBrokerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final UUID FLOW = UUID.fromString("4e1c2b3a-5d6e-4f70-8123-456789abcdef");

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(
            DockerImageName.parse("emqx/emqx:5.8.3")).withExposedPorts(1883);

    private static String brokerUrl() {
        return "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
    }

    private FlowRepository flows;
    private EntityRegistryRepository entities;
    private String fixtureArtifactJson;

    @BeforeEach
    void setUp() throws IOException {
        flows = mock(FlowRepository.class);
        entities = mock(EntityRegistryRepository.class);
        fixtureArtifactJson = Files.readString(Path.of("..", "..", "docs", "contracts", "v2",
                "examples", "flow-artifact.valid.artifact.json"));
        TenantContext.set(TENANT);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(value);
        return provider;
    }

    private FlowVersionRow row(String lifecycle, String artifactJson) {
        return new FlowVersionRow(FLOW, 2, SITE, "Marktoptimierung", "edge", lifecycle,
                "{}", null, artifactJson, Instant.now(), Instant.now(), null, null);
    }

    @Test
    void activationCompilesTheArtifactAndPublishesTheRetainedDeploymentSet() throws Exception {
        // The gateway is the battery's controlling device (E1a rule).
        when(entities.batteryAsset(SITE)).thenReturn(
                new EntityRegistryRepository.BatteryAsset(DEVICE, null, null, null, null));
        // After markActive, the site has one active edge flow with the artifact.
        when(flows.versionsForSite(SITE)).thenReturn(List.of(row("active", fixtureArtifactJson)));

        // The REAL client, its HTTP transport faked to return the flowc artifact.
        FlowCompilerHttp fakeSidecar =
                (uri, body) -> new FlowCompilerHttp.Response(200, fixtureArtifactJson);
        FlowCompiler compiler = new FlowCompilerClient(fakeSidecar,
                URI.create("http://flowc:8099"), MAPPER);

        FlowDeploymentPublisher publisher = new FlowDeploymentPublisher(brokerUrl(), "", "");
        FlowActivationService service = new FlowActivationService(flows, entities,
                mock(com.voltpilot.api.repo.FlowClaimRepository.class), new FlowCatalog(MAPPER),
                provider((com.voltpilot.api.entities.EntityRegistryService) null),
                provider(compiler), provider(publisher), MAPPER, true,
                Clock.fixed(Instant.parse("2026-07-19T09:00:00Z"), ZoneOffset.UTC));

        FlowActivationService.ActivationOutcome outcome = service.activate(SITE,
                row("simulated", null), MAPPER.createObjectNode());
        assertThat(outcome.activated()).isTrue();
        assertThat(outcome.published()).isTrue();
        assertThat(outcome.deviceId()).isEqualTo(DEVICE);

        // A device connecting AFTER the publish converges from retention.
        JsonNode deployment = MAPPER.readTree(awaitRetained(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE)));
        assertThat(deployment.path("kind").asText()).isEqualTo("deployment");
        assertThat(deployment.path("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(deployment.path("deployed_at").asText()).isEqualTo("2026-07-19T09:00:00Z");
        assertThat(deployment.path("artifacts")).hasSize(1);
        JsonNode artifact = deployment.path("artifacts").get(0);
        // The published artifact is the fixture, its flowc content_hash intact.
        FlowDeployment.requireArtifactShape(artifact);
        assertThat(artifact.path("content_hash").asText())
                .isEqualTo(MAPPER.readTree(fixtureArtifactJson).path("content_hash").asText());
    }

    private String awaitRetained(String topic) throws Exception {
        MqttClient subscriber = new MqttClient(brokerUrl(),
                "test-sub-" + UUID.randomUUID(), new MemoryPersistence());
        try {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            subscriber.connect(options);
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> received = new AtomicReference<>();
            subscriber.subscribe(topic, 1, (t, message) -> {
                if (message.getPayload().length > 0) {
                    received.set(new String(message.getPayload(), StandardCharsets.UTF_8));
                    latch.countDown();
                }
            });
            latch.await(10000, TimeUnit.MILLISECONDS);
            assertThat(received.get()).as("retained deployment on " + topic).isNotNull();
            return received.get();
        } finally {
            try {
                subscriber.disconnect();
                subscriber.close();
            } catch (Exception e) {
                // best-effort cleanup
            }
        }
    }
}
