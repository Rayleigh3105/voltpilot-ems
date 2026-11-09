package com.voltpilot.api.geraetesuche;

import com.voltpilot.api.provisioning.BrokerVerbindung;
import jakarta.annotation.PreDestroy;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
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
    private final BrokerVerbindung verbindung;

    public GeraetesuchePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.verbindung = new BrokerVerbindung(log, "geraetesuche", brokerUrl,
                "voltpilot-api-geraetesuche-" + UUID.randomUUID(), true, username, password, null, null);
    }

    /**
     * Verbindet beim Start und wartet darauf höchstens {@link BrokerVerbindung#ZEITGRENZE_MS}: der erste Versand
     * gleich danach soll noch durchgehen wie vor der Migration auf {@link BrokerVerbindung} (Befund 6/7,
     * vp-perf-robust-folge) - vorher verband ein synchrones {@code MqttClient.connect()} bis zu 5 s. Später wartet
     * kein Senden mehr auf die Verbindung; fehlt sie, meldet der Aufrufer es wie jeden anderen Verbindungsfehler,
     * und Paho verbindet selbst neu.
     */
    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        verbindung.sicherstellen();
        verbindung.erstaufbauAbwarten();
    }

    @Override
    public synchronized boolean senden(String topic, byte[] nutzlast) {
        try {
            MqttMessage message = new MqttMessage(nutzlast);
            message.setQos(1);
            message.setRetained(false);
            verbindung.verbundenerClient().publish(topic, message).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("published geraetesuche to {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish geraetesuche to {}: {} (bleibt ungesendet)", topic, e.getMessage());
            return false;
        }
    }

    @PreDestroy
    public void close() {
        verbindung.schliessen();
    }
}
