package com.voltpilot.api.purge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BelegeImWeg;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.IMqttMessageListener;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Device-initiated data purge: the edge publishes a {@code purge_request} on
 * its own {@code ems/{t}/{s}/{d}/status} topic (contract:
 * docs/contracts/mqtt-data-purge.schema.json) and this listener runs the exact
 * same {@link DevicePurgeService} the portal endpoint uses.
 *
 * <p><b>Why the status topic is a legitimate authorization channel:</b> on the
 * hardened broker the per-device ACL only lets a device publish on its OWN
 * topic path, and its identity comes from the mTLS certificate CN - so a
 * message arriving on this topic path IS the authenticated device, and a
 * device may always delete its own recordings. Defense in depth on top: the
 * payload identity must equal the topic identity (like the ingest validator),
 * and the device row is resolved through the RLS-scoped repository with the
 * topic's tenant - a fabricated tenant/site/device combination resolves to
 * zero rows and is skipped.
 *
 * <p>Malformed or unknown messages are logged and skipped, never crash the
 * stream (the topic also carries the regular status heartbeats, which have no
 * {@code type} field and are ignored cheaply). Off by default so unit tests
 * and broker-less deployments are unaffected; compose turns it on.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.purge.mqtt-listener-enabled", havingValue = "true")
public class PurgeRequestListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(PurgeRequestListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final DevicePurgeService purgeService;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public PurgeRequestListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DevicePurgeService purgeService) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.purgeService = purgeService;
    }

    /** Connect once the context is up (never blocks or fails startup). */
    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            // automaticReconnect keeps retrying in the background; the feature
            // degrades to "device purge waits for broker connectivity".
            log.warn("Purge-request listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-purge-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Purge-request listener subscribed to {} at {}", STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Purge-request subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Purge-request listener lost the broker connection: {} (auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
                    // Handled by the per-subscription listener.
                }

                @Override
                public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {
                }
            });
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
    }

    private IMqttMessageListener messageListener() {
        return (topic, message) -> {
            try {
                handle(topic, message.getPayload());
            } catch (Exception e) {
                // Log + skip, never crash the stream (ingest convention).
                log.warn("Purge request on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        if (json == null || !"purge_request".equals(json.path("type").asText())) {
            return; // a regular status heartbeat
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("purge_request on non-UUID topic '{}' skipped", topic);
            return;
        }
        // Topic identity must equal payload identity (a device may not request
        // a purge for another device's data - mirrors the ingest validator).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("purge_request payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        // Resolve the device through the RLS-scoped repository with the topic's
        // tenant: a mismatched tenant/site/device yields zero rows.
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("purge_request for unknown device {} (tenant {}) skipped", deviceId, tenantId);
                return;
            }
            DevicePurgeService.Result r = purgeService.purge(device.get());
            log.info("Device-initiated purge completed for device {} ({} rows)", deviceId, r.purgedRows());
        } catch (BelegeImWeg e) {
            // UEMS AP-07 E8: the box's series are Belege of Messstellen - refused like the
            // portal path, nothing written. The contract has no "refused" answer, so the box
            // keeps its intent and asks again on its next connect (known, see IP-11 notes).
            log.warn("Device-initiated purge for device {} (tenant {}) refused: {}", deviceId, tenantId,
                    e.getMessage());
        } finally {
            TenantContext.clear();
        }
    }

    private static UUID parseUuid(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
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
            } catch (Exception e) {
                log.debug("Purge listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Purge listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
