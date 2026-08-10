package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
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
 * Ingests the additive {@code consumers} block from the device status
 * heartbeat (ems/{t}/{s}/{d}/status) into {@code consumer_runtime_status}:
 * per controllable consumer entity the edge runtime state
 * {@code {state, reason_code, actual_kw, confirmed, requirement_progress}}
 * (Verbrauchssteuerung Inkrement 3, D9/§15.1).
 *
 * <p><b>A SIBLING listener</b> (the Geschwister rule: a new heartbeat block
 * gets its OWN listener, never the early-return of an existing one extended) -
 * the seventh sibling on {@code ems/+/+/+/status} next to purge/control/
 * entities/sources/flow-node/curtailment/ota. Same authorization posture as
 * all of them: broker ACL + mTLS-CN identity, topic identity re-validated
 * against the payload, the device resolved through the RLS repository under
 * the topic tenant, the writes running under that tenant so RLS' WITH CHECK
 * stamps every row.
 *
 * <p>Honesty rules (D9): unknown STATE words drop the whole entity entry
 * (state is the row's spine); an unknown REASON word is dropped alone (the
 * word is discarded, never stored - the entry keeps its known state); a
 * reported entity id that is not one of the site's consumer entities is
 * discarded (a spoofed/foreign id never mints a row). The device's whole set
 * is REPLACED per heartbeat.
 *
 * <p>Off by default so unit tests and broker-less deployments are unaffected;
 * both composes turn it on next to its siblings.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.consumers.mqtt-listener-enabled", havingValue = "true")
public class ConsumerRuntimeStatusListener {

