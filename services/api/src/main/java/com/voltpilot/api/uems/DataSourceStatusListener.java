package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.DeviceDataSourceStatusRepository.Meldung;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
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
 * Records every valid status-heartbeat arrival for box liveness and ingests the
 * additive {@code data_sources[]} block into the UEMS sink. Old boxes omit the
 * block: their arrival is still recorded, while source callers derive the
 * explicit legacy state „Box meldet noch nicht je Quelle“. Topic and payload
 * identity are checked like in all sibling status listeners.
 *
 * <p>Replica-singleton assumption: like the sibling listeners, this uses one independent MQTT
 * client and relies on the current production topology having exactly one API replica. More API
 * replicas require a shared subscription or leader election before being enabled.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.uems.data-source-status.mqtt-listener-enabled",
        havingValue = "true", matchIfMissing = true)
public class DataSourceStatusListener {

    private static final Logger log = LoggerFactory.getLogger(DataSourceStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    private static final int MAX_ENTRIES = 128;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final DeviceDataSourceStatusRepository statuses;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public DataSourceStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DeviceDataSourceStatusRepository statuses) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.statuses = statuses;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Data-source-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-data-sources-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Data-source-status listener subscribed to {} at {}", STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Data-source-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override public void connectionLost(Throwable cause) {
                    log.warn("Data-source-status listener lost the broker connection: {} (auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }
                @Override public void messageArrived(String topic, MqttMessage message) {}
                @Override public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {}
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
                log.warn("Data source status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Test-visible parser for one old or new heartbeat fixture. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return;
        }
        if (json == null || !json.isObject()) {
            return;
        }
        String[] parts = topic.split("/");
        if (parts.length != 5 || !"ems".equals(parts[0]) || !"status".equals(parts[4])) {
            return;
        }
        UUID tenantId = uuid(parts[1]);
        UUID siteId = uuid(parts[2]);
        UUID deviceId = uuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null
                || !tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            return;
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                return;
            }
            devices.markStatusSeen(deviceId);
            JsonNode block = json.get("data_sources");
            if (block == null || !block.isArray()) {
                return;
            }
            Instant reportedAt = instant(json.get("ts"));
            if (reportedAt == null) {
                reportedAt = Instant.now();
            }
            List<Meldung> rows = parse(block);
            statuses.replaceForDevice(deviceId, tenantId, reportedAt, rows);
        } finally {
            TenantContext.clear();
        }
    }

    private static List<Meldung> parse(JsonNode block) {
        List<Meldung> rows = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode entry : block) {
            if (rows.size() >= MAX_ENTRIES) {
                break;
            }
            String id = entry.path("id").asText("");
            String health = entry.path("health").asText("");
            Instant since = instant(entry.get("since"));
            if (!id.matches("[A-Z0-9./-]{2,16}") || !seen.add(id)
                    || !("ok".equals(health) || "stale".equals(health) || "never".equals(health))
                    || (!"ok".equals(health) && since == null)) {
                continue;
            }
            String error = "ok".equals(health) ? null
                    : DatenquelleRegeln.fehlerklasse(entry.path("error_class").asText(null),
                            DatenquelleRegeln.Herkunft.BOX).map(DatenquelleRegeln.Fehlerklasse::code).orElse(null);
            rows.add(new Meldung(id, health, error, "ok".equals(health) ? null : since,
                    instant(entry.get("read_at")), nonNegative(entry.get("requests_per_min")),
                    nonNegative(entry.get("samples_per_min"))));
        }
        return List.copyOf(rows);
    }

    private static Double nonNegative(JsonNode node) {
        if (node == null || !node.isNumber()) {
            return null;
        }
        double value = node.asDouble();
        return Double.isFinite(value) && value >= 0 ? value : null;
    }

    private static Instant instant(JsonNode node) {
        if (node == null || !node.isTextual() || node.asText().isBlank()) {
            return null;
        }
        try {
            return Instant.parse(node.asText());
        } catch (Exception e) {
            return null;
        }
    }

    private static UUID uuid(String raw) {
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
                log.debug("Data-source-status listener disconnect failed: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Data-source-status listener close failed: {}", e.getMessage());
            }
            client = null;
        }
    }
}
