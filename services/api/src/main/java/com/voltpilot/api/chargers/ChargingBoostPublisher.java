package com.voltpilot.api.chargers;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
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
 * Der Verteilweg der Übersteuerung „Jetzt voll laden": NICHT-RETAINED (QoS1)
 * auf {@code ems/{t}/{s}/{d}/v2/charging-boost} (Kontrakt
 * {@code docs/contracts/mqtt-charging-boost.schema.json}).
 *
 * <p><b>⚠ NICHT-RETAINED ist die tragende Entscheidung</b> - und der Grund, aus
 * dem dies ein EIGENER Publisher neben {@link ChargingConfigPublisher} ist: eine
 * retained Nachricht wird bei JEDEM Verbindungsaufbau erneut zugestellt, eine
 * Einmal-Übersteuerung wäre damit keine (sie setzte ein Fahrzeug beliebig oft
 * erneut auf Netzstrom). Dieselbe Trennung wie zwischen der OTA-Zuweisung
 * (retained) und der OTA-Freigabe (nicht retained).
 *
 * <p><b>Die zweite Hälfte ist {@code requested_at}</b>: die Box hält eine
 * dauerhafte Sitzung, der Broker darf also NACHLIEFERN. Das Gerät nimmt diesen
 * Stempel als Beginn seines Fensters, also ist eine nachgelieferte Nachricht bei
 * der Ankunft bereits abgelaufen und wird verworfen.
 *
 * <p><b>Sie ist keine Grenze.</b> Sie nimmt EINEN laufenden Ladevorgang von der
 * Quellen-Politik aus; Anschlussgrenze, Sicherheitsabstand, §14a, Vorrang und
 * das in der Säule hinterlegte Ausfall-Profil binden ihn danach unverändert -
 * und die Priorität aller anderen Ladevorgänge bleibt, wie sie ist.
 *
 * <p><b>NICHT best-effort</b>, anders als der Konfigurations-Push: die Nachricht
 * IST die Freigabe. Geht sie nicht hinaus, darf keine Zusage entstehen - der
 * Aufrufer meldet das ehrlich (dieselbe Regel wie beim Register-Schreiben).
 * Reitet auf demselben Broker-Schalter wie die Provisionierung.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ChargingBoostPublisher {

    private static final Logger log = LoggerFactory.getLogger(ChargingBoostPublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public ChargingBoostPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** Das Übersteuerungs-Topic eines Geräts (v2/#-Teilbaum, D-2). */
    public static String boostTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/charging-boost";
    }

    /**
     * Schickt EINE Übersteuerung (oder ihre Rücknahme) an ein Gerät.
     *
     * @return false, wenn der Broker nicht erreichbar war - dann gibt es keine
     *         Freigabe, und der Aufrufer sagt das
     */
    public synchronized boolean publish(UUID tenantId, UUID siteId, UUID deviceId,
            String chargePointId, int connectorId, Integer minutes, boolean cancel,
            String actor, Instant requestedAt) {
        String topic = boostTopic(tenantId, siteId, deviceId);
        byte[] payload = document(tenantId, siteId, deviceId, chargePointId, connectorId, minutes,
                cancel, actor, requestedAt);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(false);
            connected().publish(topic, message);
            log.info("published charging boost ({}#{}, cancel={}) to {}", chargePointId,
                    connectorId, cancel, topic);
            return true;
        } catch (Exception e) {
            log.warn("could not publish charging boost to {}: {}", topic, e.getMessage());
            return false;
        }
    }

    /** Baut den Umschlag von Hand - dieselbe Klasse Nachricht wie die OTA-Freigabe. */
    static byte[] document(UUID tenantId, UUID siteId, UUID deviceId, String chargePointId,
            int connectorId, Integer minutes, boolean cancel, String actor, Instant requestedAt) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("{\"schema_version\":\"1.0\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"')
                .append(",\"charge_point_id\":\"").append(esc(chargePointId)).append('"')
                .append(",\"connector_id\":").append(connectorId);
        if (minutes != null) {
            sb.append(",\"minutes\":").append(minutes.intValue());
        }
        if (cancel) {
            sb.append(",\"cancel\":true");
        }
        sb.append(",\"requested_at\":\"").append(requestedAt).append('"');
        if (actor != null && !actor.isBlank()) {
            sb.append(",\"actor\":\"").append(esc(actor)).append('"');
        }
        return sb.append('}').toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String esc(String v) {
        return v == null ? "" : new String(JsonStringEncoder.getInstance().quoteAsString(v));
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-chargingboost-" + UUID.randomUUID(),
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
            log.debug("charging boost publisher close failed: {}", e.getMessage());
        }
        client = null;
    }
}
