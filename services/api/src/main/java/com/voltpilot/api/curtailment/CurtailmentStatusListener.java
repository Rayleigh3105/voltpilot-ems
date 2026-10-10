package com.voltpilot.api.curtailment;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.kundenbereich.Rueckmeldeweg;
import com.voltpilot.api.repo.CurtailmentStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import com.voltpilot.api.web.dto.CurtailmentUnitDto;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.DeviceExportLimitDto;
import com.voltpilot.api.web.dto.ExportGuardDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
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
 * Ingests the additive {@code curtailment} block from the device status
 * heartbeat (ems/{t}/{s}/{d}/status) into {@code device_curtailment_status}:
 * the plant's curtailment CAPABILITY (configured units, per-unit First-Light
 * releases, the control kill-switch) plus its latest execution OBSERVATIONS
 * (applied cap, readback match, possible override).
 *
 * <p>It is what turns the Fahrplan's "Abregeln" slot from a claim into a
 * verifiable statement. The edge has been sending this block since it was
 * built - explicitly so the cloud could tell "geplant und ausgeführt" from
 * "geplant, Anlage kann es (noch) nicht" - and nothing read it, so the portal
 * said "die PV wird gedrosselt" next to a measured 16,6 kW feed-in (scout
 * {@code vp-pilsting-abregeln}). Zero edge change was needed here.
 *
 * <p><b>Since „Grenzen &amp; Wächter" Stufe 0 it also ingests the two LIMIT
 * statements riding in the same block</b> (scout
 * {@code vp-kommando-transparenz-k3} §7 Stufe 0, Herzogau Runde 2 §7 points
 * 3+4): the live feed-in watchdog ({@code export_guard} - which limit the box
 * holds and whether it reaches any device at all) and the limit the INVERTER
 * ITSELF holds ({@code device_export_limit_kw}). The first needed no edge
 * change whatsoever - the box had been sending it in every heartbeat since it
 * was built while the cloud read NOTHING of it, which is why the question
 * "welche Einspeisegrenze hält die Box?" cost two investigation rounds through
 * a maintenance tunnel. Both are ADDITIVE: a heartbeat without them stores
 * NULLs and every surface stays byte-identical to before.
 *
 * <p><b>A SIBLING listener, not an extension of
 * {@link com.voltpilot.api.control.ControlStatusListener}</b>: that one returns
 * early when the heartbeat carries no {@code control} block, and the two blocks
 * are independent (the edge omits {@code control} without an inverter readback
 * and {@code curtailment} without a curtailment-capable source). Extending it
 * would silently drop the curtailment truth of exactly the plant whose primary
 * inverter reports nothing. Same topic filter, same authorization posture as
 * every sibling on it: broker ACL + mTLS-CN identity, topic identity
 * re-validated against the payload, the device resolved through the RLS
 * repository under the topic tenant, the upsert running under that tenant so
 * RLS' WITH CHECK stamps the row.
 *
 * <p>Off by default so unit tests and broker-less deployments are unaffected;
 * both composes turn it on next to the control listener.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.curtailment.mqtt-listener-enabled", havingValue = "true")
public class CurtailmentStatusListener extends Rueckmeldeweg {

