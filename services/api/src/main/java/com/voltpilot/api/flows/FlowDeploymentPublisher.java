package com.voltpilot.api.flows;

import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Publishes the flow deployment set to a device as ONE retained QoS1 message
 * on {@code ems/{t}/{s}/{d}/v2/flows} (flow-artifact contract §3, D-11 - the
 * proven retained-config self-wiring pattern; the topic lives in the same
 * per-device {@code v2/#} ACL subtree as the plan and the entity registry).
 *
 * <p>BEST-EFFORT exactly like {@link
 * com.voltpilot.api.entities.EntityRegistryPublisher}: a broker outage never
 * fails an activation write - re-activation (or clearing) re-publishes. Rides
 * the {@code voltpilot.provisioning.*} broker capability, no new deploy knob.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class FlowDeploymentPublisher {

    private static final Logger log = LoggerFactory.getLogger(FlowDeploymentPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public FlowDeploymentPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** The retained deployment topic of one device (contract x-topic). */
    public static String flowsTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/flows";
    }

    /**
     * Publish the deployment set retained (QoS1). Returns whether the publish
     * went out; failure is logged, never thrown.
     */
    public synchronized boolean publishDeployment(UUID tenantId, UUID siteId, UUID deviceId,
            byte[] payload) {
        String topic = flowsTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic, message);
            log.info("published flow deployment set ({} bytes) retained to {}", payload.length,
                    topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish flow deployment to {}: {} (best-effort - re-activate "
                    + "once the broker is reachable)", topic, e.getMessage());
            return false;
        }
    }

    /** Clear the retained deployment slot (device unclaimed / all flows retired). */
    public synchronized boolean clearDeployment(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = flowsTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage("".getBytes(StandardCharsets.UTF_8));
            empty.setQos(1);
            empty.setRetained(true);
            connected().publish(topic, empty);
            return true;
        } catch (Exception e) {
            log.warn("could not clear flow deployment on {}: {}", topic, e.getMessage());
            return false;
        }
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-flows-" + UUID.randomUUID(),
                    new MemoryPersistence());
        }
        if (!client.isConnected()) {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            options.setConnectionTimeout(5);
            options.setAutomaticReconnect(true);
            if (!username.isBlank()) {
                options.setUserName(username);
                options.setPassword(password.toCharArray());
            }
            client.connect(options);
        }
        return client;
    }

    @PreDestroy
    void close() {
        if (client != null) {
            try {
                if (client.isConnected()) {
                    client.disconnect();
                }
                client.close();
            } catch (Exception e) {
                log.debug("closing flow deployment publisher: {}", e.getMessage());
            }
        }
    }
}
