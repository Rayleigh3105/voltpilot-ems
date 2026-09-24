package com.voltpilot.api.probe;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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

    /**
     * Publish ONE {@code test_connection} probe - the assistant's connection
     * test, generalized to every transport (Einheitsmodell Stufe 1). Same
     * envelope, same non-retained/QoS1 discipline; only the op differs, because
     * this one names the DEVICE instead of a register and the box picks the
     * matching reader itself.
     */
    public synchronized void publishTest(UUID tenantId, UUID siteId, UUID deviceId,
            String requestId, Instant requestedAt, String requestedBy, String opId,
            String brand, String model, String family, String role,
            Map<String, Object> connection) throws Exception {
        String topic = probeTopic(tenantId, siteId, deviceId);
        MqttMessage message = new MqttMessage(testEnvelope(tenantId, siteId, deviceId, requestId,
                requestedAt, requestedBy, opId, brand, model, family, role, connection));
        message.setQos(1);
        message.setRetained(false);
        connected().publish(topic, message);
        // ⚠ Same rule as the read probe: the customer's LAN address is NOT
        // logged - it is their network topology, and a wizard step is not worth
        // a permanent record of where their devices sit.
        log.debug("published connection test {} (NON-retained)", requestId);
    }

    /**
     * Publish ONE WRITING op - the guided switch test or its cancel
     * (Einheitsmodell Stufe 4). Same envelope, same non-retained/QoS1
     * discipline; the box arms its auto-off BEFORE it writes, so a lost answer
     * can never leave a device switched on.
     */
    public synchronized void publishSwitch(UUID tenantId, UUID siteId, UUID deviceId,
            String requestId, Instant requestedAt, String requestedBy, SwitchOp op)
            throws Exception {
        String topic = probeTopic(tenantId, siteId, deviceId);
        MqttMessage message = new MqttMessage(switchEnvelope(tenantId, siteId, deviceId, requestId,
                requestedAt, requestedBy, op));
        message.setQos(1);
        message.setRetained(false);
        connected().publish(topic, message);
        // ⚠ The customer's LAN address is NOT logged here either - and a write
        // is exactly the record someone would want; the audit trail names WHO
        // and WHAT, never WHERE in their network.
        log.debug("published switch op {} ({}, NON-retained)", requestId, op.op());
    }

    /**
     * One writing op. It carries the two values verbatim, because the box is
     * meant to have nothing left to decide.
     */
    public record SwitchOp(String op, String id, String host, Integer port, Integer unitId,
            String registerKind, int address, Integer writeFc, Integer onValue, int offValue,
            Integer ttlSeconds, Integer readbackAddress, String transport) {

        /** A free Modbus register (self-built device) - the original shape. */
        public SwitchOp(String op, String id, String host, Integer port, Integer unitId,
                String registerKind, int address, Integer writeFc, Integer onValue, int offValue,
                Integer ttlSeconds, Integer readbackAddress) {
            this(op, id, host, port, unitId, registerKind, address, writeFc, onValue, offValue,
                    ttlSeconds, readbackAddress, null);
        }

        /** The contract transport word ({@code modbus_tcp} unless stated). */
        public String effectiveTransport() {
            return transport == null || transport.isBlank() ? "modbus_tcp" : transport;
        }
    }

    static byte[] switchEnvelope(UUID tenantId, UUID siteId, UUID deviceId, String requestId,
            Instant requestedAt, String requestedBy, SwitchOp op) {
        StringBuilder sb = header(tenantId, siteId, deviceId, requestId, requestedAt, requestedBy);
        sb.append(",\"ops\":[{\"op\":\"").append(esc(op.op())).append('"')
                .append(",\"transport\":\"").append(esc(op.effectiveTransport())).append('"')
                .append(",\"id\":\"").append(esc(op.id())).append('"')
                .append(",\"host\":\"").append(esc(op.host().trim())).append('"')
                .append(",\"port\":").append(op.port() == null ? 502 : op.port())
                .append(",\"unit_id\":").append(op.unitId() == null ? 1 : op.unitId())
                .append(",\"register_kind\":\"").append(esc(op.registerKind())).append('"')
                .append(",\"address\":").append(op.address());
        if (op.writeFc() != null) {
            sb.append(",\"write_fc\":").append(op.writeFc());
        }
        if (op.onValue() != null) {
            sb.append(",\"on_value\":").append(op.onValue());
        }
        sb.append(",\"off_value\":").append(op.offValue());
        if (op.ttlSeconds() != null) {
            sb.append(",\"ttl_s\":").append(op.ttlSeconds());
        }
        if (op.readbackAddress() != null) {
            sb.append(",\"readback_address\":").append(op.readbackAddress());
        }
        sb.append("}]}");
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    static byte[] testEnvelope(UUID tenantId, UUID siteId, UUID deviceId, String requestId,
            Instant requestedAt, String requestedBy, String opId, String brand, String model,
            String family, String role, Map<String, Object> connection) {
        StringBuilder sb = header(tenantId, siteId, deviceId, requestId, requestedAt, requestedBy);
        sb.append(",\"ops\":[{\"op\":\"test_connection\"")
                .append(",\"id\":\"").append(esc(opId)).append('"')
                .append(",\"brand\":\"").append(esc(brand)).append('"');
        if (model != null && !model.isBlank()) {
            sb.append(",\"model\":\"").append(esc(model)).append('"');
        }
        if (family != null && !family.isBlank()) {
            sb.append(",\"family\":\"").append(esc(family)).append('"');
        }
        if (role != null && !role.isBlank()) {
            sb.append(",\"role\":\"").append(esc(role)).append('"');
        }
        sb.append(",\"connection\":").append(connectionJson(connection)).append("}]}");
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    /**
     * The connection block, serialized with a mapper on purpose - unlike the
     * fixed-shape read op this one is the customer's own form, whose fields come
     * from the template's transport_schema and are UNKNOWN here. Hand-building
     * it would mean guessing types.
     */
    private static String connectionJson(Map<String, Object> connection) {
        try {
            return MAPPER.writeValueAsString(connection == null ? Map.of() : connection);
        } catch (Exception e) {
            throw new IllegalStateException("cannot serialize probe connection", e);
        }
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private static StringBuilder header(UUID tenantId, UUID siteId, UUID deviceId,
            String requestId, Instant requestedAt, String requestedBy) {
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
        return sb;
    }

    static byte[] envelope(UUID tenantId, UUID siteId, UUID deviceId, String requestId,
            Instant requestedAt, String requestedBy, List<ProbeRequest.Op> ops) {
        StringBuilder sb = header(tenantId, siteId, deviceId, requestId, requestedAt, requestedBy);
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
