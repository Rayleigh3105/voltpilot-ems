package com.voltpilot.api.probe;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
 * Receives a device's probe answer on {@code ems/+/+/+/v2/probe-result} and
 * hands it to the request thread waiting in {@link ProbeRegistry}.
 *
 * <p>Same authorization posture as every sibling listener on the device topics
 * (control / curtailment / consumers / purge): the broker ACL + the mTLS
 * certificate CN are what make a device able to publish here at all, and the
 * topic identity is re-validated against the payload as the second half of the
 * same discipline. The registry then applies the third: an answer is only
 * accepted for the device the question was addressed to.
 *
 * <p><b>Nothing is written to the database.</b> A probe is the answer to a
 * question asked seconds ago; it lives in memory until the waiting thread takes
 * it, and disappears with it. That is also why this listener - unlike its
 * siblings - resolves no device row and needs no tenant context.
 *
 * <p>Rides {@code voltpilot.provisioning.enabled} rather than a flag of its own.
 * That is deliberate: a listener behind a NEW default-off switch has to be
 * pulled into the gitops env before it ever runs in production, and that
 * omission has bitten this codebase before (the OTA listener flag). This one is
 * live exactly where the probe's own distribution path is live.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ProbeResultListener {

    private static final Logger log = LoggerFactory.getLogger(ProbeResultListener.class);
    private static final String RESULT_FILTER = "ems/+/+/+/v2/probe-result";

    /**
     * The contract's closed error vocabulary. An unknown word is DROPPED rather
     * than passed on - the sibling listeners' rule ("a word we do not
     * understand must not become a sentence"), and here it also stops a device
     * from putting arbitrary text in front of a customer.
     */
    private static final Set<String> ERROR_CODES = Set.of(
            "invalid_request", "unreachable", "no_answer", "invalid_response",
            "implausible", "timeout", "not_supported", "rate_limited");

    /** A bound on what one answer may carry - the contract says at most 8 ops. */
    private static final int MAX_RESULTS = 8;
    /** A bound on the German sentence a device may hand to a customer. */
    private static final int MAX_MESSAGE = 400;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final ProbeRegistry registry;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public ProbeResultListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            ProbeRegistry registry) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.registry = registry;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Probe-result listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-probe-result-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(RESULT_FILTER, 1, messageListener());
                        log.info("Probe-result listener subscribed to {} at {}",
                                RESULT_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Probe-result subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Probe-result listener lost the broker connection: {} "
                            + "(auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
                }

                @Override
                public void deliveryComplete(
                        org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {
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
                // Deliberately without the payload: it carries the customer's
                // LAN topology, and a parse failure is not worth recording it.
                log.warn("Probe result on '{}' could not be handled: {}", topic, e.getMessage());
            }
        };
    }

    /** Test-visible: parse one answer and hand it to the waiting request. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        if (json == null || !json.isObject()) {
            return;
        }
        if (!"probe_result".equals(json.path("type").asText())
                || !"1.0".equals(json.path("schema_version").asText())) {
            return;
        }
        String[] parts = topic.split("/");
        if (parts.length != 6) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            return;
        }
        // Topic identity must equal payload identity - a device may not answer
        // for another one (the ingest/control rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("probe result payload identity does not match its topic - skipped");
            return;
        }
        String requestId = json.path("request_id").asText("");
        if (requestId.isBlank()) {
            return;
        }

        List<ProbeResult.OpResult> results = new ArrayList<>();
        JsonNode arr = json.get("results");
        if (arr != null && arr.isArray()) {
            for (JsonNode line : arr) {
                if (results.size() >= MAX_RESULTS) {
                    break;
                }
                String id = line.path("id").asText("");
                if (id.isBlank()) {
                    continue;
                }
                boolean ok = line.path("ok").asBoolean(false);
                JsonNode readingNode = line.get("reading");
                if (readingNode != null && readingNode.isObject()) {
                    // A test_connection line (Einheitsmodell Stufe 1). Its honesty
                    // rule is the SAME idea as the register read's, applied to what
                    // this op actually produces: a device that reported not a single
                    // channel has not been read, whatever the line claims.
                    ProbeResult.Reading reading = new ProbeResult.Reading(
                            optDouble(readingNode, "pv_kw"), optDouble(readingNode, "load_kw"),
                            optDouble(readingNode, "grid_kw"), optDouble(readingNode, "soc_pct"));
                    boolean any = reading.any();
                    results.add(new ProbeResult.OpResult(id, ok && any, null, null, null,
                            ok && any ? null : code(line), ok && any ? null : text(line),
                            any ? reading : null));
                    continue;
                }
                Double raw = optDouble(line, "raw");
                Double value = optDouble(line, "value");
                // The contract's honesty rule, enforced on ARRIVAL: a line
                // without both numbers is not a reading, whatever it claims.
                if (ok && (raw == null || value == null)) {
                    ok = false;
                    raw = null;
                    value = null;
                }
                if (!ok) {
                    raw = null;
                    value = null;
                }
                results.add(new ProbeResult.OpResult(id, ok, raw,
                        ok ? registers(line) : null, value,
                        ok ? null : code(line), ok ? null : text(line)));
            }
        }
        registry.complete(deviceId, requestId,
                new ProbeResult(requestId, code(json), text(json), results));
    }

    private static List<Integer> registers(JsonNode line) {
        JsonNode arr = line.get("registers");
        if (arr == null || !arr.isArray() || arr.isEmpty()) {
            return null;
        }
        List<Integer> out = new ArrayList<>(2);
        for (JsonNode w : arr) {
            if (out.size() >= 2 || !w.isInt()) {
                break;
            }
            int v = w.asInt();
            if (v < 0 || v > 0xffff) {
                return null; // not a 16-bit register word - report nothing
            }
            out.add(v);
        }
        return out.isEmpty() ? null : out;
    }

    /** A known error class, or null - an invented word never reaches a customer. */
    private static String code(JsonNode node) {
        String c = node.path("error_code").asText("");
        return ERROR_CODES.contains(c) ? c : null;
    }

    private static String text(JsonNode node) {
        String m = node.path("message").asText("");
        if (m.isBlank()) {
            return null;
        }
        return m.length() > MAX_MESSAGE ? m.substring(0, MAX_MESSAGE) : m;
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull() || !v.isNumber()) {
            return null;
        }
        double d = v.asDouble();
        return Double.isFinite(d) ? d : null;
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
                log.debug("Probe listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Probe listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
