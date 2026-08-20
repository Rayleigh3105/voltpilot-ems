package com.voltpilot.api.chargers;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
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
 * Der Verteilweg der Lastmanagement-Konfiguration: Anschlussgrenze + Vorrang
 * gehen RETAINED (QoS1) auf {@code ems/{t}/{s}/{d}/v2/charging-config} (Kontrakt
 * {@code docs/contracts/mqtt-charging-config.schema.json}).
 *
 * <p><b>Retained ist der ganze Verteilmechanismus</b>, wie bei der
 * OTA-Zuweisung und der Steuerungs-Zertifizierung: hinter NAT gibt es keinen
 * Push, also holt sich eine Box, die beim Speichern offline war, ihre
 * Einstellung beim nächsten Verbindungsaufbau selbst ab. Das Topic liegt im
 * {@code v2/#}-Teilbaum, den die per-Gerät-ACL längst abdeckt (D-2) - KEINE
 * Broker-Änderung.
 *
 * <p><b>Das Dokument ist ein WUNSCH, keine Verteilung.</b> Gerechnet und
 * durchgesetzt wird weiter auf der Box (die Anschlussgrenze ist eine physische
 * Grenze, ihr Wächter darf nicht am WAN hängen - Konzept E1). Es entsteht kein
 * zweiter Verteiler und kein zweiter Schreibpfad auf eine Ladesäule.
 *
 * <p><b>⚠ Ein abwesendes Feld wird WEGGELASSEN, nie als Vorgabe gesendet</b>
 * (PATCH-Semantik des Kontrakts): das Portal besitzt heute nur die
 * Anschlussgrenze und die Vorrang-Wahl, alles andere bleibt Einstellung der Box
 * - ein Dokument, das sie stillschweigend zurücksetzte, wäre ein Datenverlust
 * ohne Absicht. Eine LEERE Vorrang-Liste ist dagegen eine Aussage und reist mit.
 *
 * <p>Best-effort wie jeder Broker-Kontakt hier: eine gespeicherte Grenze wird
 * nie wegen eines Broker-Ausfalls abgelehnt - sie steht in der DB und geht beim
 * nächsten Speichern erneut hinaus. Reitet auf demselben Broker-Schalter wie
 * die Provisionierung, also kein neuer Deployment-Knopf.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ChargingConfigPublisher {

    private static final Logger log = LoggerFactory.getLogger(ChargingConfigPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public ChargingConfigPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** Das Konfigurations-Topic eines Geräts (v2/#-Teilbaum, D-2). */
    public static String configTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/charging-config";
    }

    /**
     * Veröffentlicht die Konfiguration für EIN Gerät.
     *
     * @param gridLimitKw die Anschlussgrenze, oder null = das Portal äußert
     *                    sich nicht und die Box behält ihre eigene Zahl
     * @param priorities  die Vorrang-Säulen (leer = ausdrücklich keine), oder
     *                    null = keine Aussage
     * @return false, wenn der Broker nicht erreichbar war (best-effort)
     */
    public synchronized boolean publish(UUID tenantId, UUID siteId, UUID deviceId,
            Double gridLimitKw, List<String> priorities, Instant publishedAt) {
        String topic = configTopic(tenantId, siteId, deviceId);
        byte[] payload = document(tenantId, siteId, deviceId, gridLimitKw, priorities, publishedAt);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic, message);
            log.info("published charging config (grid_limit_kw={}, {} priority stations) retained to {}",
                    gridLimitKw, priorities == null ? "-" : priorities.size(), topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish charging config to {}: {} (best-effort - the next save "
                    + "republishes it)", topic, e.getMessage());
            return false;
        }
    }

    /**
     * Nimmt das Dokument zurück (leere retained Nachricht) - der Unclaim-Pfad:
     * ein Gerät, das niemandem mehr gehört, darf keine Einstellung behalten, die
     * auf dem Broker auf seine Rückkehr wartet (dieselbe Hygiene wie beim
     * Provisionierungs-Config, dem Entity-Push und der OTA-Zuweisung).
     */
    public synchronized boolean clear(UUID tenantId, UUID siteId, UUID deviceId) {
        String topic = configTopic(tenantId, siteId, deviceId);
        try {
            MqttMessage empty = new MqttMessage(new byte[0]);
            empty.setQos(1);
            empty.setRetained(true);
            connected().publish(topic, empty);
            log.info("cleared retained charging config on {}", topic);
            return true;
        } catch (Exception e) {
            log.warn("could not clear retained charging config on {}: {}", topic, e.getMessage());
            return false;
        }
    }

    /**
     * Baut das Dokument. Von Hand zusammengesetzt wie die OTA-Umschläge - es ist
     * dieselbe Klasse von Nachricht (eine Einstellung für eine laufende
     * Kundenanlage), und jede Zeichenkette geht durch Jacksons Escaper, damit
     * keine ChargePointId den JSON-Rahmen sprengen kann.
     */
    static byte[] document(UUID tenantId, UUID siteId, UUID deviceId, Double gridLimitKw,
            List<String> priorities, Instant publishedAt) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"schema_version\":\"1.0\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"');
        // ⚠ Abwesend heisst "dazu sagt das Portal nichts" - nie "keine Grenze".
        if (gridLimitKw != null) {
            sb.append(",\"grid_limit_kw\":").append(trim(gridLimitKw));
        }
        if (priorities != null) {
            sb.append(",\"priority_charge_point_ids\":[");
            for (int i = 0; i < priorities.size(); i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append('"').append(esc(priorities.get(i))).append('"');
            }
            sb.append(']');
        }
        sb.append(",\"published_at\":\"").append(publishedAt).append("\"}");
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** Ganze Zahlen ohne Nachkomma - 277 statt 277.0 im Kunden-Dokument. */
    private static String trim(double v) {
        if (v == Math.rint(v) && !Double.isInfinite(v)) {
            return String.valueOf((long) v);
        }
        return String.valueOf(v);
    }

    private static String esc(String v) {
        return v == null ? "" : new String(JsonStringEncoder.getInstance().quoteAsString(v));
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-chargingcfg-" + UUID.randomUUID(),
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
            client.close(true);
        } catch (Exception e) {
            log.debug("charging config publisher close failed: {}", e.getMessage());
        }
        client = null;
    }
}
