package com.voltpilot.api.ota;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
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
 * Der Verteilweg des SOLL-Stands: eine Zuweisung geht RETAINED (QoS1) auf
 * {@code ems/{t}/{s}/{d}/v2/update} (Kontrakt:
 * {@code docs/contracts/mqtt-ota-target.schema.json}, OTA Stufe 2).
 *
 * <p><b>Retained ist der ganze Verteilmechanismus, nicht eine Optimierung.</b>
 * Hinter NAT gibt es keinen Push; ein Gerät, das während des Rollout-Starts
 * offline war, holt seine Zuweisung beim nächsten Verbindungsaufbau selbst ab.
 * Genau deshalb ist {@code published_at} in der DB auch kein „zugestellt".
 *
 * <p><b>Die Manifest-Bytes werden NIE neu serialisiert.</b> Sie kommen als
 * {@code text} aus {@code edge_release.manifest} - genau die Bytes, über die
 * der Owner unterschrieben hat - und gehen base64-kodiert in den Umschlag. Der
 * Umschlag selbst wird aus genau diesem Grund von Hand zusammengesetzt statt
 * über einen Objekt-Mapper: ein serialisiertes Manifest-OBJEKT wäre eine
 * Re-Serialisierung, und die macht die Signatur lautlos unprüfbar.
 *
 * <p><b>Best-effort wie jeder Broker-Kontakt hier</b> ({@code
 * ProvisioningPublisher}/{@code EntityRegistryPublisher}): eine Zuweisung wird
 * niemals wegen eines Broker-Ausfalls abgelehnt - sie steht in der DB, und der
 * Drift-Wächter veröffentlicht sie nach. Rides denselben Broker-Schalter wie
 * die Provisionierung, also kein neuer Deployment-Knopf.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class OtaTargetPublisher {

    private static final Logger log = LoggerFactory.getLogger(OtaTargetPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private final BrokerVerbindung verbindung;

    public OtaTargetPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.verbindung = new BrokerVerbindung(log, "OTA target", brokerUrl,
                "voltpilot-api-otatarget-" + UUID.randomUUID(), true, username, password, null, null);
    }

    /**
     * Stößt den Erstaufbau beim Start nur AN, blockiert den Start-Thread nie (Review-Fix: ein beim api-Start
     * fehlender Broker hätte den Start sonst um bis zu {@link BrokerVerbindung#ZEITGRENZE_MS} je Weg verlängert -
     * Risiko einer Neustart-Schleife der {@code startupProbe}). Der erste Versand wartet dafür selbst begrenzt auf
     * den Erstaufbau ({@link BrokerVerbindung#verbundenerClient()}, wie vor der Migration das synchrone
     * {@code MqttClient.connect()}); danach wartet kein Senden mehr auf die Verbindung, und Paho verbindet selbst
     * neu.
     */
    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        verbindung.sicherstellen();
    }

    /**
     * Das Update-Topic eines Geräts - im {@code v2/#}-Teilbaum, den die
     * per-Gerät-ACL bereits abdeckt (D-2), also ohne Broker-Änderung.
     */
    public static String updateTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/update";
    }

    /** Die Zuweisung eines Geräts retained veröffentlichen. */
    public synchronized boolean publishTarget(UUID tenantId, UUID siteId, UUID deviceId,
            String release, long releaseSeq, UUID rolloutId,
            String manifest, String signature, Instant assignedAt) {
        String topic = updateTopic(tenantId, siteId, deviceId);
        byte[] payload = envelope(tenantId, siteId, deviceId, release, releaseSeq,
                rolloutId, manifest, signature, assignedAt);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            verbindung.verbundenerClient().publish(topic, message).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("published OTA target {} (seq {}) retained to {}", release, releaseSeq, topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish OTA target {} to {}: {} (best-effort - the drift "
                    + "watcher republishes once the broker is reachable)", release, topic,
                    e.getMessage());
            return false;
        }
    }

    /**
     * Die Zuweisung eines Geräts zurücknehmen (leere retained Nachricht).
     *
     * <p>Der Unclaim-Pfad ruft das mit: ein Gerät, das niemandem mehr gehört,
     * darf keine Anweisung behalten, die auf dem Broker auf seine Rückkehr
     * wartet - dieselbe Hygiene wie beim retained Provisionierungs-Config und
     * beim Entity-Push.
     */
    public synchronized boolean clearTarget(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = updateTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage(new byte[0]);
            empty.setQos(1);
            empty.setRetained(true);
            verbindung.verbundenerClient().publish(topic, empty).waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            log.info("cleared retained OTA target on {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not clear retained OTA target on {}: {}", topic, e.getMessage());
            return false;
        }
    }



    /**
     * Baut den Umschlag - von Hand, damit die Manifest-Bytes GARANTIERT
     * unverändert durchgehen (siehe Klassen-Doku). Nur die base64-Blöcke und
     * die Kopfdaten werden zusammengesetzt; die Zeichenketten werden mit
     * Jacksons Escaper abgesichert, damit kein Wert den JSON-Rahmen sprengen
     * kann.
     */
    static byte[] envelope(UUID tenantId, UUID siteId, UUID deviceId, String release,
            long releaseSeq, UUID rolloutId, String manifest, String signature,
            Instant assignedAt) {
        Base64.Encoder b64 = Base64.getEncoder();
        StringBuilder sb = new StringBuilder(manifest.length() * 2 + 512);
        sb.append("{\"schema_version\":\"1.0\",\"type\":\"update_target\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"')
                .append(",\"release\":\"").append(esc(release)).append('"')
                .append(",\"release_seq\":").append(releaseSeq);
        if (rolloutId != null) {
            sb.append(",\"rollout_id\":\"").append(rolloutId).append('"');
        }
        if (assignedAt != null) {
            sb.append(",\"assigned_at\":\"").append(assignedAt).append('"');
        }
        sb.append(",\"manifest_b64\":\"")
                .append(b64.encodeToString(manifest.getBytes(StandardCharsets.UTF_8))).append('"')
                .append(",\"signature_b64\":\"")
                .append(b64.encodeToString(signature.getBytes(StandardCharsets.UTF_8))).append('"')
                .append('}');
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String esc(String s) {
        return new String(JsonStringEncoder.getInstance().quoteAsString(s));
    }

    @PreDestroy
    void close() {
        verbindung.schliessen();
    }
}
