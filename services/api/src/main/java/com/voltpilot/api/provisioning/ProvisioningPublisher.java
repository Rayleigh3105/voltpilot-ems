package com.voltpilot.api.provisioning;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Cloud half of the zero-touch onboarding handshake at CLAIM time (contract:
 * docs/contracts/mqtt-provisioning.schema.json). When a customer claims a
 * device, this publishes the device's identity RETAINED to
 * {@code provision/{ref}/config}, so a device that booted before it was claimed
 * receives its configuration the moment the claim succeeds - without waiting
 * for its next hello retry (the ingest-side resolver answers those).
 *
 * <p><b>Best-effort by design.</b> Claiming must never fail because the broker
 * is down: a publish failure is logged and swallowed. The handshake still
 * converges through the device's periodic hello and the resolver in
 * services/ingest, which re-publishes the retained config on the next hello.
 *
 * <p>Disabled by default ({@code voltpilot.provisioning.enabled=false}) so unit
 * tests and broker-less deployments are unaffected; compose turns it on.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ProvisioningPublisher {

    private static final Logger log = LoggerFactory.getLogger(ProvisioningPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final Object lock = new Object();
    private MqttClient client;

    public ProvisioningPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /**
     * Publish the retained {@code provision/{ref}/config} for a freshly claimed
     * device. Never throws; returns whether the publish went out.
     */
    public boolean publishConfig(String externalRef, UUID tenantId, UUID siteId, UUID deviceId) {
        if (!ProvisioningTopics.isValidRef(externalRef)) {
            // A ref with topic metacharacters cannot take part in the handshake;
            // the claim itself is still valid (e.g. manually configured devices).
            log.info("Skipping provisioning publish for non-topic-safe ref '{}'", externalRef);
            return false;
        }
        String payload = configPayload(externalRef, tenantId, siteId, deviceId);
        try {
            synchronized (lock) {
                connected().publish(ProvisioningTopics.configTopic(externalRef),
                        payload.getBytes(StandardCharsets.UTF_8), 1, true);
            }
            log.info("Published retained provisioning config for ref '{}' (device {})", externalRef, deviceId);
            return true;
        } catch (Exception e) {
            log.warn("Could not publish provisioning config for ref '{}' (device {}): {} - "
                    + "the ingest resolver will answer the device's next hello instead",
                    externalRef, deviceId, e.getMessage());
            return false;
        }
    }

    /**
     * MQTT cleanup for an unclaimed (deleted) device: clear the retained
     * {@code provision/{ref}/config} - so the ref becomes claimable again
     * without a stale identity waiting on the broker - and the retained
     * schedule topic, so the physical device falls back to its watchdog
     * default instead of executing a plan for an owner that no longer exists.
     * Best-effort like {@link #publishConfig}: a broker outage must never
     * block the unclaim; a failure is logged for the operator.
     */
    public boolean clearRetained(String externalRef, UUID tenantId, UUID siteId, UUID deviceId) {
        if (!ProvisioningTopics.isValidRef(externalRef)) {
            return false;
        }
        try {
            synchronized (lock) {
                MqttClient c = connected();
                // An empty retained publish deletes the retained message (MQTT 3.1.1 §3.3.1.3).
                c.publish(ProvisioningTopics.configTopic(externalRef), new byte[0], 1, true);
                c.publish(ProvisioningTopics.scheduleTopic(tenantId, siteId, deviceId),
                        new byte[0], 1, true);
            }
            log.info("Cleared retained provisioning config + schedule for ref '{}' (device {})",
                    externalRef, deviceId);
            return true;
        } catch (Exception e) {
            log.warn("Could not clear retained MQTT state for ref '{}' (device {}): {}",
                    externalRef, deviceId, e.getMessage());
            return false;
        }
    }

    static String configPayload(String ref, UUID tenantId, UUID siteId, UUID deviceId) {
        // Shape per docs/contracts/mqtt-provisioning.schema.json ($defs/config).
        return "{\"schema_version\":\"1.0\",\"ref\":\"" + ref + "\",\"tenant_id\":\"" + tenantId
                + "\",\"site_id\":\"" + siteId + "\",\"device_id\":\"" + deviceId + "\"}";
    }

    private MqttClient connected() throws Exception {
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-provisioning-" + UUID.randomUUID(),
                    new MemoryPersistence());
        }
        if (!client.isConnected()) {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(true);
            options.setConnectionTimeout(5);
            options.setAutomaticReconnect(true);
            if (username != null && !username.isBlank()) {
                options.setUserName(username);
                options.setPassword(password == null ? new char[0] : password.toCharArray());
            }
            client.connect(options);
        }
        return client;
    }
}
