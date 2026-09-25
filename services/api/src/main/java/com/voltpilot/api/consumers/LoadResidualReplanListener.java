package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.ScheduleRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
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

/** Tenant-safe telemetry-to-plan residual trigger for prompt bounded replans. */
@Component
@ConditionalOnProperty(name = "voltpilot.load-residual-replan.enabled", havingValue = "true")
public class LoadResidualReplanListener extends Rueckmeldeweg {
    private static final Logger log = LoggerFactory.getLogger(LoadResidualReplanListener.class);
    private static final String FILTER = "ems/+/+/+/telemetry";
    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final ScheduleRepository schedules;
    private final ReplanClient replans;
    private final LoadResidualReplanTrigger trigger;
    private final Duration maxSampleAge;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ScheduledExecutorService scheduler;
    private MqttClient client;

    public LoadResidualReplanListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            @Value("${voltpilot.load-residual-replan.absolute-kw:3}") double absoluteKw,
            @Value("${voltpilot.load-residual-replan.relative-fraction:0.20}") double relativeFraction,
            @Value("${voltpilot.load-residual-replan.sustained-seconds:20}") long sustainedSeconds,
            @Value("${voltpilot.load-residual-replan.min-interval-seconds:120}") long minIntervalSeconds,
            @Value("${voltpilot.load-residual-replan.retry-seconds:5}") long retrySeconds,
            @Value("${voltpilot.load-residual-replan.max-sample-age-seconds:30}") long maxAgeSeconds,
            DeviceRepository devices, ScheduleRepository schedules, ReplanClient replans) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.schedules = schedules;
        this.replans = replans;
        this.maxSampleAge = Duration.ofSeconds(maxAgeSeconds);
        this.trigger = new LoadResidualReplanTrigger(absoluteKw, relativeFraction,
                Duration.ofSeconds(sustainedSeconds), Duration.ofSeconds(minIntervalSeconds),
                Duration.ofSeconds(retrySeconds));
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "load-residual-replan");
            t.setDaemon(true);
            return t;
        });
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        scheduler.scheduleWithFixedDelay(this::fireDue, 1, 1, TimeUnit.SECONDS);
        try { connect(); } catch (Exception e) {
            log.warn("load-residual listener could not connect to {} yet: {}", brokerUrl, e.getMessage());
        }
    }

    private synchronized void connect() throws Exception {
        if (client != null) return;
        client = new MqttClient(brokerUrl, "voltpilot-api-load-residual-" + UUID.randomUUID(),
                new MemoryPersistence());
        client.setCallback(new MqttCallbackExtended() {
            @Override public void connectComplete(boolean reconnect, String uri) {
                try { client.subscribe(FILTER, 1, (topic, message) -> handle(topic, message.getPayload(), Instant.now())); }
                catch (Exception e) { log.warn("load-residual subscribe failed: {}", e.getMessage()); }
            }
            @Override public void connectionLost(Throwable cause) {
                log.warn("load-residual listener lost broker connection: {}",
                        cause == null ? "unknown" : cause.getMessage());
            }
            @Override public void messageArrived(String topic, org.eclipse.paho.client.mqttv3.MqttMessage message) {}
            @Override public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {}
        });
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        options.setAutomaticReconnect(true);
        options.setConnectionTimeout(5);
        if (username != null && !username.isBlank()) {
            options.setUserName(username);
            options.setPassword(password == null ? new char[0] : password.toCharArray());
        }
        client.connect(options);
    }

    /** Package-visible deterministic seam used by identity/freshness tests. */
    void handle(String topic, byte[] payload, Instant now) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try { json = mapper.readTree(new String(payload, StandardCharsets.UTF_8)); }
        catch (Exception e) { return; }
        String[] parts = topic.split("/");
        if (json == null || parts.length != 5 || !"telemetry".equals(parts[4])) return;
        UUID tenantId = uuid(parts[1]);
        UUID siteId = uuid(parts[2]);
        UUID deviceId = uuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null
                || !parts[1].equals(json.path("tenant_id").asText())
                || !parts[2].equals(json.path("site_id").asText())
                || !parts[3].equals(json.path("device_id").asText())) return;
        Instant observedAt;
        try { observedAt = Instant.parse(json.path("ts").asText()); }
        catch (Exception e) { return; }
        if (observedAt.isBefore(now.minus(maxSampleAge)) || observedAt.isAfter(now.plusSeconds(5))) return;
        Long sequence = null;
        JsonNode sequenceNode = json.get("seq");
        if (sequenceNode != null) {
            if (!sequenceNode.isIntegralNumber() || !sequenceNode.canConvertToLong()
                    || sequenceNode.longValue() < 0) return;
            sequence = sequenceNode.longValue();
        }
        JsonNode loadNode = json.path("measurements").get("load_kw");
        if (loadNode == null || !loadNode.isNumber() || !Double.isFinite(loadNode.doubleValue())) return;
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) return;
            Double planned = schedules.activePlannedLoadKw(siteId, observedAt);
            if (planned != null) trigger.observe(siteId, deviceId, sequence,
                    loadNode.doubleValue(), planned, observedAt);
        } finally { TenantContext.clear(); }
    }

    void fireDue() {
        Instant now = Instant.now();
        for (UUID siteId : trigger.due(now)) {
            boolean success;
            try {
                success = replans.replan(siteId);
            } catch (Exception e) {
                success = false;
                log.warn("load-residual replan for site {} failed: {} (request stays pending)",
                        siteId, e.getMessage());
            }
            trigger.complete(siteId, success, Instant.now());
        }
    }

    @PreDestroy public synchronized void stop() {
        scheduler.shutdownNow();
        if (client != null) try { client.disconnect(); client.close(); } catch (Exception ignored) {}
        client = null;
    }

    private static UUID uuid(String value) {
        try { return UUID.fromString(value); } catch (Exception e) { return null; }
    }
}
