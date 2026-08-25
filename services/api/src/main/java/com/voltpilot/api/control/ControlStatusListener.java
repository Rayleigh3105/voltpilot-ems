package com.voltpilot.api.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.command.CommandLogWriter;
import com.voltpilot.api.repo.ControlStatusRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
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
 * Ingests the additive {@code control} block from the device status heartbeat
 * (ems/{t}/{s}/{d}/status, report §5.3) into {@code device_control_status}, so
 * the portal can render the "Steuerung" strip ("Fahrplan-Sollwert X ->
 * Wechselrichter bestätigt Y", healthy | mismatch | stale).
 *
 * <p>A sibling of {@link com.voltpilot.api.purge.PurgeRequestListener} on the
 * SAME topic filter: a heartbeat without a {@code control} block (or a
 * {@code purge_request}) is ignored cheaply. Authorization is the same broker
 * ACL + mTLS-CN identity - a message on {@code ems/{t}/{s}/{d}/status} IS the
 * authenticated device, and it reports only its OWN control state. Defense in
 * depth: the device is resolved through the RLS-scoped repository with the
 * topic's tenant (a fabricated identity yields zero rows and is skipped), and
 * the upsert runs under that tenant so RLS' WITH CHECK stamps the row.
 *
 * <p>Off by default so unit tests and broker-less deployments are unaffected;
 * both composes turn it on next to the purge listener.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.control.mqtt-listener-enabled", havingValue = "true")
public class ControlStatusListener {

    private static final Logger log = LoggerFactory.getLogger(ControlStatusListener.class);
    private static final String STATUS_FILTER = "ems/+/+/+/status";
    /** The additive execution modes the edge may report - anything else is ignored. */
    private static final Set<String> EXECUTION_MODES = Set.of(
            "plan", "follow", "trim", "absorb", "fallback", "idle_follow", "autonomous_discharge");
    /** The two follow directions - only meaningful for mode {@code follow}. */
    private static final Set<String> FOLLOW_DIRECTIONS = Set.of("deepen", "reduce");
    /** The three certification sources the core may report - anything else is ignored. */
    private static final Set<String> CERT_SOURCES = Set.of("env", "device", "platform");
    /** The four platform-register verdicts - anything else is ignored. */
    private static final Set<String> CERT_VERDICTS =
            Set.of("granted", "covered_not_activated", "not_covered", "unknown");

    private final String brokerUrl;
    private final String username;
    private final String password;
    private final DeviceRepository devices;
    private final ControlStatusRepository controlStatus;
    private final CommandLogWriter commandLog;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Object lock = new Object();
    private MqttClient client;

    public ControlStatusListener(
            @Value("${voltpilot.provisioning.broker-url:tcp://localhost:1883}") String brokerUrl,
            @Value("${voltpilot.provisioning.username:}") String username,
            @Value("${voltpilot.provisioning.password:}") String password,
            DeviceRepository devices, ControlStatusRepository controlStatus,
            CommandLogWriter commandLog) {
        this.brokerUrl = brokerUrl;
        this.username = username;
        this.password = password;
        this.devices = devices;
        this.controlStatus = controlStatus;
        this.commandLog = commandLog;
    }

    @EventListener(ContextRefreshedEvent.class)
    public void start() {
        try {
            connect();
        } catch (Exception e) {
            log.warn("Control-status listener could not connect to {} yet: {} (auto-reconnect active)",
                    brokerUrl, e.getMessage());
        }
    }

    private void connect() throws Exception {
        synchronized (lock) {
            if (client != null) {
                return;
            }
            client = new MqttClient(brokerUrl, "voltpilot-api-control-" + UUID.randomUUID(),
                    new MemoryPersistence());
            client.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverUri) {
                    try {
                        client.subscribe(STATUS_FILTER, 1, messageListener());
                        log.info("Control-status listener subscribed to {} at {}", STATUS_FILTER, serverUri);
                    } catch (Exception e) {
                        log.warn("Control-status subscribe failed: {}", e.getMessage());
                    }
                }

                @Override
                public void connectionLost(Throwable cause) {
                    log.warn("Control-status listener lost the broker connection: {} (auto-reconnect active)",
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
                log.warn("Control status on '{}' failed: {}", topic, e.getMessage());
            }
        };
    }

    /** Package-visible + test-visible: parse one status heartbeat's control block. */
    public void handle(String topic, byte[] payload) {
        JsonNode json;
        try {
            json = mapper.readTree(new String(payload, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return; // not JSON - not for us
        }
        JsonNode control = json == null ? null : json.get("control");
        if (control == null || !control.isObject()) {
            return; // a heartbeat without a control block (or a purge_request)
        }
        String[] parts = topic.split("/");
        if (parts.length != 5) {
            return;
        }
        UUID tenantId = parseUuid(parts[1]);
        UUID siteId = parseUuid(parts[2]);
        UUID deviceId = parseUuid(parts[3]);
        if (tenantId == null || siteId == null || deviceId == null) {
            log.warn("control status on non-UUID topic '{}' skipped", topic);
            return;
        }
        // Topic identity must equal payload identity (a device may not report
        // another device's control state - mirrors the ingest validator).
        if (!tenantId.toString().equals(json.path("tenant_id").asText())
                || !siteId.toString().equals(json.path("site_id").asText())
                || !deviceId.toString().equals(json.path("device_id").asText())) {
            log.warn("control status payload identity does not match topic '{}' - skipped", topic);
            return;
        }
        TenantContext.set(tenantId);
        try {
            Optional<DeviceDto> device = devices.findById(deviceId);
            if (device.isEmpty() || !siteId.equals(device.get().siteId())) {
                log.warn("control status for unknown device {} (tenant {}) skipped", deviceId, tenantId);
                return;
            }
            ControlStatusRepository.Execution execution = execution(json, control);
            ControlStatusRepository.CertState cert = certState(control);
            String mismatchRoles = joinRoles(control.get("mismatch_roles"));
            controlStatus.upsert(deviceId, siteId,
                    optDouble(control, "commanded_kw"), optDouble(control, "confirmed_kw"),
                    control.path("all_match").asBoolean(false),
                    control.path("control_enabled").asBoolean(false),
                    control.path("certified").asBoolean(false),
                    mismatchRoles,
                    optInstant(control, "slot_start"), checkedAt(control),
                    execution, cert);
            // Und den VERLAUF fortschreiben (Kommando-Transparenz V1): nur die
            // HALTEPERIODE, nie der Zustand - additiv und nie werfend.
            // `possible_conflict` reist nur hier durch: die Momentaufnahme
            // speichert es nicht, und der Verlauf soll dafuer keine Spalte in
            // einer fremden Tabelle erzwingen.
            commandLog.ingestControl(siteId, deviceId, new CommandLogWriter.ControlFacts(
                    optDouble(control, "commanded_kw"),
                    control.path("all_match").asBoolean(false),
                    control.path("control_enabled").asBoolean(false),
                    control.path("certified").asBoolean(false),
                    mismatchRoles, optText(control, "control_path"),
                    control.path("possible_conflict").asBoolean(false),
                    execution.mode(), execution.plannedKw(), cert.source()),
                    checkedAt(control));
        } finally {
            TenantContext.clear();
        }
    }

    /**
     * The in-slot EXECUTION truth of this heartbeat: the top-level
     * {@code control_source} (sent by every edge for ages, ignored until now)
     * plus the additive {@code control.execution} block (PR 3).
     *
     * <p>Strict on purpose - an unknown mode or direction is DROPPED rather
     * than stored, because every consumer turns these into a sentence about
     * what the device is doing, and a word we do not understand must not
     * become a claim. The measured target is whichever of
     * {@code deficit_kw}/{@code surplus_kw} the mode implies; both absent (the
     * device could not measure it) stays null, never 0.
     */
    private static ControlStatusRepository.Execution execution(JsonNode json, JsonNode control) {
        String source = optText(json, "control_source");
        JsonNode ex = control.get("execution");
        if (ex == null || !ex.isObject()) {
            // An older edge: the coarse source is all we know, and it is stored
            // as exactly that - no mode, no direction, no invented detail.
            return new ControlStatusRepository.Execution(source, null, null, null, null, null, null);
        }
        String mode = optText(ex, "mode");
        if (mode != null && !EXECUTION_MODES.contains(mode)) {
            log.warn("unknown control execution mode '{}' ignored", mode);
            mode = null;
        }
        String direction = "follow".equals(mode) ? optText(ex, "direction") : null;
        if (direction != null && !FOLLOW_DIRECTIONS.contains(direction)) {
            log.warn("unknown control follow direction '{}' ignored", direction);
            direction = null;
        }
        // WHICH measurement the target is only follows from the mode, so a
        // dropped/absent mode leaves it out too - an uninterpretable number is
        // worse than none.
        Double target = mode == null
                ? null
                : Set.of("trim", "absorb").contains(mode)
                        ? optDouble(ex, "surplus_kw") : optDouble(ex, "deficit_kw");
        return new ControlStatusRepository.Execution(
                source, mode, direction, optDouble(ex, "planned_kw"), target,
                optDouble(ex, "effective_floor_soc_pct"),
                ex.has("measurements_fresh") && ex.get("measurements_fresh").isBoolean()
                        ? ex.get("measurements_fresh").booleanValue() : null);
    }

    /**
     * WHY the control is (not) released (Plattform-Register, 10.08.2026): which
     * source granted it, and what the model register says about this device.
     *
     * <p>Strict on purpose, like {@link #execution}: an unknown source or
     * verdict is DROPPED rather than stored, because every consumer turns these
     * into a sentence about what a customer must do next, and a word we do not
     * understand must not become a claim. An older edge sends no fields at all,
     * and null then honestly means "we do not know" - never "not covered".
     */
    private static ControlStatusRepository.CertState certState(JsonNode control) {
        String source = optText(control, "cert_source");
        if (source != null && !CERT_SOURCES.contains(source)) {
            log.warn("unknown control certification source '{}' ignored", source);
            source = null;
        }
        JsonNode p = control.get("platform_cert");
        if (p == null || !p.isObject()) {
            return new ControlStatusRepository.CertState(source, null, null, null);
        }
        String verdict = optText(p, "verdict");
        if (verdict != null && !CERT_VERDICTS.contains(verdict)) {
            log.warn("unknown platform certification verdict '{}' ignored", verdict);
            verdict = null;
        }
        // Model and reason DESCRIBE a verdict; without one they would describe
        // nothing, so they are dropped with it.
        if (verdict == null) {
            return new ControlStatusRepository.CertState(source, null, null, null);
        }
        return new ControlStatusRepository.CertState(source, verdict,
                optText(p, "model"), optText(p, "reason"));
    }

    /** A non-blank text field, or null. */
    private static String optText(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull() || !v.isTextual()) {
            return null;
        }
        String s = v.asText().trim();
        return s.isEmpty() ? null : s;
    }

    private static Double optDouble(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return (v == null || v.isNull() || !v.isNumber()) ? null : v.asDouble();
    }

    private static String joinRoles(JsonNode roles) {
        if (roles == null || !roles.isArray() || roles.isEmpty()) {
            return null;
        }
        List<String> out = new ArrayList<>();
        roles.forEach(r -> out.add(r.asText()));
        return String.join(",", out);
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

    /** checked_at from the block, or now() when it is missing/unparseable. */
    private static Instant checkedAt(JsonNode control) {
        Instant t = optInstant(control, "checked_at");
        return t != null ? t : Instant.now();
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
                log.debug("Control listener disconnect failed on shutdown: {}", e.getMessage());
            }
            try {
                client.close(true);
            } catch (Exception e) {
                log.debug("Control listener close failed on shutdown: {}", e.getMessage());
            }
            client = null;
        }
    }
}