    private static final Logger log = LoggerFactory.getLogger(ConsumerRuntimeStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /** Sanity bound on reported entities per device (a site has a handful). */
    private static final int MAX_ENTITIES = 64;
    /** Sanity bounds on the per-day counters (a day has 86400 seconds). */
    private static final int MAX_RUNTIME_SECONDS = 2 * 86400;
    private static final int MAX_STARTS = 10000;

    /**
     * The §14.13 state vocabulary. The edge today claims a subset
     * (running_forced/running_optimized/waiting/clamped/offline); the full
     * customer set is whitelisted so a future edge can grow into it without a
     * cloud release - but a word OUTSIDE it is discarded, never stored.
     */
    static final Set<String> STATES = Set.of(
            "disconnected", "offline", "ready", "running_forced", "running_optimized",
            "waiting", "fulfilled", "clamped", "missed", "unknown");

    /**
     * The §15 reason vocabulary incl. the Inkrement-3 cycle-guard extension
     * and the Inkrement-6 deadline fallback ({@code flex_deadline_fallback}:
     * the DEVICE started the flexible task itself so the deadline holds -
     * without this word here the honest edge report would be discarded).
     */
    static final Set<String> REASONS = Set.of(
            "vehicle_connected", "fixed_window", "price_below_threshold",
            "soc_above_threshold", "flex_deadline", "flex_deadline_fallback",
            "optimizer_selected_low_cost",
            "consumer_first", "storage_first", "guard_rated_power", "guard_grid_limit",
            "device_offline", "readback_mismatch", "signal_stale",
            "guard_min_on", "guard_min_off", "guard_max_starts", "guard_ramp", "plan_stale");

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final ConsumerRuntimeStatusRepository store;
    private final ConsumerRequirementLedgerWriter ledger;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public ConsumerRuntimeStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, ConsumerRuntimeStatusRepository store,
            ConsumerRequirementLedgerWriter ledger) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.store = store;
        this.ledger = ledger;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Consumer-status listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-consumers-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Consumer-status listener subscribed to {} at {}",
                                STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Consumer-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Consumer-status listener lost the broker connection: {} "
                            + "(auto-reconnect active)", cause == null ? "unknown" : cause.getMessage());
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
                log.warn("Consumer status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one heartbeat's consumers block. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode consumers = json == null ? null : json.get("consumers");
        if (consumers == null || !consumers.isObject()) {
            return; // an older edge / a site without consumer entities
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("consumer status on non-UUID topic '{}' skipped", topic);
            return;
        }
        // Topic identity must equal payload identity (a device may not report
        // another device's consumers - the ingest/control rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("consumer status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        Instant reportedAt = reportedAt(json);
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("consumer status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            Set<UUID> known = store.consumerEntityIds(siteId);
            List<ConsumerRuntimeStatusRepository.Row> rows = new ArrayList<>();
            Iterator<Map.Entry<String, JsonNode>> it = consumers.fields();
            while (it.hasNext() && rows.size() < MAX_ENTITIES) {
                Map.Entry<String, JsonNode> entry = it.next();
                UUID entityId = parseUuid(entry.getKey());
                if (entityId == null || !known.contains(entityId)) {
                    log.debug("consumer status for unknown entity '{}' on site {} discarded",
                            entry.getKey(), siteId);
                    continue;
                }
                ConsumerRuntimeStatusRepository.Row row = parseEntry(entityId, entry.getValue());
                if (row != null) {
                    rows.add(row);
                }
            }
            // The device's whole set is replaced - also when every entry was
            // discarded (the device reported, and what it reported was not
            // storable; keeping stale rows would claim an older truth).
            store.replaceForDevice(deviceId, siteId, reportedAt, rows);
            // Derive + upsert the fulfilment ledger from the SAME confirmed
            // telemetry (§9.4) - additive, never throws, tenant context still set.
            ledger.ingest(siteId, rows, reportedAt);
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * One entity entry. An unknown STATE word drops the entry (D9: discarded,
     * never stored); an unknown REASON word is dropped alone.
     */
    private ConsumerRuntimeStatusRepository.Row parseEntry(UUID entityId, JsonNode node) {
        if (node == null || !node.isObject()) {
            return null;
        }
        String state = node.path("state").asText("");
        if (!STATES.contains(state)) {
            log.debug("consumer state word '{}' for {} discarded", state, entityId);
            return null;
        }
        String reason = node.path("reason_code").asText("");
        if (reason.isBlank()) {
            reason = null;
        } else if (!REASONS.contains(reason)) {
            log.debug("consumer reason word '{}' for {} discarded", reason, entityId);
            reason = null;
        }
        Double actualKw = optDouble(node, "actual_kw");
        Boolean confirmed = optBoolean(node, "confirmed");
        Integer runtime = null;
        Integer starts = null;
        JsonNode progress = node.get("requirement_progress");
        if (progress != null && progress.isObject()) {
            runtime = boundedInt(progress, "runtime_seconds_today", MAX_RUNTIME_SECONDS);
            starts = boundedInt(progress, "starts_today", MAX_STARTS);
        }
        return new ConsumerRuntimeStatusRepository.Row(entityId, state, reason, actualKw,
                confirmed, runtime, starts);
    }

    private static Integer boundedInt(JsonNode node, String field, int max) {
        JsonNode v = node.get(field);
        if (v == null || !v.canConvertToInt()) {
            return null;
        }
        int n = v.asInt();
        if (n < 0) {
            return null;
        }
        return Math.min(n, max);
    }

    /** Tri-state boolean: null when the device did not report it (D9). */
    private static Boolean optBoolean(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isBoolean()) ? null : v.asBoolean();
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull() || !v.isNumber()) {
            return null;
        }
        double d = v.asDouble();
        return (Double.isNaN(d) || Double.isInfinite(d)) ? null : d;
    }

    /** The heartbeat's ts, or now() when missing/unparseable. */
    private static Instant reportedAt(JsonNode json) {
        JsonNode v = json.get("ts");
        if (v != null && !v.isNull() && !v.asText().isBlank()) {
            try {
                return Instant.parse(v.asText());
            } catch (Exception e) {
                // fall through
            }
        }
        return Instant.now();
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
                log.debug("Consumer listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Consumer listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
