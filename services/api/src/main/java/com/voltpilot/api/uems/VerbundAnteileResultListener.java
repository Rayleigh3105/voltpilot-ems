package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.DokumentAblehnung;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Stand;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
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
 * Empfang der Quittung eines Anteils-Dokuments {@code …/v2/verbund-anteile-result} (UEMS AP-15 IP-7, Y3; Vertrag
 * {@code docs/contracts/v2/mqtt-verbund-anteile.md}; Muster {@link PlanResultListener}). Prüft Topic- und
 * Payload-Identität und das geschlossene Grund-Vokabular aus IP-2 ({@code dokument_ablehnung}), dann übergibt es an
 * {@link SteuerungsverbundAnteilDienst#quittungEmpfangen}. Eine Box ohne Verbund sendet nichts: für sie läuft hier nie
 * etwas.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class VerbundAnteileResultListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(VerbundAnteileResultListener.class);
    private static final String FILTER = "ems/+/+/+/v2/verbund-anteile-result";

    /** Eine gültige Quittung samt Mandant, Anlage und Box aus dem Topic. */
    record Gepruefte(UUID tenantId, UUID siteId, UUID box, Stand stand, boolean angenommen, DokumentAblehnung grund,
            Stand wirksam, Instant quittiertUm) {}

    private final String brokerUrl, username, password;
    private final SteuerungsverbundAnteilDienst dienst;
    private final ObjectMapper mapper;
    private MqttClient client;

    public VerbundAnteileResultListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            SteuerungsverbundAnteilDienst dienst, ObjectMapper mapper) {
        this.brokerUrl = brokerUrl; this.username = username; this.password = password;
        this.dienst = dienst; this.mapper = mapper;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Wiederverbindung wie {@link PlanResultListener}: ein Broker-Ausfall beim Start hält nichts auf. */
    @Scheduled(fixedDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}",
            initialDelayString = "${voltpilot.measurements.status-reconnect-ms:5000}")
    public synchronized void ensureConnected() {
        if (client != null && client.isConnected()) return;
        try {
            connect();
        } catch (Exception e) {
            log.warn("verbund-anteile result listener awaits broker: {}", e.getMessage());
            discardClient();
        }
    }

    private void connect() throws Exception {
        discardClient();
        client = new MqttClient(brokerUrl, "voltpilot-api-verbund-anteile-result", new MemoryPersistence());
        client.setCallback(new MqttCallbackExtended() {
            @Override public void connectComplete(boolean reconnect, String uri) {
                try { client.subscribe(FILTER, 1, listener()); }
                catch (Exception e) { log.warn("verbund-anteile result subscribe failed: {}", e.getMessage()); }
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
            catch (Exception e) { log.warn("verbund-anteile result on {} rejected: {}", topic, e.getMessage()); }
        };
    }

    /** Prüft und übergibt; false = verworfen (ungültig oder keine aktive Box des Verbunds dieser Anlage). */
    public boolean handle(String topic, byte[] payload, Instant empfangenUm) {
        if (kundenbereichBeendet(topic)) return false; // Kundenbereich beendet: verworfen und gezählt
        Gepruefte g = pruefe(topic, payload);
        if (g == null) return false;
        TenantContext.set(g.tenantId());
        try {
            return dienst.quittungEmpfangen(g.siteId(), g.box(), g.stand(), g.angenommen(), g.grund(), g.wirksam(),
                    empfangenUm);
        } finally {
            TenantContext.clear();
        }
    }

    /** Reine Vertragsprüfung ohne Datenbank (die Vektoren laufen hier durch). */
    Gepruefte pruefe(String topic, byte[] payload) {
        try {
            String[] p = topic == null ? new String[0] : topic.split("/");
            if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4])
                    || !"verbund-anteile-result".equals(p[5])) return null;
            UUID tenant = UUID.fromString(p[1]), site = UUID.fromString(p[2]), box = UUID.fromString(p[3]);
            JsonNode root = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
            if (root == null || !root.isObject()
                    || !VerbundAnteileDokument.SCHEMA_VERSION.equals(root.path("schema_version").asText())
                    || !p[1].equals(root.path("tenant_id").asText())
                    || !p[2].equals(root.path("site_id").asText())
                    || !p[3].equals(root.path("device_id").asText())
                    || !ganzzahlNichtNegativ(root.path("epoche")) || !ganzzahlNichtNegativ(root.path("revision"))
                    || !root.path("urteil").isTextual()) return null;
            String urteil = root.path("urteil").asText();
            boolean angenommen;
            if ("angenommen".equals(urteil)) angenommen = true;
            else if ("abgelehnt".equals(urteil)) angenommen = false;
            else return null;
            JsonNode grundKnoten = root.path("grund");
            DokumentAblehnung grund = null;
            if (angenommen) {
                if (!grundKnoten.isMissingNode()) return null;
            } else {
                grund = grundKnoten.isTextual() ? ablehnung(grundKnoten.asText()) : null;
                if (grund == null) return null;
            }
            Stand wirksam = null;
            JsonNode w = root.path("wirksam");
            if (!w.isMissingNode()) {
                if (!w.isObject() || !ganzzahlNichtNegativ(w.path("epoche"))
                        || !ganzzahlNichtNegativ(w.path("revision"))) return null;
                wirksam = new Stand(w.path("epoche").asLong(), w.path("revision").asLong());
            }
            Instant quittiertUm = Instant.parse(root.path("ts").asText());
            return new Gepruefte(tenant, site, box, new Stand(root.path("epoche").asLong(),
                    root.path("revision").asLong()), angenommen, grund, wirksam, quittiertUm);
        } catch (Exception e) {
            log.debug("invalid verbund-anteile result: {}", e.getMessage());
            return null;
        }
    }

    private static boolean ganzzahlNichtNegativ(JsonNode n) {
        return n.isIntegralNumber() && n.asLong() >= 0;
    }

    private static DokumentAblehnung ablehnung(String code) {
        for (DokumentAblehnung a : DokumentAblehnung.values()) {
            if (a.code().equals(code)) return a;
        }
        return null;
    }
}
