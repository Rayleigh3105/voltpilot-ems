package com.voltpilot.api.repo;

import com.voltpilot.api.command.CommandFilter;
import com.voltpilot.api.registerwrite.RegisterWriteResult;
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
     * Wie oft dieses Register auf diesem Gerät HEUTE schon angefordert wurde -
     * die EEPROM-Ehrlichkeit des Drawers (Konzept §2.3: „heute bereits 2x
     * geschrieben"), ausdrücklich statt einer Sperre.
     *
     * <p><b>Gezählt werden ANFORDERUNGEN, nicht Quittungen</b>, und das ist die
     * ehrliche Richtung: ein Schreibvorgang, dessen Antwort verloren ging, kann
     * angekommen sein - ihn nicht mitzuzählen würde die Zahl kleiner machen, als
     * das EEPROM sie erlebt hat. Ein Probelauf steht gar nicht im Journal.
     *
     * <p>Der Tag ist der BERLINER Kalendertag - dieselbe Zeitrechnung, in der
     * jede andere Tagesgröße dieses Hauses gezählt wird.
     */
    public int countWritesToday(UUID siteId, UUID deviceId, int address) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM register_write_event "
                        + "WHERE site_id = ? AND device_id = ? AND address = ? "
                        + "AND event = '" + EVENT_REQUESTED + "' "
                        + "AND (requested_at AT TIME ZONE 'Europe/Berlin')::date "
                        + "= (now() AT TIME ZONE 'Europe/Berlin')::date",
                Integer.class, siteId, deviceId, address);
        return n == null ? 0 : n;
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
        return query(siteId, deviceId, null, null, null, limit);
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
        return query(siteId, deviceId, null, from, to, limit);
    }

    /**
     * Die Vorgänge, die der BOX gehören: die ihres Geräts OHNE Komponente - also
     * die primäre Lane und eine frei getippte Adresse (Ziel-Attribution, Konzept
     * {@code vp-geraeteseite-rev-b8} §5).
     *
     * <p>Ein Vorgang auf der Lane „komponente" trägt seine Komponente und steht
     * damit auf der Seite des Geräts, das sie besitzt; ihn hier zusätzlich zu
     * zeigen hiesse, denselben Schreibvorgang an zwei Orten zu behaupten. Die
     * ganze Anlage auf einmal zeigt weiterhin die Befehle-Seite ohne Filter.
     */
    public List<Entry> betweenForBox(UUID siteId, UUID deviceId, Instant from, Instant to,
            int limit) {
        return query(siteId, deviceId, null, from, to, limit, true);
    }

    /**
     * Dieselben Vorgänge, aber auf die KOMPONENTEN eines Geräts hinter der Box
     * eingegrenzt (Anlagen-Zentrale Stufe 1).
     *
     * <p>Zugeordnet wird ausschließlich über {@code entity_id} - also über die
     * Lane „komponente". Ein Vorgang auf der primären Lane oder auf einer frei
     * getippten Adresse trägt keine Komponente; er gehört dem Schreibweg der
     * BOX und erscheint dort, statt hier einem Gerät zugeschrieben zu werden,
     * über das er nichts aussagt.
     *
     * <p>Eine LEERE Menge liefert ehrlich nichts (nie „alle Vorgänge").
     */
    public List<Entry> betweenForEntities(UUID siteId, List<UUID> entityIds, Instant from,
            Instant to, int limit) {
        return query(siteId, null, entityIds, from, to, limit);
    }

    private List<Entry> query(UUID siteId, UUID deviceId, List<UUID> entityIds, Instant from,
            Instant to, int limit) {
        return query(siteId, deviceId, entityIds, from, to, limit, false);
    }

    private List<Entry> query(UUID siteId, UUID deviceId, List<UUID> entityIds, Instant from,
            Instant to, int limit, boolean withoutEntity) {
        return query(siteId, deviceId, entityIds, from, to, limit, withoutEntity,
                CommandFilter.Filter.NONE, null);
    }

    /**
     * Dieselben Vorgänge mit den STRUKTUR-Filtern der Befehls-Suche
     * (Geräteseiten Revision B §6) und dem Seiten-Cursor.
     *
     * <p>Gefiltert wird auf dem GEFALTETEN Vorgang, nicht auf einer seiner zwei
     * Zeilen: das Ergebnis steht auf der Quittung, die Herkunft auf der
     * Anforderung - ein Prädikat auf einer einzelnen Zeile beantwortete jeweils
     * nur die halbe Frage. Deshalb reisen beide als {@code HAVING} über die
     * Gruppe.
     */
    public List<Entry> filtered(UUID siteId, UUID deviceId, List<UUID> entityIds, Instant from,
            Instant to, int limit, boolean withoutEntity, CommandFilter.Filter filter,
            Instant before) {
        return query(siteId, deviceId, entityIds, from, to, limit, withoutEntity, filter, before);
    }

    /**
     * Wie viele VORGÄNGE das Fenster trägt - die Register-Hälfte des
     * Treffer-Zählers („14 von 212 Zeilen").
     */
    public int count(UUID siteId, UUID deviceId, List<UUID> entityIds, Instant from, Instant to,
            boolean withoutEntity, CommandFilter.Filter filter) {
        List<Object> args = new ArrayList<>();
        String inner = grouped(siteId, deviceId, entityIds, from, to, withoutEntity, filter, null,
                args);
        Integer n = jdbc.queryForObject("SELECT count(*) FROM (" + inner + ") x", Integer.class,
                args.toArray());
        return n == null ? 0 : n;
    }

    private List<Entry> query(UUID siteId, UUID deviceId, List<UUID> entityIds, Instant from,
            Instant to, int limit, boolean withoutEntity, CommandFilter.Filter filter,
            Instant before) {
        // Das Limit greift auf VORGÄNGEN, nicht auf Zeilen: ein Vorgang mit
        // Quittung darf nicht seinen Kopf verlieren, nur weil die Grenze mitten
        // zwischen seinen zwei Zeilen lag.
        List<Object> args = new ArrayList<>();
        StringBuilder inner = new StringBuilder(grouped(siteId, deviceId, entityIds, from, to,
                withoutEntity, filter, before, args));
        inner.append(" ORDER BY max(id) DESC LIMIT ?");
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

    /**
     * Die GRUPPIERTE Auswahl der Vorgänge im Fenster - der gemeinsame Kern von
     * Liste und Zähler. Sie liefert Kennungen, keine Zeilen.
     */
    private static String grouped(UUID siteId, UUID deviceId, List<UUID> entityIds, Instant from,
            Instant to, boolean withoutEntity, CommandFilter.Filter filter, Instant before,
            List<Object> args) {
        StringBuilder inner = new StringBuilder(
                "SELECT request_id FROM register_write_event WHERE site_id = ?");
        args.add(siteId);
        if (deviceId != null) {
            inner.append(" AND device_id = ?");
            args.add(deviceId);
        }
        if (entityIds != null) {
            inner.append(" AND entity_id = ANY(?::uuid[])");
            args.add(CommandLogRepository.uuidArray(entityIds));
        }
        if (withoutEntity) {
            inner.append(" AND entity_id IS NULL");
        }
        if (from != null) {
            inner.append(" AND requested_at >= ?");
            args.add(Timestamp.from(from));
        }
        if (to != null) {
            inner.append(" AND requested_at < ?");
            args.add(Timestamp.from(to));
        }
        if (before != null) {
            // ⚠ `<=`, nie `<`: zwei Vorgänge dürfen denselben Zeitpunkt tragen,
            // und ein striktes Kleiner verlöre den zweiten an der Seitengrenze.
            inner.append(" AND requested_at <= ?");
            args.add(Timestamp.from(before));
        }
        inner.append(" GROUP BY request_id");
        having(inner, args, filter);
        return inner.toString();
    }

    /**
     * Herkunft und Ergebnis als {@code HAVING} über den GEFALTETEN Vorgang.
     *
     * <p>⚠ Die drei Ergebnis-Wörter sind eine ABBILDUNG, keine Spalte: das
     * Journal kennt sechs Ausgänge ({@code uebernommen}, {@code nicht_uebernommen},
     * {@code abgelehnt}, {@code fehler}, {@code unbekannt}, {@code gelesen}),
     * und ein Kunde fragt nach dreien. „Nicht übernommen" bündelt deshalb den
     * belegten Widerspruch mit der Ablehnung und dem Fehler - alle drei sagen
     * „der Wert steht nicht im Gerät". „Keine Quittung" ist ausdrücklich das
     * SCHWEIGEN (gar kein Ausgang oder {@code unbekannt}) und nie dasselbe:
     * die PR-280-Lehre, hier auf dem Register-Pfad.
     */
    private static void having(StringBuilder inner, List<Object> args,
            CommandFilter.Filter filter) {
        if (filter == null || filter.isEmpty()) {
            return;
        }
        List<String> parts = new ArrayList<>();
        if (!filter.sources().isEmpty()) {
            parts.add("bool_or(source = ANY(?::text[]))");
            args.add(CommandLogRepository.textArray(filter.sources()));
        }
        var results = filter.registerResults();
        if (!results.isEmpty()) {
            List<String> or = new ArrayList<>();
            if (results.contains(CommandFilter.RESULT_UEBERNOMMEN)) {
                or.add("bool_or(outcome = '" + RegisterWriteResult.OUTCOME_ADOPTED + "')");
            }
            if (results.contains(CommandFilter.RESULT_NICHT_UEBERNOMMEN)) {
                or.add("bool_or(outcome IN ('" + RegisterWriteResult.OUTCOME_NOT_ADOPTED + "','"
                        + RegisterWriteResult.OUTCOME_REFUSED + "','"
                        + RegisterWriteResult.OUTCOME_ERROR + "'))");
            }
            if (results.contains(CommandFilter.RESULT_KEINE_QUITTUNG)) {
                or.add("NOT bool_or(outcome IS NOT NULL AND outcome <> '"
                        + RegisterWriteResult.OUTCOME_UNKNOWN + "')");
            }
            parts.add("(" + String.join(" OR ", or) + ")");
        }
        if (!parts.isEmpty()) {
            inner.append(" HAVING ").append(String.join(" AND ", parts));
        }
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
