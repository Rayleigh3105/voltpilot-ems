package com.voltpilot.api.steuerlogik;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SteuerlogikRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
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
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Nimmt den Block {@code logik} des Herzschlags an ({@code docs/contracts/v2/steuerlogik-rueckmeldung.md}): welche
 * Steuerlogik in welcher Fassung auf der Box mitläuft, ihr Zustand und das Vergleichsprotokoll "würde schalten"
 * gegen "ist geschaltet". Ein eigener Geschwister-Eingang auf {@code ems/+/+/+/status} (die Regel: ein neuer Block
 * bekommt seinen eigenen Eingang), mit derselben Haltung wie alle: Topic-Identität gegen Nutzlast-Identität, die Box
 * unter dem Mandanten des Topics aufgelöst, geschrieben unter diesem Mandanten.
 *
 * <p>Gelesen und geprüft wird in {@link SteuerlogikRueckmeldung}; hier nur Weg und Speicher. Ein Herzschlag ohne
 * Block lässt die Zeilen stehen (eine ältere Box, ein Herzschlag eines anderen Programms); ein Block mit leerer Liste
 * gibt es nicht - die Box lässt ihn dann weg -, darum leert nur ein Block ohne gültigen Lauf die Läufe der Box.
 * Aus, solange {@code voltpilot.steuerlogik.mqtt-listener-enabled} nicht gesetzt ist; beide Compose-Dateien setzen es.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.steuerlogik.mqtt-listener-enabled", havingValue = "true")
public class SteuerlogikRueckmeldungListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(SteuerlogikRueckmeldungListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    private final DeviceRepository devices;
    private final SteuerlogikRepository logiken;
    private final TransactionTemplate tx;
    private final ObjectMapper mapper = new ObjectMapper();
    private final BrokerVerbindung verbindung;
    private final Clock clock;

    public SteuerlogikRueckmeldungListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, SteuerlogikRepository logiken, TransactionTemplate tx) {
        this.devices = devices;
        this.logiken = logiken;
        this.tx = tx;
        this.clock = Clock.systemUTC();
        this.verbindung = new BrokerVerbindung(log, "steuerlogik status", brokerUrl,
                "voltpilot-api-steuerlogik-" + UUID.randomUUID(), true, username, password,
                (client, quittung) -> client.subscribe(STATUS_FILTER, 1, null, quittung), this::empfangen);
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        ensureConnected();
    }

    /** Startet die erste Verbindung, bis sie steht; danach verbindet Paho selbst neu. */
    @Scheduled(fixedDelayString = "${voltpilot.mqtt.erstverbindung-takt-ms:5000}",
            initialDelayString = "${voltpilot.mqtt.erstverbindung-takt-ms:5000}")
    public void ensureConnected() {
        verbindung.sicherstellen();
    }

    private void empfangen(String topic, MqttMessage message) {
        try {
            handle(topic, message.getPayload());
        } catch (Exception e) {
            log.warn("Steuerlogik-Rückmeldung auf '{}' fehlgeschlagen: {}", topic, e.getMessage());
        }
    }

    /** Ein Herzschlag; für Tests sichtbar. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // kein JSON - nicht für uns
        }
        JsonNode block = json == null ? null : json.get("logik");
        if (block == null || !block.isObject()) {
            return; // eine Box ohne Mitlauf
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) return;
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) return;
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("Steuerlogik-Rückmeldung: Identität der Nutzlast passt nicht zum Topic '{}' - verworfen", topic);
            return;
        }
        SteuerlogikRueckmeldung.Gelesen gelesen = SteuerlogikRueckmeldung.lies(block, deviceId, mapper);
        Instant jetzt = clock.instant();
        TenantContext.set(tenantId);
        try {
            DeviceDto device = devices.findById(deviceId).orElse(null);
            if (device == null || !siteId.equals(device.siteId())) {
                log.warn("Steuerlogik-Rückmeldung für unbekannte Box {} (Mandant {}) verworfen", deviceId, tenantId);
                return;
            }
            tx.executeWithoutResult(s -> {
                logiken.ersetzeLaeufe(deviceId, tenantId, siteId, gelesen.laeufe(), jetzt);
                logiken.schreibeWechsel(tenantId, siteId, gelesen.wechsel());
                logiken.raeumeWechsel(deviceId, jetzt.minus(SteuerlogikService.PROTOKOLL_DAUER));
            });
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
