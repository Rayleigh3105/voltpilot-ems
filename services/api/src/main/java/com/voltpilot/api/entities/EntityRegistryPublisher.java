package com.voltpilot.api.entities;

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
 * Publishes the v2 entity registry to a device as ONE retained message on
 * {@code ems/{t}/{s}/{d}/v2/entities} (contract:
 * docs/contracts/v2/edge-entity-config.md §1 - the inverter-config pattern
 * lifted onto the cloud link). Retention makes the next (re)connect converge;
 * an empty payload clears the slot (device unclaimed).
 *
 * <p>BEST-EFFORT by design, exactly like {@link
 * com.voltpilot.api.provisioning.ProvisioningPublisher}: a broker outage never
 * fails a registry write - the admin re-pushes (or the next bootstrap does).
 * Rides the same broker capability/flag as provisioning
 * ({@code voltpilot.provisioning.*}), so no new deployment knob.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class EntityRegistryPublisher {

    private static final Logger log = LoggerFactory.getLogger(EntityRegistryPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public EntityRegistryPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** The retained registry topic of one device (the reserved v2 sibling). */
    public static String entitiesTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/entities";
    }

    /**
     * Publish the registry push payload retained (QoS1). Returns whether the
     * publish went out; failure is logged, never thrown.
     */
    public synchronized boolean publishRegistry(UUID tenantId, UUID siteId, UUID deviceId,
            byte[] payload) {
        String topic = entitiesTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic, message);
            log.info("published v2 entity registry ({} bytes) retained to {}", payload.length, topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish v2 entity registry to {}: {} (best-effort - "
                    + "re-push via the admin endpoint once the broker is reachable)",
                    topic, e.getMessage());
            return false;
        }
    }

    /** Clear the retained registry slot of a device (unclaim/offboard cleanup). */
    public synchronized boolean clearRegistry(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = entitiesTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage("".getBytes(StandardCharsets.UTF_8));
            empty.setQos(1);
            empty.setRetained(true);
            connected().publish(topic, empty);
            return true;
        } catch (Exception e) {
            log.warn("could not clear v2 entity registry on {}: {}", topic, e.getMessage());
            return false;
        }
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-entities-" + UUID.randomUUID(),
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
                log.debug("closing entity registry publisher: {}", e.getMessage());
            }
        }
    }
}
