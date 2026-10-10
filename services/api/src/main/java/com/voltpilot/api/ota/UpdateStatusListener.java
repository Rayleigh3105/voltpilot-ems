package com.voltpilot.api.ota;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.UpdateStatusRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.Set;
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
 * Ingests the top-level {@code version} field and the additive {@code update}
 * block of the device status heartbeat into {@code device_update_status} - the
 * cloud half of OTA Stufe 0 „Sehen" (scout {@code vp-ota-rollout-h4} §5/§9).
 *
 * <p><b>A SIBLING listener, deliberately not an extension of
 * {@link com.voltpilot.api.flows.FlowNodeStatusListener}</b> - the same
 * reasoning that produced {@code CurtailmentStatusListener} next to
 * {@code ControlStatusListener}, and here it is the whole point of the
 * increment: that listener returns early when the heartbeat carries neither a
 * {@code flows} nor a {@code flow_node_status} block, and the device class this
 * feature exists for is EXACTLY the one that never sends a {@code flows} block
 * (the edge does not build it before its first flow deployment). Extending it
 * would have kept the blind spot it is meant to close. The two blocks are
 * independent in the other direction too: an edge reports {@code version} on
 * every heartbeat while {@code flows} may vanish, so each needs its own row and
 * its own freshness anchor.
 *
 * <p>Authorization is the unchanged posture of every sibling on this topic
 * filter: the broker ACL + the mTLS cert CN make a message on
 * {@code ems/{t}/{s}/{d}/status} the authenticated device, the topic identity
 * is re-validated against the payload identity, and the device is resolved
 * through the RLS-scoped repository under the topic's tenant - so a fabricated
 * identity yields zero rows and is skipped. There is NO write path towards any
 * device anywhere in this package.
 *
 * <p>Honesty rules baked into the parse:
 * <ul>
 *   <li>A heartbeat carrying NEITHER a {@code version} nor an {@code update}
 *       block writes NOTHING - an older edge keeps behaving exactly as before
 *       and the fleet view says „unbekannt", never „veraltet".</li>
 *   <li>An {@code update.state} outside the known vocabulary is DROPPED
 *       (stored as null), never persisted verbatim: a word we do not
 *       understand must not become a sentence in the portal. Same discipline
 *       as the control listener's execution mode.</li>
 * </ul>
 *
 * <p>Off by default so unit tests and broker-less deployments are unaffected;
 * both composes turn it on next to the other listeners.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.ota.mqtt-listener-enabled", havingValue = "true")