    private static final Logger log = LoggerFactory.getLogger(CurtailmentStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /**
     * A sanity bound on the reported unit counts. The edge derives them from
     * its configured sources, so a four-digit count is a defect, not a plant -
     * and the number reaches the customer as "X von Y Wechselrichtern".
     */
    private static final int MAX_UNITS = 64;
    /**
     * The feed-in watchdog's state vocabulary (edge {@code guards.ExportState}).
     * A word outside it is DROPPED together with its whole guard block - the
     * {@code RolloutStates}/{@code UpdateStatusListener} rule: a word we do not
     * understand must not become a sentence, and a reason without a state the
     * portal can classify is exactly such a sentence. {@code aus} is
     * deliberately absent: the device omits the block entirely then.
     */
    private static final Set<String> GUARD_STATES =
            Set.of("ueberwacht", "regelt", "haelt", "zieht_zusammen", "sicherheitskappe");
    /**
     * A sanity bound on the German sentences the device writes. They are
     * operator-facing copy, not a data channel; a novel-length payload is a
     * defect and must not become an unbounded column.
     */
    private static final int MAX_SENTENCE = 500;
    /**
     * A sanity bound on any feed-in figure (kW at the grid connection point).
     * A value outside it is a decode defect, not a plant - and it would reach
     * the customer as "Ihr Wechselrichter begrenzt auf X kW".
     */
    private static final double MAX_KW = 100_000d;

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final CurtailmentStatusRepository curtailmentStatus;
    private final CommandLogWriter commandLog;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public CurtailmentStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, CurtailmentStatusRepository curtailmentStatus,
            CommandLogWriter commandLog) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.curtailmentStatus = curtailmentStatus;
        this.commandLog = commandLog;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Curtailment-status listener could not connect to {} yet: {} "
                    + "(auto-reconnect active)", brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-curtailment-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Curtailment-status listener subscribed to {} at {}",
                                STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Curtailment-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Curtailment-status listener lost the broker connection: {} "
                            + "(auto-reconnect active)", cause == null ? "unknown" : cause.getMessage());
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
                log.warn("Curtailment status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one heartbeat's curtailment block. */
    public void handle(String topic, byte[] payload) {
        if (kundenbereichBeendet(topic)) return; // Kundenbereich beendet: verworfen und gezählt
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode curtail = json == null ? null : json.get("curtailment");
        if (curtail == null || !curtail.isObject()) {
            return; // a heartbeat without a curtailment block (an older edge,
                    // or a plant with no curtailment-capable source)
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("curtailment status on non-UUID topic '{}' skipped", topic);
            return;
        }
        // Topic identity must equal payload identity (a device may not report
        // another device's curtailment state - the ingest/control rule).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("curtailment status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        int units = count(curtail, "units");
        // A block without units describes no actor at all - storing it would
        // turn "we know nothing" into "0 von 0 freigegeben".
        if (units <= 0) {
            return;
        }
        int certified = Math.min(count(curtail, "certified_units"), units);
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("curtailment status for unknown device {} (tenant {}) skipped", deviceId,
                        tenantId);
                return;
            }
            CurtailmentStatusDto row = new CurtailmentStatusDto(deviceId, units, certified,
                    curtail.path("control_enabled").asBoolean(false),
                    curtail.path("active").asBoolean(false),
                    optDouble(curtail, "applied_cap_kw"),
                    optBoolean(curtail, "all_match"),
                    curtail.path("possible_override").asBoolean(false),
                    checkedAt(curtail),
                    exportGuard(curtail.get("export_guard")),
                    deviceExportLimit(curtail));
            curtailmentStatus.upsert(siteId, row);
            // Die Einheiten-Liste (R4a / E2) wird GANZ ersetzt: der Herzschlag
            // trägt die vollständige Menge, eine verschwundene Einheit darf
            // nicht als Geist stehen bleiben (das device_source_status-Muster).
            curtailmentStatus.replaceUnits(siteId, deviceId, perUnit(curtail));
            // Und den VERLAUF fortschreiben (Kommando-Transparenz V1): der
            // Abregel-Schreibweg ist ein EIGENER Strom neben dem Batterie-
            // Sollwert - die zwei beschreiben verschiedene Geraete-Register.
            commandLog.ingestCurtailment(siteId, deviceId, row, row.checkedAt());
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * The per-unit curtailment breakdown (R4a / Captain-Entscheid E2), or an
     * empty list when the device did not report one (an older edge - the block
     * predates the list).
     *
     * <p><b>⚠ An entry without a {@code source_id} is DROPPED, not stored.</b>
     * That id is the only join key to the reported sources, so a unit without
     * it cannot become a device name - and attributing it to nothing would be
     * exactly the fabricated attribution E2 rejected. The list is then SHORTER
     * than {@code units}, which is why {@code units} stays THE count.
     *
     * <p>Duplicates on one source id are dropped too (the table is keyed on
     * {@code (device_id, source_id)}, so a second row would collide): the FIRST
     * wins, deterministically, rather than letting the insert order decide.
     */
    private static List<CurtailmentUnitDto> perUnit(JsonNode curtail) {
        JsonNode list = curtail.get("per_unit");
        if (list == null || !list.isArray()) {
            return List.of();
        }
        List<CurtailmentUnitDto> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode u : list) {
            if (!u.isObject()) {
                continue;
            }
            String sourceId = u.path("source_id").asText("").trim();
            if (sourceId.isEmpty() || !seen.add(sourceId)) {
                continue;
            }
            Double cap = optDouble(u, "applied_cap_kw");
            if (cap != null && !plausibleKw(cap)) {
                cap = null; // an implausible cap is no cap - never a claimed number
            }
            out.add(new CurtailmentUnitDto(sourceId, u.path("certified").asBoolean(false), cap,
                    optBoolean(u, "match")));
        }
        return List.copyOf(out);
    }

    /**
     * The live feed-in watchdog block, or null when the device did not report a
     * usable one („Grenzen &amp; Wächter" Stufe 0).
     *
     * <p>Two things make it null rather than partially stored, and both are
     * honesty rules rather than defensiveness: an unknown {@code state} word
     * (see {@link #GUARD_STATES}) and a missing/implausible {@code limit_kw} - a
     * watchdog without its limit is not a limit statement, and the number is
     * exactly what the customer reads ("Einspeisegrenze 70 kW").
     */
    private static ExportGuardDto exportGuard(JsonNode guard) {
        if (guard == null || !guard.isObject()) {
            return null;
        }
        String state = guard.path("state").asText("");
        if (!GUARD_STATES.contains(state)) {
            return null;
        }
        Double limit = optDouble(guard, "limit_kw");
        if (limit == null || !plausibleKw(limit)) {
            return null;
        }
        Double cap = optDouble(guard, "cap_kw");
        if (cap != null && !plausibleKw(cap)) {
            cap = null; // an implausible cap is dropped ALONE - the limit still stands
        }
        return new ExportGuardDto(limit, state, sentence(guard, "reason"), cap,
                guard.path("limiting").asBoolean(false),
                guard.path("blind").asBoolean(false),
                // effective ABSENT is the honest "not effective": the device
                // always sends it (no omitempty), so an absent field can only
                // mean an older/unknown shape - and claiming reach we did not
                // measure is the one mistake this whole block exists to prevent.
                guard.path("effective").asBoolean(false),
                sentence(guard, "reach"));
    }

    /**
     * The limit the INVERTER ITSELF holds, or null when the device did not
     * report it (older edge, a family whose register map has no trustworthy
     * feed-in-cap register, or simply not read yet - the register is read at
     * most once a day).
     *
     * <p>All three parts are required together: a value without its read time
     * would claim a freshness it does not have, and one without its register
     * would be a number without its origin (the DB CHECK mirrors this).
     */
    private static DeviceExportLimitDto deviceExportLimit(JsonNode curtail) {
        Double kw = optDouble(curtail, "device_export_limit_kw");
        if (kw == null || !plausibleKw(kw)) {
            return null;
        }
        String register = curtail.path("device_export_limit_register").asText("").trim();
        if (register.isEmpty() || register.length() > 32) {
            return null;
        }
        JsonNode at = curtail.get("device_export_limit_read_at");
        if (at == null || at.isNull() || at.asText("").isBlank()) {
            return null;
        }
        try {
            return new DeviceExportLimitDto(kw, register, Instant.parse(at.asText()));
        } catch (Exception e) {
            return null; // an unparseable read time is no freshness at all
        }
    }

    /** A feed-in figure in kW that can describe a real grid connection point. */
    private static boolean plausibleKw(double kw) {
        return Double.isFinite(kw) && kw >= 0 && kw <= MAX_KW;
    }

    /**
     * One of the device's German sentences, trimmed and bounded; null when it is
     * absent or blank (the surfaces treat null as "say nothing", never as "").
     */
    private static String sentence(JsonNode node, String field) {
        String raw = node.path(field).asText("").trim();
        if (raw.isEmpty()) {
            return null;
        }
        return raw.length() <= MAX_SENTENCE ? raw : raw.substring(0, MAX_SENTENCE);
    }

    /** A non-negative, sanity-bounded unit count; anything else reads as 0. */
    private static int count(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isInt()) {
            return 0;
        }
        int n = v.asInt();
        return n < 0 ? 0 : Math.min(n, MAX_UNITS);
    }

    /**
     * A tri-state boolean: null when the device did not report it. Load-bearing
     * for {@code all_match} - "nothing applied" (absent) must not be stored as
     * "the readback disagreed" (false), because only TRUE is a confirmation and
     * false is what the portal renders as an override-shaped warning.
     */
    private static Boolean optBoolean(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isBoolean()) ? null : v.asBoolean();
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isNumber()) ? null : v.asDouble();
    }

    /** checked_at from the block, or now() when it is missing/unparseable. */
    private static Instant checkedAt(JsonNode curtail) {
        JsonNode v = curtail.get("checked_at");
        if (v != null && !v.isNull() && !v.asText().isBlank()) {
            try {
                return Instant.parse(v.asText());
            } catch (Exception e) {
                // fall through - an unparseable stamp is no reason to drop a
                // truth we otherwise understand.
            }
        }
        return Instant.now();
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
                log.debug("Curtailment listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Curtailment listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
