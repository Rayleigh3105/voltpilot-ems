package com.voltpilot.api.consumers;

import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.repo.ConsumerOverrideRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
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

    public record OverrideRequest(String action, Integer durationMinutes, Instant endsAt,
            BigDecimal setpointKw) {}

    public record OverrideOutcome(boolean applied, boolean pushed, String kind, Instant endsAt,
            BigDecimal effectivePowerKw, boolean gridImportPossible, boolean ttlCapped,
            String message) {}

    private final ConsumerRepository consumers;
    private final ConsumerOverrideRepository overrides;
    private final ConsumerAuditRepository audit;
    private final ConsumerPolicyActivationService activation;
    private final ObjectProvider<ConsumerOverridePublisher> publisher;
    private final JdbcTemplate jdbc;

    public ConsumerOverrideService(ConsumerRepository consumers, ConsumerOverrideRepository overrides,
            ConsumerAuditRepository audit, ConsumerPolicyActivationService activation,
            ObjectProvider<ConsumerOverridePublisher> publisher, JdbcTemplate jdbc) {
        this.consumers = consumers;
        this.overrides = overrides;
        this.audit = audit;
        this.activation = activation;
        this.publisher = publisher;
        this.jdbc = jdbc;
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
        } else {
            // continuous/stepped: the requested setpoint, clamped to Nennleistung
            // (the wirksame Leistung the portal previews); guards clamp further.
            command = "setpoint_kw";
            value = clampToRated(req.setpointKw(), row.ratedPowerKw());
            onOff = null;
            effectivePower = value;
        }

        overrides.put(siteId, entityId, stop ? "stop" : "start", command, value, endsAt, actor);
        audit.append(siteId, entityId, stop ? "override_stopped" : "override_started", null, null,
                actor, "ends_at=" + endsAt);

        boolean pushed = false;
        boolean flagOn = activation.activationAvailable();
        if (flagOn) {
            ConsumerOverridePublisher pub = publisher.getIfAvailable();
            if (pub != null) {
                UUID deviceId = resolveDevice(siteId, entityId, row);
                if (deviceId != null) {
                    pushed = pub.publishOverride(TenantContext.get(), siteId, deviceId, entityId,
                            onOff, value, ttlSeconds, now);
                }
            }
        }
        boolean grid = !stop; // a manual run may draw grid power (the §14.13 hint)
        String msg = message(stop, flagOn, pushed);
        return new OverrideOutcome(true, pushed, stop ? "stop" : "start", endsAt, effectivePower,
                grid, capped, msg);
    }

    @Transactional
    public OverrideOutcome clear(UUID siteId, UUID entityId, String actor) {
        ConsumerRow row = requireConsumer(siteId, entityId);
        overrides.clear(siteId, entityId);
        audit.append(siteId, entityId, "override_cleared", null, null, actor, null);
        boolean pushed = false;
        if (activation.activationAvailable()) {
            ConsumerOverridePublisher pub = publisher.getIfAvailable();
            if (pub != null) {
                UUID deviceId = resolveDevice(siteId, entityId, row);
                if (deviceId != null) {
                    pushed = pub.publishWithdraw(TenantContext.get(), siteId, deviceId, entityId);
                }
            }
        }
        return new OverrideOutcome(true, pushed, "resume", null, null, false, false,
                "Der manuelle Eingriff wurde beendet. Die Automatik übernimmt wieder.");
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
        if (row.deviceId() == null && row.edgeSourceId() == null && !row.ioBound()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Verbraucher ist noch nicht verbunden.");
        }
        return row;
    }

    /** The gateway device: the entity's own device_id, else the site's single device. */
    private UUID resolveDevice(UUID siteId, UUID entityId, ConsumerRow row) {
        if (row.deviceId() != null) {
            return row.deviceId();
        }
        List<UUID> devices = jdbc.queryForList(
                "SELECT id FROM device WHERE site_id = ? ORDER BY id LIMIT 2", UUID.class, siteId);
        return devices.size() == 1 ? devices.get(0) : null; // never guess on a multi-device site
    }

    private static ResponseStatusException badRequest(String msg) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, msg);
    }
}
