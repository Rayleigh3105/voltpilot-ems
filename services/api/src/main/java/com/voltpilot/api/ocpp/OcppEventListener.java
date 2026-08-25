package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
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

/** MQTT ingress for durable edge OCPP protocol events. */
@Component
@ConditionalOnProperty(name = "voltpilot.ocpp.mqtt-listener-enabled", havingValue = "true")
public class OcppEventListener {
    private static final Logger log = LoggerFactory.getLogger(OcppEventListener.class);
    private static final String FILTER = "ems/+/+/+/v2/ocpp-events";
    private static final int MAX_PAYLOAD_BYTES = 1024 * 1024;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final String clientId;
    private final DeviceRepository devices;
    private final OcppRepository repository;
    private final ObjectMapper mapper;
    private final Object lock = new Object();
    private final ScheduledExecutorService mqttRetryExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "ocpp-mqtt-initial-connect");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicBoolean retryScheduled = new AtomicBoolean();
    private final AtomicBoolean subscriptionRetryScheduled = new AtomicBoolean();
    private volatile boolean stopped;
    private MqttClient client;

    public OcppEventListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            @Value("${voltpilot.ocpp.mqtt-client-id:voltpilot-api-ocpp}") String clientId,
            DeviceRepository devices, OcppRepository repository, ObjectMapper mapper) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.clientId = clientId;
        this.devices = devices;
        this.repository = repository;
        this.mapper = mapper;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        connectOrRetry();
    }

    private void connectOrRetry() {
        if (stopped) return;
        try {
            connect();
        } catch (Exception e) {
            synchronized (lock) {
                try { if (client != null) client.close(); } catch (Exception ignored) {}
                client = null;
            }
            log.warn("OCPP-event listener could not connect to {} yet: {} (retry in 5s)",
                    brokerUrl, e.getMessage());
            if (!stopped && retryScheduled.compareAndSet(false, true)) {
                mqttRetryExecutor.schedule(() -> {
                    retryScheduled.set(false);
                    connectOrRetry();
                }, 5, TimeUnit.SECONDS);
            }
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) return;
            client = new MqttClient(brokerUrl, clientId, new MemoryPersistence());
            // A stable broker session bridges API restarts. Manual ACK keeps a
            // QoS1 delivery outstanding until the DB transaction completed;
            // a transient persistence error is therefore retried, not lost.
            client.setManualAcks(true);
            client.setCallback(new MqttCallbackExtended() {
                @Override public void connectComplete(boolean reconnect, String serverUri) {
                    subscribeOrRetry(serverUri);
                }
                @Override public void connectionLost(Throwable cause) {
                    log.warn("OCPP-event listener lost broker connection: {} (auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }
                @Override public void messageArrived(String topic, MqttMessage message) {
                    handleAndAcknowledge(topic, message);
                }
                @Override public void deliveryComplete(
                        org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {}
            });
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(false);
            options.setConnectionTimeout(5);
            options.setAutomaticReconnect(true);
            if (username != null && !username.isBlank()) {
                options.setUserName(username);
                options.setPassword(password == null ? new char[0] : password.toCharArray());
            }
            client.connect(options);
        }
    }

    private void subscribeOrRetry(String serverUri) {
        if (stopped) return;
        try {
            client.subscribe(FILTER, 1);
            subscriptionRetryScheduled.set(false);
            log.info("OCPP-event listener subscribed to {} at {}", FILTER, serverUri);
        } catch (Exception e) {
            log.warn("OCPP-event subscribe failed: {} (retry in 5s)", e.getMessage());
            if (!stopped && subscriptionRetryScheduled.compareAndSet(false, true)) {
                mqttRetryExecutor.schedule(() -> {
                    subscriptionRetryScheduled.set(false);
                    subscribeOrRetry(serverUri);
                }, 5, TimeUnit.SECONDS);
            }
        }
    }

    private void handleAndAcknowledge(String topic, MqttMessage message) {
        try {
            // Invalid/untrusted messages are deliberately discarded and
            // ACKed; only an exception (for example a DB outage) remains
            // unacknowledged for redelivery.
            handle(topic, message.getPayload());
            client.messageArrivedComplete(message.getId(), message.getQos());
        } catch (Exception e) {
            log.warn("OCPP event on '{}' failed and remains unacknowledged: {}",
                    topic, e.getMessage());
        }
    }

    /** Test-visible single-message ingress. */
    public boolean handle(String topic, byte[] raw) {
        if (topic == null || raw == null || raw.length == 0 || raw.length > MAX_PAYLOAD_BYTES) return false;
        String[] parts = topic.split("/");
        if (parts.length != 6 || !"ems".equals(parts[0]) || !"v2".equals(parts[4])
                || !"ocpp-events".equals(parts[5])) return false;
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) return false;
        JsonNode json;
        try { json = mapper.readTree(new String(raw, StandardCharsets.UTF_8)); }
        catch (Exception e) { return false; }
        if (json == null || !tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("OCPP event payload identity does not match topic '{}' - skipped", topic);
            return false;
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("OCPP event for unknown device {} (tenant {}) skipped", deviceId, tenantId);
                return false;
            }
            // The retained purge command removes the edge spool before upload,
            // but correctness must never depend on an online/cooperative edge.
            // Reject an old journal replay against the same committed watermark
            // that protects telemetry from resurrection.
            Instant occurredAt = parseInstant(json.path("occurred_at").asText());
            Optional<Instant> purgedBefore = devices.dataPurgedBefore(deviceId);
            if (occurredAt != null && purgedBefore.isPresent()
                    && !occurredAt.isAfter(purgedBefore.get())) {
                log.info("OCPP event {} at {} is at/before device purge watermark {} - skipped",
                        json.path("event_id").asText(), occurredAt, purgedBefore.get());
                return false;
            }
            return repository.ingest(tenantId, siteId, deviceId, json);
        } finally {
            TenantContext.clear();
        }
    }

    private static UUID parseUuid(String value) {
        try { return UUID.fromString(value); } catch (Exception e) { return null; }
    }

    private static Instant parseInstant(String value) {
        try { return Instant.parse(value); } catch (Exception e) { return null; }
    }

    @PreDestroy
    public void stop() {
        stopped = true;
        mqttRetryExecutor.shutdownNow();
        synchronized (lock) {
            if (client == null) return;
            try { if (client.isConnected()) client.disconnect(); } catch (Exception ignored) {}
            try { client.close(); } catch (Exception ignored) {}
            client = null;
        }
    }
}
