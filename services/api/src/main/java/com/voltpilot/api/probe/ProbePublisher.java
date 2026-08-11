package com.voltpilot.api.probe;

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
 * Puts ONE probe on {@code ems/{t}/{s}/{d}/v2/probe} - NON-retained, QoS1
 * (contract {@code docs/contracts/mqtt-probe.schema.json}).
 *
 * <p><b>⚠ NON-retained is the load-bearing decision, exactly as for the one-shot
 * apply approval.</b> A retained message is redelivered on EVERY reconnect, so a
 * one-shot preview placed there would knock on the customer's device again and
 * again for as long as it sat on the broker. It therefore does NOT live on any
 * retained slot, and a box that was offline deliberately never gets a missed
 * probe delivered late.
 *
 * <p><b>Nor is non-retained enough by itself:</b> the box holds a durable session
 * ({@code cleanSession=false}), so the broker MAY redeliver a QoS1 message after
 * an outage. That is what {@code requested_at} is for - the box adopts this
 * stamp as the start of its own expiry window instead of the arrival time, so a
 * late delivery is already expired when it lands.
 *
 * <p>Unlike the OTA assignment this is NOT best-effort: there the DB is the
 * truth and a watcher republishes; here the message IS the question, and a
 * caller blocked on the answer has to learn that it never went out.
 *
 * <p>The envelope is assembled by hand like its siblings
 * ({@code OtaTargetPublisher}) - same class of message, same reason not to hand
 * a mapper the chance to reshape what travels.
 *
 * <p>Rides {@code voltpilot.provisioning.*} (the broker the provisioning,
 * registry-push and OTA distribution already use), so this feature adds no
 * deployment switch of its own.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class ProbePublisher {

    private static final Logger log = LoggerFactory.getLogger(ProbePublisher.class);

    private final String brokerUrl;
    private final String username;
    private final String password;

    private MqttClient client;

    public ProbePublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
    }

    /**
     * The probe topic of a device - in the {@code v2/#} subtree the per-device
     * ACL already covers (D-2), so no broker change.
     */
    public static String probeTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/probe";
    }

    /** The topic the device answers on. */
    public static String resultTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/probe-result";
    }

    /**
     * Publish one probe. Throws when it could not go out - the caller is
     * blocked on the answer and must not be told a question was asked that
     * never left the building.
     */
    public synchronized void publish(UUID tenantId, UUID siteId, UUID deviceId,
            String requestId, Instant requestedAt, String requestedBy,
            List<ProbeRequest.Op> ops) throws Exception {
        String topic = probeTopic(tenantId, siteId, deviceId);
        MqttMessage message = new MqttMessage(
                envelope(tenantId, siteId, deviceId, requestId, requestedAt, requestedBy, ops));
        message.setQos(1);
        message.setRetained(false);
        connected().publish(topic, message);
        // ⚠ The customer's LAN address is deliberately NOT logged: it is their
        // network topology, it appears in no other log line on this path, and a
        // preview is not worth a permanent record of where their devices sit.
        log.debug("published probe {} ({} ops, NON-retained)", requestId, ops.size());
    }

    static byte[] envelope(UUID tenantId, UUID siteId, UUID deviceId, String requestId,
            Instant requestedAt, String requestedBy, List<ProbeRequest.Op> ops) {
        StringBuilder sb = new StringBuilder(512);
        sb.append("{\"schema_version\":\"1.0\",\"type\":\"probe_request\"")
                .append(",\"tenant_id\":\"").append(tenantId).append('"')
                .append(",\"site_id\":\"").append(siteId).append('"')
                .append(",\"device_id\":\"").append(deviceId).append('"')
                .append(",\"request_id\":\"").append(esc(requestId)).append('"')
                .append(",\"requested_at\":\"").append(requestedAt).append('"');
        if (requestedBy != null && !requestedBy.isBlank()) {
            sb.append(",\"requested_by\":\"").append(esc(requestedBy)).append('"');
        }
        sb.append(",\"ops\":[");
        for (int i = 0; i < ops.size(); i++) {
            ProbeRequest.Op op = ops.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append("{\"op\":\"read\",\"transport\":\"modbus_tcp\"")
                    .append(",\"id\":\"").append(esc(op.id())).append('"')
                    .append(",\"host\":\"").append(esc(op.host().trim())).append('"')
                    .append(",\"port\":").append(op.port() == null ? 502 : op.port())
                    .append(",\"unit_id\":").append(op.unitId() == null ? 1 : op.unitId())
                    .append(",\"register_kind\":\"").append(esc(op.registerKind())).append('"')
                    .append(",\"address\":").append(op.address())
                    .append(",\"data_type\":\"").append(esc(op.dataType())).append('"')
                    .append(",\"word_order\":\"")
                    .append(op.wordOrder() == null || op.wordOrder().isBlank()
                            ? "big" : esc(op.wordOrder()))
                    .append('"');
            // scale/offset are DISPLAY arithmetic: omitted when not asked for,
            // so raw == value reads as "no scaling was requested" rather than
            // as "scaled by 1", which is a different statement to a customer.
            if (op.scale() != null && Double.isFinite(op.scale())) {
                sb.append(",\"scale\":").append(op.scale());
            }
            if (op.offset() != null && Double.isFinite(op.offset())) {
                sb.append(",\"offset\":").append(op.offset());
            }
            sb.append('}');
        }
        sb.append("]}");
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
            client = new MqttClient(brokerUrl, "voltpilot-api-probe-" + UUID.randomUUID(),
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
    void close() {
        if (client != null) {
            try {
                if (client.isConnected()) {
                    client.disconnect();
                }
                client.close();
            } catch (Exception e) {
                log.debug("closing probe publisher: {}", e.getMessage());
            }
        }
    }
}
