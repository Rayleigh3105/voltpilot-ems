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
 * Der D6-UPLINK: die Box meldet ihr EIGENES Schreib-Audit im Herzschlag, damit
 * ein Schreibvorgang, der VOR ORT am Gerät gemacht wurde, auch im Cloud-Journal
 * steht (Konzept {@code vp-reg-schreib-konzept-p8}, Captain-Entscheid D6).
 *
 * <p><b>Er schließt die „zwei Wahrheiten über denselben Vorgang"-Lücke</b>
 * (§2.9 Punkt 7): die Box führt ihr Buch, die Cloud ihres, verbunden über die
 * {@code request_id} - ohne diesen Uplink stünde ein lokaler Schreibvorgang nur
 * in EINEM davon, und die Befehle-Seite hätte auf Dauer sagen müssen
 * „Vor-Ort-Schreibvorgänge erscheinen hier nicht".
 *
 * <p><b>⚠ Er reitet auf {@code voltpilot.provisioning.enabled}, nicht auf einem
 * eigenen Flag</b> - anders als seine Geschwister auf demselben Topic
 * (control/curtailment/consumers/sources/ota), die je ein eigenes, per Vorgabe
 * ausgeschaltetes Flag haben. Ein solches müsste im gitops-Repo nachgezogen
 * werden, und genau diese Klasse hat hier schon einmal einen stillen
 * Produktions-Ausfall gekostet (die OTA-Listener-Falle). Das Feature ist damit
 * als EINE Einheit an oder aus: Publisher, Quittungs-Zuhörer und dieser Uplink.
 *
 * <p><b>Es entstehen nie Doppel-Zeilen:</b> jeder INSERT ist
 * {@code ON CONFLICT (request_id, event) DO NOTHING}, also ist ein in jedem
 * Herzschlag wiederholter Eintrag ein No-op - und ein PORTAL-Schreibvorgang, den
 * die Cloud schon protokolliert hat, trifft schlicht auf das, was dort steht.
 * Ging seine Quittung unterwegs verloren, füllt das Buch der Box die Lücke.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.provisioning.enabled", havingValue = "true")
public class RegisterWriteUplinkListener {

