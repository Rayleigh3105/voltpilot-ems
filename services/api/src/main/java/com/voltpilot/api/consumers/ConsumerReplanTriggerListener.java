package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
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
 * The event-replanning trigger listener (D8, docs/verbrauchssteuerung.md
 * §13.4): its OWN sibling on {@code ems/+/+/+/status} (the Geschwister rule -
 * a new concern gets a new listener, never an extension of an existing one's
 * early-return), watching the additive {@code consumers} block for the §13.4
 * transitions and calling the solve service's {@code POST /replan} per site,
 * debounced + rate-limited by the pure {@link ConsumerReplanTrigger}.
 *
 * <p>Authorization posture = the sibling listeners': broker ACL + mTLS-CN put
 * a device on its own topic; topic identity is re-validated against the
 * payload, and the device is resolved through the RLS-scoped repository under
 * the topic tenant - a spoofed identity feeds nothing.
 *
 * <p>Flag {@code voltpilot.consumer-control.replan-trigger-enabled}
 * (VOLTPILOT_CONSUMER_REPLAN_TRIGGER_ENABLED, default OFF). Replica-singleton
 * like every MQTT listener here (today 1 api replica; with several, each would
 * fire its own debounced replans - the solve service's semaphore bounds the
 * damage, the documented shared-subscription fix applies).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.consumer-control.replan-trigger-enabled",
        havingValue = "true")
public class ConsumerReplanTriggerListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(ConsumerReplanTriggerListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final ReplanClient replans;
    private final ConsumerReplanTrigger trigger;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private final ScheduledExecutorService scheduler;
    private MqttClient client;

    public ConsumerReplanTriggerListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            @Value("${voltpilot.consumer-control.replan-debounce-seconds:8}") long debounceSeconds,
            @Value("${voltpilot.consumer-control.replan-min-interval-seconds:120}")
            long minIntervalSeconds,
            DeviceRepository devices, ReplanClient replans) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.replans = replans;
        this.trigger = new ConsumerReplanTrigger(Duration.ofSeconds(debounceSeconds),
                Duration.ofSeconds(minIntervalSeconds), 3);
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "consumer-replan-trigger");
            t.setDaemon(true);
            return t;
        });
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        scheduler.scheduleWithFixedDelay(this::fireDue, 2, 2, TimeUnit.SECONDS);
        try {
            connect();
        } catch (Exception e) {
            log.warn("Replan-trigger listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-replan-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Replan-trigger listener subscribed to {} at {}",
                                STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Replan-trigger subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Replan-trigger listener lost the broker connection: {} "
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
                handle(topic, message.getPayload(), Instant.now());
            } catch (Exception e) {
                log.warn("Replan trigger on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible for tests: observe one heartbeat's consumers block. */
    public void handle(String topic, byte[] payload, Instant now) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode consumers = json == null ? null : json.get("consumers");
        if (consumers == null || !consumers.isObject()) {
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
        // Topic identity == payload identity (the ingest/control rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("replan trigger payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("replan trigger for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            Iterator<Map.Entry<String, JsonNode>> it = consumers.fields();
            while (it.hasNext()) {
                Map.Entry<String, JsonNode> entry = it.next();
                UUID entityId = parseUuid(entry.getKey());
                JsonNode node = entry.getValue();
                if (entityId == null || node == null || !node.isObject()) {
                    continue;
                }
                String state = node.path("state").asText(null);
                Boolean confirmed = node.has("confirmed") && node.get("confirmed").isBoolean()
                        ? node.get("confirmed").asBoolean() : null;
                trigger.observe(siteId, entityId, state, confirmed, now);
            }
        } finally {
            TenantContext.clear();
        }
    }

    /** Fire the due, debounced site replans (called by the scheduler). */
    void fireDue() {
        try {
            for (UUID siteId : trigger.due(Instant.now())) {
                replans.replan(siteId);
            }
        } catch (Exception e) {
            log.warn("replan trigger firing failed: {}", e.getMessage());
        }
    }

    @PreDestroy
    public void stop() {
        scheduler.shutdownNow();
        synchronized (lock) {
            if (client != null) {
                try {
                    client.disconnect();
                    client.close();
                } catch (Exception e) {
                    log.debug("replan listener close: {}", e.getMessage());
                }
                client = null;
            }
        }
    }

    private static UUID parseUuid(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (Exception e) {
            return null;
        }
    }
}
