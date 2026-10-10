package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.tenant.TenantContext;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.IMqttMessageListener;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Empfang der Plan-Quittung {@code …/v2/plan-result} (AP-15 IP-10, P3/Y3; Vertrag
 * docs/contracts/v2/mqtt-plan-result.md). Prüft Topic- und Payload-Identität, das geschlossene
 * Grund-Vokabular und den Standort der Box, dann schreibt es das Urteil in
 * {@code plan_zustellung}. Eine alte Box sendet nichts: für sie läuft hier nie etwas.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class PlanResultListener extends Rueckmeldeweg {
    private static final Logger log = LoggerFactory.getLogger(PlanResultListener.class);
    private static final String FILTER = "ems/+/+/+/v2/plan-result";
    /** Geschlossen; Zwillinge: Go plan2.Grund*, CHECK plan_zustellung_grund_chk, Vektoren. */
    static final List<String> GRUENDE = List.of("unlesbar", "schema_version_unbekannt",
            "slot_minutes_ungueltig", "keine_entitaeten", "fremde_box");

    /** Eine gültige, einem Plan zuzuordnende Quittung samt Mandant aus dem Topic. */
    record Gepruefte(UUID tenantId, PlanZustellungRepository.Quittung quittung) {}

    private final String brokerUrl, username, password;
    private final PlanZustellungRepository repository;
    private final ObjectMapper mapper;
    private MqttClient client;

    public PlanResultListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            PlanZustellungRepository repository, ObjectMapper mapper) {
        this.brokerUrl = brokerUrl; this.username = username; this.password = password;
        this.repository = repository; this.mapper = mapper;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Initial broker outages are retried; a failed half-created client never wedges startup. */
    @Scheduled(fixedDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}",
            initialDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}")
    public synchronized void ensureConnected() {
        if (client != null && client.isConnected()) return;
        try {
            connect();
        } catch (Exception e) {
            log.warn("plan result listener awaits broker: {}", e.getMessage());
            discardClient();
        }
    }

    private void connect() throws Exception {
        discardClient();
        client = new MqttClient(brokerUrl, "voltpilot-api-plan-result", new MemoryPersistence());
        client.setCallback(new MqttCallbackExtended() {
            @Override public void connectComplete(boolean reconnect, String uri) {
                try { client.subscribe(FILTER, 1, listener()); }
                catch (Exception e) { log.warn("plan result subscribe failed: {}", e.getMessage()); }
            }
            @Override public void connectionLost(Throwable cause) { }
            @Override public void messageArrived(String topic, MqttMessage message) { }
            @Override public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken t) { }
        });
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(false); options.setAutomaticReconnect(true); options.setConnectionTimeout(5);
        if (username != null && !username.isBlank()) {
            options.setUserName(username); options.setPassword(password == null ? new char[0] : password.toCharArray());
        }
        client.connect(options);
        client.subscribe(FILTER, 1, listener());
    }

    @PreDestroy
    void stop() {
        discardClient();
    }

    private void discardClient() {
        if (client == null) return;
        try { if (client.isConnected()) client.disconnect(); client.close(); }
        catch (Exception ignored) { }
        client = null;
    }

    private IMqttMessageListener listener() {
        return (topic, message) -> {
            try { handle(topic, message.getPayload(), Instant.now()); }
            catch (Exception e) { log.warn("plan result on {} rejected: {}", topic, e.getMessage()); }
        };
    }

    /** Prüft und schreibt; false = verworfen (ungültig, fremde Box, älter als das Gespeicherte). */
    public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
        if (kundenbereichBeendet(topic)) return false; // Kundenbereich beendet: verworfen und gezählt
        Gepruefte g = pruefe(topic, payload, empfangenUm);
        if (g == null) return false;
        TenantContext.set(g.tenantId());
        try {
            UUID site = repository.standortDerAktivenBox(g.quittung().deviceId());
            if (site == null || !site.equals(g.quittung().siteId())) return false;
            return repository.quittieren(g.tenantId(), g.quittung());
        } finally {
            TenantContext.clear();
        }
    }

    /** Reine Vertragsprüfung ohne Datenbank (die Vektoren laufen hier durch). */
    Gepruefte pruefe(String topic, byte[] payload, Instant empfangenUm) {
        try {
            String[] p = topic == null ? new String[0] : topic.split("/");
            if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4]) || !"plan-result".equals(p[5])) return null;
            UUID tenant = UUID.fromString(p[1]), site = UUID.fromString(p[2]), device = UUID.fromString(p[3]);
            JsonNode root = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
            if (root == null || !root.isObject()
                    || !"1.0".equals(root.path("schema_version").asText())
                    || !p[1].equals(root.path("tenant_id").asText())
                    || !p[2].equals(root.path("site_id").asText())
                    || !p[3].equals(root.path("device_id").asText())
                    || !root.path("angenommen").isBoolean()
                    || !root.path("plan_id").isTextual()) return null;
            boolean angenommen = root.path("angenommen").booleanValue();
            JsonNode grund = root.path("grund");
            if (angenommen ? !grund.isMissingNode()
                    : !(grund.isTextual() && GRUENDE.contains(grund.asText()))) return null;
            UUID planId = UUID.fromString(root.path("plan_id").asText());
            Instant quittiertUm = Instant.parse(root.path("ts").asText());
            Instant generatedAt = root.path("generated_at").isTextual()
                    ? Instant.parse(root.path("generated_at").asText()) : null;
            return new Gepruefte(tenant, new PlanZustellungRepository.Quittung(device, site, planId, generatedAt,
                    angenommen, angenommen ? null : grund.asText(), quittiertUm, empfangenUm));
        } catch (Exception e) {
            log.debug("invalid plan result: {}", e.getMessage());
            return null;
        }
    }
}
