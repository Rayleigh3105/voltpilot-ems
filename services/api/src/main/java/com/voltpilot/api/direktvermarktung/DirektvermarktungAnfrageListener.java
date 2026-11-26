package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Nimmt die Zugangs-Anfrage der Box an ({@code ems/+/+/+/v2/direktvermarktung-anfrage}, Vertrag §3): die Box
 * nennt den Fingerabdruck aus dem retained Profil, den sie noch nicht hält; geantwortet wird einmal, nicht
 * retained, über {@link DirektvermarktungZustellung#zugangSenden} - und NUR der Box, der das Profil
 * zugestellt ist, NUR für den aktuellen Zugang. Kein Byte des Materials erreicht je ein Log; die Anfrage
 * selbst trägt ohnehin nur den Fingerabdruck.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.direktvermarktung.mqtt-listener-enabled", havingValue = "true")
public class DirektvermarktungAnfrageListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungAnfrageListener.class);
    private static final String FILTER = "ems/+/+/+/v2/direktvermarktung-anfrage";

    private final DeviceRepository devices;
    private final DirektvermarktungZustellung zustellung;
    private final PartnerzugangSpeicher speicher;
    private final ObjectMapper mapper = new ObjectMapper();
    private final BrokerVerbindung verbindung;

    public DirektvermarktungAnfrageListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DirektvermarktungZustellung zustellung, PartnerzugangSpeicher speicher) {
        this.devices = devices;
        this.zustellung = zustellung;
        this.speicher = speicher;
        this.verbindung = new BrokerVerbindung(log, "direktvermarktung anfrage", brokerUrl,
                "voltpilot-api-dv-anfrage-" + UUID.randomUUID(), true, username, password,
                (client, quittung) -> client.subscribe(FILTER, 1, null, quittung), this::empfangen);
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    @Scheduled(fixedDelayString = "${voltpilot.mqtt.erstverbindung-takt-ms:5000}",
            initialDelayString = "${voltpilot.mqtt.erstverbindung-takt-ms:5000}")
    public void ensureConnected() {
        verbindung.sicherstellen();
    }

    private void empfangen(String topic, MqttMessage message) {
        try {
            handle(topic, message.getPayload());
        } catch (Exception e) {
            log.warn("direktvermarktung: Anfrage auf '{}' fehlgeschlagen: {}", topic, e.getMessage());
        }
    }

    /** Eine Anfrage; für Tests sichtbar. Wirft nie wegen einer kaputten Nutzlast. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return;
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return;
        }
        if (json == null || !json.isObject()) return;
        String[] parts = topic.split("/");
        if (parts.length != 6) return;
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) return;
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("direktvermarktung: Anfrage mit fremder Identitaet auf '{}' - verworfen", topic);
            return;
        }
        String fingerabdruck = json.path("zugang_fingerabdruck").asText("");
        if (fingerabdruck.isBlank()) return;
        TenantContext.set(tenantId);
        try {
            DeviceDto device = devices.findById(deviceId).orElse(null);
            if (device == null || !siteId.equals(device.siteId())) {
                log.warn("direktvermarktung: Anfrage von unbekannter Box {} (Mandant {}) verworfen",
                        deviceId, tenantId);
                return;
            }
            zustellung.zugangSenden(siteId, deviceId, fingerabdruck, speicher);
        } finally {
            TenantContext.clear();
        }
    }

    private static UUID parseUuid(String s) {
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
