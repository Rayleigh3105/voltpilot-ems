package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
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
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Empfang des Sprungprobe-Berichts {@code …/v2/sprungprobe-result} (UEMS AP-15 IP-21; Vertrag
 * {@code docs/contracts/v2/mqtt-sprungprobe.md} §3; Muster {@link VerbundAnteileResultListener}). Prüft Topic- und
 * Payload-Identität ({@link SprungprobeBericht#lesen}), dann wertet {@link SprungprobeDienst#berichtEmpfangen} aus. Eine
 * Box ohne Auftrag sendet nichts: für sie läuft hier nie etwas.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class SprungprobeBerichtListener {

    private static final Logger log = LoggerFactory.getLogger(SprungprobeBerichtListener.class);
    private static final String FILTER = "ems/+/+/+/v2/" + SprungprobeBericht.ERGEBNIS;

    private final String brokerUrl, username, password;
    private final SprungprobeDienst dienst;
    private final ObjectMapper mapper;
    private MqttClient client;

    public SprungprobeBerichtListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            SprungprobeDienst dienst, ObjectMapper mapper) {
        this.brokerUrl = brokerUrl; this.username = username; this.password = password;
        this.dienst = dienst; this.mapper = mapper;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Wiederverbindung wie {@link PlanResultListener}: ein Broker-Ausfall beim Start hält nichts auf. */
    @Scheduled(fixedDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}",
            initialDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}")
    public synchronized void ensureConnected() {
        if (client != null && client.isConnected()) return;
        try {
            connect();
        } catch (Exception e) {
            log.warn("sprungprobe result listener awaits broker: {}", e.getMessage());
            discardClient();
        }
    }

    private void connect() throws Exception {
        discardClient();
        client = new MqttClient(brokerUrl, "voltpilot-api-sprungprobe-result", new MemoryPersistence());
        client.setCallback(new MqttCallbackExtended() {
            @Override public void connectComplete(boolean reconnect, String uri) {
                try { client.subscribe(FILTER, 1, listener()); }
                catch (Exception e) { log.warn("sprungprobe result subscribe failed: {}", e.getMessage()); }
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

    @PreDestroy
    void stop() {
        discardClient();
    }

    private void discardClient() {
        if (client == null) return;
        try { if (client.isConnected()) client.disconnect(); client.close(); }
        catch (Exception ignored) { }
        client = null;
    }

    private IMqttMessageListener listener() {
        return (topic, message) -> {
            try { handle(topic, message.getPayload(), Instant.now()); }
            catch (Exception e) { log.warn("sprungprobe result on {} rejected: {}", topic, e.getMessage()); }
        };
    }

    /** Prüft und übergibt; false = verworfen (ungültig oder keine laufende Probe dieser Box). */
    public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
        SprungprobeBericht b = SprungprobeBericht.lesen(topic, payload, mapper);
        if (b == null) return false;
        TenantContext.set(b.tenantId());
        try {
            return dienst.berichtEmpfangen(b, empfangenUm);
        } finally {
            TenantContext.clear();
        }
    }
}
