package com.voltpilot.api.chargers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.fahrzeuge.SiteVehicleRepository;
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

    /**
     * Die Form eines Karten-Pseudonyms, so wie die BOX es bildet (P7). Sie ist
     * hier wiederholt (nicht aus {@code FahrzeugSteuerart} importiert), weil
     * dieser Zuhörer der PARSER ist und vom Fachdienst frei bleiben soll - die
     * beiden sind über die DB-Bedingung und den Kontrakt aneinander gepinnt.
     */
    private static final java.util.regex.Pattern TAG_REF =
            java.util.regex.Pattern.compile("^tagref_[0-9a-f]{8,64}$");
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

    /**
     * WO eine Säule hängt (Cockpit Phase 1 / C1). Wie jedes andere Vokabular
     * hier GESCHLOSSEN: ein Wort, das wir nicht verstehen, wird verworfen statt
     * gespeichert - die Säule bleibt dann bei „nicht gemeldet", was ehrlich
     * ist, statt eine Bilanz-Aussage zu bekommen, die niemand getroffen hat.
     */
    private static final Set<String> CONNECTIONS = Set.of("haus", "eigen");

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final DeviceChargerStatusRepository chargerStatus;
    private final ObjectProvider<ChargerComponentComposer> composer;
    private final ObjectProvider<CommandLogWriter> commandLog;
    /**
     * Die Ladekarten-Sichtungen (P7). Als {@link ObjectProvider}, damit ein
     * Deployment ohne diese Bohne sich zeichengleich wie vorher verhält - nie
     * ein Pflicht-Glied für ein additives Feature.
     */
    private final ObjectProvider<SiteVehicleRepository> vehicles;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public ChargerStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, DeviceChargerStatusRepository chargerStatus,
            ObjectProvider<ChargerComponentComposer> composer,
            ObjectProvider<CommandLogWriter> commandLog,
            ObjectProvider<SiteVehicleRepository> vehicles) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.chargerStatus = chargerStatus;
        this.composer = composer;
        this.commandLog = commandLog;
        this.vehicles = vehicles;
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
                    optInstant(c, "last_seen"), vocabulary(c, "connection", CONNECTIONS),
                    connectors(c.get("connectors"))));
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
            JsonNode controlStatus = block.get("control_status");
            if (validControlStatus(controlStatus))
                chargerStatus.replaceOcppControlStatus(deviceId, controlStatus.toString());
            // P7: die SICHTUNGEN der Ladekarten. Sie sind das, woraus im Portal
            // überhaupt erst eine benennbare Zeile wird - ohne sie gäbe es
            // nichts, dem der Kunde einen Namen geben könnte.
            //
            // ⚠ Sie ist eine BEOBACHTUNG, keine Entscheidung: Name und
            // Steuerart werden dabei nie angefasst, und ein Herzschlag ohne
            // Karte schreibt gar nichts.
            merkeKarten(tenantId, siteId, chargers, reportedAt);
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
     * Hält fest, welche Ladekarte gerade an welcher Säule lädt (P7).
     *
     * <p>⚠ Nie werfend: eine Sichtung ist die Kür, der Ist-Zustand die Pflicht
     * (die {@code CommandLogWriter}-Disziplin). Und sie läuft über den
     * {@link ObjectProvider}, damit ein Deployment ohne die P7-Bohne sich
     * zeichengleich wie vorher verhält.
     */
    private void merkeKarten(UUID tenantId, UUID siteId, List<ChargePointRow> chargers,
            Instant reportedAt) {
        SiteVehicleRepository repo = vehicles.getIfAvailable();
        if (repo == null) {
            return;
        }
        try {
            for (ChargePointRow c : chargers) {
                for (ConnectorRow con : c.connectors()) {
                    if (con.tagRef() != null) {
                        repo.touch(tenantId, siteId, con.tagRef(), c.chargePointId(), reportedAt);
                    }
                }
            }
        } catch (RuntimeException e) {
            log.warn("vehicle sighting for site {} not stored: {}", siteId, e.toString());
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
                    con.path("boost").asBoolean(false), tagRef(con)));
        }
        return out;
    }

    /**
     * Der PSEUDONYM der Ladekarte dieses Ladevorgangs (P7).
     *
     * <p>⚠ Angenommen wird NUR, was diese Box gebildet haben kann - dieselbe
     * Form, die der Kontrakt und die DB-Bedingung fordern. Ein Klartext-IdTag
     * oder ein doppelt gehashter Journal-Bezug wird VERWORFEN statt gespeichert
     * (die Regel dieses Zuhörers, hier auf die Karte angewandt): eine Kennung,
     * die kein Fahrzeug-Profil je treffen kann, ist keine Auskunft, sondern ein
     * Rätsel - und ein Klartext-Tag wäre obendrein genau der Wert, der diese
     * Box nie verlassen darf.
     */
    private static String tagRef(JsonNode node) {
        String v = node.path("tag_ref").asText("");
        return TAG_REF.matcher(v).matches() ? v : null;
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

    static boolean validControlStatus(JsonNode report) {
        if (report == null || !report.isObject() || report.toString().length() > 1_048_576
                || !report.path("revision").isIntegralNumber() || report.path("revision").asLong() < 0
                || !report.path("enabled").isBoolean()
                || !java.util.Set.of("free", "allowlist").contains(report.path("authorization_mode").asText())
                || !report.path("stations").isArray() || report.path("stations").size() > 64
                || !report.path("seen_tags").isArray() || report.path("seen_tags").size() > 128) return false;
        for (var tag : report.path("seen_tags")) if (!tag.isTextual() || !tag.asText().matches("tagref_[0-9a-f]{24}")) return false;
        for (var station : report.path("stations")) {
            if (!station.path("id").asText().matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
                    || !station.path("connected").isBoolean() || !station.path("capabilities_read").isBoolean()
                    || !station.path("profiles_accepted").isBoolean() || !station.path("connectors").isArray()
                    || station.path("connectors").size() > 32) return false;
            for (var con : station.path("connectors")) {
                if (!con.path("id").isIntegralNumber() || con.path("id").asInt() < 1 || con.path("id").asInt() > 32
                        || !con.path("reconciling").isBoolean() || !con.path("fresh_power").isBoolean()) return false;
            }
        }
        if (report.hasNonNull("test")) {
            var test = report.path("test");
            if (!java.util.Set.of("running", "confirmed", "not_confirmed", "cancelled").contains(test.path("state").asText())
                    || !test.path("limited").isBoolean() || !test.path("paused").isBoolean() || !test.path("resumed").isBoolean()) return false;
        }
        return true;
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
