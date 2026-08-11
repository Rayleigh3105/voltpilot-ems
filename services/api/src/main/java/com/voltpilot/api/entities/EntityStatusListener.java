package com.voltpilot.api.entities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
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
 * Ingests the additive {@code entities} block from the device status heartbeat
 * (edge-entity-config.md §5, E1b bidirectional sync) into
 * {@code entity_observed_state}: the applied registry revision, per-entity
 * observed type/health/telemetry, and the edge-local commissioning view
 * ({@code local_setup} - the :8484 inverter/sources, stored with
 * source='local'). The cloud RECONCILES this Ist against its registry Soll
 * and surfaces drift in the portal; it never auto-imports or overwrites.
 *
 * <p>A sibling of {@link com.voltpilot.api.control.ControlStatusListener} on
 * the SAME topic filter with the same authorization posture (broker ACL +
 * mTLS-CN identity; topic==payload identity re-validated; device resolved
 * through the RLS repository under the topic tenant). Off by default; both
 * composes turn it on next to the control listener.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.entities.mqtt-listener-enabled", havingValue = "true")
public class EntityStatusListener {

    private static final Logger log = LoggerFactory.getLogger(EntityStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final EntityObservedRepository observed;
    private final com.voltpilot.api.components.ComponentApplyRepository componentApply;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public EntityStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, EntityObservedRepository observed,
            com.voltpilot.api.components.ComponentApplyRepository componentApply) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.observed = observed;
        this.componentApply = componentApply;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Entity-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-entities-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Entity-status listener subscribed to {} at {}", STATUS_FILTER,
                                serverUri);
                    } catch (Exception e) {
                        log.warn("Entity-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Entity-status listener lost the broker connection: {} (auto-reconnect active)",
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
                log.warn("Entity status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one heartbeat's entities block. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode entities = json == null ? null : json.get("entities");
        if (entities == null || !entities.isObject()) {
            return; // a heartbeat without an entities block
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
        // Topic identity must equal payload identity (a device reports only
        // its OWN entity state - the ingest/control-listener rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("entity status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        String revision = entities.path("revision").asText(null);
        Instant reportedAt = Instant.now();
        List<ObservedRow> rows = new ArrayList<>();
        JsonNode observedNode = entities.get("observed");
        if (observedNode != null && observedNode.isObject()) {
            for (Map.Entry<String, JsonNode> e : observedNode.properties()) {
                JsonNode o = e.getValue();
                rows.add(new ObservedRow(deviceId, e.getKey(), "registry",
                        o.path("entity_type").asText(null), o.path("health").asText(null), null,
                        optInstant(o, "last_telemetry_at"), revision,
                        arrayJson(o.get("channels")), reportedAt, null, null, null));
            }
        }
        JsonNode localSetup = entities.get("local_setup");
        if (localSetup != null && localSetup.isArray()) {
            for (JsonNode l : localSetup) {
                String id = l.path("id").asText("");
                if (id.isBlank()) {
                    continue;
                }
                // The label stays CLEAN (the operator-given name only); brand/
                // model/role travel in their own columns. The former localLabel
                // concatenation ("brand · model · label · role") leaked raw
                // catalog ids into every customer surface AND - via the adoption
                // dialogs' prefill - into persisted entity names (the Pilsting
                // ghost, scout vp-vier-erzeuger-p9).
                rows.add(new ObservedRow(deviceId, "local:" + id, "local",
                        l.path("kind").asText(null), null, textOrNull(l, "label"), null, revision,
                        null, reportedAt, textOrNull(l, "role"), textOrNull(l, "brand"),
                        textOrNull(l, "model")));
            }
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("entity status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            observed.replaceForDevice(deviceId, tenantId, siteId, reportedAt, rows);
            ingestComponentApply(entities.get("component_apply"), deviceId, tenantId, siteId,
                    reportedAt);
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Der Einheitsmodell-Stufe-1-Block: WELCHE Push-Revision die Box wirklich
     * angewandt hat, und was sie zuletzt NICHT anwenden konnte.
     *
     * <p><b>Abwesend heißt unbekannt.</b> Eine ältere Box sendet den Block gar
     * nicht - dann entsteht KEINE Zeile, und das Portal sagt „unbekannt" statt
     * „box-verwaltet" zu behaupten. Ein Wort außerhalb des Vokabulars wird
     * VERWORFEN statt gespeichert (die Regel des unbekannten Zustands, die
     * jeder Status-Zuhörer hier trägt).
     */
    private void ingestComponentApply(JsonNode block, UUID deviceId, UUID tenantId, UUID siteId,
            Instant reportedAt) {
        if (block == null || !block.isObject()) {
            return;
        }
        String authority = block.path("authority").asText("");
        if (!"portal".equals(authority) && !"box".equals(authority)) {
            log.warn("component_apply authority '{}' unknown - skipped", authority);
            return;
        }
        componentApply.upsert(deviceId, tenantId, siteId, authority,
                textOrNull(block, "revision"), optInstant(block, "applied_at"),
                textOrNull(block, "refused_revision"), textOrNull(block, "refused_reason"),
                reportedAt);
    }

    private static String textOrNull(JsonNode node, String field) {
        String v = node.path(field).asText("");
        return v.isBlank() ? null : v;
    }

    private String arrayJson(JsonNode node) {
        if (node == null || !node.isArray() || node.isEmpty()) {
            return null;
        }
        return node.toString();
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
                log.debug("Entity listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Entity listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
