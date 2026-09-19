package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.uems.ErwarteteKadenz;
import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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

/** Publishes the complete additional-measurement desired state retained/QoS1. */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class MeasurementConfigPublisher {
    private static final Logger log = LoggerFactory.getLogger(MeasurementConfigPublisher.class);
    private final String brokerUrl;
    private final String username;
    private final String password;
    private final ObjectMapper mapper;
    private final ErwarteteKadenz kadenzen;
    private MqttClient client;

    public MeasurementConfigPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            ObjectMapper mapper, ErwarteteKadenz kadenzen) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.mapper = mapper;
        this.kadenzen = kadenzen;
    }

    public static String topic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId
                + "/v2/measurement-config";
    }

    /** Best-effort transport; DB desired state remains authoritative on outage. */
    public synchronized boolean publish(DeviceScope scope, State state) {
        if (state.desiredRevision() < 1) return true;
        try {
            MqttMessage message = new MqttMessage(payload(scope, state));
            message.setQos(1);
            message.setRetained(true);
            connected().publish(topic(scope.tenantId(), scope.siteId(), scope.deviceId()), message);
            return true;
        } catch (Exception e) {
            log.warn("measurement desired state revision {} for device {} could not be published: {}",
                    state.desiredRevision(), scope.deviceId(), e.getMessage());
            return false;
        }
    }

    /** Clear the retired box's desired plan through the same retained transport. */
    public synchronized boolean clear(UUID tenantId, UUID siteId, UUID deviceId) {
        try {
            connected().publish(topic(tenantId, siteId, deviceId), new byte[0], 1, true);
            return true;
        } catch (Exception e) {
            log.warn("Could not clear measurement config for {}: {}", deviceId, e.getMessage());
            return false;
        }
    }

    /**
     * One entry per POINT KEY, in the order the state lists them.
     *
     * <p>⚠ The document is the plan of ONE device and the edge keys its poll
     * plan on the point key alone (it rejects a duplicate outright). Two
     * components of the same box that observe the same register therefore
     * collapse into one entry carrying the FASTEST requested cadence - the box
     * performs exactly one read either way, and the faster of the two wishes is
     * the conservative one. {@code entity_id} rides along only when the key
     * belongs unambiguously to ONE component: it is routing metadata for the
     * Stufe-3c edge, and an ambiguous binding would be an invented one.
     *
     * <p><b>⚠ Die Kadenz kommt seit UEMS AP-07 IP-10 aus der Quellenbindung</b> (Entscheid E9):
     * gilt für den Messkanal dieser Auswahlzeile eine eingetragene Fassung, steht DEREN Zahl in
     * {@code cadence_s} - sonst die der Auswahl, genau wie bisher. Am Draht ändert das nichts: das
     * Dokument hat dieselben Felder in derselben Reihenfolge, {@code schema_version} bleibt 2.0,
     * und die Fassung trägt dieselben Schranken wie das Feld (1 … 86 400 s), weil sie gar nicht
     * anders entstehen kann. Nur die QUELLE der Zahl wechselt.
     */
    byte[] payload(DeviceScope scope, State state) throws Exception {
        Map<Messkanal, Integer> fassungen = kadenzen.fassungenJeKanal(messkanaele(state), Instant.now());
        List<Map<String, Object>> selections = MeasurementPlan.compose(state.selections(), fassungen)
                .stream().map(MeasurementConfigPublisher::wireEntry).toList();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schema_version", "2.0");
        payload.put("tenant_id", scope.tenantId());
        payload.put("site_id", scope.siteId());
        payload.put("device_id", scope.deviceId());
        payload.put("revision", state.desiredRevision());
        payload.put("catalog_version", state.catalogVersion());
        payload.put("selections", selections);
        return mapper.writeValueAsBytes(payload);
    }

    private static Map<String, Object> wireEntry(MeasurementPlan.Entry entry) {
        Map<String, Object> selection = new LinkedHashMap<>();
        selection.put("point_key", entry.pointKey());
        selection.put("cadence_s", entry.cadenceS());
        if (entry.customDefinition() != null) selection.put("definition", entry.customDefinition());
        if (entry.entityId() != null) selection.put("entity_id", entry.entityId());
        return selection;
    }

    /** Die Messkanäle, nach deren Fassung gefragt wird: je aktive Auswahlzeile mit Komponente. */
    private static Set<Messkanal> messkanaele(State state) {
        Set<Messkanal> out = new LinkedHashSet<>();
        for (MeasurementSelectionService.SelectionPoint p : state.selections()) {
            if (p.enabled() && p.entityId() != null) {
                out.add(new Messkanal(p.entityId(), p.pointKey()));
            }
        }
        return out;
    }

    private MqttClient connected() throws Exception {
        if (client == null) {
            client = new MqttClient(brokerUrl, "voltpilot-api-measurements",
                    new MemoryPersistence());
        }
        if (!client.isConnected()) {
            MqttConnectOptions options = new MqttConnectOptions();
            options.setCleanSession(false);
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
        if (client == null) return;
        try {
            if (client.isConnected()) client.disconnect();
            client.close();
        } catch (Exception e) {
            log.debug("closing measurement publisher: {}", e.getMessage());
        }
    }
}
