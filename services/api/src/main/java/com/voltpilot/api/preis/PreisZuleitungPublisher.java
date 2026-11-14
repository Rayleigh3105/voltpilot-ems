package com.voltpilot.api.preis;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.UUID;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Der Verteilweg des aktuellen Börsenpreises: RETAINED (QoS1) auf
 * {@code ems/{t}/{s}/{d}/v2/price} (Vertrag
 * {@code docs/contracts/v2/mqtt-price-current.md}).
 *
 * <p><b>Retained ist der ganze Verteilmechanismus</b>, wie bei der
 * Lastmanagement-Konfiguration: hinter NAT gibt es keinen Push, also holt
 * sich eine Box, die beim Slotwechsel offline war, den Stand beim nächsten
 * Verbindungsaufbau selbst ab - und die Frische-Regel des Vertrags sorgt
 * dafür, dass ein ALTER Stand dann ausdrücklich unbekannt ist, nie „aktuell".
 * Das Topic liegt im {@code v2/#}-Teilbaum der per-Gerät-ACL (D-2) - keine
 * Broker-Änderung.
 *
 * <p><b>Das Dokument ist DATEN, nie ein Befehl:</b> der Fahrplan bleibt die
 * Entscheidung der Cloud; die Box wertet damit nur die Preis-Bedingungen
 * ihrer Kundenregeln aus. Best-effort wie jeder Broker-Kontakt: ein
 * Broker-Ausfall kostet höchstens einen Slot, der nächste Takt holt auf.
 * Reitet auf demselben Broker-Schalter wie die Provisionierung.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class PreisZuleitungPublisher {

    private static final Logger log = LoggerFactory.getLogger(PreisZuleitungPublisher.class);
    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_INSTANT;

    private final BrokerVerbindung verbindung;

    public PreisZuleitungPublisher(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password) {
        this.verbindung = new BrokerVerbindung(log, "price feed", brokerUrl,
                "voltpilot-api-preis-" + UUID.randomUUID(), true, username, password, null, null);
    }

    /** Erstaufbau nur ANSTOSSEN, den Start-Thread nie blockieren (ChargingConfigPublisher-Muster). */
    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        verbindung.sicherstellen();
    }

    /** Das Preis-Topic eines Geräts (v2/#-Teilbaum, D-2). */
    public static String priceTopic(UUID tenantId, UUID siteId, UUID deviceId) {
        return "ems/" + tenantId + "/" + siteId + "/" + deviceId + "/v2/price";
    }

    /** Das Dokument des Vertrags - statisch und testbar gegen das Schema. */
    static byte[] document(UUID tenantId, UUID siteId, UUID deviceId,
            PreisZuleitung.PricePoint slot, String biddingZone, Instant publishedAt) {
        ObjectNode doc = new ObjectMapper().createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("tenant_id", tenantId.toString());
        doc.put("site_id", siteId.toString());
        doc.put("device_id", deviceId.toString());
        doc.put("generated_at", ISO.format(publishedAt.atOffset(ZoneOffset.UTC)));
        doc.put("slot_start", ISO.format(slot.slotStart().atOffset(ZoneOffset.UTC)));
        doc.put("slot_end", ISO.format(slot.slotEnd().atOffset(ZoneOffset.UTC)));
        doc.put("price_ct_kwh", slot.priceCtKwh());
        doc.put("unit", "ct/kWh");
        doc.put("bidding_zone", biddingZone);
        return doc.toString().getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Veröffentlicht den aktuellen Slot für EIN Gerät.
     *
     * @return false, wenn der Broker nicht erreichbar war (best-effort)
     */
    public synchronized boolean publish(UUID tenantId, UUID siteId, UUID deviceId,
            PreisZuleitung.PricePoint slot, String biddingZone, Instant publishedAt) {
        byte[] payload = document(tenantId, siteId, deviceId, slot, biddingZone, publishedAt);
        try {
            MqttMessage message = new MqttMessage(payload);
            message.setQos(1);
            message.setRetained(true);
            verbindung.verbundenerClient()
                    .publish(priceTopic(tenantId, siteId, deviceId), message)
                    .waitForCompletion(BrokerVerbindung.ZEITGRENZE_MS);
            return true;
        } catch (Exception e) {
            log.warn("price publish for device {} failed (best-effort, next slot retries): {}",
                    deviceId, e.toString());
            return false;
        }
    }
}
