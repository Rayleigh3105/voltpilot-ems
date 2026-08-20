package com.voltpilot.api.registerwrite;

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
 * Legt EINEN Register-Auftrag auf {@code ems/{t}/{s}/{d}/v2/register-write} -
 * NICHT retained, QoS1 (Kontrakt
 * {@code docs/contracts/mqtt-register-write.schema.json}).
 *
 * <p><b>⚠ NICHT-RETAINED IST DIE TRAGENDE ENTSCHEIDUNG</b>, und hier wiegt sie
 * schwerer als bei der Einmal-Freigabe: eine retained Nachricht wird bei JEDEM
 * Verbindungsaufbau erneut zugestellt, ein retained Schreib-Auftrag wäre also
 * ein EEPROM-Schreibzyklus je Reconnect. <b>Nicht-retained allein genügt
 * nicht</b> - die Box hält eine dauerhafte Sitzung ({@code cleanSession=false}),
 * der Broker darf eine QoS1-Nachricht also nachliefern. Die zweite Hälfte ist
 * {@code requested_at}: die Box übernimmt diesen Stempel als Beginn ihres
 * Fensters statt der Empfangszeit, eine nachgelieferte Anfrage ist bei Ankunft
 * also bereits verfallen. Die dritte ist die {@code request_id}, die sich die
 * Box als zuletzt ausgeführte merkt.
 *
 * <p><b>Nicht best-effort:</b> anders als der OTA-Zuweisungs-Publisher (dort ist
 * die DB die Wahrheit und ein Wächter veröffentlicht nach) IST diese Nachricht
 * der Auftrag. Geht sie nicht hinaus, wurde nichts angefordert - und genau das
 * muss der wartende Aufrufer erfahren, statt in einen Timeout über einen Auftrag
 * zu laufen, der das Haus nie verlassen hat. Aus demselben Grund entsteht dann
 * auch KEINE Journal-Zeile (die Reihenfolge des OTA-Apply: erst veröffentlichen,
 * dann protokollieren).
 *
 * <p>Der Umschlag wird von HAND zusammengesetzt wie bei seinen Geschwistern
 * ({@code ProbePublisher}, {@code OtaTargetPublisher}) - dieselbe Klasse
 * Nachricht, derselbe Grund, einem Objekt-Mapper nicht die Gelegenheit zu geben,
 * die reisende Form umzuformen.
 *
 * <p>Reitet auf {@code voltpilot.provisioning.*} (demselben Broker wie
 * Provisionierung, Registry-Push, OTA-Verteilung und Probe-Kanal), damit dieses
 * Feature keinen eigenen, per Vorgabe ausgeschalteten Transport-Schalter
 * braucht, der im gitops-Repo nachgezogen werden müsste.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class RegisterWritePublisher {

    private static final Logger log = LoggerFactory.getLogger(RegisterWritePublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public RegisterWritePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /** Das Auftrags-Topic eines Geräts - im {@code v2/#}-Teilbaum, den die per-Gerät-ACL längst deckt (D-2). */
    public static String requestTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/register-write";
    }

    /** Das Topic, auf dem die Box quittiert. */
    public static String resultTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/register-write-result";
    }

    /**
     * Ein Auftrag, wie er auf den Draht geht. {@code value}/{@code confirm} sind
     * bei einer Vorschau {@code null} - ein Umschlag, der beim Lesen einen Wert
     * mitführt, wäre eine widersprüchliche Anweisung, und der Kontrakt verbietet
     * ihn.
     */
    public record Order(String mode, String lane, UUID entityId, String host, Integer port,
            Integer unitId, String registerKind, int address, Integer writeFc, Integer value,
            Integer expectedBefore, String confirm) {

        /** Die Lane-Wörter des Kontrakts (die Cloud-Seite nennt sie deutsch im Journal). */
        public static final String LANE_PRIMARY = "primary";
        public static final String LANE_ENTITY = "entity";
        public static final String LANE_LAN = "lan";
    }

    /** Veröffentlicht einen Auftrag. Wirft, wenn er nicht hinausging. */
    public synchronized void publish(UUID tenantId, UUID siteId, UUID deviceId, String requestId,
            Instant requestedAt, String requestedBy, Order order) throws Exception {
        MqttMessage message = new MqttMessage(
                envelope(tenantId, siteId, deviceId, requestId, requestedAt, requestedBy, order));
        message.setQos(1);
        message.setRetained(false);
        connected().publish(requestTopic(tenantId, siteId, deviceId), message);
        // ⚠ Die LAN-Adresse des Kunden wird bewusst NICHT protokolliert (die
        // Probe-Regel): sie ist Netz-Topologie und erscheint auf diesem Pfad in
        // keiner anderen Zeile. Register und Modus schon - sie sind die
        // Betriebs-Tatsache, um die es hier geht.
        // ⚠ DAS GERÄT GEHÖRT IN DIESE ZEILE (Produktionsvorfall 20.08.2026): ohne
        // es sagt das Protokoll „veröffentlicht", aber nicht WOHIN - und genau
        // die Frage „auf welchem Geräte-Pfad lag der Auftrag?" war danach aus
        // dem Protokoll allein nicht mehr zu beantworten. Es ist keine
        // Kunden-Information, sondern die Kennung, die ohnehin in jeder zweiten
        // Zeile dieses Pfades steht; die LAN-Adresse bleibt draußen (die
        // Probe-Regel).
        log.info("register write {} ({}) an Gerät {} auf Register {} veröffentlicht "
                + "(NICHT retained, Lane {})",
                requestId, order.mode(), deviceId, RegisterKnowledge.hex(order.address()),
                order.lane());
    }

    static byte[] envelope(UUID tenantId, UUID siteId, UUID deviceId, String requestId,
            Instant requestedAt, String requestedBy, Order o) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\"schema_version\":\"1.0\",\"type\":\"register_write_request\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"')
                .append(",\"request_id\":\"").append(esc(requestId)).append('"')
                .append(",\"requested_at\":\"").append(requestedAt).append('"');
        if (requestedBy != null && !requestedBy.isBlank()) {
            sb.append(",\"requested_by\":\"").append(esc(requestedBy)).append('"');
        }
        sb.append(",\"mode\":\"").append(esc(o.mode())).append('"')
                .append(",\"target\":{\"kind\":\"").append(esc(o.lane())).append('"');
        if (Order.LANE_ENTITY.equals(o.lane()) && o.entityId() != null) {
            sb.append(",\"entity_id\":\"").append(o.entityId()).append('"');
        }
        if (Order.LANE_LAN.equals(o.lane())) {
            sb.append(",\"host\":\"").append(esc(o.host() == null ? "" : o.host().trim())).append('"');
            if (o.port() != null) {
                sb.append(",\"port\":").append(o.port());
            }
            if (o.unitId() != null) {
                sb.append(",\"unit_id\":").append(o.unitId());
            }
        }
        sb.append("},\"register\":{\"kind\":\"").append(esc(o.registerKind()))
                .append("\",\"address\":").append(o.address()).append('}');
        if (o.writeFc() != null) {
            sb.append(",\"write_fc\":").append(o.writeFc());
        }
        if (o.value() != null) {
            sb.append(",\"value\":").append(o.value());
        }
        if (o.expectedBefore() != null) {
            sb.append(",\"expected_before\":").append(o.expectedBefore());
        }
        if (o.confirm() != null && !o.confirm().isBlank()) {
            sb.append(",\"confirm\":\"").append(esc(o.confirm())).append('"');
        }
        sb.append('}');
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String esc(String s) {
        return new String(JsonStringEncoder.getInstance().quoteAsString(s));
    }

    private MqttClient connected() throws Exception {
        if (client != null && client.isConnected()) {
            return client;
        }
        if (client == null) {
            client = new MqttClient(brokerUrl,
                    "voltpilot-api-register-write-" + UUID.randomUUID(), new MemoryPersistence());
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
    void close() {
        if (client != null) {
            try {
                if (client.isConnected()) {
                    client.disconnect();
                }
                client.close();
            } catch (Exception e) {
                log.debug("closing register-write publisher: {}", e.getMessage());
            }
        }
    }
}
