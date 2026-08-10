package com.voltpilot.api.control;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
import com.voltpilot.api.repo.ControlCertificationRepository.Certification;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
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
 * Der Verteilweg der Steuerungs-Zertifizierung: das Plattform-Register plus die
 * Scharfschaltung dieser Anlage gehen RETAINED (QoS1) auf
 * {@code ems/{t}/{s}/{d}/v2/control-certification} (Kontrakt
 * {@code docs/contracts/mqtt-control-certification.schema.json}).
 *
 * <p><b>Retained ist der ganze Verteilmechanismus</b>, wie bei der
 * OTA-Zuweisung: hinter NAT gibt es keinen Push, also holt sich eine Box, die
 * beim Scharfschalten offline war, das Dokument beim nächsten Verbindungsaufbau
 * selbst ab. Das Topic liegt im {@code v2/#}-Teilbaum, den die per-Gerät-ACL
 * längst abdeckt (D-2) - keine Broker-Änderung.
 *
 * <p><b>Das Dokument autorisiert nichts an der Physik.</b> Es öffnet
 * ausschließlich dasselbe Zertifizierungs-Tor, das die env-Allowlist und die
 * gerätelokale First-Light-Freigabe bereits öffnen; Not-Aus, Guard-Kette und
 * jede Layer-1-Regel binden unverändert. Und die ENTSCHEIDUNG fällt auf dem
 * Gerät: die Cloud sagt, welche Modelle gedeckt sind, das Gerät vergleicht das
 * mit seiner EIGENEN Auswahl (die OTA-Sidecar-Disziplin).
 *
 * <p><b>Best-effort wie jeder Broker-Kontakt hier</b> ({@code
 * ProvisioningPublisher}/{@code OtaTargetPublisher}): eine Scharfschaltung wird
 * nie wegen eines Broker-Ausfalls abgelehnt - sie steht in der DB, und der
 * Startup-Abgleich veröffentlicht sie nach. Reitet auf demselben
 * Broker-Schalter wie die Provisionierung, also kein neuer Deployment-Knopf.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ControlCertificationPublisher {

    private static final Logger log = LoggerFactory.getLogger(ControlCertificationPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public ControlCertificationPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** Das Zertifizierungs-Topic eines Geräts (v2/#-Teilbaum, D-2). */
    public static String certificationTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/control-certification";
    }

    /**
     * Veröffentlicht Register + Scharfschaltung für EIN Gerät.
     *
     * @return false, wenn der Broker nicht erreichbar war (best-effort)
     */
    public synchronized boolean publish(UUID tenantId, UUID siteId, UUID deviceId,
            boolean activated, List<Certification> register, Instant publishedAt) {
        String topic = certificationTopic(tenantId, siteId, deviceId);
        byte[] payload = document(tenantId, siteId, deviceId, activated, register, publishedAt);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic, message);
            log.info("published control certification (activated={}, {} certified models) retained to {}",
                    activated, register.size(), topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish control certification to {}: {} (best-effort - the startup "
                    + "reconcile republishes once the broker is reachable)", topic, e.getMessage());
            return false;
        }
    }

    /**
     * Nimmt das Dokument zurück (leere retained Nachricht).
     *
     * <p>Der Unclaim-Pfad ruft das: ein Gerät, das niemandem mehr gehört, darf
     * keine Freigabe behalten, die auf dem Broker auf seine Rückkehr wartet -
     * dieselbe Hygiene wie beim retained Provisionierungs-Config, beim
     * Entity-Push und bei der OTA-Zuweisung.
     */
    public synchronized boolean clear(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = certificationTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage(new byte[0]);
            empty.setQos(1);
            empty.setRetained(true);
            connected().publish(topic, empty);
            log.info("cleared retained control certification on {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not clear retained control certification on {}: {}", topic, e.getMessage());
            return false;
        }
    }

    /**
     * Baut das Dokument. Von Hand zusammengesetzt wie die OTA-Umschläge - es ist
     * dieselbe Klasse von Nachricht (eine Anweisung an eine laufende
     * Kundenanlage), und jede Zeichenkette geht durch Jacksons Escaper, damit
     * kein Registerwert den JSON-Rahmen sprengen kann.
     */
    static byte[] document(UUID tenantId, UUID siteId, UUID deviceId, boolean activated,
            List<Certification> register, Instant publishedAt) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\"schema_version\":\"1.0\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"')
                .append(",\"activated\":").append(activated)
                .append(",\"certified_models\":[");
        for (int i = 0; i < register.size(); i++) {
            Certification c = register.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append("{\"brand\":\"").append(esc(c.brand()))
                    .append("\",\"model\":\"").append(esc(c.model()))
                    .append("\",\"family\":\"").append(esc(c.family())).append('"');
            if (c.controlPath() != null && !c.controlPath().isBlank()) {
                sb.append(",\"control_path\":\"").append(esc(c.controlPath())).append('"');
            }
            // ⚠ NULL wird WEGGELASSEN, nie als false gesendet: absent heisst
            // "der Pruefstand hat die Vorzeichenfrage nicht beantwortet", false
            // heisst "er hat sie beantwortet". Das Geraet prueft nur den
            // zweiten Fall.
            if (c.invertControlSign() != null) {
                sb.append(",\"invert_control_sign\":").append(c.invertControlSign().booleanValue());
            }
            sb.append(",\"certified_at\":\"").append(c.certifiedAt()).append('"');
            if (c.firmwareNote() != null && !c.firmwareNote().isBlank()) {
                sb.append(",\"firmware_note\":\"").append(esc(c.firmwareNote())).append('"');
            }
            if (c.note() != null && !c.note().isBlank()) {
                sb.append(",\"note\":\"").append(esc(c.note())).append('"');
            }
            sb.append('}');
        }
        sb.append("],\"published_at\":\"").append(publishedAt).append("\"}");
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String esc(String v) {
        return v == null ? "" : new String(JsonStringEncoder.getInstance().quoteAsString(v));
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-controlcert-" + UUID.randomUUID(),
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
    public synchronized void close() {
        if (client == null) {
            return;
        }
        try {
            if (client.isConnected()) {
                client.disconnect();
            }
        } catch (Exception e) {
            log.debug("control-certification publisher disconnect failed: {}", e.getMessage());
        }
        try {
            client.close(true);
        } catch (Exception e) {
            log.debug("control-certification publisher close failed: {}", e.getMessage());
        }
        client = null;
    }
}
