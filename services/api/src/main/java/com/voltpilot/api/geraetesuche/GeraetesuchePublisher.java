package com.voltpilot.api.geraetesuche;

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
 * Veröffentlicht einen Gerätesuche-Auftrag NICHT gespeichert auf {@code ems/{t}/{s}/{d}/v2/geraetesuche} (Muster
 * {@code SprungprobePublisher}). Wird nur vom {@link GeraetesucheDienst} gerufen — auf „Geräte suchen“ oder „Abbrechen“
 * eines Menschen mit {@code geraet.einrichten}; kein Läufer sendet je einen Auftrag.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class GeraetesuchePublisher implements GeraetesucheVersand {

    private static final Logger log = LoggerFactory.getLogger(GeraetesuchePublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;
    private MqttClient client;

    public GeraetesuchePublisher(
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
            message.setRetained(false);
            connected().publish(topic, message);
            log.info("published geraetesuche to {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish geraetesuche to {}: {} (bleibt ungesendet)", topic, e.getMessage());
            return false;
        }
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-geraetesuche-" + UUID.randomUUID(),
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
            log.debug("geraetesuche publisher close failed: {}", e.getMessage());
        }
        client = null;
    }
}
