package com.voltpilot.api.uems;

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
    private final BrokerVerbindung verbindung;

    public VerbundAnteilePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.verbindung = new BrokerVerbindung(log, "verbund-anteile", brokerUrl,
                "voltpilot-api-verbund-anteile-" + UUID.randomUUID(), true, username, password, null, null);
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
            message.setRetained(true);
            verbindung.verbundenerClient().publish(topic, message).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("published verbund-anteile to {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish verbund-anteile to {}: {} (bleibt ungesendet)", topic, e.getMessage());
            return false;
        }
    }

    @PreDestroy
    public void close() {
        verbindung.schliessen();
    }
}
