package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import jakarta.annotation.PreDestroy;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Publishes the complete additional-measurement desired state retained/QoS1. */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class MeasurementConfigPublisher {
    private static final Logger log = LoggerFactory.getLogger(MeasurementConfigPublisher.class);
    private final String brokerUrl;
    private final String username;
    private final String password;
    private final ObjectMapper mapper;
    private MqttClient client;

    public MeasurementConfigPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            ObjectMapper mapper) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.mapper = mapper;
    }

    public static String topic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId
                + "/v2/measurement-config";
    }

    /** Best-effort transport; DB desired state remains authoritative on outage. */
    public synchronized boolean publish(DeviceScope scope, State state) {
        if (state.desiredRevision() < 1) return true;
        try {
            MqttMessage message = new MqttMessage(payload(scope, state));
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic(scope.tenantId(), scope.siteId(), scope.deviceId()), message);
            return true;
        } catch (Exception e) {
            log.warn("measurement desired state revision {} for device {} could not be published: {}",
                    state.desiredRevision(), scope.deviceId(), e.getMessage());
            return false;
        }
    }

    byte[] payload(DeviceScope scope, State state) throws Exception {
        List<Map<String, Object>> selections = state.selections().stream()
                .filter(MeasurementSelectionService.SelectionPoint::enabled)
                .map(p -> Map.<String, Object>of(
                        "point_key", p.pointKey(), "cadence_s", p.cadenceS()))
                .toList();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schema_version", "2.0");
        payload.put("tenant_id", scope.tenantId());
        payload.put("site_id", scope.siteId());
        payload.put("device_id", scope.deviceId());
        payload.put("revision", state.desiredRevision());
        payload.put("catalog_version", state.catalogVersion());
        payload.put("selections", selections);
        return mapper.writeValueAsBytes(payload);
    }

    private MqttClient connected() throws Exception {
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-measurements-" + UUID.randomUUID(),
                    new MemoryPersistence());
        }
        if (!client.isConnected()) {
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
        return client;
    }

    @PreDestroy
    void close() {
        if (client == null) return;
        try {
            if (client.isConnected()) client.disconnect();
            client.close();
        } catch (Exception e) {
            log.debug("closing measurement publisher: {}", e.getMessage());
        }
    }
}
