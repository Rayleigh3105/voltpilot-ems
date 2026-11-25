package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.provisioning.BrokerVerbindung;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.Eintrag;
import com.voltpilot.api.repo.DirektvermarktungRepository.Zustellung;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangZeile;
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
 * Nimmt die Quittungen der Box an ({@code ems/+/+/+/v2/direktvermarktung-quittung}, Vertrag §3):
 * {@code zugestellt} setzt {@code zugestellt_am} am Zugang und hebt einen wartenden Anschluss auf
 * {@code verbindet}; {@code geloescht} räumt die Zustell-Buchführung der Box - ERST DANACH stellt der
 * Abgleich an eine andere Box zu (PS-D22) - und zieht den Zugang zurück, wenn er nicht mehr der aktuelle
 * ist (Rückzug, Ersatz-Upload). Quittungen sind idempotent; QoS 1 darf doppelt zustellen.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.direktvermarktung.mqtt-listener-enabled", havingValue = "true")
public class DirektvermarktungQuittungListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(DirektvermarktungQuittungListener.class);
    private static final String FILTER = "ems/+/+/+/v2/direktvermarktung-quittung";

    private final DeviceRepository devices;
    private final DirektvermarktungRepository repo;
    private final DirektvermarktungZustellung zustellung;
    private final TransactionTemplate tx;
    private final ObjectMapper mapper = new ObjectMapper();
    private final BrokerVerbindung verbindung;
    private final Clock clock;

    public DirektvermarktungQuittungListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DirektvermarktungRepository repo, DirektvermarktungZustellung zustellung,
            TransactionTemplate tx) {
        this(brokerUrl, username, password, devices, repo, zustellung, tx, Clock.systemUTC());
    }

    DirektvermarktungQuittungListener(String brokerUrl, String username, String password, DeviceRepository devices,
            DirektvermarktungRepository repo, DirektvermarktungZustellung zustellung, TransactionTemplate tx,
            Clock clock) {
        this.devices = devices;
        this.repo = repo;
        this.zustellung = zustellung;
        this.tx = tx;
        this.clock = clock;
        this.verbindung = new BrokerVerbindung(log, "direktvermarktung quittung", brokerUrl,
                "voltpilot-api-dv-quittung-" + UUID.randomUUID(), true, username, password,
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
            log.warn("direktvermarktung: Quittung auf '{}' fehlgeschlagen: {}", topic, e.getMessage());
        }
    }

    /** Eine Quittung; für Tests sichtbar. Wirft nie wegen einer kaputten Nutzlast. */
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
            log.warn("direktvermarktung: Quittung mit fremder Identitaet auf '{}' - verworfen", topic);
            return;
        }
        String ereignis = json.path("ereignis").asText("");
        String fingerabdruck = json.path("zugang_fingerabdruck").asText("");
        if (fingerabdruck.isBlank()
                || (!"zugestellt".equals(ereignis) && !"geloescht".equals(ereignis))) {
            return;
        }
        Instant jetzt = clock.instant();
        boolean abgleichen;
        TenantContext.set(tenantId);
        try {
            DeviceDto device = devices.findById(deviceId).orElse(null);
            if (device == null || !siteId.equals(device.siteId())) {
                log.warn("direktvermarktung: Quittung von unbekannter Box {} (Mandant {}) verworfen",
                        deviceId, tenantId);
                return;
            }
            abgleichen = tx.execute(s -> "zugestellt".equals(ereignis)
                    ? zugestellt(tenantId, siteId, deviceId, fingerabdruck, jetzt)
                    : geloescht(tenantId, siteId, deviceId, fingerabdruck, jetzt));
            if (Boolean.TRUE.equals(abgleichen)) {
                // Nach dem Commit: der Rückzug ist quittiert, die neue Box darf jetzt bedient werden.
                zustellung.abgleichen(siteId);
            }
        } finally {
            TenantContext.clear();
        }
    }

    private boolean zugestellt(UUID tenantId, UUID siteId, UUID deviceId, String fingerabdruck, Instant jetzt) {
        ZugangZeile zugang = repo.zugangZuFingerabdruck(siteId, fingerabdruck);
        if (zugang != null && repo.zugangZugestellt(zugang.id(), jetzt)) {
            repo.protokolliere(tenantId, siteId, zugang.direktvermarktungId(), "zugang_zugestellt", null,
                    DirektvermarktungZustellung.ROLLE, "{\"box\":\"" + deviceId + "\"}", jetzt);
        }
        Eintrag aktiv = repo.aktiverOhneEnde(siteId);
        if (aktiv != null && DirektvermarktungRepository.WARTET_AUF_ZUGANG.equals(aktiv.zustand())) {
            repo.zustandSetzen(aktiv.id(), DirektvermarktungRepository.VERBINDET, jetzt);
            repo.protokolliere(tenantId, siteId, aktiv.id(), "zustand", null, "box",
                    "{\"zustand\":\"" + DirektvermarktungRepository.VERBINDET + "\"}", jetzt);
        }
        return false;
    }

    private boolean geloescht(UUID tenantId, UUID siteId, UUID deviceId, String fingerabdruck, Instant jetzt) {
        boolean geraeumt = false;
        for (Zustellung z : repo.zustellungenMitBox(siteId)) {
            if (deviceId.equals(z.boxId())) {
                repo.profilZurueckgezogen(z.eintragId(), jetzt);
                repo.protokolliere(tenantId, siteId, z.eintragId(), "profil_zurueckgezogen", null,
                        DirektvermarktungZustellung.ROLLE, "{\"box\":\"" + deviceId + "\"}", jetzt);
                geraeumt = true;
            }
        }
        // Der Zugang gilt als zurückgezogen, sobald er nicht mehr der aktuelle des aktiven Anschlusses
        // ist - beim Rückzug (Beenden, Lösen) genauso wie nach einem Ersatz-Upload. Beim Box-Tausch bleibt
        // er aktuell und wird gleich der neuen Box zugestellt.
        ZugangZeile zugang = repo.zugangZuFingerabdruck(siteId, fingerabdruck);
        Eintrag aktiv = repo.aktiverOhneEnde(siteId);
        ZugangZeile aktueller = aktiv == null ? null : repo.aktuellerZugang(aktiv.id());
        boolean nochAktuell = aktueller != null && aktueller.fingerabdruck().equals(fingerabdruck);
        if (zugang != null && !nochAktuell && repo.zugangZurueckgezogen(zugang.id(), jetzt)) {
            repo.protokolliere(tenantId, siteId, zugang.direktvermarktungId(), "zugang_zurueckgezogen", null,
                    DirektvermarktungZustellung.ROLLE, "{\"box\":\"" + deviceId + "\"}", jetzt);
        }
        if (aktiv == null) {
            // Kein aktiver Anschluss mehr: alte Zahlen wären eine Lüge - "Stand unbekannt".
            repo.standLoeschen(siteId);
        }
        return geraeumt;
    }

    private static UUID parseUuid(String s) {
        try {
            return UUID.fromString(s);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
