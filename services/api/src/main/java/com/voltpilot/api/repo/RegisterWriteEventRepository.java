package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das append-only Audit-Journal der Einmal-Schreibvorgänge
 * ({@code register_write_event}, Migration V20260827000000) - Lese- UND
 * Schreibpfad, beide an der mandantenbezogenen App-Rolle (dem {@code @Primary}
 * {@code JdbcTemplate}).
 *
 * <p><b>Es gibt hier bewusst KEINEN BYPASSRLS-Zwilling.</b> Ein Schreibvorgang
 * an einem Kundengerät ist ein Kundendatum; Postgres-RLS ist der Zaun - ein
 * Kunde erreicht ausschließlich seine eigenen Anlagen, ein Portal-Admin jede
 * über den {@code X-Tenant-Id}-Umschalter auf demselben Pfad.
 *
 * <p><b>Zwei Zeilen je Vorgang, nie eine mutierte:</b> {@code angefordert} trägt
 * WER/WOHIN/WAS samt der verbatim getippten Begriffe, {@code quittung} bzw.
 * {@code keine_quittung} trägt das Ergebnis. Verbunden werden sie über
 * {@code request_id} - denselben Schlüssel, unter dem die Box ihr eigenes Audit
 * führt. Es gibt kein UPDATE und kein DELETE; die Migration nimmt der App-Rolle
 * beides ausdrücklich weg.
 *
 * <p><b>Jeder INSERT ist {@code ON CONFLICT DO NOTHING}</b> auf
 * {@code (request_id, event)}: eine QoS1-Doppelzustellung der Quittung und ein
 * wiederholter Herzschlag (D6) erzeugen damit keine zweite Zeile. Das bleibt
 * append-only - ein nicht ausgeführter INSERT ist keine Mutation.
 */
@Repository
public class RegisterWriteEventRepository {

    /** Die Quelle: dieser Kanal. */
    public static final String SOURCE_PORTAL = "portal";
    /** Die Quelle: der Wartungszugang an der Box (D6, per Herzschlag nachgemeldet). */
    public static final String SOURCE_DEVICE = "geraet";

    public static final String EVENT_REQUESTED = "angefordert";
    public static final String EVENT_RECEIPT = "quittung";
    public static final String EVENT_SILENT = "keine_quittung";

    /** Die Herkunft eines Vorgangs - server-seitig gestempelt, nie aus dem Körper. */
    public static final String ORIGIN_CUSTOMER = "kunde";
    public static final String ORIGIN_VOLTPILOT = "voltpilot";
    public static final String ORIGIN_DEVICE = "geraet";

    private final JdbcTemplate jdbc;

    public RegisterWriteEventRepository(JdbcTemplate jdbcTemplate) {
        this.jdbc = jdbcTemplate;
    }

    /**
     * Die Anforderungs-Zeile: WER, WOHIN, WAS - inklusive der verbatim getippten
     * Begriffe. Der Mandant kommt aus der RLS-SITZUNG selbst, nie aus dem Aufruf
     * (das {@code rule_event}-Muster), und die {@code WITH CHECK}-Policy
     * bestätigt es ein zweites Mal.
     */
    public void recordRequest(Request r) {
        jdbc.update("INSERT INTO register_write_event ("
                + "request_id, event, source, tenant_id, site_id, device_id, device_ref, "
                + "lane, entity_id, target_label, register_kind, address, write_fc, "
                + "address_input, value_input, note, value_raw, expected_before, "
                + "register_label, register_class, scale_note, "
                + "origin, actor_sub, actor_name, actor_role, via_tenant_switcher, requested_at) "
                + "VALUES (?, '" + EVENT_REQUESTED + "', ?, "
                + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (request_id, event) DO NOTHING",
                r.requestId(), r.source(), r.siteId(), r.deviceId(), r.deviceRef(),
                r.lane(), r.entityId(), r.targetLabel(), r.registerKind(), r.address(),
                r.writeFc(), r.addressInput(), r.valueInput(), r.note(), r.valueRaw(),
                r.expectedBefore(), r.registerLabel(), r.registerClass(), r.scaleNote(),
                r.origin(), r.actorSub(), r.actorName(), r.actorRole(), r.viaTenantSwitcher(),
                Timestamp.from(r.requestedAt()));
    }

