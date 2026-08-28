package com.voltpilot.api.chargers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.BudgetRow;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.ChargePointRow;
import com.voltpilot.api.repo.DeviceChargerStatusRepository.ConnectorRow;
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
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Ingestiert den additiven {@code chargers}-Block des Geräte-Herzschlags
 * (ems/{t}/{s}/{d}/status) in {@code device_charging_budget} /
 * {@code device_charge_point} / {@code device_charge_connector}: das
 * Standort-Ladebudget, die OCPP-Ladesäulen und ihre Stecker (Lastmanagement
 * Stufe 3, Konzept {@code vp-ocpp-lastmgmt-konzept-w4} §5.3).
 *
 * <p>Das ACHTE Geschwister auf DEMSELBEN Topic-Filter mit derselben
 * Autorisierungs-Haltung wie {@code SourceStatusListener} und
 * {@code CurtailmentStatusListener}: Broker-ACL + mTLS-CN, Topic-Identität
 * gegen die Nutzlast nachgeprüft, Gerät über die RLS-Repository unter dem
 * Mandanten des Topics aufgelöst. ANZEIGE-DATEN - nichts hier fasst Telemetrie,
 * Rollups oder den Optimierer an, und es entsteht KEIN Schreibpfad zum Gerät
 * (die Anschlussgrenze ist eine physische Grenze; ihr Wächter bleibt auf der
 * Box, Konzept E1).
 *
 * <p>Zwei Ehrlichkeits-Regeln, beide aus dem Haus-Kanon:
 * <ul>
 *   <li>ein Stecker-Status AUSSERHALB des OCPP-1.6-Vokabulars wird VERWORFEN
 *       statt gespeichert - ein Wort, das wir nicht verstehen, darf kein Satz
 *       werden (die {@code ControlStatusListener}-Regel);</li>
 *   <li>ein fehlender Messwert bleibt NULL, nie 0 - ein Ladepunkt, der nichts
 *       meldet, lädt nicht nachweislich nichts.</li>
 * </ul>
 */
@Component
@ConditionalOnProperty(name = "voltpilot.chargers.mqtt-listener-enabled", havingValue = "true")
public class ChargerStatusListener {