    private static final Logger log = LoggerFactory.getLogger(RegisterWriteUplinkListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";

    /** Eine Grenze für einen Herzschlag - die Box sendet höchstens fünf. */
    private static final int MAX_ENTRIES = 8;
    private static final int MAX_MESSAGE = 400;

    /**
     * Das Ergebnis-Vokabular der Box. Ein Wort außerhalb wird VERWORFEN, statt
     * eine Aussage zu werden, die niemand einordnen kann.
     */
    private static final Set<String> RESULTS =
            Set.of("dry_run", "applied", "mismatch", "failed", "precondition");

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final RegisterWriteEventRepository journal;
    private final DeviceRepository devices;
    private final RegisterKnowledge knowledge;
    private final RegisterWriteTargets targets;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public RegisterWriteUplinkListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            RegisterWriteEventRepository journal, DeviceRepository devices,
            RegisterKnowledge knowledge, RegisterWriteTargets targets) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.journal = journal;
        this.devices = devices;
        this.knowledge = knowledge;
        this.targets = targets;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Register-write uplink listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl,
                    "voltpilot-api-register-write-uplink-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Register-write uplink listener subscribed to {} at {}",
                                STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Register-write uplink subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Register-write uplink listener lost the broker connection: {} "
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
                log.warn("Register-write uplink on '{}' could not be handled: {}",
                        topic, e.getMessage());
            }
        };
    }

    /** Test-sichtbar: einen Herzschlag auswerten und seine Einträge journalisieren. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // kein JSON - nicht für uns
        }
        JsonNode block = json == null ? null : json.get("register_writes");
        if (block == null || !block.isObject()) {
            return; // ein Herzschlag ohne den Block (der Normalfall)
        }
        JsonNode entries = block.get("entries");
        if (entries == null || !entries.isArray() || entries.isEmpty()) {
            return;
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
        // Topic-Identität MUSS der Payload-Identität entsprechen - ein Gerät darf
        // nicht für ein anderes melden (die Ingest-/Control-Regel).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("register write uplink payload identity does not match its topic - skipped");
            return;
        }

        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("register write uplink for unknown device {} skipped", deviceId);
                return;
            }
            int seen = 0;
            for (JsonNode e : entries) {
                if (seen++ >= MAX_ENTRIES) {
                    break;
                }
                ingest(siteId, device.get(), e);
            }
        } catch (Exception e) {
            log.error("register write uplink could not be journalled: {}", e.getMessage());
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * EIN gemeldeter Vorgang als die zwei Journal-Zeilen. Er wird VERWORFEN,
     * sobald irgendetwas fehlt, das die Zeile beweisbar machen würde - eine
     * halbe Aussage über einen Schreibvorgang an einem Kundengerät ist schlechter
     * als keine.
     */
    private void ingest(UUID siteId, DeviceDto device, JsonNode e) {
        String requestId = text(e, "request_id", 64);
        String register = text(e, "register", 32);
        String result = e.path("result").asText("");
        Integer requested = optRegister(e, "requested");
        if (requestId == null || register == null || requested == null
                || !RESULTS.contains(result)) {
            return;
        }
        Integer address = RegisterKnowledge.parseAddress(register).orElse(null);
        if (address == null) {
            return;
        }
        Instant at = instant(e, "at");
        if (at == null) {
            return;
        }
        // Die Herkunft: das Wort der Box entscheidet, WELCHER Trigger es war.
        String boxSource = text(e, "source", 64);
        boolean portal = boxSource != null && boxSource.startsWith("portal");
        String source = portal
                ? RegisterWriteEventRepository.SOURCE_PORTAL
                : RegisterWriteEventRepository.SOURCE_DEVICE;
        // ⚠ Die Familie entscheidet, was ein Register BEDEUTET (auf hybrid_1p ist
        // dieselbe Zahl ein anderes Register mit anderer Skala). Ohne gemeldete
        // Familie bleibt der Eintrag ehrlich „unbekannt" - ein Deye-Name auf ein
        // fremdes Gerät zu stempeln waere die schlechteste Auskunft dieses Pfades.
        RegisterKnowledge.Known known = knowledge.of(
                targets.primaryFamily(siteId, device.id()), address);

        journal.recordRequest(new RegisterWriteEventRepository.Request(
                requestId, source, siteId, device.id(), device.externalRef(),
                RegisterWriteTargets.LANE_PRIMARY, null,
                targetLabel(device), "holding", address, null,
                // Die Box hat kein Formular: was sie AUFGEZEICHNET hat, IST hier
                // die verbatim Eingabe.
                register, String.valueOf(requested), null, requested, null,
                known.label(), known.clazz(), known.scaleNote(requested),
                RegisterWriteEventRepository.ORIGIN_DEVICE,
                boxSource == null ? "wartungszugang" : boxSource, null, "wartungszugang",
                false, at));

        Integer before = optRegister(e, "before");
        Integer after = optRegister(e, "after");
        Boolean adopted = after == null ? null : after.equals(requested);
        journal.recordOutcome(new RegisterWriteEventRepository.Receipt(
                requestId, RegisterWriteEventRepository.EVENT_RECEIPT, source, siteId,
                device.id(), before, after, adopted, outcome(result, adopted),
                text(e, "message", MAX_MESSAGE), targetLabel(device), at));
    }

    /**
     * WOHIN - in Klartext. Die Box meldet kein Ziel-Label (sie schreibt per
     * Konstruktion auf ihren eigenen primären Wechselrichter), also nennt die
     * Zeile das Gerät statt ein erfundenes Modell.
     */
    private static String targetLabel(DeviceDto device) {
        String name = device.name() == null || device.name().isBlank()
                ? device.externalRef() : device.name();
        return "Vor Ort am Gerät · " + name;
    }

    /**
     * Das Urteil der Box in das Vokabular des Journals. {@code applied} allein
     * behauptet nichts: ob übernommen wurde, sagt die Rücklesung.
     */
    private static String outcome(String result, Boolean adopted) {
        return switch (result) {
            case "applied" -> Boolean.TRUE.equals(adopted)
                    ? RegisterWriteResult.OUTCOME_ADOPTED
                    : RegisterWriteResult.OUTCOME_NOT_ADOPTED;
            case "mismatch" -> RegisterWriteResult.OUTCOME_NOT_ADOPTED;
            case "precondition" -> RegisterWriteResult.OUTCOME_REFUSED;
            case "dry_run" -> RegisterWriteResult.OUTCOME_READ;
            default -> RegisterWriteResult.OUTCOME_ERROR;
        };
    }

    private static Instant instant(JsonNode node, String field) {
        String raw = node.path(field).asText("");
        if (raw.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private static String text(JsonNode node, String field, int max) {
        String m = node.path(field).asText("");
        if (m.isBlank()) {
            return null;
        }
        return m.length() > max ? m.substring(0, max) : m;
    }

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
                log.debug("Register-write uplink disconnect failed on shutdown: {}",
                        e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Register-write uplink close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