    /** Die Ergebnis-Zeile (Quittung oder ihr Ausbleiben). */
    public void recordOutcome(Receipt r) {
        jdbc.update("INSERT INTO register_write_event ("
                + "request_id, event, source, tenant_id, site_id, device_id, "
                + "before_raw, after_raw, adopted, outcome, reason, target_label, requested_at) "
                + "VALUES (?, ?, ?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, "
                + "?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (request_id, event) DO NOTHING",
                r.requestId(), r.event(), r.source(), r.siteId(), r.deviceId(),
                r.beforeRaw(), r.afterRaw(), r.adopted(), r.outcome(), r.reason(),
                r.targetLabel(), Timestamp.from(r.at()));
    }

    /**
     * Die Vorgänge einer Anlage, NEUESTE zuerst, je Vorgang zu EINER Zeile
     * gefaltet. Optional auf ein Gerät eingegrenzt.
     *
     * <p>Die Faltung passiert hier und nicht in SQL, weil die beiden Zeilen
     * verschiedene Spalten füllen und ein {@code FULL JOIN} auf sich selbst
     * genau dieselbe Arbeit in einer schwerer lesbaren Sprache täte.
     */
    public List<Entry> recent(UUID siteId, UUID deviceId, int limit) {
        return query(siteId, deviceId, null, null, limit);
    }

    /**
     * Die Vorgänge einer Anlage im Fenster {@code [from, to)} - die Form, die die
     * Befehle-Seite als vierten Strom {@code register} einmischt.
     *
     * <p>Das Fenster greift auf {@code requested_at}, also auf den Zeitpunkt der
     * ANFORDERUNG: ein Vorgang gehört zu dem Tag, an dem jemand ihn ausgelöst
     * hat - dieselbe Konvention wie beim Kommando-Verlauf, dessen Zeilen zum Tag
     * ihres Starts gehören.
     */
    public List<Entry> between(UUID siteId, UUID deviceId, Instant from, Instant to, int limit) {
        return query(siteId, deviceId, from, to, limit);
    }

    private List<Entry> query(UUID siteId, UUID deviceId, Instant from, Instant to, int limit) {
        // Das Limit greift auf VORGÄNGEN, nicht auf Zeilen: ein Vorgang mit
        // Quittung darf nicht seinen Kopf verlieren, nur weil die Grenze mitten
        // zwischen seinen zwei Zeilen lag.
        StringBuilder inner = new StringBuilder(
                "SELECT request_id FROM register_write_event WHERE site_id = ?");
        List<Object> args = new ArrayList<>();
        args.add(siteId);
        if (deviceId != null) {
            inner.append(" AND device_id = ?");
            args.add(deviceId);
        }
        if (from != null) {
            inner.append(" AND requested_at >= ?");
            args.add(Timestamp.from(from));
        }
        if (to != null) {
            inner.append(" AND requested_at < ?");
            args.add(Timestamp.from(to));
        }
        inner.append(" GROUP BY request_id ORDER BY max(id) DESC LIMIT ?");
        args.add(limit);

        String sql = "SELECT * FROM register_write_event WHERE request_id IN (" + inner
                + ") AND site_id = ? ORDER BY id ASC";
        args.add(siteId);

        Map<String, Entry> folded = new LinkedHashMap<>();
        jdbc.query(sql, rs -> {
            String requestId = rs.getString("request_id");
            folded.put(requestId, merge(folded.get(requestId), rs));
        }, args.toArray());
        List<Entry> out = new ArrayList<>(folded.values());
        // Die Anzeige will die jüngsten zuerst; gelesen wurde aufsteigend, damit
        // die Anforderungs-Zeile immer VOR ihrer Quittung gefaltet wird.
        out.sort((a, b) -> Long.compare(b.id(), a.id()));
        return out;
    }

