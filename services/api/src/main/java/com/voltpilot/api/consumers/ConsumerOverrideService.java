package com.voltpilot.api.consumers;

import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.repo.ConsumerOverrideRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The manual override of a consumer (Inkrement 5 / §11 + §14.13 Sofortaktionen
 * "Jetzt starten" / "Jetzt stoppen" / "Automatik fortsetzen"). It records the
 * TTL-bound intervention (the cloud truth + audit anchor), then best-effort
 * pushes it to the edge over the existing desired-override way. A manual start
 * requires an end time / duration (§14.13); the intervention never touches the
 * stored rule and expires by its TTL (§16).
 *
 * <p>The physical PUSH rides the master control flag (like activation): with the
 * flag off - this increment's default - the override is recorded + audited but
 * NOT pushed, and the outcome says so honestly. Deactivate-style stop safety is
 * not needed here: the arbiter's bounded TTL is the failsafe.
 */
@Service
public class ConsumerOverrideService {

    /** Above this the arbiter's OverrideTTLCap (4 h) trims it anyway; we say so. */
    static final Duration MAX_TTL = Duration.ofHours(4);

    /**
     * @param stufe Heizstab V1: die Stufe eines Stufen-Verbrauchers, 1-basiert in seine
     *     {@code levels_kw} (ein Heizstab mit Stufen 1/2/3 Phasen: 1 = eine Phase). Fehlt sie,
     *     gilt {@code setpointKw} (auf die Stufe darunter gerundet) oder die oberste Stufe.
     */
    public record OverrideRequest(String action, Integer durationMinutes, Instant endsAt,
            BigDecimal setpointKw, Integer stufe) {

        /** Der Weg vor dem Heizstab (V1, Paket 3). */
        public OverrideRequest(String action, Integer durationMinutes, Instant endsAt, BigDecimal setpointKw) {
            this(action, durationMinutes, endsAt, setpointKw, null);
        }
    }

    public record OverrideOutcome(boolean applied, boolean pushed, String kind, Instant endsAt,
            BigDecimal effectivePowerKw, boolean gridImportPossible, boolean ttlCapped,
            String message, String pushReason) {}

    private final ConsumerRepository consumers;
    private final ConsumerOverrideRepository overrides;
    private final ConsumerAuditRepository audit;
    private final ConsumerPolicyActivationService activation;
    private final ObjectProvider<ConsumerOverridePublisher> publisher;
    private final com.voltpilot.api.entities.EinmalAuftragZiel ziel;

    public ConsumerOverrideService(ConsumerRepository consumers, ConsumerOverrideRepository overrides,
            ConsumerAuditRepository audit, ConsumerPolicyActivationService activation,
            ObjectProvider<ConsumerOverridePublisher> publisher, com.voltpilot.api.entities.EinmalAuftragZiel ziel) {
        this.consumers = consumers;
        this.overrides = overrides;
        this.audit = audit;
        this.activation = activation;
        this.publisher = publisher;
        this.ziel = ziel;
    }

