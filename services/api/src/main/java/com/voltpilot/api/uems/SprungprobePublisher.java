package com.voltpilot.api.uems;

import com.voltpilot.api.provisioning.BrokerVerbindung;
import jakarta.annotation.PreDestroy;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Veröffentlicht einen Sprungprobe-Auftrag NICHT gespeichert auf {@code ems/{t}/{s}/{d}/v2/sprungprobe} (UEMS AP-15
 * IP-21; Muster {@link VerbundAnteilePublisher}). Wird nur vom {@link SprungprobeDienst} gerufen — und der ruft nur
 * auf den Handgriff der Plattform-Rolle an einer Anlage MIT Gemeinsamer Steuerung: eine Bestandsbox bekommt nie eins.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class SprungprobePublisher implements SprungprobeVersand {

    private static final Logger log = LoggerFactory.getLogger(SprungprobePublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final BrokerVerbindung verbindung;

    public SprungprobePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.verbindung = new BrokerVerbindung(log, "sprungprobe", brokerUrl,
                "voltpilot-api-sprungprobe-" + UUID.randomUUID(), true, username, password, null, null);
    }

    @Override
    public synchronized boolean senden(String topic, byte[] nutzlast) {
        try {
            MqttMessage message = new MqttMessage(nutzlast);
            message.setQos(1);
            message.setRetained(false);
            verbindung.verbundenerClient().publish(topic, message).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("published sprungprobe to {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish sprungprobe to {}: {} (bleibt ungesendet)", topic, e.getMessage());
            return false;
        }
    }

    @PreDestroy
    public void close() {
        verbindung.schliessen();
    }
}
