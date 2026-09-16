package com.voltpilot.api.entities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
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
import org.springframework.stereotype.Component;

/**
 * Ingests the additive {@code entities} block from the device status heartbeat
 * (edge-entity-config.md §5, E1b bidirectional sync) into
 * {@code entity_observed_state}: the applied registry revision, per-entity
 * observed type/health/telemetry, and the edge-local commissioning view
 * ({@code local_setup} - the :8484 inverter/sources, stored with
 * source='local'). The cloud RECONCILES this Ist against its registry Soll
 * and surfaces drift in the portal; it never auto-imports or overwrites.
 *
 * <p>A sibling of {@link com.voltpilot.api.control.ControlStatusListener} on
 * the SAME topic filter with the same authorization posture (broker ACL +
 * mTLS-CN identity; topic==payload identity re-validated; device resolved
 * through the RLS repository under the topic tenant). Off by default; both
 * composes turn it on next to the control listener.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.entities.mqtt-listener-enabled", havingValue = "true")
public class EntityStatusListener {

    private static final Logger log = LoggerFactory.getLogger(EntityStatusListener.class);
    private com.voltpilot.api.uems.UebergabeRepository uebergaben;

    @org.springframework.beans.factory.annotation.Autowired
    void uebergaben(com.voltpilot.api.uems.UebergabeRepository repo) { this.uebergaben = repo; }

    private static final String STATUS_FILTER = "ems/+/+/+/status";

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final EntityObservedRepository observed;
    private final com.voltpilot.api.components.ComponentApplyRepository componentApply;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public EntityStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, EntityObservedRepository observed,
            com.voltpilot.api.components.ComponentApplyRepository componentApply) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.observed = observed;
        this.componentApply = componentApply;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Entity-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-entities-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Entity-status listener subscribed to {} at {}", STATUS_FILTER,
                                serverUri);
                    } catch (Exception e) {
                        log.warn("Entity-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Entity-status listener lost the broker connection: {} (auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
                }

                @Override
                public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {
                }
            });
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
    }

    private IMqttMessageListener messageListener() {
        return (topic, message) -> {
            try {
                handle(topic, message.getPayload());
            } catch (Exception e) {
                log.warn("Entity status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one heartbeat's entities block. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode entities = json == null ? null : json.get("entities");
        if (entities == null || !entities.isObject()) {
            return; // a heartbeat without an entities block
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            return;
        }
        // Topic identity must equal payload identity (a device reports only
        // its OWN entity state - the ingest/control-listener rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("entity status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        String revision = entities.path("revision").asText(null);
        Instant reportedAt = Instant.now();
        List<ObservedRow> rows = new ArrayList<>();
        JsonNode observedNode = entities.get("observed");
        if (observedNode != null && observedNode.isObject()) {
            for (Map.Entry<String, JsonNode> e : observedNode.properties()) {
                JsonNode o = e.getValue();
                rows.add(new ObservedRow(deviceId, e.getKey(), "registry",
                        o.path("entity_type").asText(null), o.path("health").asText(null), null,
                        optInstant(o, "last_telemetry_at"), revision,
                        arrayJson(o.get("channels")), reportedAt, null, null, null, null));
            }
        }
        JsonNode localSetup = entities.get("local_setup");
        if (localSetup != null && localSetup.isArray()) {
            for (JsonNode l : localSetup) {
                String id = l.path("id").asText("");
                if (id.isBlank()) {
                    continue;
                }
                // The label stays CLEAN (the operator-given name only); brand/
                // model/role travel in their own columns. The former localLabel
                // concatenation ("brand · model · label · role") leaked raw
                // catalog ids into every customer surface AND - via the adoption
                // dialogs' prefill - into persisted entity names (the Pilsting
                // ghost, scout vp-vier-erzeuger-p9).
                rows.add(new ObservedRow(deviceId, "local:" + id, "local",
                        l.path("kind").asText(null), null, textOrNull(l, "label"), null, revision,
                        null, reportedAt, textOrNull(l, "role"), textOrNull(l, "brand"),
                        textOrNull(l, "model"), edgeLink(l)));
            }
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("entity status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            observed.replaceForDevice(deviceId, tenantId, siteId, reportedAt, rows);
            ingestComponentApply(entities.get("component_apply"), deviceId, tenantId, siteId,
                    reportedAt);
            if (uebergaben != null) {
                try {
                    uebergaben.herzschlag(tenantId, deviceId, revision, reportedAt);
                } catch (RuntimeException e) {
                    io.micrometer.core.instrument.Metrics.counter("voltpilot_uems_uebergabe_herzschlag",
                            "ergebnis", "fehler").increment();
                    log.warn("Übergabe-Herzschlag für {} nicht gespeichert: {}", deviceId, e.toString());
                }
            }
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Der Einheitsmodell-Stufe-1-Block: WELCHE Push-Revision die Box wirklich
     * angewandt hat, und was sie zuletzt NICHT anwenden konnte.
     *
     * <p><b>Abwesend heißt unbekannt.</b> Eine ältere Box sendet den Block gar
     * nicht - dann entsteht KEINE Zeile, und das Portal sagt „unbekannt" statt
     * „box-verwaltet" zu behaupten. Ein Wort außerhalb des Vokabulars wird
     * VERWORFEN statt gespeichert (die Regel des unbekannten Zustands, die
     * jeder Status-Zuhörer hier trägt).
     *
     * <p>Seit Befund L1 trägt der Block eine DRITTE Antwort: {@code held_*} =
     * die Box hat die Revision GESEHEN und bewusst nichts angewandt (heute:
     * das Portal nennt kein verbundenes Gerät mehr). Sie ist additiv - eine
     * ältere Box lässt die zwei Felder weg, und daraus wird {@code null},
     * also „kein Halt gemeldet", nie sein Gegenteil.
     *
     * <p><b>⚠ Seit Befund L8 meldet die Box auch die RÜCKGABE der Autorität</b>
     * ({@code authority: "box"}, ohne Revision und ohne Grund). Der Upsert
     * schreibt jede Spalte aus dem Block, ein solcher Bericht RÄUMT die Zeile
     * also von selbst: die zuletzt angewandte Revision, eine Ablehnung und ein
     * Halt gehören der Portal-Ära und dürfen sie nicht überleben. Vorher schwieg
     * die Box dort, die alte {@code authority=portal}-Zeile blieb stehen, und
     * das Portal behauptete über eine wieder box-verwaltete Anlage dauerhaft
     * einen Stand, den niemand mehr fährt.
     *
     * <p><b>Die Zeile wird dabei NICHT gelöscht.</b> Ein {@code authority=box}
     * ist eine Aussage („diese Box pflegt ihre Geräte selbst"); ein Löschen
     * machte sie wieder von „hat sich nie geäußert" ununterscheidbar - genau
     * die Zweideutigkeit, aus der der Befund entstand.
     */
    private void ingestComponentApply(JsonNode block, UUID deviceId, UUID tenantId, UUID siteId,
            Instant reportedAt) {
        if (block == null || !block.isObject()) {
            return;
        }
        String authority = block.path("authority").asText("");
        if (!"portal".equals(authority) && !"box".equals(authority)) {
            log.warn("component_apply authority '{}' unknown - skipped", authority);
            return;
        }
        componentApply.upsert(deviceId, tenantId, siteId, authority,
                textOrNull(block, "revision"), optInstant(block, "applied_at"),
                textOrNull(block, "refused_revision"), textOrNull(block, "refused_reason"),
                textOrNull(block, "held_revision"), textOrNull(block, "held_reason"),
                reportedAt);
    }

    private static String textOrNull(JsonNode node, String field) {
        String v = node.path(field).asText("");
        return v.isBlank() ? null : v;
    }

    /**
     * Die VERBINDUNGS-Hälfte eines {@code local_setup}-Eintrags (Einheitsmodell
     * Stufe 2): der Transport plus die Felder, mit denen die Box das Gerät
     * wirklich erreicht.
     *
     * <p><b>Ein älterer Box-Stand meldet sie nicht</b> - dann entsteht hier
     * {@code null}, und das heißt „diese Box meldet noch keine Verbindungen",
     * NIE „dieses Gerät hat keine". Genau daran hängt, dass eine Bestandsanlage
     * mit alter Software box-verwaltet bleibt statt aus einem halben Ist
     * übernommen zu werden.
     *
     * <p>Ein Eintrag mit Transport ABER ohne Verbindungsobjekt (oder umgekehrt)
     * wird als unvollständig gespeichert, nicht verworfen: die Übernahme prüft
     * {@link EntityObservedRepository.EdgeLink#complete()} und lässt die Anlage
     * dann in Ruhe - der Betreiber soll sehen, was gemeldet wurde.
     */
    private EntityObservedRepository.EdgeLink edgeLink(JsonNode l) {
        String communication = textOrNull(l, "communication");
        JsonNode connection = l.get("connection");
        boolean hasConnection = connection != null && connection.isObject()
                && !connection.isEmpty();
        if (communication == null && !hasConnection) {
            return null;
        }
        JsonNode interval = l.get("interval_s");
        JsonNode capacity = l.get("capacity_kwp");
        return new EntityObservedRepository.EdgeLink(
                communication,
                textOrNull(l, "family"),
                hasConnection ? connection.toString() : null,
                interval == null || !interval.isNumber() ? null : interval.asInt(),
                capacity == null || !capacity.isNumber() ? null
                        : java.math.BigDecimal.valueOf(capacity.asDouble()),
                textOrNull(l, "registry_unit_id"));
    }

    private String arrayJson(JsonNode node) {
        if (node == null || !node.isArray() || node.isEmpty()) {
            return null;
        }
        return node.toString();
    }

    private static Instant optInstant(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull() || v.asText().isBlank()) {
            return null;
        }
        try {
            return Instant.parse(v.asText());
        } catch (Exception e) {
            return null;
        }
    }

    private static UUID parseUuid(String raw) {
        try {
            return UUID.fromString(raw);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    @PreDestroy
    public void close() {
        synchronized (lock) {
            if (client == null) {
                return;
            }
            try {
                if (client.isConnected()) {
                    client.disconnect();
                }
            } catch (Exception e) {
                log.debug("Entity listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Entity listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
