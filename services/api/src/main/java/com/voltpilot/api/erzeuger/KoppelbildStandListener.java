package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
 * Nimmt den Block {@code koppel} des Herzschlags an ({@code docs/contracts/v2/koppelbild.md} §15): je Steuerung mit
 * Koppelbild die Lage der Box, der Kopf der Quittung und je Stellplatz Angebot, Wunsch und Urteil. Ein eigener
 * Geschwister-Eingang auf {@code ems/+/+/+/status} wie {@code SteuerlogikRueckmeldungListener}: Topic-Identität gegen
 * Nutzlast-Identität, die Box unter dem Mandanten des Topics aufgelöst, geschrieben unter diesem Mandanten.
 *
 * <p>Gelesen und bereinigt wird in {@link Koppelbild#lies}; ein Eintrag, dessen Steuerung keine eingebaute
 * Anlagensteuerung dieses Mandanten ist, fällt weg - Anlage und Gerät kommen aus der Cloud, nie aus der Nutzlast. Ein
 * Herzschlag ohne Block lässt den Stand stehen (eine ältere Box, ein Herzschlag eines anderen Programms); ein Block
 * mit leerer Liste leert ihn. Danach gleicht {@link KoppelbildService#abgleichen} die Freigaben gegen die gemeldeten
 * Angebote ab und stellt, wenn eine fiel, nach dem Commit den Registry-Push zu.
 *
 * <p>Aus, solange {@code voltpilot.koppelbild.mqtt-listener-enabled} nicht gesetzt ist; die Produktion setzt es über
 * die Vorgabe in {@code application.yml}, Surefire schaltet es ab und die Tests rufen {@link #handle} selbst.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.koppelbild.mqtt-listener-enabled", havingValue = "true")
public class KoppelbildStandListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(KoppelbildStandListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    private final DeviceRepository devices;
    private final KoppelbildRepository repo;
    private final KoppelbildService service;
    private final AnlagensteuerungQuelle quelle;
    private final TransactionTemplate tx;
    private final ObjectMapper mapper = new ObjectMapper();
    private final BrokerVerbindung verbindung;
    private final Clock clock = Clock.systemUTC();

    public KoppelbildStandListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, KoppelbildRepository repo, KoppelbildService service,
            AnlagensteuerungQuelle quelle, TransactionTemplate tx) {
        this.devices = devices;
        this.repo = repo;
        this.service = service;
        this.quelle = quelle;
        this.tx = tx;
        this.verbindung = new BrokerVerbindung(log, "koppelbild status", brokerUrl,
                "voltpilot-api-koppelbild-" + UUID.randomUUID(), true, username, password,
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
            log.warn("Koppelbild-Stand auf '{}' fehlgeschlagen: {}", topic, e.getMessage());
        }
    }

    /** Ein Herzschlag; für Tests sichtbar. Wirft nie wegen einer kaputten Nutzlast. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // kein JSON - nicht für uns
        }
        List<Koppelbild.Eintrag> eintraege = json == null || !json.isObject() ? null : Koppelbild.lies(json.get("koppel"));
        if (eintraege == null) {
            return; // eine Box ohne Koppelbild
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
            log.warn("Koppelbild-Stand: Identität der Nutzlast passt nicht zum Topic '{}' - verworfen", topic);
            return;
        }
        Instant jetzt = clock.instant();
        Set<UUID> neuZuStellen = new LinkedHashSet<>();
        TenantContext.set(tenantId);
        try {
            DeviceDto device = devices.findById(deviceId).orElse(null);
            if (device == null || !siteId.equals(device.siteId())) {
                log.warn("Koppelbild-Stand für unbekannte Box {} (Mandant {}) verworfen", deviceId, tenantId);
                return;
            }
            tx.executeWithoutResult(s -> {
                Map<UUID, KoppelbildRepository.Komponente> bekannt = repo.komponenten(
                        eintraege.stream().map(Koppelbild.Eintrag::steuerung).toList());
                List<KoppelbildRepository.NeuerStand> staende = new ArrayList<>();
                for (Koppelbild.Eintrag e : eintraege) {
                    KoppelbildRepository.Komponente k = bekannt.get(e.steuerung());
                    if (k != null) {
                        staende.add(new KoppelbildRepository.NeuerStand(k.entityId(), k.siteId(),
                                Koppelbild.json(mapper, e.stand()).toString()));
                    }
                }
                repo.ersetzeStand(deviceId, tenantId, staende, jetzt);
                for (Koppelbild.Eintrag e : eintraege) {
                    KoppelbildRepository.Komponente k = bekannt.get(e.steuerung());
                    if (k != null && service.abgleichen(k.geraetId(), k.siteId(), k.entityId(), e.stand())) {
                        neuZuStellen.add(k.siteId());
                    }
                }
            });
            // Nach dem Commit: der Push liest die Freigaben, die eben fielen.
            neuZuStellen.forEach(quelle::zustellen);
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
