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
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** JDBC persistence for command intent, audit and evidence. */
@Repository
public class OcppActionRepository {
    public record StationTarget(UUID deviceId, boolean connected) {}
    private record TimeoutCandidate(UUID id, UUID tenantId) {}

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

    public Optional<OcppActionDto.Action> byIdForSite(UUID siteId, UUID id) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE site_id=? AND id=?", this::map, siteId, id).stream().findFirst();
    }

    public Optional<OcppActionDto.Action> byIdempotency(UUID tenantId, String key) {
        return jdbc.query("SELECT * FROM ocpp_action WHERE tenant_id=? AND idempotency_key=?",
                this::map, tenantId, key).stream().findFirst();
    }

    public boolean hasRunning(UUID deviceId, String cp, String action) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM ocpp_action WHERE device_id=? AND "
                + "charge_point_id=? AND action=? AND state IN ('prepared','sent','accepted_waiting_effect')",
                Integer.class, deviceId, cp, action);
        return n != null && n > 0;
    }

    public OcppActionDto.Action insert(UUID id, UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, String correlation, String idempotency, String actor, Integer connector,
            Integer transaction, JsonNode request, Instant prepared, Instant deadline) {
        jdbc.update("INSERT INTO ocpp_action (id,tenant_id,site_id,device_id,charge_point_id,action,state,"
                + "correlation_id,idempotency_key,actor,connector_id,transaction_id,request_payload,"
                + "prepared_at,deadline_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,? ,?::jsonb,?,?,?)",
                id, tenantId, siteId, deviceId, cp, action, "prepared", correlation, idempotency, actor,
                connector, transaction, json(request), ts(prepared), ts(deadline), ts(prepared));
        audit(id, tenantId, actor, "prepared", null);
        return byId(id).orElseThrow();
    }

    public void transition(UUID id, UUID tenantId, String actor, String state, String reason,
            Instant at, String column) {
        String time = switch (column) {
            case "sent" -> ", sent_at=?";
            case "response" -> ", response_at=?";
            case "effect" -> ", effect_at=?";
            default -> "";
        };
        String sql = "UPDATE ocpp_action SET state=?, reason=?, updated_at=?" + time + " WHERE id=?";
        if (time.isEmpty()) jdbc.update(sql, state, reason, ts(at), id);
        else jdbc.update(sql, state, reason, ts(at), ts(at), id);
        audit(id, tenantId, actor, state, reason);
    }

    public void response(UUID id, UUID tenantId, String actor, String state, String status,
            JsonNode payload, String reason, Instant at, boolean awaitsEffect) {
        jdbc.update("UPDATE ocpp_action SET state=CASE WHEN state IN "
                + "('prepared','sent','accepted_waiting_effect') THEN ? ELSE state END, "
                + "response_status=?, response_payload=?::jsonb, "
                + "reason=CASE WHEN state IN ('prepared','sent','accepted_waiting_effect') "
                + "THEN ? ELSE COALESCE(reason, ?) END, response_at=?, updated_at=? WHERE id=?",
                state, status, json(payload), reason, reason == null ? "Spätes OCPP-Ergebnis nach Abschluss." : reason,
                ts(at), ts(at), id);
        audit(id, tenantId, actor, currentState(id), reason);
    }

    public void effect(UUID id, UUID tenantId, String actor, String state, JsonNode evidence,
            Instant at, String reason) {
        jdbc.update("UPDATE ocpp_action SET state=CASE WHEN state IN "
                + "('prepared','sent','accepted_waiting_effect') THEN ? ELSE state END, "
                + "effect_payload=?::jsonb, effect_at=?, reason=CASE WHEN state IN "
                + "('prepared','sent','accepted_waiting_effect') THEN ? ELSE COALESCE(reason, ?) END, "
                + "updated_at=? WHERE id=?", state, json(evidence), ts(at), reason,
                reason == null ? "Später Wirkungsbeleg nach Abschluss." : reason, ts(at), id);
        audit(id, tenantId, actor, currentState(id), reason);
    }

    public void cancel(UUID id, UUID tenantId, String actor, Instant at) {
        int updated = jdbc.update("UPDATE ocpp_action SET state='cancelled', reason='vom Bediener abgebrochen', "
                + "updated_at=? WHERE id=? AND state IN ('prepared','sent','accepted_waiting_effect')", ts(at), id);
        if (updated > 0) audit(id, tenantId, actor, "cancelled", "vom Bediener abgebrochen");
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
            String action, String phrase, String actor, Instant expiresAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO ocpp_action_intent(id,tenant_id,site_id,device_id,charge_point_id,action,phrase,expires_at,actor) "
                + "VALUES(?,?,?,?,?,?,?,?,?)", id, tenantId, siteId, deviceId, cp, action, phrase, ts(expiresAt), actor);
        return new OcppActionDto.Intent(id, action, phrase, expiresAt);
    }

    public boolean consumeIntent(UUID id, UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, Instant now) {
        return jdbc.update("UPDATE ocpp_action_intent SET consumed_at=? WHERE id=? AND tenant_id=? AND site_id=? "
                + "AND device_id=? AND charge_point_id=? AND action=? AND consumed_at IS NULL AND expires_at>?",
                ts(now), id, tenantId, siteId, deviceId, cp, action, ts(now)) > 0;
    }

    public void expire(Instant now) {
        List<TimeoutCandidate> ids = jdbc.query("SELECT id, tenant_id FROM ocpp_action "
                + "WHERE state IN ('sent','accepted_waiting_effect') AND deadline_at < ?",
                (rs, n) -> new TimeoutCandidate(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)), ts(now));
        for (TimeoutCandidate candidate : ids) {
            UUID id = candidate.id();
            int updated = jdbc.update("UPDATE ocpp_action SET state='timed_out', "
                    + "reason='Wirkung innerhalb der Frist nicht beobachtet', updated_at=? WHERE id=? "
                    + "AND state IN ('sent','accepted_waiting_effect')", ts(now), id);
            if (updated > 0) {
                audit(id, candidate.tenantId(), "system", "timed_out",
                        "Wirkung innerhalb der Frist nicht beobachtet");
            }
        }
    }

    /** Advance the action state only from observed journal evidence. */
    public void applyProtocolEvidence(UUID tenantId, UUID deviceId, String cp, JsonNode envelope) {
        String type = envelope.path("message_type").asText();
        String direction = envelope.path("direction").asText();
        String correlation = envelope.path("correlation_id").asText(null);
        String action = envelope.path("action").asText("");
        Instant at = Instant.parse(envelope.path("occurred_at").asText());
        if ("CallResult".equals(type) && "station_to_csms".equals(direction)) {
            var a = byCorrelation(deviceId, cp, correlation);
            if (a.isEmpty()) return;
            JsonNode payload = envelope.path("payload");
            String status = payload.path("status").asText(null);
            boolean negative = status != null && (status.equals("Rejected") || status.equals("Faulted")
                    || status.equals("Failed") || status.equals("Unavailable") || status.equals("VersionMismatch"));
            boolean readback = a.get().action().equals("GetConfiguration") || a.get().action().equals("GetLocalListVersion")
                    || a.get().action().equals("GetCompositeSchedule");
            String state = negative ? "rejected" : readback ? "completed" : "accepted_waiting_effect";
            response(a.get().id(), tenantId, a.get().actor(), state, status, payload,
                    negative ? "Station hat die Aktion abgelehnt." : null, at, !readback);
        } else if ("CallError".equals(type) && "station_to_csms".equals(direction)) {
            var a = byCorrelation(deviceId, cp, correlation);
            if (a.isPresent()) response(a.get().id(), tenantId, a.get().actor(), "call_error",
                    envelope.path("error_code").asText("CallError"), envelope.path("error_details"),
                    "Die Station hat einen OCPP-Fehler gemeldet.", at, false);
        } else if ("Call".equals(type) && "station_to_csms".equals(direction)) {
            String observed = switch (action) {
                case "StartTransaction" -> "RemoteStartTransaction";
                case "StopTransaction" -> "RemoteStopTransaction";
                case "StatusNotification" -> "ChangeAvailability";
                case "DiagnosticsStatusNotification" -> "GetDiagnostics";
                case "FirmwareStatusNotification" -> "UpdateFirmware";
                default -> null;
            };
            if ("BootNotification".equals(action)) {
                List<OcppActionDto.Action> reset = jdbc.query("SELECT * FROM ocpp_action WHERE tenant_id=? AND device_id=? "
                        + "AND charge_point_id=? AND action IN ('HardReset','SoftReset') "
                        + "AND state='accepted_waiting_effect' ORDER BY CASE WHEN action='HardReset' THEN 0 ELSE 1 END, "
                        + "response_at DESC LIMIT 1", this::map, tenantId, deviceId, cp);
                if (!reset.isEmpty()) effect(reset.get(0).id(), tenantId, reset.get(0).actor(), "effect_observed",
                        envelope.path("payload"), at, "Folgebeleg BootNotification beobachtet.");
                return;
            }
            if (observed == null) return;
            List<OcppActionDto.Action> open = jdbc.query("SELECT * FROM ocpp_action WHERE tenant_id=? AND device_id=? "
                    + "AND charge_point_id=? AND action=? AND state='accepted_waiting_effect' ORDER BY response_at DESC LIMIT 1",
                    this::map, tenantId, deviceId, cp, observed);
            if (!open.isEmpty()) effect(open.get(0).id(), tenantId, open.get(0).actor(), "effect_observed",
                    envelope.path("payload"), at, "Folgebeleg " + action + " beobachtet.");
        }
    }

    private void audit(UUID id, UUID tenant, String actor, String state, String reason) {
        jdbc.update("INSERT INTO ocpp_action_audit(action_id,tenant_id,site_id,device_id,charge_point_id,"
                + "connector_id,transaction_id,actor,state,reason) SELECT id,tenant_id,site_id,device_id,"
                + "charge_point_id,connector_id,transaction_id,?,?,? FROM ocpp_action WHERE id=?",
                actor, state, reason, id);
    }

    private String currentState(UUID id) {
        return jdbc.query("SELECT state FROM ocpp_action WHERE id=?", rs -> rs.next() ? rs.getString(1) : "unknown", id);
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
    private JsonNode parse(String s) { try { return mapper.readTree(s == null ? "{}" : s); } catch (Exception e) { return mapper.createObjectNode(); } }
    private String json(JsonNode node) { try { return mapper.writeValueAsString(node == null ? mapper.createObjectNode() : node); } catch (Exception e) { throw new IllegalArgumentException(e); } }
    private static Timestamp ts(Instant i) { return Timestamp.from(i); }
    private static Instant instant(ResultSet rs, String name) throws SQLException { Timestamp t=rs.getTimestamp(name); return t==null?null:t.toInstant(); }
}
