package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
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
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Authenticated, identity-bound apply acknowledgement consumer. */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class MeasurementConfigStatusListener {
    private static final Logger log = LoggerFactory.getLogger(MeasurementConfigStatusListener.class);
    private static final String FILTER = "ems/+/+/+/v2/measurement-config-status";
    private static final Pattern POINT_KEY = Pattern.compile("^[a-z0-9][a-z0-9._*\\[\\]@-]{0,239}$");
    private static final Set<String> ROOT_FIELDS = Set.of("schema_version", "tenant_id", "site_id",
            "device_id", "revision", "applied_at", "accepted", "rejected", "edge_version");
    private static final Set<String> REJECTION_FIELDS = Set.of("point_key", "reason");
    // The CLOSED rejection vocabulary of mqtt-measurement-config-status. An
    // unknown word invalidates the WHOLE acknowledgement (see the loop below),
    // so a reason the edge starts sending must land here in the same release -
    // otherwise every point of that device stays pending_edge forever.
    // `binding_unavailable` is Geraeteseite Stufe 3c: the edge could not resolve
    // the selection's component (entity_id) to a device it reads and therefore
    // refused the point instead of reading it over the primary inverter.
    static final Set<String> REASONS = Set.of("unknown_point", "unsupported_catalog",
            "edge_too_old", "invalid_cadence", "budget_samples", "budget_requests",
            "budget_duty_cycle", "driver_unavailable", "ocpp_configuration_incompatible",
            "binding_unavailable");

    private final String brokerUrl, username, password;
    private final MeasurementSelectionRepository repository;
    private final ObjectMapper mapper;
    private MqttClient client;

    public MeasurementConfigStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            MeasurementSelectionRepository repository, ObjectMapper mapper) {
        this.brokerUrl = brokerUrl; this.username = username; this.password = password;
        this.repository = repository; this.mapper = mapper;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Initial broker outages are retried; a failed half-created client never wedges startup. */
    @Scheduled(fixedDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}",
            initialDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}")
    public synchronized void ensureConnected() {
        if (client != null && client.isConnected()) return;
        try {
            connect();
        } catch (Exception e) {
            log.warn("measurement status listener awaits broker: {}", e.getMessage());
            discardClient();
        }
    }

    private void connect() throws Exception {
        discardClient();
        client = new MqttClient(brokerUrl, "voltpilot-api-measurement-status",
                new MemoryPersistence());
        client.setCallback(new MqttCallbackExtended() {
            @Override public void connectComplete(boolean reconnect, String uri) {
                try { client.subscribe(FILTER, 1, listener()); }
                catch (Exception e) { log.warn("measurement status subscribe failed: {}", e.getMessage()); }
            }
            @Override public void connectionLost(Throwable cause) { }
            @Override public void messageArrived(String topic, MqttMessage message) { }
            @Override public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken t) { }
        });
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(false); options.setAutomaticReconnect(true); options.setConnectionTimeout(5);
        if (username != null && !username.isBlank()) {
            options.setUserName(username); options.setPassword(password == null ? new char[0] : password.toCharArray());
        }
        client.connect(options);
        client.subscribe(FILTER, 1, listener());
    }

    private void discardClient() {
        if (client == null) return;
        try { if (client.isConnected()) client.disconnect(); client.close(); }
        catch (Exception ignored) { }
        client = null;
    }

    boolean connectedForTest() { return client != null && client.isConnected(); }

    private IMqttMessageListener listener() {
        return (topic, message) -> {
            try { handle(topic, message.getPayload()); }
            catch (Exception e) { log.warn("measurement status on {} rejected: {}", topic, e.getMessage()); }
        };
    }

    /** Test-visible strict validator and monotone state transition. */
    public boolean handle(String topic, byte[] payload) {
        try {
            String[] p = topic == null ? new String[0] : topic.split("/");
            if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4])
                    || !"measurement-config-status".equals(p[5])) return false;
            UUID tenant = UUID.fromString(p[1]), site = UUID.fromString(p[2]), device = UUID.fromString(p[3]);
            JsonNode root = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .readTree(payload);
            if (root == null || !root.isObject() || !onlyFields(root, ROOT_FIELDS)
                    || !"2.0".equals(root.path("schema_version").asText())
                    || !p[1].equals(root.path("tenant_id").asText())
                    || !p[2].equals(root.path("site_id").asText())
                    || !p[3].equals(root.path("device_id").asText())) return false;
            if (!root.path("revision").isIntegralNumber()) return false;
            long revision = root.path("revision").asLong(0);
            Instant appliedAt = Instant.parse(root.path("applied_at").asText());
            String edgeVersion = root.path("edge_version").asText("");
            if (revision < 1 || edgeVersion.isBlank() || edgeVersion.length() > 128) return false;
            Set<String> accepted = new LinkedHashSet<>();
            if (!root.path("accepted").isArray() || !root.path("rejected").isArray()) return false;
            if (root.path("accepted").size() + root.path("rejected").size() > 2301) return false;
            for (JsonNode n : root.path("accepted")) {
                if (!n.isTextual() || !POINT_KEY.matcher(n.asText()).matches()
                        || !accepted.add(n.asText())) return false;
            }
            Map<String, String> rejected = new LinkedHashMap<>();
            for (JsonNode n : root.path("rejected")) {
                if (!n.isObject() || !onlyFields(n, REJECTION_FIELDS)) return false;
                String point = n.path("point_key").asText("");
                String reason = n.path("reason").asText("");
                if (!POINT_KEY.matcher(point).matches() || !REASONS.contains(reason)
                        || accepted.contains(point)
                        || rejected.put(point, reason) != null) return false;
            }
            TenantContext.set(tenant);
            try {
                var scope = repository.aktiverDeviceScope(device);
                if (scope == null || !site.equals(scope.siteId())
                        || revision > repository.revision(device)
                        || revision < repository.acknowledgedRevision(device)) {
                    return false;
                }
                repository.applyAcknowledgement(device, revision, appliedAt, accepted, rejected, edgeVersion);
                return true;
            } finally { TenantContext.clear(); }
        } catch (Exception e) {
            log.debug("invalid measurement status: {}", e.getMessage());
            return false;
        }
    }

    private static boolean onlyFields(JsonNode node, Set<String> allowed) {
        var names = node.fieldNames();
        while (names.hasNext()) if (!allowed.contains(names.next())) return false;
        return true;
    }

    @PreDestroy synchronized void close() { discardClient(); }
}
