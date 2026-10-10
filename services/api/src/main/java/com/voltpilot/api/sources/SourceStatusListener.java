package com.voltpilot.api.sources;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.DeviceSourceStatusRepository;
import com.voltpilot.api.repo.DeviceSourceStatusRepository.SourceRow;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
 * Ingests the additive {@code sources} block from the device status heartbeat
 * (ems/{t}/{s}/{d}/status) into {@code device_source_status}: the primary
 * inverter plus every configured measurement point with its OWN latest reading
 * and freshness. It is what makes a multi-inverter site's composite PV
 * explainable in the portal ("39,0 kW = Deye 8,3 + Fronius 21,3 + …") - before
 * this the parts were visible only on the device's own :8484 page.
 *
 * <p>A sibling of {@link com.voltpilot.api.control.ControlStatusListener} on the
 * SAME topic filter with the same authorization posture: broker ACL + mTLS-CN
 * identity, topic identity re-validated against the payload, the device
 * resolved through the RLS repository under the topic tenant. Display-only -
 * nothing here touches telemetry, rollups or the optimizer.
 *
 * <p>Off by default so unit tests and broker-less deployments are unaffected;
 * both composes turn it on next to the control listener.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.sources.mqtt-listener-enabled", havingValue = "true")
public class SourceStatusListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(SourceStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /** Same bound as the edge's own cap - a heartbeat can never inflate the set. */
    private static final int MAX_ENTRIES = 16;
    /**
     * Der Namensraum der Kanäle einer per CAN gekoppelten Batterie (P4) und ihr
     * Deckel. Das Präfix IST die ganze Vokabel-Regel: jeder Kanal, den die Box
     * aus dem BMS-Block dekodiert, heißt {@code bms_<sache>}, also kann durch
     * diese Tür kein fremdes Feld hereinkommen; der Deckel spiegelt den der Box
     * (maxBmsChannels), damit ein fehlgeleiteter Herzschlag nichts aufblähen
     * kann.
     */
    private static final String BMS_PREFIX = "bms_";

    private static final int MAX_BMS_CHANNELS = 24;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final DeviceSourceStatusRepository sourceStatus;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public SourceStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DeviceSourceStatusRepository sourceStatus) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.sourceStatus = sourceStatus;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Source-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-sources-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Source-status listener subscribed to {} at {}", STATUS_FILTER,
                                serverUri);
                    } catch (Exception e) {
                        log.warn("Source-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Source-status listener lost the broker connection: {} (auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
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
                log.warn("Source status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one heartbeat's sources block. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode sources = json == null ? null : json.get("sources");
        if (sources == null || !sources.isObject()) {
            return; // a heartbeat without a sources block
        }
        JsonNode entries = sources.get("entries");
        if (entries == null || !entries.isArray()) {
            return;
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            return;
        }
        // Topic identity must equal payload identity (a device reports only its
        // OWN measurement points - the ingest/control-listener rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("source status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        Instant reportedAt = optInstant(sources, "reported_at");
        if (reportedAt == null) {
            reportedAt = Instant.now();
        }
        List<SourceRow> rows = new ArrayList<>();
        for (JsonNode e : entries) {
            if (rows.size() >= MAX_ENTRIES) {
                break;
            }
            String id = e.path("id").asText("");
            if (id.isBlank()) {
                continue;
            }
            rows.add(new SourceRow(id, e.path("kind").asText("source"), textOrNull(e, "role"),
                    textOrNull(e, "label"), textOrNull(e, "brand"), textOrNull(e, "model"),
                    optDouble(e, "pv_kw"), optDouble(e, "power_kw"), optDouble(e, "load_kw"),
                    health(e), optInstant(e, "read_at"), bms(e)));
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("source status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            sourceStatus.replaceForDevice(deviceId, tenantId, siteId, reportedAt, rows);
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Der {@code bms}-Block eines Eintrags (P4): die Kanäle einer per CAN
     * gekoppelten Batterie, die der Wechselrichter selbst meldet.
     *
     * <p>Eine WEISSE LISTE, kein Durchreichen: nur Schlüssel mit dem Präfix
     * {@code bms_} (und nie das nackte Präfix), nur endliche Zahlen, gedeckelt.
     * {@code null}, wenn nichts gekoppelt ist - das ist der Normalfall und
     * bedeutet ABWESENHEIT, nie „0 %".
     */
    private static Map<String, Double> bms(JsonNode entry) {
        JsonNode node = entry.get("bms");
        if (node == null || !node.isObject()) {
            return null;
        }
        Map<String, Double> out = new LinkedHashMap<>();
        Iterator<Map.Entry<String, JsonNode>> it = node.fields();
        while (it.hasNext() && out.size() < MAX_BMS_CHANNELS) {
            Map.Entry<String, JsonNode> f = it.next();
            String key = f.getKey();
            if (!key.startsWith(BMS_PREFIX) || key.length() == BMS_PREFIX.length()) {
                continue;
            }
            JsonNode v = f.getValue();
            if (v == null || !v.isNumber()) {
                continue;
            }
            double d = v.asDouble();
            if (!Double.isFinite(d)) {
                continue;
            }
            out.put(key, d);
        }
        return out.isEmpty() ? null : out;
    }

    /** ok | stale | never; an unknown/absent value degrades to "never". */
    private static String health(JsonNode entry) {
        String h = entry.path("health").asText("");
        return switch (h) {
            case "ok", "stale", "never" -> h;
            default -> "never";
        };
    }

    private static String textOrNull(JsonNode node, String field) {
        String v = node.path(field).asText("");
        return v.isBlank() ? null : v;
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isNumber()) ? null : v.asDouble();
    }

    private static Instant optInstant(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull() || v.asText().isBlank()) {
            return null;
        }
        try {
            return Instant.parse(v.asText());
        } catch (Exception e) {
            return null;
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
                log.debug("Source listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Source listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