    @Transactional
    public OverrideOutcome start(UUID siteId, UUID entityId, OverrideRequest req, String actor) {
        ConsumerRow row = requireConnected(siteId, entityId);
        String action = req == null ? null : req.action();
        boolean stop = "stop".equals(action);
        if (!stop && !"start".equals(action)) {
            throw badRequest("Unbekannte Aktion. Erlaubt sind \"start\" und \"stop\".");
        }
        Instant now = Instant.now();
        Instant endsAt = requireEnd(req, now);
        boolean capped = false;
        if (endsAt.isAfter(now.plus(MAX_TTL))) {
            endsAt = now.plus(MAX_TTL);
            capped = true;
        }
        int ttlSeconds = (int) Math.max(1, Duration.between(now, endsAt).getSeconds());

        String command;
        BigDecimal value;
        BigDecimal effectivePower;
        Boolean onOff;
        if (stop) {
            command = "on_off".equals(row.controlKind()) ? "on_off" : "setpoint_kw";
            value = "on_off".equals(command) ? null : BigDecimal.ZERO;
            onOff = "on_off".equals(command) ? Boolean.FALSE : null;
            effectivePower = BigDecimal.ZERO;
        } else if ("on_off".equals(row.controlKind())) {
            command = "on_off";
            value = null;
            onOff = Boolean.TRUE;
            effectivePower = row.ratedPowerKw();
        } else if ("stepped".equals(row.controlKind()) && !stufenKw(row).isEmpty()) {
            // Heizstab V1: eine Stufe ist eine STUFE - nie ein Wert dazwischen, nie mehr als
            // befohlen. Die Box wählt aus dem Sollwert dieselbe Stufe (restrict-only).
            if (heizstab != null && heizstab.anschlussOffen(siteId, entityId)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Der Anschluss dieses Heizstabs ist nicht bestätigt. Erst wenn Ihr Elektriker ihn "
                                + "bestätigt hat, schaltet VoltPilot den Stab.");
            }
            command = "setpoint_kw";
            value = stufeKw(stufenKw(row), req.stufe(), req.setpointKw());
            onOff = null;
            effectivePower = value;
        } else {
            // continuous/stepped: the requested setpoint, clamped to Nennleistung
            // (the wirksame Leistung the portal previews); guards clamp further.
            command = "setpoint_kw";
            value = clampToRated(req.setpointKw(), row.ratedPowerKw());
            onOff = null;
            effectivePower = value;
        }

