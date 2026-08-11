package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.RuleEventsDto.RuleActivityDto;
import com.voltpilot.api.web.dto.RuleEventsDto.RuleEventDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der VERLAUFSSPEICHER des Regel-Protokolls (Tabellen {@code rule_event} +
 * {@code rule_event_recording}, Migration V20260816000000), RLS-gefenced auf
 * den laufenden Mandanten wie jede andere Kundendaten-Tabelle - geschrieben
 * wird aus den Herzschlag-Zuhörern unter dem Mandanten des Topics, gelesen
 * über die Kunden-Route unter dem Mandanten des Tokens.
 *
 * <p>Anders als seine Geschwister ({@code consumer_runtime_status},
 * {@code flow_device_ack}) ist diese Tabelle APPEND-ONLY: sie ist genau der
 * Verlauf, den jene Momentaufnahmen je Herzschlag wegwerfen.
 */
@Repository
public class RuleEventRepository {

    /** Eine anzuhängende Zeile, mit der schon aufgelösten Regel-Zuordnung. */
    public record NewEvent(UUID entityId, String ruleKind, String ruleRef, String kind,
            String state, String previousState, String reasonCode, Double actualKw,
            String detail, Instant occurredAt) {
    }

    private final JdbcTemplate jdbc;

    public RuleEventRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Anhängen. Der Mandant kommt aus der RLS-Sitzung, nie aus dem Aufruf -
     * das WITH CHECK stempelt die Zeile, ein fremder Mandant wäre gar nicht
     * schreibbar.
     */
    public void append(UUID siteId, List<NewEvent> events) {
        for (NewEvent e : events) {
            jdbc.update(
                    "INSERT INTO rule_event (tenant_id, site_id, entity_id, rule_kind, rule_ref, "
                            + "kind, state, previous_state, reason_code, actual_kw, detail, "
                            + "occurred_at) VALUES ("
                            + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                            + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    siteId, e.entityId(), e.ruleKind(), e.ruleRef(), e.kind(), e.state(),
                    e.previousState(), e.reasonCode(), e.actualKw(), e.detail(),
                    Timestamp.from(e.occurredAt()));
        }
    }

    /**
     * Den Aufzeichnungs-Beginn festhalten. Der ERSTE Eintrag gewinnt
     * ({@code DO NOTHING}) - er ist die Aussage „ab hier haben wir hingesehen"
     * und darf sich nie nach hinten verschieben.
     */
    public void markRecording(UUID siteId, Instant startedAt) {
        jdbc.update(
                "INSERT INTO rule_event_recording (site_id, tenant_id, started_at) VALUES ("
                        + "?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?) "
                        + "ON CONFLICT (site_id) DO NOTHING",
                siteId, Timestamp.from(startedAt));
    }

    /** Seit wann für diese Anlage aufgezeichnet wird; leer = noch gar nicht. */
    public Optional<Instant> recordingSince(UUID siteId) {
        return jdbc.query("SELECT started_at FROM rule_event_recording WHERE site_id = ?",
                        (rs, i) -> rs.getTimestamp("started_at").toInstant(), siteId)
                .stream().findFirst();
    }

    /** Wie viele Ereignisse die Anlage seit {@code dayStart} schon getragen hat. */
    public int countSince(UUID siteId, Instant dayStart) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM rule_event WHERE site_id = ? AND occurred_at >= ?",
                Integer.class, siteId, Timestamp.from(dayStart));
        return n == null ? 0 : n;
    }

    /** Die Art des jüngsten Ereignisses der Anlage (für den Deckel-Vermerk). */
    public Optional<String> newestKind(UUID siteId) {
        return jdbc.query(
                        "SELECT kind FROM rule_event WHERE site_id = ? "
                                + "ORDER BY occurred_at DESC, id DESC LIMIT 1",
                        (rs, i) -> rs.getString("kind"), siteId)
                .stream().findFirst();
    }

    /**
     * Die Zähler je Regel seit {@code dayStart}. Gezählt werden STARTS
     * („3× geschaltet"), der Zeitpunkt ist der jüngste Schaltvorgang in beide
     * Richtungen. Regellose Ereignisse ({@code rule_ref IS NULL}) fallen heraus -
     * sie stehen im Gesamt-Protokoll, aber es gibt keine Karte, an die sie
     * gehörten.
     */
    public List<RuleActivityDto> activity(UUID siteId, Instant dayStart, Set<String> startKinds,
            Set<String> switchKinds) {
        return jdbc.query(
                "SELECT rule_kind, rule_ref, "
                        + "count(*) FILTER (WHERE kind = ANY(?) AND occurred_at >= ?) AS starts, "
                        + "max(occurred_at) FILTER (WHERE kind = ANY(?)) AS last_switch "
                        + "FROM rule_event WHERE site_id = ? AND rule_ref IS NOT NULL "
                        + "GROUP BY rule_kind, rule_ref",
                (rs, i) -> new RuleActivityDto(rs.getString("rule_kind"), rs.getString("rule_ref"),
                        rs.getInt("starts"),
                        rs.getTimestamp("last_switch") == null
                                ? null : rs.getTimestamp("last_switch").toInstant()),
                startKinds.toArray(String[]::new), Timestamp.from(dayStart),
                switchKinds.toArray(String[]::new), siteId);
    }

    /** Das Gesamt-Protokoll der Anlage, neueste zuerst. */
    public List<RuleEventDto> events(UUID siteId, int limit) {
        return jdbc.query(
                "SELECT id, rule_kind, rule_ref, entity_id, kind, state, previous_state, "
                        + "reason_code, actual_kw, detail, occurred_at FROM rule_event "
                        + "WHERE site_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?",
                (rs, i) -> new RuleEventDto(rs.getLong("id"), rs.getString("rule_kind"),
                        rs.getString("rule_ref"),
                        rs.getObject("entity_id") == null
                                ? null : rs.getObject("entity_id", UUID.class).toString(),
                        rs.getString("kind"), rs.getString("state"), rs.getString("previous_state"),
                        rs.getString("reason_code"), (Double) rs.getObject("actual_kw"),
                        rs.getString("detail"), rs.getTimestamp("occurred_at").toInstant()),
                siteId, limit);
    }

    /**
     * Aufräumen: alles älter als {@code cutoff}, GEDECKELT je Aufruf. Der
     * Deckel ist Absicht - ein Aufräumen, das im Schreibpfad reitet, darf nie
     * eine lange Transaktion werden; was übrig bleibt, holt der nächste Lauf.
     * Läuft ohne Mandanten-Prädikat, weil RLS es setzt.
     */
    public int prune(Instant cutoff, int limit) {
        return jdbc.update(
                "DELETE FROM rule_event WHERE ctid IN ("
                        + "SELECT ctid FROM rule_event WHERE occurred_at < ? LIMIT ?)",
                Timestamp.from(cutoff), limit);
    }

    /**
     * Die Komponenten der Anlage mit einer AKTIVEN Verbraucher-Regel - die eine
     * Hälfte der V-5-Zuordnung (die andere sind die Ansprüche aktiver Flows).
     */
    public Set<UUID> entitiesWithActivePolicy(UUID siteId) {
        return jdbc.queryForList(
                        "SELECT entity_id FROM consumer_policy "
                                + "WHERE site_id = ? AND lifecycle = 'active'",
                        UUID.class, siteId)
                .stream().collect(Collectors.toSet());
    }
}
