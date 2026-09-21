package com.voltpilot.api.uems;

import jakarta.annotation.PreDestroy;
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

/**
 * Veröffentlicht Anteils-Dokumente gespeichert (retained) auf {@code ems/{t}/{s}/{d}/v2/verbund-anteile} (UEMS AP-15
 * IP-7, Y1; Muster {@code ChargingConfigPublisher}). Wird nur vom {@link SteuerungsverbundAnteilDienst} gerufen — und
 * der ruft nur für eine Anlage MIT Gemeinsamer Steuerung: eine Bestandsbox bekommt nie ein Topic.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class VerbundAnteilePublisher implements VerbundAnteileVersand {

    private static final Logger log = LoggerFactory.getLogger(VerbundAnteilePublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;
    private MqttClient client;

    public VerbundAnteilePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    @Override
    public synchronized boolean senden(String topic, byte[] nutzlast) {
        try {
            MqttMessage message = new MqttMessage(nutzlast);
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic, message);
            log.info("published verbund-anteile to {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish verbund-anteile to {}: {} (bleibt ungesendet)", topic, e.getMessage());
            return false;
        }
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-verbund-anteile-" + UUID.randomUUID(),
                    new MemoryPersistence());
        }
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(true);
        options.setConnectionTimeout(5);
        options.setAutomaticReconnect(true);
        if (username != null && !username.isBlank()) {
            options.setUserName(username);
            options.setPassword(password == null ? new char[0] : password.toCharArray());
        }
        client.connect(options);
        return client;
    }

    @PreDestroy
    public synchronized void close() {
        if (client == null) {
            return;
        }
        try {
            if (client.isConnected()) {
                client.disconnect();
            }
            client.close(true);
        } catch (Exception e) {
            log.debug("verbund-anteile publisher close failed: {}", e.getMessage());
        }
        client = null;
    }
}