        boolean flagOn = activation.activationAvailable();
        UUID deviceId = flagOn ? ziel.komponente(siteId, entityId).id() : null;
        overrides.put(siteId, entityId, stop ? "stop" : "start", command, value, endsAt, actor);
        audit.append(siteId, entityId, stop ? "override_stopped" : "override_started", null, null,
                actor, "ends_at=" + endsAt);
        ConsumerOverridePublisher pub = flagOn ? publisher.getIfAvailable() : null;
        boolean pushed = pub != null && pub.publishOverride(TenantContext.get(), siteId, deviceId,
                entityId, onOff, value, ttlSeconds, now);
        String reason = !flagOn ? "control_disabled" : pub == null ? "publisher_unavailable"
                : pushed ? null : "publish_failed";
        boolean grid = !stop; // a manual run may draw grid power (the §14.13 hint)
        String msg = message(stop, flagOn, pushed)
                + ("publisher_unavailable".equals(reason) ? " Die Zustellung ist derzeit nicht verfügbar."
                        : "publish_failed".equals(reason) ? " Die Zustellung an die Box ist fehlgeschlagen." : "");
        return new OverrideOutcome(true, pushed, stop ? "stop" : "start", endsAt, effectivePower,
                grid, capped, msg, reason);
    }

    @Transactional
    public OverrideOutcome clear(UUID siteId, UUID entityId, String actor) {
        requireConsumer(siteId, entityId);
        boolean flagOn = activation.activationAvailable();
        UUID deviceId = flagOn ? ziel.komponente(siteId, entityId).id() : null;
        overrides.clear(siteId, entityId);
        audit.append(siteId, entityId, "override_cleared", null, null, actor, null);
        ConsumerOverridePublisher pub = flagOn ? publisher.getIfAvailable() : null;
        boolean pushed = pub != null && pub.publishWithdraw(TenantContext.get(), siteId, deviceId, entityId);
        String reason = !flagOn ? "control_disabled" : pub == null ? "publisher_unavailable"
                : pushed ? null : "publish_failed";
        return new OverrideOutcome(true, pushed, "resume", null, null, false, false,
                pushed ? "Der manuelle Eingriff wurde beendet. Die Automatik übernimmt wieder."
                        : "Das Beenden ist notiert, wurde aber noch nicht an die Box gesendet. "
                                + (!flagOn ? "Die Steuerung ist noch nicht aktiviert."
                                        : pub == null ? "Die Zustellung ist derzeit nicht verfügbar."
                                                : "Die Zustellung an die Box ist fehlgeschlagen."), reason);
    }

    // --- helpers -------------------------------------------------------------

    private static String message(boolean stop, boolean flagOn, boolean pushed) {
        if (!flagOn) {
            return "Der Eingriff ist notiert. Die Steuerung ist noch nicht aktiviert, deshalb "
                    + "wird er noch nicht an das Gerät gesendet.";
        }
        if (!pushed) {
            return "Der Eingriff ist notiert, konnte aber gerade nicht an das Gerät gesendet "
                    + "werden. VoltPilot versucht es weiter.";
        }
        return stop ? "Der Verbraucher wird gestoppt." : "Der Verbraucher wird gestartet.";
    }

    private Instant requireEnd(OverrideRequest req, Instant now) {
        if (req.endsAt() != null) {
            if (!req.endsAt().isAfter(now)) {
                throw badRequest("Die Endzeit muss in der Zukunft liegen.");
            }
            return req.endsAt();
        }
        if (req.durationMinutes() != null && req.durationMinutes() > 0) {
            return now.plus(Duration.ofMinutes(req.durationMinutes()));
        }
        throw badRequest("Bitte eine Endzeit oder Dauer angeben - ein Eingriff läuft nie unbegrenzt.");
    }

    /** Heizstab V1, Paket 3 (optional, damit von Hand gebaute Tests unverändert bleiben). */
    private HeizstabGeraet heizstab;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void heizstab(HeizstabGeraet heizstab) {
        this.heizstab = heizstab;
    }

    /** Die kW je Stufe eines Stufen-Verbrauchers (aufsteigend), leer ohne levels_kw. */
    static java.util.List<BigDecimal> stufenKw(ConsumerRow row) {
        if (row.levelsKwJson() == null || row.levelsKwJson().isBlank()) {
            return java.util.List.of();
        }
        try {
            com.fasterxml.jackson.databind.JsonNode arr =
                    new com.fasterxml.jackson.databind.ObjectMapper().readTree(row.levelsKwJson());
            java.util.List<BigDecimal> out = new java.util.ArrayList<>();
            arr.forEach(n -> {
                if (n.isNumber() && n.decimalValue().signum() > 0) {
                    out.add(n.decimalValue());
                }
            });
            out.sort(BigDecimal::compareTo);
            return out;
        } catch (Exception e) {
            return java.util.List.of();
        }
    }

    /**
     * Die kW der gewählten Stufe: {@code stufe} (1-basiert), sonst die höchste Stufe, die in
     * {@code setpointKw} passt, sonst die oberste.
     */
    static BigDecimal stufeKw(java.util.List<BigDecimal> stufen, Integer stufe, BigDecimal setpointKw) {
        if (stufe != null) {
            if (stufe < 1 || stufe > stufen.size()) {
                throw badRequest("Diese Stufe gibt es nicht (1 bis " + stufen.size() + ").");
            }
            return stufen.get(stufe - 1);
        }
        if (setpointKw == null || setpointKw.signum() <= 0) {
            return stufen.get(stufen.size() - 1);
        }
        BigDecimal best = null;
        for (BigDecimal k : stufen) {
            if (k.compareTo(setpointKw) <= 0) {
                best = k;
            }
        }
        if (best == null) {
            throw badRequest("Weniger als die kleinste Stufe (" + stufen.get(0).stripTrailingZeros().toPlainString()
                    + " kW) lässt sich nicht einschalten.");
        }
        return best;
    }

    private static BigDecimal clampToRated(BigDecimal requested, BigDecimal rated) {
        if (requested == null || requested.signum() <= 0) {
            return rated; // default a start to full Nennleistung
        }
        return rated != null && requested.compareTo(rated) > 0 ? rated : requested;
    }

    private ConsumerRow requireConsumer(UUID siteId, UUID entityId) {
        ConsumerRow row = consumers.findForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Verbraucher nicht gefunden.");
        }
        return row;
    }

    private ConsumerRow requireConnected(UUID siteId, UUID entityId) {
        ConsumerRow row = requireConsumer(siteId, entityId);
        // An I/O-module output IS a connection: the consumer's driver is the
        // module channel, switched by the box that reads the module.
        if (row.deviceId() == null && row.edgeSourceId() == null && !row.ioBound()
                && !ziel.hatQuelle(siteId, entityId)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Verbraucher ist noch nicht verbunden.");
        }
        return row;
    }

    private static ResponseStatusException badRequest(String msg) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, msg);
    }
}