    private static Entry merge(Entry current, ResultSet rs) throws SQLException {
        String event = rs.getString("event");
        if (EVENT_REQUESTED.equals(event)) {
            Entry base = new Entry(rs.getLong("id"), rs.getString("request_id"),
                    rs.getString("source"), uuid(rs, "device_id"), rs.getString("device_ref"),
                    rs.getString("lane"), uuid(rs, "entity_id"), rs.getString("target_label"),
                    rs.getString("register_kind"), integer(rs, "address"),
                    rs.getString("address_input"), rs.getString("value_input"),
                    rs.getString("note"), integer(rs, "value_raw"),
                    integer(rs, "expected_before"), rs.getString("register_label"),
                    rs.getString("register_class"), rs.getString("scale_note"),
                    rs.getString("origin"), rs.getString("actor_name"), rs.getString("actor_role"),
                    rs.getBoolean("via_tenant_switcher"), instant(rs, "requested_at"),
                    null, null, null, null, null, null);
            return current == null ? base : base.withOutcomeOf(current);
        }
        Outcome outcome = new Outcome(integer(rs, "before_raw"), integer(rs, "after_raw"),
                (Boolean) rs.getObject("adopted", Boolean.class), rs.getString("outcome"),
                rs.getString("reason"), instant(rs, "recorded_at"));
        if (current == null) {
            // Eine Quittung ohne ihre Anforderungs-Zeile (Fenster-Rand, D6-Zeile
            // eines Vorgangs, dessen Kopf woanders steht) - sie steht für sich.
            return new Entry(rs.getLong("id"), rs.getString("request_id"), rs.getString("source"),
                    uuid(rs, "device_id"), null, null, null, rs.getString("target_label"),
                    null, null, null, null, null, null, null, null, null, null, null, null, null,
                    false, instant(rs, "requested_at"),
                    outcome.beforeRaw(), outcome.afterRaw(), outcome.adopted(),
                    outcome.outcome(), outcome.reason(), outcome.at());
        }
        return current.with(outcome, Math.max(current.id(), rs.getLong("id")));
    }

    private record Outcome(Integer beforeRaw, Integer afterRaw, Boolean adopted, String outcome,
            String reason, Instant at) {
    }

    /** Die Anforderungs-Tatsachen EINES Vorgangs, wie sie ins Journal wandern. */
    public record Request(String requestId, String source, UUID siteId, UUID deviceId,
            String deviceRef, String lane, UUID entityId, String targetLabel, String registerKind,
            int address, Integer writeFc, String addressInput, String valueInput, String note,
            Integer valueRaw, Integer expectedBefore, String registerLabel, String registerClass,
            String scaleNote, String origin, String actorSub, String actorName, String actorRole,
            boolean viaTenantSwitcher, Instant requestedAt) {
    }

    /** Die Ergebnis-Tatsachen EINES Vorgangs. */
    public record Receipt(String requestId, String event, String source, UUID siteId,
            UUID deviceId, Integer beforeRaw, Integer afterRaw, Boolean adopted, String outcome,
            String reason, String targetLabel, Instant at) {
    }

    /** Ein gefalteter Vorgang: Anforderung + (ggf.) sein Ergebnis. */
    public record Entry(long id, String requestId, String source, UUID deviceId, String deviceRef,
            String lane, UUID entityId, String targetLabel, String registerKind, Integer address,
            String addressInput, String valueInput, String note, Integer valueRaw,
            Integer expectedBefore, String registerLabel, String registerClass, String scaleNote,
            String origin, String actorName, String actorRole, boolean viaTenantSwitcher,
            Instant requestedAt, Integer beforeRaw, Integer afterRaw, Boolean adopted,
            String outcome, String reason, Instant answeredAt) {

        Entry with(Outcome o, long id) {
            return new Entry(id, requestId, source, deviceId, deviceRef, lane, entityId,
                    targetLabel, registerKind, address, addressInput, valueInput, note, valueRaw,
                    expectedBefore, registerLabel, registerClass, scaleNote, origin, actorName,
                    actorRole, viaTenantSwitcher, requestedAt, o.beforeRaw(), o.afterRaw(),
                    o.adopted(), o.outcome(), o.reason(), o.at());
        }

        Entry withOutcomeOf(Entry other) {
            return new Entry(Math.max(id, other.id()), requestId, source, deviceId, deviceRef,
                    lane, entityId, targetLabel, registerKind, address, addressInput, valueInput,
                    note, valueRaw, expectedBefore, registerLabel, registerClass, scaleNote,
                    origin, actorName, actorRole, viaTenantSwitcher, requestedAt,
                    other.beforeRaw(), other.afterRaw(), other.adopted(), other.outcome(),
                    other.reason(), other.answeredAt());
        }
    }

    private static UUID uuid(ResultSet rs, String column) throws SQLException {
        Object v = rs.getObject(column);
        return v == null ? null : UUID.fromString(v.toString());
    }

    private static Integer integer(ResultSet rs, String column) throws SQLException {
        int v = rs.getInt(column);
        return rs.wasNull() ? null : v;
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
