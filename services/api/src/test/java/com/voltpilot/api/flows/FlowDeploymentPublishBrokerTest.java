package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * The D-11 rollout channel against a REAL broker: the deployment set built
 * from the contract fixture artifact is published RETAINED on
 * {@code ems/{t}/{s}/{d}/v2/flows}, so a device subscribing AFTERWARDS (the
 * reconnect/reinstall convergence property) still receives the full desired
 * state; the clearing publish empties the retained slot.
 */
@Testcontainers(disabledWithoutDocker = true)
class FlowDeploymentPublishBrokerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final UUID TENANT = UUID.randomUUID();
    private static final UUID SITE = UUID.randomUUID();
    private static final UUID DEVICE = UUID.randomUUID();

    @Container
    static final GenericContainer<?> EMQX = new GenericContainer<>(
            DockerImageName.parse("emqx/emqx:5.8.3")).withExposedPorts(1883);

    private static String brokerUrl() {
        return "tcp://" + EMQX.getHost() + ":" + EMQX.getMappedPort(1883);
    }

    @Test
    void deploymentSetIsRetainedAndClearable() throws Exception {
        JsonNode artifact = MAPPER.readTree(Files.readString(Path.of("..", "..", "docs",
                "contracts", "v2", "examples", "flow-artifact.valid.artifact.json")));
        ObjectNode deployment = FlowDeployment.deploymentSet(MAPPER, TENANT, SITE, DEVICE,
                Instant.now(), List.of(artifact));

        FlowDeploymentPublisher publisher = new FlowDeploymentPublisher(brokerUrl(), "", "");
        assertThat(publisher.publishDeployment(TENANT, SITE, DEVICE,
                deployment.toString().getBytes(StandardCharsets.UTF_8))).isTrue();

        // A device connecting AFTER the publish converges from retention.
        JsonNode received = MAPPER.readTree(awaitRetained(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE)));
        assertThat(received.path("kind").asText()).isEqualTo("deployment");
        assertThat(received.path("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(received.path("artifacts").size()).isEqualTo(1);
        assertThat(received.path("artifacts").get(0).path("content_hash").asText())
                .isEqualTo(artifact.path("content_hash").asText());

        // Clearing empties the retained slot: a fresh subscriber gets nothing.
        assertThat(publisher.clearDeployment(TENANT, SITE, DEVICE)).isTrue();
        assertThat(awaitRetainedOrNull(
                FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE), 2000)).isNull();
    }

    private String awaitRetained(String topic) throws Exception {
        String payload = awaitRetainedOrNull(topic, 10000);
        assertThat(payload).as("retained payload on " + topic).isNotNull();
        return payload;
    }

    private String awaitRetainedOrNull(String topic, long timeoutMs) throws Exception {
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
            latch.await(timeoutMs, TimeUnit.MILLISECONDS);
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
