package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.EdgeVersionRepository;
import com.voltpilot.api.repo.FlowStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.IMqttMessageListener;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * The FOURTH sibling on {@code ems/+/+/+/status} (next to the control, entity
 * and source listeners), Portal v3 M5: it ingests what the DEVICE says about
 * the flows it runs.
 *
 * <p>Two blocks, both display-only:
 * <ul>
 *   <li>{@code flows} - the EXISTING flow-deployment ack (flow_id,
 *       flow_version, content_hash, state active|error|unsupported). This is
 *       what lets the editor open the version that is REALLY running
 *       ("Läuft auf dem Gerät · v4") instead of the one the cloud activated.
 *       Since the Admin-Umbau (Stufe 1) the SAME block's {@code core_version} /
 *       {@code palette_version} are persisted too - see below.</li>
 *   <li>{@code flow_node_status} - the NEW, feature-flagged per-node state
 *       ("erfüllt", "EIN seit 14:02"). An edge without the flag simply does not
 *       send it and the editor falls back to channel values only; it NEVER
 *       guesses a node state.</li>
 * </ul>
 *
 * <p><b>Der Edge-Stand reitet im {@code flows}-Block mit, deshalb wird er HIER
 * gelesen und nicht von einem fünften Geschwister.</b> Die Curtailment-Regel
 * ("zwei unabhängige Blöcke, zwei Listener") greift genau nicht: {@code
 * core_version}/{@code palette_version} sind FELDER dieses Blocks, den dieser
 * Listener ohnehin parst - ein eigener Listener wäre eine zweite
 * Broker-Verbindung und eine zweite Identitätsprüfung für dieselben Bytes.
 * Zwei Grenzen, die man kennen muss: der Ingest hängt am Flag dieses Listeners
 * ({@code voltpilot.flows.mqtt-listener-enabled}, in beiden Composes an), und
 * die Edge baut den {@code flows}-Block erst, wenn sie je einen
 * Deployment-Satz gesehen hat - ein Gerät ohne ausgerollte Automation meldet
 * also keine Version, und die Oberfläche sagt dann ehrlich „unbekannt".
 *
 * <p>Authorization is the same posture as its siblings: the broker ACL + the
 * mTLS cert CN make a message on {@code ems/{t}/{s}/{d}/status} the
 * authenticated device, the topic identity is re-validated against the payload
 * identity, and the device is resolved through the RLS-scoped repository under
 * the topic's tenant, so a fabricated identity yields zero rows and is skipped.
 *
 * <p>Off by default; both composes turn it on next to the other listeners.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.flows.mqtt-listener-enabled", havingValue = "true")
public class FlowNodeStatusListener {

    private static final Logger log = LoggerFactory.getLogger(FlowNodeStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /** Bounded like the heartbeat blocks themselves - a device cannot flood us. */
    private static final int MAX_ACKS = 64;
    private static final int MAX_NODE_STATUSES = 512;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final FlowStatusRepository flowStatus;
    private final EdgeVersionRepository edgeVersions;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public FlowNodeStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, FlowStatusRepository flowStatus,
            EdgeVersionRepository edgeVersions) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.flowStatus = flowStatus;
        this.edgeVersions = edgeVersions;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Flow-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-flowstatus-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Flow-status listener subscribed to {} at {}", STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Flow-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Flow-status listener lost the broker connection: {} (auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, org.eclipse.paho.client.mqttv3.MqttMessage m) {
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
                log.warn("Flow status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Test-visible: parse one status heartbeat's flow blocks. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        if (json == null) {
            return;
        }
        JsonNode flows = json.get("flows");
        JsonNode nodeStatus = json.get("flow_node_status");
        boolean hasFlows = flows != null && flows.isObject();
        boolean hasNodes = nodeStatus != null && nodeStatus.isObject();
        if (!hasFlows && !hasNodes) {
            return; // a heartbeat without either block
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("flow status on non-UUID topic '{}' skipped", topic);
            return;
        }
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("flow status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        Instant reportedAt = optInstant(json, "ts");
        if (reportedAt == null) {
            reportedAt = Instant.now();
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("flow status for unknown device {} (tenant {}) skipped", deviceId, tenantId);
                return;
            }
            if (hasFlows) {
                flowStatus.replaceAcks(deviceId, siteId, parseAcks(flows.get("applied")), reportedAt);
                recordEdgeVersion(deviceId, siteId, flows, reportedAt);
            }
            if (hasNodes) {
                flowStatus.replaceNodeStatuses(deviceId, siteId,
                        parseNodeStatuses(nodeStatus.get("nodes")), reportedAt);
            }
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Den gemeldeten Edge-Stand festhalten (Admin-Umbau Stufe 1). Die zwei
     * Felder sind einzeln optional - die Edge lässt ein leeres weg (die
     * Palette-Version fehlt z. B., solange Node-REDs Admin-API nicht
     * konfiguriert ist). Trägt der Block KEINES von beiden, wird gar nichts
     * geschrieben: eine Zeile mit zwei NULLs behauptete „gemeldet, aber
     * unbekannt", und das wäre eine Aussage, die niemand gemessen hat.
     */
    private void recordEdgeVersion(UUID deviceId, UUID siteId, JsonNode flows, Instant reportedAt) {
        String core = blankToNull(flows.path("core_version").asText(""));
        String palette = blankToNull(flows.path("palette_version").asText(""));
        if (core == null && palette == null) {
            return;
        }
        edgeVersions.record(deviceId, siteId, core, palette, reportedAt);
    }

    private List<FlowStatusRepository.Ack> parseAcks(JsonNode applied) {
        List<FlowStatusRepository.Ack> out = new ArrayList<>();
        if (applied == null || !applied.isArray()) {
            return out;
        }
        for (JsonNode a : applied) {
            if (out.size() >= MAX_ACKS) {
                break;
            }
            UUID flowId = parseUuid(a.path("flow_id").asText(""));
            int version = a.path("flow_version").asInt(0);
            String state = a.path("state").asText("");
            if (flowId == null || version < 1 || state.isBlank()) {
                continue;
            }
            out.add(new FlowStatusRepository.Ack(flowId, version,
                    blankToNull(a.path("content_hash").asText("")), state,
                    blankToNull(a.path("detail").asText("")), Instant.now()));
        }
        return out;
    }

    private List<FlowStatusRepository.NodeStatus> parseNodeStatuses(JsonNode nodes) {
        List<FlowStatusRepository.NodeStatus> out = new ArrayList<>();
        if (nodes == null || !nodes.isArray()) {
            return out;
        }
        for (JsonNode n : nodes) {
            if (out.size() >= MAX_NODE_STATUSES) {
                break;
            }
            UUID flowId = parseUuid(n.path("flow_id").asText(""));
            String nodeId = n.path("node_id").asText("");
            String state = n.path("state").asText("");
            if (flowId == null || nodeId.isBlank() || state.isBlank()) {
                continue;
            }
            out.add(new FlowStatusRepository.NodeStatus(flowId, nodeId, state,
                    blankToNull(n.path("text").asText("")), optInstant(n, "since"), Instant.now()));
        }
        return out;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }

    private static Instant optInstant(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
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
        } catch (IllegalArgumentException | NullPointerException e) {
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
                log.debug("Flow-status listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Flow-status listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
