package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.direktvermarktung.DirektvermarktungStandBlock.Block;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Zustellung;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
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
 * Nimmt den Herzschlag-Block {@code direktvermarktung} an (Vertrag
 * {@code docs/contracts/v2/direktvermarktung-zustellung.md} §5): ein eigener Geschwister-Eingang auf
 * {@code ems/+/+/+/status} wie {@code KoppelbildStandListener} - Topic-Identität gegen Nutzlast-Identität,
 * die Box unter dem Mandanten des Topics aufgelöst, geschrieben unter diesem Mandanten.
 *
 * <p>Der Block kommt NUR von der Box, der das Profil zugestellt ist ({@code box_id}); jede andere wird
 * verworfen - eine getauschte Box darf den Spiegel ihrer Nachfolgerin nicht überschreiben. Gespiegelt wird
 * in {@code direktvermarktung_stand} (eine Zeile je Anlage, NUR Anzeige - nie Soll-Stand, die
 * Fernwartungs-Regel). Zusätzlich führt die Lage der Box den groben Anschluss-Zustand nach
 * ({@link DirektvermarktungStandBlock#zustandAusLage}), nur zwischen den Laufzeit-Zuständen und nur im
 * Protokoll nachvollziehbar; ein Herzschlag ohne Block lässt alles stehen ("Unbekannt ist keine Null").
 *
 * <p>Aus, solange {@code voltpilot.direktvermarktung.mqtt-listener-enabled} nicht gesetzt ist; die
 * Produktion setzt es in {@code application.yml}, Surefire schaltet es ab, Tests rufen {@link #handle}.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.direktvermarktung.mqtt-listener-enabled", havingValue = "true")
public class DirektvermarktungStandListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungStandListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    /** Nur zwischen diesen Zuständen bewegt die Box-Lage den Anschluss (nie entwurf/endet/beendet). */
    private static final Set<String> BEWEGLICH = Set.of(DirektvermarktungRepository.WARTET_AUF_ZUGANG,
            DirektvermarktungRepository.VERBINDET, DirektvermarktungRepository.WARTET_AUF_PARTNER,
            DirektvermarktungRepository.VERBUNDEN, DirektvermarktungRepository.GESTOERT);

    private final DeviceRepository devices;
    private final DirektvermarktungRepository repo;
    private final TransactionTemplate tx;
    private final ObjectMapper mapper = new ObjectMapper();
    private final BrokerVerbindung verbindung;
    private final Clock clock;

    public DirektvermarktungStandListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DirektvermarktungRepository repo, TransactionTemplate tx) {
        this(brokerUrl, username, password, devices, repo, tx, Clock.systemUTC());
    }

    DirektvermarktungStandListener(String brokerUrl, String username, String password, DeviceRepository devices,
            DirektvermarktungRepository repo, TransactionTemplate tx, Clock clock) {
        this.devices = devices;
        this.repo = repo;
        this.tx = tx;
        this.clock = clock;
        this.verbindung = new BrokerVerbindung(log, "direktvermarktung status", brokerUrl,
                "voltpilot-api-dv-stand-" + UUID.randomUUID(), true, username, password,
                (client, quittung) -> client.subscribe(STATUS_FILTER, 1, null, quittung), this::empfangen);
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
            log.warn("direktvermarktung: Stand auf '{}' fehlgeschlagen: {}", topic, e.getMessage());
        }
    }

    /** Ein Herzschlag; für Tests sichtbar. Wirft nie wegen einer kaputten Nutzlast. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return;
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // kein JSON - nicht für uns
        }
        if (json == null || !json.isObject()) return;
        Block block = DirektvermarktungStandBlock.lies(json.get("direktvermarktung"));
        if (block == null) {
            return; // eine Box ohne Anschluss - der Stand bleibt stehen
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
            log.warn("direktvermarktung: Identitaet der Nutzlast passt nicht zum Topic '{}' - verworfen", topic);
            return;
        }
        Instant jetzt = clock.instant();
        TenantContext.set(tenantId);
        try {
            DeviceDto device = devices.findById(deviceId).orElse(null);
            if (device == null || !siteId.equals(device.siteId())) {
                log.warn("direktvermarktung: Stand von unbekannter Box {} (Mandant {}) verworfen",
                        deviceId, tenantId);
                return;
            }
            Eintrag aktiv = repo.aktiverOhneEnde(siteId);
            if (aktiv == null) {
                return; // kein Anschluss (mehr) - ein alter Block schreibt nichts
            }
            Zustellung zustellung = repo.zustellung(aktiv.id());
            if (zustellung == null || !deviceId.equals(zustellung.boxId())) {
                log.warn("direktvermarktung: Stand von Box {} ohne zugestelltes Profil verworfen (Anlage {})",
                        deviceId, siteId);
                return;
            }
            String neu = DirektvermarktungStandBlock.zustandAusLage(block.lage());
            tx.executeWithoutResult(s -> {
                repo.standSchreiben(tenantId, siteId, block.stand(), jetzt);
                if (neu != null && BEWEGLICH.contains(aktiv.zustand()) && !neu.equals(aktiv.zustand())) {
                    repo.zustandSetzen(aktiv.id(), neu, jetzt);
                    repo.protokolliere(tenantId, siteId, aktiv.id(), "zustand", null, "box",
                            "{\"zustand\":\"" + neu + "\",\"lage\":\""
                                    + block.lage().replace("\"", "") + "\"}",
                            jetzt);
                }
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
