package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.OcppActionDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** JDBC persistence for command intent, audit and evidence. */
@Repository
public class OcppActionRepository {
    public record StationTarget(UUID deviceId, boolean connected) {}
    public record StoredAction(OcppActionDto.Action action, UUID tenantId, UUID siteId,
            String requestHash, String conflictKey) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public OcppActionRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    public Optional<StationTarget> target(UUID siteId, String chargePointId) {
        return jdbc.query("SELECT device_id, connected FROM ocpp_station WHERE site_id=? AND charge_point_id=?",
                (rs, n) -> new StationTarget(rs.getObject(1, UUID.class), rs.getBoolean(2)),
                siteId, chargePointId).stream().findFirst();
    }

    public Optional<OcppActionDto.Action> byId(UUID id) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE id=?", this::map, id).stream().findFirst();
    }

    public Optional<OcppActionDto.Action> lockById(UUID id) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE id=? FOR UPDATE", this::map, id).stream().findFirst();
    }

    public Optional<OcppActionDto.Action> byIdForSite(UUID siteId, UUID id) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE site_id=? AND id=?", this::map, siteId, id).stream().findFirst();
    }

    public Optional<OcppActionDto.Action> byIdempotency(UUID tenantId, String key) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE tenant_id=? AND idempotency_key=?",
                this::map, tenantId, key).stream().findFirst();
    }

    public Optional<StoredAction> storedByIdempotency(UUID tenantId, String key) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE tenant_id=? AND idempotency_key=?",
                this::mapStored, tenantId, key).stream().findFirst();
    }

    /** Serialize retries for one tenant/key before either uniqueness constraint is evaluated. */
    public void lockIdempotency(UUID tenantId, String key) {
        jdbc.queryForObject("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", Object.class,
                tenantId + ":" + key);
    }

    public boolean hasRunning(UUID deviceId, String cp, String conflictKey) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM ocpp_action WHERE device_id=? AND "
                + "charge_point_id=? AND conflict_key=? AND state IN ('prepared','sent','accepted_waiting_effect')",
                Integer.class, deviceId, cp, conflictKey);
        return n != null && n > 0;
    }

    @Transactional
    public OcppActionDto.Action insert(UUID id, UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, String correlation, String idempotency, String requestHash,
            String conflictKey, String actor, Integer connector, Integer transaction,
            JsonNode request, Instant prepared, Instant deadline) {
        return insertIfAbsent(id, tenantId, siteId, deviceId, cp, action, correlation, idempotency,
                requestHash, conflictKey, actor, connector, transaction, request, prepared, deadline)
                .orElseThrow(() -> new org.springframework.dao.DuplicateKeyException("idempotency key exists"));
    }

    @Transactional
    public Optional<OcppActionDto.Action> insertIfAbsent(UUID id, UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, String correlation, String idempotency, String requestHash,
            String conflictKey, String actor, Integer connector, Integer transaction,
            JsonNode request, Instant prepared, Instant deadline) {
        int inserted = jdbc.update("INSERT INTO ocpp_action (id,tenant_id,site_id,device_id,charge_point_id,action,state,"
                + "correlation_id,idempotency_key,request_hash,conflict_key,actor,connector_id,transaction_id,request_payload,"
                + "prepared_at,deadline_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,? ,?::jsonb,?,?,?) "
                + "ON CONFLICT (tenant_id,idempotency_key) DO NOTHING",
                id, tenantId, siteId, deviceId, cp, action, "prepared", correlation, idempotency,
                requestHash, conflictKey, actor, connector, transaction, json(request), ts(prepared), ts(deadline), ts(prepared));
        if (inserted == 0) return Optional.empty();
        audit(id, tenantId, actor, "prepared", null, prepared);
        return byId(id);
    }

    @Transactional
    public void transition(UUID id, UUID tenantId, String actor, String state, String reason,
            Instant at, String column) {
        String time = switch (column) {
            case "sent" -> ", sent_at=?";
            case "response" -> ", response_at=?";
            case "effect" -> ", effect_at=?";
            default -> "";
        };
        String expected = "sent".equals(state) ? " AND state='prepared'" :
                " AND state IN ('prepared','sent','accepted_waiting_effect')";
        String sql = "UPDATE ocpp_action SET state=?, reason=?, updated_at=?" + time + " WHERE id=?" + expected;
        int updated = time.isEmpty() ? jdbc.update(sql, state, reason, ts(at), id)
                : jdbc.update(sql, state, reason, ts(at), ts(at), id);
        if (updated > 0) audit(id, tenantId, actor, state, reason, at);
    }

    @Transactional
    public void response(UUID id, UUID tenantId, String actor, String state, String status,
            JsonNode payload, String reason, Instant at) {
        var before = lockById(id);
        if (before.isEmpty()) return;
        boolean active = Set.of("prepared", "sent", "accepted_waiting_effect").contains(before.get().state());
        String late = "Spätes OCPP-Ergebnis nach Abschluss (ursprünglicher Abschluss bleibt bestehen).";
        if (active) {
            jdbc.update("UPDATE ocpp_action SET state=?, response_status=?, response_payload=?::jsonb, "
                    + "reason=?, response_at=?, updated_at=? WHERE id=?", state, status, json(payload),
                    reason, ts(at), ts(at), id);
            audit(id, tenantId, actor, state, reason, at);
        } else {
            jdbc.update("UPDATE ocpp_action SET response_status=COALESCE(response_status,?), "
                    + "response_payload=CASE WHEN response_at IS NULL THEN ?::jsonb ELSE response_payload END, "
                    + "response_at=COALESCE(response_at,?), reason=CASE WHEN reason IS NULL OR reason='' "
                    + "THEN ? ELSE reason || ' ' || ? END, updated_at=? WHERE id=?",
                    status, json(payload), ts(at), late, late, ts(at), id);
            audit(id, tenantId, actor, "late_response", late, at);
        }
    }

    @Transactional
    public void effect(UUID id, UUID tenantId, String actor, String state, JsonNode evidence,
            Instant at, String reason) {
        var before = lockById(id);
        if (before.isEmpty()) return;
        boolean active = Set.of("prepared", "sent", "accepted_waiting_effect").contains(before.get().state());
        String late = "Später Wirkungsbeleg nach Abschluss (ursprünglicher Abschluss bleibt bestehen).";
        if (active) {
            jdbc.update("UPDATE ocpp_action SET state=?, effect_payload=?::jsonb, effect_at=?, "
                    + "reason=?, updated_at=? WHERE id=?", state, json(evidence), ts(at), reason, ts(at), id);
            audit(id, tenantId, actor, state, reason, at);
        } else {
            jdbc.update("UPDATE ocpp_action SET effect_payload=CASE WHEN effect_at IS NULL THEN ?::jsonb ELSE effect_payload END, "
                    + "effect_at=COALESCE(effect_at,?), reason=CASE WHEN reason IS NULL OR reason='' THEN ? "
                    + "ELSE reason || ' ' || ? END, updated_at=? WHERE id=?", json(evidence), ts(at),
                    late, late, ts(at), id);
            audit(id, tenantId, actor, "late_effect", late, at);
        }
    }

    @Transactional
    public boolean cancel(UUID id, UUID tenantId, String actor, Instant at) {
        int updated = jdbc.update("UPDATE ocpp_action SET state='cancelled', reason='vom Bediener abgebrochen', "
                + "updated_at=? WHERE id=? AND state='prepared'", ts(at), id);
        if (updated > 0) audit(id, tenantId, actor, "cancelled", "vom Bediener abgebrochen", at);
        return updated > 0;
    }

    public List<OcppActionDto.Action> list(UUID siteId, String cp, int limit) {
        if (cp == null || cp.isBlank()) return jdbc.query("SELECT * FROM ocpp_action WHERE site_id=? "
                + "ORDER BY prepared_at DESC LIMIT ?", this::map, siteId, Math.max(1, Math.min(limit, 500)));
        return jdbc.query("SELECT * FROM ocpp_action WHERE site_id=? AND charge_point_id=? "
                + "ORDER BY prepared_at DESC LIMIT ?", this::map, siteId, cp, Math.max(1, Math.min(limit, 500)));
    }

    public List<OcppActionDto.Audit> audit(UUID siteId, UUID actionId) {
        return jdbc.query("SELECT id,actor,state,reason,device_id,charge_point_id,connector_id,transaction_id,occurred_at "
                + "FROM ocpp_action_audit WHERE site_id=? AND action_id=? ORDER BY id", (rs, n) ->
                new OcppActionDto.Audit(rs.getLong("id"), rs.getString("actor"), rs.getString("state"),
                        rs.getString("reason"), rs.getObject("device_id", UUID.class),
                        rs.getString("charge_point_id"), (Integer) rs.getObject("connector_id"),
                        (Integer) rs.getObject("transaction_id"), rs.getTimestamp("occurred_at").toInstant()),
                siteId, actionId);
    }

    /** Matches the external correlation id installed by the edge journal. */
    public Optional<OcppActionDto.Action> byCorrelation(UUID deviceId, String cp, String correlation) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE device_id=? AND charge_point_id=? AND correlation_id=?",
                this::map, deviceId, cp, correlation).stream().findFirst();
    }

    public OcppActionDto.Intent insertIntent(UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, String phrase, String actor, String requestHash, Integer connectorId,
            Integer transactionId, boolean fourEyes, Instant expiresAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO ocpp_action_intent(id,tenant_id,site_id,device_id,charge_point_id,action,phrase,"
                + "request_hash,connector_id,transaction_id,four_eyes,expires_at,actor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                id, tenantId, siteId, deviceId, cp, action, phrase, requestHash, connectorId,
                transactionId, fourEyes, ts(expiresAt), actor);
        return new OcppActionDto.Intent(id, action, phrase, fourEyes, expiresAt);
    }

    public boolean consumeIntent(UUID id, UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, String requestHash, Integer connectorId, Integer transactionId,
            boolean fourEyesRequired, String phrase, String actionActor, Instant now) {
        return jdbc.update("UPDATE ocpp_action_intent SET consumed_at=? WHERE id=? AND tenant_id=? AND site_id=? "
                + "AND device_id=? AND charge_point_id=? AND action=? AND request_hash=? "
                + "AND connector_id IS NOT DISTINCT FROM ? AND transaction_id IS NOT DISTINCT FROM ? "
                + "AND four_eyes=? AND phrase=? AND (NOT four_eyes AND actor=? OR four_eyes AND actor<>?) "
                + "AND consumed_at IS NULL AND expires_at>?",
                ts(now), id, tenantId, siteId, deviceId, cp, action, requestHash, connectorId,
                transactionId, fourEyesRequired, phrase, actionActor, actionActor, ts(now)) > 0;
    }

    public boolean firmwareAllowed(String location, String sha256, String signature) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM ocpp_firmware_artifact WHERE location=? "
                + "AND sha256=? AND signature=? AND revoked_at IS NULL", Integer.class,
                location, sha256.toLowerCase(java.util.Locale.ROOT), signature);
        return count != null && count > 0;
    }

    public void expire(Instant now) {
        jdbc.queryForObject("SELECT expire_ocpp_actions(?)", Integer.class, ts(now));
    }

    /** Bounded history; only the narrowly scoped owner function can cascade audit rows. */
    public void purgeRetention(Instant actionCutoff, Instant intentCutoff) {
        jdbc.queryForObject("SELECT purge_ocpp_action_history(?, ?)", Integer.class,
                ts(actionCutoff), ts(intentCutoff));
    }

    /** Advance the action state only from observed journal evidence. */
    public void applyProtocolEvidence(UUID tenantId, UUID deviceId, String cp, JsonNode envelope) {
        String type = envelope.path("message_type").asText();
        String direction = envelope.path("direction").asText();
        String correlation = envelope.path("correlation_id").asText(null);
        String wireId = envelope.path("wire_id").asText(null);
        String wireAction = envelope.path("action").asText("");
        Instant at = Instant.parse(envelope.path("occurred_at").asText());
        if ("Event".equals(type) && "internal".equals(direction)
                && "CommandRejected".equals(wireAction) && correlation != null) {
            byCorrelation(deviceId, cp, correlation).ifPresent(a -> {
                String rejectedActionId = envelope.path("payload").path("action_id").asText(null);
                if (!a.id().toString().equals(rejectedActionId)) return;
                String code = envelope.path("payload").path("code").asText("EdgeRejected");
                String reason = envelope.path("payload").path("reason").asText("Edge hat den Befehl abgelehnt.");
                if ("readback_failed".equals(code))
                    effect(a.id(), tenantId, "edge:" + cp, "effect_failed",
                            envelope.path("payload"), at, reason);
                else response(a.id(), tenantId, "edge:" + cp, "edge_rejected", code,
                        envelope.path("payload"), reason, at);
            });
            return;
        }
        if ("CallResult".equals(type) && "station_to_csms".equals(direction)) {
            var a = byCorrelation(deviceId, cp, correlation);
            if (a.isEmpty()) {
                applyExactEffect(tenantId, deviceId, cp, wireAction, correlation,
                        envelope.path("payload"), at);
                return;
            }
            if (!a.get().id().toString().equals(wireId) || !wireMatches(a.get().action(), wireAction)) return;
            JsonNode payload = envelope.path("payload");
            String status = payload.path("status").asText(null);
            boolean negative = isNegativeStatus(status);
            boolean malformed = !negative && !isPositiveResponse(a.get().action(), status);
            boolean terminal = responseIsTerminal(a.get().action());
            String state = negative ? "rejected" : malformed ? "call_error"
                    : terminal ? "completed" : "accepted_waiting_effect";
            response(a.get().id(), tenantId, "station:" + cp, state, status, payload,
                    negative ? negativeReason(status) : malformed
                            ? "Die Station hat eine unvollständige oder unbekannte OCPP-Antwort geliefert." : null, at);
        } else if ("CallError".equals(type) && "station_to_csms".equals(direction)) {
            var a = byCorrelation(deviceId, cp, correlation);
            if (a.isPresent() && a.get().id().toString().equals(wireId)
                    && wireMatches(a.get().action(), wireAction)) response(a.get().id(), tenantId, "station:" + cp, "call_error",
                    envelope.path("error_code").asText("CallError"), envelope.path("error_details"),
                    "Die Station hat einen OCPP-Fehler gemeldet.", at);
        } else if (("Call".equals(type) && "station_to_csms".equals(direction))
                || ("CallResult".equals(type) && "station_to_csms".equals(direction))) {
            applyExactEffect(tenantId, deviceId, cp, wireAction, correlation,
                    envelope.path("payload"), at);
        }
    }

    private void applyExactEffect(UUID tenantId, UUID deviceId, String cp, String wireAction,
            String correlation, JsonNode payload, Instant at) {
        List<OcppActionDto.Action> candidates = jdbc.query("SELECT * FROM ocpp_action WHERE tenant_id=? "
                + "AND device_id=? AND charge_point_id=? AND response_at<=? "
                + "AND state IN ('accepted_waiting_effect','timed_out') ORDER BY response_at DESC",
                this::map, tenantId, deviceId, cp, ts(at));
        for (OcppActionDto.Action a : candidates) {
            EffectMatch match = effectMatch(a, wireAction, correlation, payload, at);
            if (match == EffectMatch.NONE) continue;
            String state = match == EffectMatch.FAILURE ? "effect_failed" : "effect_observed";
            String reason = match == EffectMatch.FAILURE
                    ? Set.of("ChangeConfiguration", "SendLocalList", "SetChargingProfile", "ClearChargingProfile")
                            .contains(a.action())
                            ? "Der gezielte Readback widerspricht dem angeforderten Zustand."
                            : "Der Folgebeleg meldet einen fehlgeschlagenen Abschluss."
                    : "Passender Folgebeleg " + wireAction + " beobachtet.";
            if ("RemoteStartTransaction".equals(a.action()) && payload.path("transactionId").isIntegralNumber()) {
                jdbc.update("UPDATE ocpp_action SET transaction_id=COALESCE(transaction_id,?) WHERE id=?",
                        payload.path("transactionId").intValue(), a.id());
            }
            effect(a.id(), tenantId, "station:" + cp, state, payload, at, reason);
            return;
        }
    }

    private enum EffectMatch { NONE, SUCCESS, FAILURE }

    private EffectMatch effectMatch(OcppActionDto.Action a, String wire, String correlation,
            JsonNode p, Instant at) {
        JsonNode r = a.request();
        int connector = p.path("connectorId").asInt(Integer.MIN_VALUE);
        return switch (a.action()) {
            case "RemoteStartTransaction" -> "StartTransaction".equals(wire)
                    && sameOptionalInt(a.connectorId(), connector)
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "RemoteStopTransaction" -> "StopTransaction".equals(wire)
                    && a.transactionId() != null && a.transactionId() == p.path("transactionId").asInt(Integer.MIN_VALUE)
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "UnlockConnector" -> "StatusNotification".equals(wire)
                    && sameOptionalInt(a.connectorId(), connector)
                    && connectorStatusChanged(a, connector, p.path("status").asText(), at)
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "ChangeAvailability" -> "StatusNotification".equals(wire)
                    && sameOptionalInt(a.connectorId(), connector)
                    && (("Inoperative".equals(r.path("type").asText()) && "Unavailable".equals(p.path("status").asText()))
                    || ("Operative".equals(r.path("type").asText()) && "Available".equals(p.path("status").asText())))
                    && connectorStatusChanged(a, connector, p.path("status").asText(), at)
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "SoftReset", "HardReset" -> "BootNotification".equals(wire)
                    && disconnectedAfter(a, at) ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "TriggerMessage" -> triggerWire(r.path("requestedMessage").asText()).equals(wire)
                    && (!r.has("connectorId") || r.path("connectorId").asInt() == connector)
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "ChangeConfiguration" -> "GetConfiguration".equals(wire)
                    && readbackCorrelation(a, correlation)
                    ? configurationContains(p, r.path("key").asText(), r.path("value").asText(""))
                            ? EffectMatch.SUCCESS : EffectMatch.FAILURE
                    : EffectMatch.NONE;
            case "SendLocalList" -> "GetLocalListVersion".equals(wire)
                    && readbackCorrelation(a, correlation)
                    ? p.path("listVersion").asInt(Integer.MIN_VALUE) == r.path("listVersion").asInt()
                            ? EffectMatch.SUCCESS : EffectMatch.FAILURE
                    : EffectMatch.NONE;
            case "SetChargingProfile", "ClearChargingProfile" -> "GetCompositeSchedule".equals(wire)
                    && readbackCorrelation(a, correlation)
                    ? connector == (a.connectorId() == null ? 0 : a.connectorId())
                            && profileUnitMatches(a.action(), r, p)
                            ? EffectMatch.SUCCESS : EffectMatch.FAILURE
                    : EffectMatch.NONE;
            case "GetDiagnostics" -> diagnosticEffect(wire, p);
            case "UpdateFirmware" -> firmwareEffect(wire, p);
            case "ReserveNow" -> "StatusNotification".equals(wire) && "Reserved".equals(p.path("status").asText())
                    && sameOptionalInt(a.connectorId(), connector)
                    && connectorStatusChanged(a, connector, "Reserved", at)
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            case "CancelReservation" -> "StatusNotification".equals(wire) && !"Reserved".equals(p.path("status").asText())
                    && sameOptionalInt(a.connectorId(), connector)
                    && "Reserved".equals(previousConnectorStatus(a, connector, at))
                    ? EffectMatch.SUCCESS : EffectMatch.NONE;
            default -> EffectMatch.NONE;
        };
    }

    private boolean disconnectedAfter(OcppActionDto.Action a, Instant bootAt) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM ocpp_protocol_event WHERE device_id=? "
                + "AND charge_point_id=? AND message_type='Event' AND action='Disconnected' "
                + "AND occurred_at>=? AND occurred_at<?", Integer.class, a.deviceId(), a.chargePointId(),
                ts(a.responseAt()), ts(bootAt));
        return count != null && count > 0;
    }
    private boolean connectorStatusChanged(OcppActionDto.Action a, int connector, String status, Instant at) {
        String before = previousConnectorStatus(a, connector, at);
        return before != null && !before.equals(status);
    }
    private String previousConnectorStatus(OcppActionDto.Action a, int connector, Instant at) {
        return jdbc.query("SELECT status FROM ocpp_connector_status_event WHERE device_id=? "
                + "AND charge_point_id=? AND connector_id=? AND occurred_at<? ORDER BY occurred_at DESC LIMIT 1",
                rs -> rs.next() ? rs.getString(1) : null, a.deviceId(), a.chargePointId(), connector, ts(at));
    }
    private static boolean readbackCorrelation(OcppActionDto.Action a, String correlation) {
        return ("readback-" + a.correlationId()).equals(correlation);
    }
    private static boolean wireMatches(String logicalAction, String wireAction) {
        return Set.of("SoftReset", "HardReset").contains(logicalAction)
                ? "Reset".equals(wireAction) : logicalAction.equals(wireAction);
    }
    private static boolean configurationContains(JsonNode payload, String key, String value) {
        for (JsonNode entry : payload.path("configurationKey"))
            if (key.equals(entry.path("key").asText())
                    && (value == null || value.isBlank() || value.equals(entry.path("value").asText()))) return true;
        return false;
    }
    private static boolean profileUnitMatches(String action, JsonNode request, JsonNode response) {
        if ("ClearChargingProfile".equals(action)) return true;
        String requested = request.path("csChargingProfiles").path("chargingSchedule")
                .path("chargingRateUnit").asText("");
        String observed = response.path("chargingSchedule").path("chargingRateUnit").asText("");
        return !requested.isBlank() && requested.equals(observed);
    }
    private static EffectMatch diagnosticEffect(String wire, JsonNode p) {
        if (!"DiagnosticsStatusNotification".equals(wire)) return EffectMatch.NONE;
        return switch (p.path("status").asText()) { case "Uploaded" -> EffectMatch.SUCCESS; case "UploadFailed" -> EffectMatch.FAILURE; default -> EffectMatch.NONE; };
    }
    private static EffectMatch firmwareEffect(String wire, JsonNode p) {
        if (!"FirmwareStatusNotification".equals(wire)) return EffectMatch.NONE;
        return switch (p.path("status").asText()) { case "Installed" -> EffectMatch.SUCCESS; case "DownloadFailed", "InstallationFailed" -> EffectMatch.FAILURE; default -> EffectMatch.NONE; };
    }
    private static boolean sameOptionalInt(Integer expected, int actual) { return expected == null || expected == actual; }
    private static String triggerWire(String requested) { return requested == null ? "" : requested; }
    private static boolean isNegativeStatus(String status) {
        return status != null && Set.of("Rejected","Faulted","Failed","Unavailable","VersionMismatch",
                "NotSupported","NotImplemented","UnlockFailed","Occupied","UnknownVendorId",
                "UnknownMessageId","Unknown").contains(status);
    }
    private static boolean responseIsTerminal(String action) {
        return Set.of("GetConfiguration","GetLocalListVersion","GetCompositeSchedule","ClearCache","DataTransfer").contains(action);
    }
    private static boolean isPositiveResponse(String action, String status) {
        return switch (action) {
            case "GetConfiguration", "GetLocalListVersion", "GetDiagnostics", "UpdateFirmware" -> status == null;
            case "UnlockConnector" -> "Unlocked".equals(status);
            case "ChangeAvailability" -> Set.of("Accepted", "Scheduled").contains(status);
            case "ChangeConfiguration" -> Set.of("Accepted", "RebootRequired").contains(status);
            default -> "Accepted".equals(status);
        };
    }
    private static String negativeReason(String status) {
        if ("NotSupported".equals(status) || "NotImplemented".equals(status)) return "Die Station unterstützt diese Fähigkeit nicht.";
        if ("UnlockFailed".equals(status)) return "Die Station konnte den Stecker nicht entriegeln.";
        if ("Occupied".equals(status)) return "Der Ladepunkt ist belegt.";
        if ("UnknownVendorId".equals(status) || "UnknownMessageId".equals(status)) return "Die Station kennt diese Herstellerfunktion nicht.";
        return "Station hat die Aktion abgelehnt (" + status + ").";
    }

    private void audit(UUID id, UUID tenant, String actor, String state, String reason, Instant occurredAt) {
        jdbc.update("INSERT INTO ocpp_action_audit(action_id,tenant_id,site_id,device_id,charge_point_id,"
                + "connector_id,transaction_id,actor,state,reason,occurred_at) SELECT id,tenant_id,site_id,device_id,"
                + "charge_point_id,connector_id,transaction_id,?,?,?,? FROM ocpp_action WHERE id=? AND tenant_id=?",
                actor, state, reason, ts(occurredAt), id, tenant);
    }

    private OcppActionDto.Action map(ResultSet rs, int row) throws SQLException {
        return new OcppActionDto.Action(rs.getObject("id", UUID.class), rs.getObject("device_id", UUID.class),
                rs.getString("charge_point_id"), rs.getString("action"), rs.getString("state"),
                rs.getString("correlation_id"), rs.getString("idempotency_key"), rs.getString("actor"),
                (Integer) rs.getObject("connector_id"), (Integer) rs.getObject("transaction_id"),
                parse(rs.getString("request_payload")), parse(rs.getString("response_payload")),
                rs.getString("response_status"), parse(rs.getString("effect_payload")), rs.getString("reason"),
                instant(rs,"prepared_at"), instant(rs,"sent_at"), instant(rs,"response_at"),
                instant(rs,"effect_at"), instant(rs,"deadline_at"), instant(rs,"updated_at"));
    }
    private StoredAction mapStored(ResultSet rs, int row) throws SQLException {
        return new StoredAction(map(rs, row), rs.getObject("tenant_id", UUID.class),
                rs.getObject("site_id", UUID.class), rs.getString("request_hash"),
                rs.getString("conflict_key"));
    }
    private JsonNode parse(String s) { try { return mapper.readTree(s == null ? "{}" : s); } catch (Exception e) { return mapper.createObjectNode(); } }
    private String json(JsonNode node) { try { return mapper.writeValueAsString(node == null ? mapper.createObjectNode() : node); } catch (Exception e) { throw new IllegalArgumentException(e); } }
    private static Timestamp ts(Instant i) { return Timestamp.from(i); }
    private static Instant instant(ResultSet rs, String name) throws SQLException { Timestamp t=rs.getTimestamp(name); return t==null?null:t.toInstant(); }
}