    private static final Logger log = LoggerFactory.getLogger(ChargerStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /** Dieselben Grenzen wie am Rand - ein Herzschlag kann den Satz nie aufblähen. */
    private static final int MAX_CHARGERS = 16;
    private static final int MAX_CONNECTORS = 8;

    /** Das OCPP-1.6-Status-Vokabular, wörtlich. Alles andere wird verworfen. */
    private static final Set<String> STATUS = Set.of("Available", "Preparing", "Charging",
            "SuspendedEVSE", "SuspendedEV", "Finishing", "Reserved", "Unavailable", "Faulted");
    /** Das Rücklese-Urteil des CSMS. */
    private static final Set<String> READBACK = Set.of("ok", "abweichend", "unbekannt");

    /**
     * Das Vokabular der Stufe-4-Quellen-Bahn. Wie {@link #STATUS} / {@link
     * #READBACK} GESCHLOSSEN: ein Wort, das wir nicht verstehen, darf kein
     * gespeicherter Zustand werden.
     */
    private static final Set<String> POLICIES = Set.of("nur_sonne", "sonne_zuerst", "schnell");

    private static final Set<String> STORAGE = Set.of("speicher_vor_auto", "auto_vor_speicher");

    private static final Set<String> SURPLUS_MODES = Set.of("aus", "gemessen", "nicht_belegbar");

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final DeviceChargerStatusRepository chargerStatus;
    private final ObjectProvider<ChargerComponentComposer> composer;
    private final ObjectProvider<CommandLogWriter> commandLog;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public ChargerStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DeviceChargerStatusRepository chargerStatus,
            ObjectProvider<ChargerComponentComposer> composer,
            ObjectProvider<CommandLogWriter> commandLog) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.chargerStatus = chargerStatus;
        this.composer = composer;
        this.commandLog = commandLog;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Charger-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-chargers-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Charger-status listener subscribed to {} at {}", STATUS_FILTER,
                                serverUri);
                    } catch (Exception e) {
                        log.warn("Charger-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Charger-status listener lost the broker connection: {} (auto-reconnect active)",
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
                log.warn("Charger status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Test-sichtbar: EINEN Herzschlag mit seinem chargers-Block verarbeiten. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // kein JSON - nicht für uns
        }
        JsonNode block = json == null ? null : json.get("chargers");
        if (block == null || !block.isObject()) {
            return; // ein Herzschlag ohne Ladepunkt-Block
        }
        JsonNode list = block.get("chargers");
        if (list == null || !list.isArray()) {
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
        // Topic-Identität muss der Nutzlast entsprechen (ein Gerät meldet nur
        // SEINE eigenen Ladepunkte) - die Regel jedes Geschwister-Zuhörers.
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("charger status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        Instant reportedAt = optInstant(block, "reported_at");
        if (reportedAt == null) {
            reportedAt = Instant.now();
        }
        BudgetRow budget = budget(block);
        List<ChargePointRow> chargers = new ArrayList<>();
        for (JsonNode c : list) {
            if (chargers.size() >= MAX_CHARGERS) {
                break;
            }
            String id = c.path("id").asText("");
            if (id.isBlank()) {
                continue;
            }
            chargers.add(new ChargePointRow(id, textOrNull(c, "label"),
                    c.path("priority").asBoolean(false), c.path("connected").asBoolean(false),
                    textOrNull(c, "vendor"), textOrNull(c, "model"), textOrNull(c, "firmware"),
                    c.path("ready").asBoolean(false), textOrNull(c, "note"),
                    optInstant(c, "last_seen"), connectors(c.get("connectors"))));
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("charger status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            chargerStatus.replaceForDevice(deviceId, tenantId, siteId, reportedAt, budget,
                    chargers);
            // Der Kommando-Verlauf: je Säule eine laufende Periode über die
            // Grenze, die die Box ihr hinterlegt hat. Nie werfend - der
            // Verlauf ist die Kür, der Ist-Zustand die Pflicht.
            CommandLogWriter log = commandLog.getIfAvailable();
            if (log != null) {
                log.ingestChargers(siteId, deviceId, chargerFacts(deviceId, chargers,
                        budget.controlEnabled()), reportedAt);
            }
            // Die Säule wird zur KOMPONENTE, sobald sie sich gemeldet hat - das
            // Bestands-Übernahme-Muster, telemetrie-getrieben und NIE werfend:
            // ein Ladepunkt, der lädt, ist wichtiger als sein Modell-Eintrag.
            ChargerComponentComposer c = composer.getIfAvailable();
            if (c != null) {
                c.ensureComposed(siteId, deviceId);
            }
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * Die Verlaufs-Fakten je Säule. Die Entitäts-Id kommt aus der GESPEICHERTEN
     * Bindung (die Komposition läuft eine Zeile darüber), damit der Verlauf
     * dieselbe Komponente meint wie das Anlagen-Modell; eine Säule ohne
     * Komponente wird ausgelassen statt mit einer erfundenen Id geführt.
     */
    private List<CommandLogWriter.ChargerFacts> chargerFacts(UUID deviceId,
            List<ChargePointRow> chargers, boolean controlEnabled) {
        Map<String, UUID> bound = chargerStatus.entityIdsByChargePoint(deviceId);
        List<CommandLogWriter.ChargerFacts> out = new ArrayList<>();
        for (ChargePointRow c : chargers) {
            UUID entityId = bound.get(c.chargePointId());
            if (entityId == null) {
                continue;
            }
            double allocated = 0;
            boolean charging = false;
            Boolean confirmed = null;
            String reason = null;
            for (ConnectorRow con : c.connectors()) {
                if (con.allocatedKw() != null) {
                    allocated += con.allocatedKw();
                }
                if (con.charging()) {
                    charging = true;
                }
                // Das Rücklese-Urteil der Säule: ein „abweichend" an EINEM
                // Stecker ist die schärfere Aussage und gewinnt; ohne jede
                // Antwort bleibt es dreiwertig null (eine Lücke, kein Nein).
                if ("abweichend".equals(con.readback())) {
                    confirmed = Boolean.FALSE;
                } else if ("ok".equals(con.readback()) && confirmed == null) {
                    confirmed = Boolean.TRUE;
                }
                if (reason == null && con.reason() != null) {
                    reason = con.reason();
                }
            }
            out.add(new CommandLogWriter.ChargerFacts(entityId, charging, allocated, reason,
                    confirmed, controlEnabled));
        }
        return out;
    }

    private static BudgetRow budget(JsonNode b) {
        return new BudgetRow(b.path("enabled").asBoolean(false),
                b.path("control_enabled").asBoolean(false), textOrNull(b, "control_note"),
                optDouble(b, "grid_limit_kw"), optDouble(b, "margin_pct"),
                optDouble(b, "min_power_kw"), optDouble(b, "budget_kw"),
                optDouble(b, "allocated_kw"), optDouble(b, "reserved_kw"),
                optDouble(b, "measured_kw"), optDouble(b, "site_load_kw"),
                optDouble(b, "site_grid_kw"), textOrNull(b, "budget_mode"),
                textOrNull(b, "budget_note"), b.path("budget_blind").asBoolean(false),
                optDouble(b, "eff_limit_kw"), optDouble(b, "safe_default_kw"),
                textOrNull(b, "safe_default_note"), optBool(b, "safe_default_holds"),
                optDouble(b, "safe_worst_case_kw"), optDouble(b, "max_house_load_kw"),
                b.path("connector_count").asInt(0),
                // ⚠ Stufe 4: ein Wort ausserhalb des Vokabulars wird VERWORFEN
                // statt gespeichert - der Stecker behaelt damit "nicht
                // gemeldet" statt eine erfundene Wahl (die Regel dieses
                // Zuhoerers, hier auf die Quellen-Bahn angewandt).
                vocabulary(b, "surplus_policy", POLICIES),
                vocabulary(b, "storage_priority", STORAGE),
                b.path("surplus_active").asBoolean(false), optDouble(b, "surplus_kw"),
                vocabulary(b, "surplus_mode", SURPLUS_MODES), textOrNull(b, "surplus_note"),
                b.path("surplus_blind").asBoolean(false), optDouble(b, "surplus_total_kw"),
                optDouble(b, "surplus_battery_kw"), optDouble(b, "source_allocated_kw"),
                // ⚠ Ein Port ausserhalb des gueltigen Bereichs (und die 0, mit
                // der eine Box sagt "ich lausche nicht") wird VERWORFEN statt
                // gespeichert - eine Adresse, auf der niemand antwortet, waere
                // die schlechtere Auskunft als gar keine.
                optPort(b, "ocpp_port"), textOrNull(b, "url_path"));
    }

    /** Ein Port, den eine Saeule wirklich anwaehlen kann - sonst nichts. */
    private static Integer optPort(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isNumber()) {
            return null;
        }
        int port = v.asInt();
        return port > 0 && port <= 65535 ? port : null;
    }

    private static List<ConnectorRow> connectors(JsonNode list) {
        List<ConnectorRow> out = new ArrayList<>();
        if (list == null || !list.isArray()) {
            return out;
        }
        for (JsonNode con : list) {
            if (out.size() >= MAX_CONNECTORS) {
                break;
            }
            JsonNode idNode = con.get("id");
            if (idNode == null || !idNode.isNumber()) {
                continue;
            }
            out.add(new ConnectorRow(idNode.asInt(), vocabulary(con, "status", STATUS),
                    con.path("charging").asBoolean(false), optDouble(con, "allocated_kw"),
                    textOrNull(con, "reason"), textOrNull(con, "reason_text"),
                    optInstant(con, "next_turn"), optDouble(con, "power_kw"),
                    optDouble(con, "energy_kwh"), optDouble(con, "soc_pct"),
                    textOrNull(con, "command_status"), vocabulary(con, "readback", READBACK),
                    textOrNull(con, "readback_note"), optInstant(con, "session_since"),
                    optDouble(con, "session_kwh"), optInstant(con, "metered_at"),
                    con.path("boost").asBoolean(false)));
        }
        return out;
    }

    /**
     * Ein Wort aus einem GESCHLOSSENEN Vokabular, sonst null: ein unbekanntes
     * Wort wird verworfen statt gespeichert - der Stecker behält damit "kein
     * Zustand gemeldet" statt einen erfundenen zu bekommen.
     */
    private static String vocabulary(JsonNode node, String field, Set<String> allowed) {
        String v = node.path(field).asText("");
        return allowed.contains(v) ? v : null;
    }

    private static String textOrNull(JsonNode node, String field) {
        String v = node.path(field).asText("");
        return v.isBlank() ? null : v;
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isNumber()) ? null : v.asDouble();
    }

    private static Boolean optBool(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isBoolean()) ? null : v.asBoolean();
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
                log.debug("Charger listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Charger listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
