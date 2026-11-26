package com.voltpilot.api.direktvermarktung;

import com.voltpilot.api.provisioning.BrokerVerbindung;
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
 * Der Broker-Weg der Direktvermarktungs-Zustellung (Vertrag
 * {@code docs/contracts/v2/direktvermarktung-zustellung.md} §1): das Partnerprofil RETAINED auf
 * {@code ems/{t}/{s}/{d}/v2/direktvermarktung} (leer = Rückzug; hinter NAT gibt es keinen Push, eine offline
 * gewesene Box holt sich den Stand beim Verbindungsaufbau selbst ab), die Einmal-Zugangsantwort NICHT
 * retained auf {@code …/v2/direktvermarktung-zugang} - Schlüsselmaterial liegt nie beim Broker.
 *
 * <p>Best-effort wie {@code ControlCertificationPublisher}: nichts wird wegen eines Broker-Ausfalls
 * abgelehnt - der Zustell-Abgleich ({@code DirektvermarktungZustellung}) veröffentlicht nach. Kein Byte
 * einer Nutzlast erscheint in einem Log; geloggt werden Topic und Länge, beim Zugang nicht einmal die.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class DirektvermarktungPublisher {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungPublisher.class);

    private final BrokerVerbindung verbindung;

    public DirektvermarktungPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.verbindung = new BrokerVerbindung(log, "direktvermarktung zustellung", brokerUrl,
                "voltpilot-api-direktvermarktung-" + UUID.randomUUID(), true, username, password, null, null);
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        verbindung.sicherstellen();
    }

    public static String profilTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/direktvermarktung";
    }

    public static String zugangTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/direktvermarktung-zugang";
    }

    /** Veröffentlicht das Profil-Dokument retained an EINE Box. */
    public boolean publishProfil(UUID tenantId, UUID siteId, UUID deviceId, byte[] dokument) {
        return publish(profilTopic(tenantId, siteId, deviceId), dokument, true, "profil");
    }

    /** Zieht das Profil zurück (leere retained Nachricht); die Box löscht und quittiert {@code geloescht}. */
    public boolean clearProfil(UUID tenantId, UUID siteId, UUID deviceId) {
        return publish(profilTopic(tenantId, siteId, deviceId), new byte[0], true, "profil-rueckzug");
    }

    /** Die Einmal-Zugangsantwort, NICHT retained. */
    public boolean publishZugang(UUID tenantId, UUID siteId, UUID deviceId, byte[] antwort) {
        return publish(zugangTopic(tenantId, siteId, deviceId), antwort, false, "zugang");
    }

    private boolean publish(String topic, byte[] payload, boolean retained, String art) {
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(retained);
            verbindung.verbundenerClient().publish(topic, message).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("direktvermarktung: {} an {} gesendet", art, topic);
            return true;
        } catch (Exception e) {
            log.warn("direktvermarktung: {} an {} nicht gesendet: {} (best-effort, der Abgleich holt es nach)",
                    art, topic, e.getMessage());
            return false;
        }
    }
}
