package com.voltpilot.api.registerwrite;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.RegisterWriteEventRepository;
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
 * Nimmt die Quittung eines Geräts auf {@code ems/+/+/+/v2/register-write-result}
 * entgegen (Kontrakt {@code docs/contracts/mqtt-register-write.schema.json}).
 *
 * <p><b>Er tut ZWEI Dinge, und die Reihenfolge ist Absicht:</b> zuerst
 * PERSISTIERT er die Quittung ins append-only Journal, dann weckt er den
 * wartenden Request-Thread. Anders als beim Probe-Kanal (der nichts speichert)
 * ist das hier tragend: der wartende Aufruf hat nach wenigen Sekunden aufgegeben
 * und die Oberfläche „Zustand unbekannt" gesagt - trifft die Quittung Sekunden
 * später doch ein, ist das Journal der Ort, an dem sie sichtbar wird. Ein
 * Schreibvorgang darf nie spurlos sein.
 *
 * <p>Dieselbe Autorisierungs-Haltung wie bei jedem Geschwister-Zuhörer auf den
 * Gerätetopics (control / curtailment / consumers / sources / purge): die
 * Broker-ACL und das mTLS-Zertifikats-CN machen ein Gerät überhaupt erst
 * publikationsfähig, die Topic-Identität wird gegen die Nutzlast nachgeprüft,
 * und die Registry lässt eine Antwort nur für das Gerät zu, an das die Frage
 * ging.
 *
 * <p><b>Ein unbekanntes Fehlerwort wird VERWORFEN, nicht weitergereicht</b> -
 * die Ingest-Regel des Hauses („was wir nicht verstehen, darf kein Satz
 * werden"), die hier zusätzlich verhindert, dass ein Gerät beliebigen Text vor
 * einen Kunden stellt.
 *
 * <p>Reitet auf {@code voltpilot.provisioning.enabled} statt auf einem eigenen,
 * per Vorgabe ausgeschalteten Flag - ein solches müsste im gitops-Repo
 * nachgezogen werden, und genau das hat dieses Repo schon einmal einen stillen
 * Produktions-Ausfall gekostet (die OTA-Listener-Falle).
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class RegisterWriteResultListener {

    private static final Logger log = LoggerFactory.getLogger(RegisterWriteResultListener.class);
    private static final String RESULT_FILTER = "ems/+/+/+/v2/register-write-result";

    /** Die geschlossene Fehlermenge des Kontrakts. */
    static final Set<String> ERROR_CODES = Set.of(
            "invalid_request", "unreachable", "no_answer", "invalid_response", "implausible",
            "timeout", "not_supported", "rate_limited", "gate_disabled", "refused_policy",
            "refused_control_owned", "refused_expected_before", "busy");

    private static final Set<String> MODES =
            Set.of(RegisterWriteResult.MODE_READ, RegisterWriteResult.MODE_WRITE);

    /** Eine Grenze für den deutschen Satz, den ein Gerät einem Kunden reicht. */
    private static final int MAX_MESSAGE = 400;
    private static final int MAX_LABEL = 200;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final RegisterWriteRegistry registry;
    private final RegisterWriteEventRepository journal;
    private final DeviceRepository devices;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public RegisterWriteResultListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            RegisterWriteRegistry registry, RegisterWriteEventRepository journal,
            DeviceRepository devices) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.registry = registry;
        this.journal = journal;
        this.devices = devices;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Register-write-result listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl,
                    "voltpilot-api-register-write-result-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(RESULT_FILTER, 1, messageListener());
                        log.info("Register-write-result listener subscribed to {} at {}",
                                RESULT_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Register-write-result subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Register-write-result listener lost the broker connection: {} "
                            + "(auto-reconnect active)",
                            cause == null ? "unknown" : cause.getMessage());
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
                }

                @Override
                public void deliveryComplete(
                        org.eclipse.paho.client.mqttv3.IMqttDeliveryToken token) {
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
                log.warn("Register-write result on '{}' could not be handled: {}",
                        topic, e.getMessage());
            }
        };
    }

    /** Test-sichtbar: eine Quittung auswerten, persistieren und zustellen. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // kein JSON - nicht für uns
        }
        if (json == null || !json.isObject()) {
            return;
        }
        if (!"register_write_result".equals(json.path("type").asText())
                || !"1.0".equals(json.path("schema_version").asText())) {
            return;
        }
        String[] parts = topic.split("/");
        if (parts.length != 6) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            return;
        }
        // Topic-Identität MUSS der Payload-Identität entsprechen - ein Gerät darf
        // nicht für ein anderes quittieren (die Ingest-/Control-Regel).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("register write result payload identity does not match its topic - skipped");
            return;
        }
        String requestId = json.path("request_id").asText("");
        if (requestId.isBlank()) {
            return;
        }
        String mode = json.path("mode").asText("");
        if (!MODES.contains(mode)) {
            // Ein Modus, den wir nicht kennen, macht aus der ganzen Quittung eine
            // Aussage, die niemand einordnen kann.
            log.warn("register write result {} carries an unknown mode - skipped", requestId);
            return;
        }
        boolean ok = json.path("ok").asBoolean(false);
        RegisterWriteResult result = new RegisterWriteResult(requestId, mode, ok,
                optRegister(json, "before_raw"), optRegister(json, "after_raw"),
                optBoolean(json, "wrote"), optBoolean(json, "adopted"),
                text(json, "target_label", MAX_LABEL), code(json),
                text(json, "message", MAX_MESSAGE), answeredAt(json));

        persist(tenantId, siteId, deviceId, result);
        // ⚠ DER AUSGANG DER KORRELATION WIRD PROTOKOLLIERT (Produktionsvorfall
        // 20.08.2026). Vorher schwieg dieser Pfad vollständig: eine Quittung,
        // die zu spät oder zu einer vergessenen Kennung eintraf, verschwand
        // spurlos - im api-Protokoll war „das Gerät hat nie geantwortet" von
        // „das Gerät hat zu spät geantwortet" nicht zu unterscheiden, obwohl
        // genau das die Diagnose war. Eine ZUGESTELLTE Quittung bleibt still
        // (der Aufruf selbst ist die Spur); die zwei anderen Ausgänge sind laut.
        RegisterWriteRegistry.Delivery delivery = registry.complete(deviceId, requestId, result);
        switch (delivery) {
            case LATE -> log.warn("register write result {} von Gerät {} kam ZU SPÄT - der "
                    + "Aufruf hatte das Warten schon aufgegeben (mode={}, ok={}). Das Budget "
                    + "voltpilot.register-write.*-timeout ist für diese Anlage zu knapp.",
                    requestId, deviceId, mode, ok);
            case UNKNOWN -> log.warn("register write result {} von Gerät {} ließ sich keiner "
                    + "wartenden Anfrage zuordnen (mode={}) - unbekannte Kennung, fremdes Gerät "
                    + "oder längst verfallen.", requestId, deviceId, mode);
            default -> { }
        }
    }

    /**
     * Die Quittungs-Zeile - UNABHÄNGIG davon, ob noch jemand wartet. Sie wird
     * unter dem Mandanten des TOPICS geschrieben (das
     * {@code ControlStatusListener}-Muster), und das Gerät muss wirklich zu
     * dieser Anlage gehören: sonst wäre es eine Zeile über eine fremde Anlage.
     *
     * <p>Ein Fehlschlag hier darf die Zustellung nie verhindern - der wartende
     * Kunde bekommt seine Antwort auch dann, wenn die Papier-Spur klemmt; er
     * erfährt es LAUT im Protokoll.
     */
    private void persist(UUID tenantId, UUID siteId, UUID deviceId, RegisterWriteResult r) {
        // Ein Probelauf ändert nichts und wird deshalb nicht protokolliert -
        // dieselbe Entscheidung wie im Box-Audit: ein Protokoll der Lesungen
        // würde die Schreibvorgänge begraben, für die es das Journal gibt.
        if (!RegisterWriteResult.MODE_WRITE.equals(r.mode())) {
            return;
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("register write result for unknown device {} skipped", deviceId);
                return;
            }
            journal.recordOutcome(new RegisterWriteEventRepository.Receipt(
                    r.requestId(), RegisterWriteEventRepository.EVENT_RECEIPT,
                    RegisterWriteEventRepository.SOURCE_PORTAL, siteId, deviceId,
                    r.beforeRaw(), r.afterRaw(), r.adopted(), r.outcome(), r.message(),
                    r.targetLabel(), r.answeredAt() == null ? Instant.now() : r.answeredAt()));
        } catch (Exception e) {
            log.error("register write receipt {} could not be journalled: {}",
                    r.requestId(), e.getMessage());
        } finally {
            TenantContext.clear();
        }
    }

    private static Instant answeredAt(JsonNode json) {
        String raw = json.path("answered_at").asText("");
        if (raw.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** Eine bekannte Fehlerklasse, oder null - ein erfundenes Wort erreicht nie einen Kunden. */
    private static String code(JsonNode node) {
        String c = node.path("error_code").asText("");
        return ERROR_CODES.contains(c) ? c : null;
    }

    private static String text(JsonNode node, String field, int max) {
        String m = node.path(field).asText("");
        if (m.isBlank()) {
            return null;
        }
        return m.length() > max ? m.substring(0, max) : m;
    }

    private static Boolean optBoolean(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || !v.isBoolean() ? null : v.asBoolean();
    }

    /** Ein 16-Bit-Registerwort, oder null - nie ein zurechtgebogener Wert. */
    private static Integer optRegister(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isInt()) {
            return null;
        }
        int i = v.asInt();
        return i >= 0 && i <= 0xffff ? i : null;
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
                log.debug("Register-write listener disconnect failed on shutdown: {}",
                        e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Register-write listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
