package com.voltpilot.api.curtailment;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.CurtailmentStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
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
 * Ingests the additive {@code curtailment} block from the device status
 * heartbeat (ems/{t}/{s}/{d}/status) into {@code device_curtailment_status}:
 * the plant's curtailment CAPABILITY (configured units, per-unit First-Light
 * releases, the control kill-switch) plus its latest execution OBSERVATIONS
 * (applied cap, readback match, possible override).
 *
 * <p>It is what turns the Fahrplan's "Abregeln" slot from a claim into a
 * verifiable statement. The edge has been sending this block since it was
 * built - explicitly so the cloud could tell "geplant und ausgeführt" from
 * "geplant, Anlage kann es (noch) nicht" - and nothing read it, so the portal
 * said "die PV wird gedrosselt" next to a measured 16,6 kW feed-in (scout
 * {@code vp-pilsting-abregeln}). Zero edge change was needed here.
 *
 * <p><b>A SIBLING listener, not an extension of
 * {@link com.voltpilot.api.control.ControlStatusListener}</b>: that one returns
 * early when the heartbeat carries no {@code control} block, and the two blocks
 * are independent (the edge omits {@code control} without an inverter readback
 * and {@code curtailment} without a curtailment-capable source). Extending it
 * would silently drop the curtailment truth of exactly the plant whose primary
 * inverter reports nothing. Same topic filter, same authorization posture as
 * every sibling on it: broker ACL + mTLS-CN identity, topic identity
 * re-validated against the payload, the device resolved through the RLS
 * repository under the topic tenant, the upsert running under that tenant so
 * RLS' WITH CHECK stamps the row.
 *
 * <p>Off by default so unit tests and broker-less deployments are unaffected;
 * both composes turn it on next to the control listener.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.curtailment.mqtt-listener-enabled", havingValue = "true")
public class CurtailmentStatusListener {

    private static final Logger log = LoggerFactory.getLogger(CurtailmentStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /**
     * A sanity bound on the reported unit counts. The edge derives them from
     * its configured sources, so a four-digit count is a defect, not a plant -
     * and the number reaches the customer as "X von Y Wechselrichtern".
     */
    private static final int MAX_UNITS = 64;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final CurtailmentStatusRepository curtailmentStatus;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public CurtailmentStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, CurtailmentStatusRepository curtailmentStatus) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.curtailmentStatus = curtailmentStatus;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Curtailment-status listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-curtailment-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Curtailment-status listener subscribed to {} at {}",
                                STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Curtailment-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Curtailment-status listener lost the broker connection: {} "
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
                log.warn("Curtailment status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one heartbeat's curtailment block. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode curtail = json == null ? null : json.get("curtailment");
        if (curtail == null || !curtail.isObject()) {
            return; // a heartbeat without a curtailment block (an older edge,
                    // or a plant with no curtailment-capable source)
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("curtailment status on non-UUID topic '{}' skipped", topic);
            return;
        }
        // Topic identity must equal payload identity (a device may not report
        // another device's curtailment state - the ingest/control rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("curtailment status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        int units = count(curtail, "units");
        // A block without units describes no actor at all - storing it would
        // turn "we know nothing" into "0 von 0 freigegeben".
        if (units <= 0) {
            return;
        }
        int certified = Math.min(count(curtail, "certified_units"), units);
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("curtailment status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            curtailmentStatus.upsert(deviceId, siteId, units, certified,
                    curtail.path("control_enabled").asBoolean(false),
                    curtail.path("active").asBoolean(false),
                    optDouble(curtail, "applied_cap_kw"),
                    optBoolean(curtail, "all_match"),
                    curtail.path("possible_override").asBoolean(false),
                    checkedAt(curtail));
        } finally {
            TenantContext.clear();
        }
    }

    /** A non-negative, sanity-bounded unit count; anything else reads as 0. */
    private static int count(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isInt()) {
            return 0;
        }
        int n = v.asInt();
        return n < 0 ? 0 : Math.min(n, MAX_UNITS);
    }

    /**
     * A tri-state boolean: null when the device did not report it. Load-bearing
     * for {@code all_match} - "nothing applied" (absent) must not be stored as
     * "the readback disagreed" (false), because only TRUE is a confirmation and
     * false is what the portal renders as an override-shaped warning.
     */
    private static Boolean optBoolean(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isBoolean()) ? null : v.asBoolean();
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isNumber()) ? null : v.asDouble();
    }

    /** checked_at from the block, or now() when it is missing/unparseable. */
    private static Instant checkedAt(JsonNode curtail) {
        JsonNode v = curtail.get("checked_at");
        if (v != null && !v.isNull() && !v.asText().isBlank()) {
            try {
                return Instant.parse(v.asText());
            } catch (Exception e) {
                // fall through - an unparseable stamp is no reason to drop a
                // truth we otherwise understand.
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
                log.debug("Curtailment listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Curtailment listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
