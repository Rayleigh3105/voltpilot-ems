package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.annotation.PreDestroy;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
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
 * Pushes a MANUAL consumer override to the edge (Inkrement 5 / §11 + §14.13). It
 * publishes a NON-RETAINED desired envelope on {@code ems/{t}/{s}/{d}/v2/desired}
 * (the v2/# ACL subtree, no broker change); the edge forwards it to the local
 * bus desired path where the arbiter clamps + enforces the bounded TTL. The
 * override rides the EXISTING desired-override way exactly (Source local-ui,
 * class flow, override - above the market plan, below contract/grid/safety);
 * Deckel/TTL are the arbiter's, unchanged.
 *
 * <p>NON-retained is load-bearing (§16): a manual override must never be
 * revived as an immortal retained wish. "Automatik fortsetzen" publishes a
 * withdrawal envelope ({@code withdraw:true}) so the plan/automation re-takes at
 * once, without waiting out the TTL.
 *
 * <p>Best-effort by design (like {@link com.voltpilot.api.provisioning.ProvisioningPublisher}):
 * a publish failure is logged, never thrown - the override record + audit stand,
 * and the SERVICE reports honestly whether the push went out. Disabled unless
 * the provisioning broker is configured; both composes enable it.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ConsumerOverridePublisher {

    private static final Logger log = LoggerFactory.getLogger(ConsumerOverridePublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public ConsumerOverridePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    private static String topic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/desired";
    }

    /**
     * Publish the manual override desired. {@code onOff} XOR {@code setpointKw}
     * (a start's command); a stop passes {@code onOff=false}. Returns whether the
     * publish went out.
     */
    public boolean publishOverride(UUID tenantId, UUID siteId, UUID deviceId, UUID entityId,
            Boolean onOff, BigDecimal setpointKw, int ttlSeconds, Instant now) {
        ObjectNode env = mapper.createObjectNode();
        env.put("schema_version", "1.0");
        env.put("entity_id", entityId.toString());
        env.put("request_id", "override:" + entityId + ":" + now.getEpochSecond());
        ObjectNode source = env.putObject("source");
        source.put("kind", "local-ui");
        env.put("priority", "flow");
        env.put("override", true);
        env.put("ttl_s", ttlSeconds);
        env.put("issued_at", now.toString());
        ObjectNode command = env.putObject("command");
        if (setpointKw != null) {
            command.put("type", "setpoint_kw");
            command.put("value", setpointKw);
        } else {
            command.put("type", "on_off");
            command.put("value", onOff != null && onOff);
        }
        return publish(tenantId, siteId, deviceId, env.toString(), entityId);
    }

    /** Publish the withdrawal so the plan/automation re-takes at once ("Automatik fortsetzen"). */
    public boolean publishWithdraw(UUID tenantId, UUID siteId, UUID deviceId, UUID entityId) {
        ObjectNode env = mapper.createObjectNode();
        env.put("entity_id", entityId.toString());
        env.put("withdraw", true);
        return publish(tenantId, siteId, deviceId, env.toString(), entityId);
    }

    private boolean publish(UUID tenantId, UUID siteId, UUID deviceId, String payload,
            UUID entityId) {
        try {
            synchronized (lock) {
                connected().publish(topic(tenantId, siteId, deviceId),
                        payload.getBytes(StandardCharsets.UTF_8), 1, false);
            }
            return true;
        } catch (Exception e) {
            log.warn("Could not publish consumer override for entity {} (device {}): {}", entityId,
                    deviceId, e.getMessage());
            return false;
        }
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-override-" + UUID.randomUUID(),
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

    @PreDestroy
    public void close() {
        synchronized (lock) {
            if (client == null) {
                return;
            }
            try {
                if (client.isConnected()) {
                    client.disconnect();
                }
                client.close(true);
            } catch (Exception e) {
                log.debug("override publisher close failed: {}", e.getMessage());
            }
            client = null;
        }
    }
}