public class UpdateStatusListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(UpdateStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    /**
     * The state vocabulary of the contract (scout §5). Anything else is a word
     * this cloud version does not understand - it is dropped rather than
     * stored, so a future edge state can never render as a fabricated portal
     * claim before the portal learns it.
     */
    private static final Set<String> KNOWN_STATES = Set.of("idle", "verifying", "deferred",
            "downloading", "applying", "self_test", "succeeded", "failed", "rolled_back");

    /**
     * Das Urteil der GERÄTE-EIGENEN Signaturprüfung (OTA Stufe 2). Es steht
     * neben {@code state}, weil beide verschiedene Fragen beantworten - siehe
     * die Spalten-Doku in Migration V20260805000000. Ein unbekanntes Wort wird
     * wie ein unbekannter Zustand VERWORFEN.
     */
    private static final Set<String> KNOWN_VERDICTS = Set.of("ok", "deferred", "rejected");

    /**
     * Das Sperr-Vokabular des Sidecars ({@code otaapply.Blocker*}) - der
     * maschinenlesbare Name einer STEHENDEN Sperre, seit dem Admin-UX-Umbau
     * additiv im Herzschlag. Es ist ausdrücklich ein VERTRAG (kurz, stabil, ohne
     * Umlaute), und ein Wort außerhalb davon wird VERWORFEN wie ein unbekannter
     * Zustand: es gäbe keiner Oberfläche etwas zu rendern, und eine erfundene
     * Ersatz-Aussage wäre schlimmer als das ehrliche „kein Name gemeldet" (der
     * deutsche {@code reason} trägt die Aussage dann allein).
     */
    private static final Set<String> KNOWN_BLOCKERS = Set.of("kette", "politik",
            "zurueckgenommen", "backend", "state_schema", "kern_still", "platte", "neutralzeit",
            "neutralzeit_zu_kurz", "interlock", "freigabe_release", "laden", "rueckfallziel",
            "sicherung", "unlesbar");

    /**
     * A sanity bound on the free-text fields. They reach an operator surface,
     * and a device is not the authority on how long our columns are.
     */
    private static final int MAX_TEXT = 200;

    /**
     * Die Form einer {@code key_id} im Signatur-Kontrakt
     * ({@code otaverify.keyIDRe}). Sie enthält per Konstruktion KEIN Komma -
     * genau deshalb darf die Liste komma-getrennt gespeichert werden, und
     * genau deshalb wird hier gefiltert statt escaped: ein Wert, der nicht
     * dieser Form entspricht, ist keine Schlüssel-Kennung und wird verworfen
     * (dieselbe Disziplin wie beim unbekannten Zustand).
     */
    private static final java.util.regex.Pattern KEY_ID =
            java.util.regex.Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");

    /** Ein Vertrauens-Set dieser Flotte hat eine Handvoll Schlüssel, nie hundert. */
    private static final int MAX_KEY_IDS = 16;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final UpdateStatusRepository updateStatus;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public UpdateStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, UpdateStatusRepository updateStatus) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.updateStatus = updateStatus;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Update-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-updatestatus-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Update-status listener subscribed to {} at {}", STATUS_FILTER,
                                serverUri);
                    } catch (Exception e) {
                        log.warn("Update-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Update-status listener lost the broker connection: {} "
                            + "(auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
                }

                @Override
                public void deliveryComplete(org.eclipse.paho.client.mqttv3.IMqttDeliveryToken t) {
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
                log.warn("Update status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Test-visible: parse one status heartbeat's version + update block. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        if (json == null) {
            return;
        }
        String version = text(json.get("version"));
        JsonNode update = json.get("update");
        boolean hasUpdate = update != null && update.isObject();
        // Die eigene Erreichbarkeit der Box (Anlagen-Zentrale Stufe 2, D5) ist
        // wie `version` ein TOP-LEVEL-Feld und wird deshalb HIER gelesen: dies
        // ist der eine Zuhörer, der ohne Unterblock nicht früh zurückkehrt -
        // genau die Eigenschaft, für die er in OTA Stufe 0 entstanden ist. Ein
        // eigener Geschwister-Zuhörer wäre eine zweite Broker-Verbindung, eine
        // zweite Identitätsprüfung für dieselben Bytes UND ein neues, per
        // Vorgabe ausgeschaltetes Flag, das im gitops-Repo nachgezogen werden
        // müsste (die dokumentierte Falle). Er SCHREIBT dafür in ein anderes
        // Repository - ein Zuhörer ist ein Transportweg, keine Tabelle.
        JsonNode network = json.get("network");
        boolean hasNetwork = network != null && network.isObject();
        if (version == null && !hasUpdate && !hasNetwork) {
            return; // an older edge: nothing reported, nothing claimed
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("update status on non-UUID topic '{}' skipped", topic);
            return;
        }
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("update status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        Instant reportedAt = optInstant(json, "ts");
        if (reportedAt == null) {
            reportedAt = Instant.now();
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("update status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            if (hasNetwork) {
                storeLanAddress(deviceId, network);
            }
            if (version == null && !hasUpdate) {
                return; // NUR die Adresse gemeldet - nichts über den Stand zu sagen
            }
            JsonNode trust = hasUpdate ? update.get("trust") : null;
            boolean hasTrust = trust != null && trust.isObject();
            updateStatus.upsert(deviceId, siteId, version,
                    hasUpdate ? text(update.get("backend")) : null,
                    hasUpdate ? text(update.get("current")) : null,
                    hasUpdate ? number(update.get("current_seq")) : null,
                    hasUpdate ? text(update.get("target")) : null,
                    hasUpdate ? number(update.get("target_seq")) : null,
                    hasUpdate ? state(update.get("state")) : null,
                    hasUpdate ? text(update.get("reason")) : null,
                    hasUpdate ? text(update.get("last_known_good")) : null,
                    hasUpdate ? verdict(update.get("target_verdict")) : null,
                    hasUpdate ? blocker(update.get("blocker")) : null,
                    // ⚠ Die DREI Zustände von root_key_ids sind hier zu Hause:
                    // kein trust-Block => null (ein älterer Stand, „unbekannt");
                    // ein Block mit leerer Liste => "" (Image OHNE Wurzel, also
                    // Crossover offen); sonst die sortierte Liste. Ein
                    // `keyIds(...)` ohne die hasTrust-Fallunterscheidung würde
                    // aus „nie gemeldet" stillschweigend „kein Schlüssel" machen.
                    hasTrust ? keyIds(trust.get("root_key_ids")) : null,
                    hasTrust ? keyIds(trust.get("trust_set_key_ids")) : null,
                    hasTrust ? text(trust.get("trust_set_generated_at")) : null,
                    hasTrust ? text(trust.get("trust_set_signed_by")) : null,
                    hasTrust ? text(trust.get("trust_set_error")) : null,
                    // ⚠ DREIWERTIG wie die Vertrauens-Spalten: ein Feld, das das
                    // Gerät nicht sendet, bleibt null („unbekannt") - ein
                    // `asBoolean()` mit Default machte daraus stillschweigend ein
                    // behauptetes „kann nicht anwenden", und die Oberfläche würde
                    // einem älteren Stand einen Knopf verweigern, den er sehr wohl
                    // bedienen kann.
                    reportedAt);
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Speichert die eigene Erreichbarkeit der Box - mit der ausdrücklich vom
     * Host ermittelten Kundennetz-Adresse als erster Wahl.
     *
     * <p><b>{@code lan_host} schlägt {@code host} und {@code ip}.</b> Der
     * Installer ermittelt diesen Endpunkt außerhalb des Bridge-Containers aus
     * der Nicht-VPN-Route des Docker-Hosts. Ein beobachteter HTTP-Host beweist
     * dagegen nur, dass IRGENDEIN Browser die Box erreicht hat: ein
     * VoltPilot-Servicezugriff über WireGuard würde sonst seine {@code 10.10.*}
     * Adresse als Kundenlink speichern. Für ältere/manuelle Installationen
     * bleiben {@code host} und danach {@code ip} die kompatiblen Fallbacks.
     *
     * <p>Ohne verwertbares Feld wird NICHTS geschrieben - eine gespeicherte
     * Adresse überlebt damit einen Herzschlag, der sie nicht trägt, statt zu
     * verschwinden; und {@code null} heißt weiterhin „meldet die Box nicht",
     * nie „nicht erreichbar".
     */
    private void storeLanAddress(UUID deviceId, JsonNode network) {
        String host = text(network.get("lan_host"));
        String source = "schnittstelle";
        Instant seenAt = optInstant(network, "reported_at");
        if (host == null) {
            host = text(network.get("host"));
            source = "erreicht";
            seenAt = optInstant(network, "seen_at");
        }
        if (host == null) {
            host = text(network.get("ip"));
            source = "schnittstelle";
            seenAt = optInstant(network, "reported_at");
        }
        if (host == null || host.length() > 255) {
            return;
        }
        if (seenAt == null) {
            seenAt = Instant.now();
        }
        devices.setLanAddress(deviceId, host, seenAt, source);
    }

    /**
     * A boolean that is absent or not a boolean stays {@code null} - „the device
     * did not say", never a fabricated no.
     */
    private static Boolean bool(JsonNode node) {
        return node != null && node.isBoolean() ? node.booleanValue() : null;
    }

    /**
     * A state outside the contract vocabulary is DROPPED. It is the same rule
     * the control listener applies to an unknown execution mode: the alternative
     * would be to store a word no surface can render, and every surface that
     * cannot render it would have to invent a fallback claim.
     */
    private static String state(JsonNode node) {
        String raw = text(node);
        if (raw == null) {
            return null;
        }
        if (!KNOWN_STATES.contains(raw)) {
            log.warn("unknown update state '{}' reported - dropped instead of stored", raw);
            return null;
        }
        return raw;
    }

    private static String verdict(JsonNode node) {
        String raw = text(node);
        if (raw == null) {
            return null;
        }
        if (!KNOWN_VERDICTS.contains(raw)) {
            log.warn("unknown target verdict '{}' reported - dropped instead of stored", raw);
            return null;
        }
        return raw;
    }

    /**
     * Der Sperr-Name, gegen das Vertrags-Vokabular geprüft. Ein unbekanntes Wort
     * wird verworfen - der deutsche Grund bleibt und trägt die Aussage; was
     * verloren geht, ist nur der Hebel-Hinweis, nicht die Ehrlichkeit.
     */
    private static String blocker(JsonNode node) {
        String raw = text(node);
        if (raw == null) {
            return null;
        }
        if (!KNOWN_BLOCKERS.contains(raw)) {
            log.warn("unknown OTA blocker '{}' reported - dropped instead of stored", raw);
            return null;
        }
        return raw;
    }

    /**
     * Eine Liste von Schlüssel-Kennungen zu EINEM Feld verdichten.
     *
     * <p>Sortiert (zwei Boxen mit demselben Set müssen denselben String
     * ergeben - die Oberfläche vergleicht sie), gedeckelt, und jeder Eintrag
     * muss der Kontrakt-Form entsprechen. Ein Eintrag, der es nicht tut, wird
     * VERWORFEN statt gespeichert: das ist dieselbe Regel wie beim unbekannten
     * Zustand, und sie ist hier zusätzlich die Zusicherung, dass kein Komma in
     * die komma-getrennte Ablage gerät.
     *
     * <p>Rückgabe {@code ""} für eine leere/fehlende Liste INNERHALB eines
     * vorhandenen trust-Blocks - das ist die Aussage „Image ohne Wurzel", nicht
     * „nichts gemeldet".
     */
    private static String keyIds(JsonNode node) {
        if (node == null || node.isNull() || !node.isArray()) {
            return "";
        }
        java.util.TreeSet<String> ids = new java.util.TreeSet<>();
        for (JsonNode n : node) {
            if (ids.size() >= MAX_KEY_IDS) {
                break;
            }
            String raw = text(n);
            if (raw == null) {
                continue;
            }
            if (!KEY_ID.matcher(raw).matches()) {
                log.warn("malformed OTA key id '{}' reported - dropped instead of stored", raw);
                continue;
            }
            ids.add(raw);
        }
        return String.join(",", ids);
    }

    private static String text(JsonNode node) {
        if (node == null || node.isNull() || !node.isTextual()) {
            return null;
        }
        String raw = node.asText().trim();
        if (raw.isEmpty()) {
            return null;
        }
        return raw.length() > MAX_TEXT ? raw.substring(0, MAX_TEXT) : raw;
    }

    /**
     * A sequence number is only meaningful as a whole number. Anything else
     * (a string, a float, a negative) is not the register's ordering and is
     * dropped rather than coerced.
     */
    private static Long number(JsonNode node) {
        if (node == null || node.isNull() || !node.canConvertToLong()) {
            return null;
        }
        long v = node.asLong();
        return v < 0 ? null : v;
    }

    private static Instant optInstant(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
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
        } catch (IllegalArgumentException | NullPointerException e) {
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
                log.debug("Update-status listener disconnect failed on shutdown: {}",
                        e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Update-status listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
