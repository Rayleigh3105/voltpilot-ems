package com.voltpilot.api.repo;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.command.CommandLog;
import com.voltpilot.api.command.CommandLog.Detail;
import com.voltpilot.api.command.CommandLog.OpenPeriod;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der VERLAUFSSPEICHER des Kommando-Verlaufs (Tabellen {@code device_command_log}
 * + {@code device_command_recording}, Migration V20260823000000), RLS-gefenced
 * auf den laufenden Mandanten wie jede andere Kundendaten-Tabelle - geschrieben
 * aus den Herzschlag-Zuhörern unter dem Mandanten des Topics, gelesen über die
 * Kunden-Route unter dem Mandanten des Tokens.
 *
 * <p>Anders als seine Geschwister ({@code device_control_status},
 * {@code device_curtailment_status}, {@code consumer_runtime_status}) ist diese
 * Tabelle ein VERLAUF: sie hält genau das fest, was jene Momentaufnahmen je
 * Herzschlag wegwerfen. Perioden werden fortgeschrieben (UPDATE der offenen
 * Zeile), Ereignisse angehängt.
 */
@Repository
public class CommandLogRepository {

    private static final Logger log = LoggerFactory.getLogger(CommandLogRepository.class);

    /** Die Spalten, die {@link #map(ResultSet)} liest. */
    private static final String COLUMNS =
            "id, device_id, entity_id, stream, kind, event_kind, started_at, ended_at, "
                    + "last_seen_at, mode, path, why_kind, why_ref, commanded_kw_first, "
                    + "commanded_kw_last, commanded_kw_min, commanded_kw_max, verdict, cycles, "
                    + "cycles_confirmed, cycles_no_answer, cycles_mismatch, control_enabled, "
                    + "released, foreign_influence, detail, source";

    /** Eine gelesene Zeile - Periode ODER Punkt-Ereignis (siehe {@code kind}). */
    public record Row(long id, UUID deviceId, UUID entityId, String stream, String kind,
            String eventKind, Instant startedAt, Instant endedAt, Instant lastSeenAt, String mode,
            String path, String whyKind, String whyRef, Double commandedKwFirst,
            Double commandedKwLast, Double commandedKwMin, Double commandedKwMax, String verdict,
            Integer cycles, Integer cyclesConfirmed, Integer cyclesNoAnswer, Integer cyclesMismatch,
            Boolean controlEnabled, Boolean released, Boolean foreignInfluence, Detail detail,
            String source) {
    }

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper = new ObjectMapper();

    public CommandLogRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // -- Schreiben ------------------------------------------------------------

    /**
     * Die offene Periode eines Stroms an einem Gerät. {@code entityId} wird nur
     * dort verglichen, wo die Komponente den Strom wirklich unterscheidet
     * (Verbraucher) - für Batterie und Abregelung gibt es je Gerät genau EINE
     * laufende Periode, deren Komponente nachgetragen werden darf, ohne dass
     * daraus ein neuer Betriebszustand würde.
     */
    public Optional<OpenPeriod> findOpen(UUID deviceId, String stream, UUID entityId,
            boolean perEntity) {
        String sql = "SELECT id, stream, entity_id, started_at, last_seen_at, mode, path, "
                + "why_kind, why_ref, verdict, control_enabled, released, foreign_influence "
                + "FROM device_command_log WHERE device_id = ? AND stream = ? "
                + "AND kind = '" + CommandLog.KIND_PERIODE + "' AND ended_at IS NULL"
                + (perEntity ? " AND entity_id IS NOT DISTINCT FROM ?" : "");
        Object[] args = perEntity
                ? new Object[] {deviceId, stream, entityId}
                : new Object[] {deviceId, stream};
        return jdbc.query(sql, (rs, i) -> new OpenPeriod(
                rs.getLong("id"), rs.getString("stream"), rs.getObject("entity_id", UUID.class),
                rs.getTimestamp("started_at").toInstant(),
                rs.getTimestamp("last_seen_at").toInstant(),
                rs.getString("mode"), rs.getString("path"), rs.getString("why_kind"),
                rs.getString("why_ref"), rs.getString("verdict"),
                rs.getObject("control_enabled", Boolean.class),
                rs.getObject("released", Boolean.class),
                rs.getObject("foreign_influence", Boolean.class)), args)
                .stream().findFirst();
    }

    /**
     * Eine neue Periode eröffnen. Der Mandant kommt aus der RLS-Sitzung, nie aus
     * dem Aufruf - das WITH CHECK stempelt die Zeile, ein fremder Mandant wäre
     * gar nicht schreibbar.
     *
     * <p>Die vier {@code commanded_kw_*}-Spalten starten alle auf dem ersten
     * gemessenen Wert; ein nicht gemeldeter Wert bleibt NULL statt 0.
     */
    public void openPeriod(UUID siteId, UUID deviceId, CommandLog.Observation obs, Instant at) {
        jdbc.update("INSERT INTO device_command_log (tenant_id, site_id, device_id, entity_id, "
                + "stream, kind, started_at, last_seen_at, mode, path, why_kind, why_ref, "
                + "commanded_kw_first, commanded_kw_last, commanded_kw_min, commanded_kw_max, "
                + "verdict, control_enabled, released, foreign_influence, detail, source) VALUES ("
                + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, '"
                + CommandLog.KIND_PERIODE + "', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                + "?::jsonb, '" + CommandLog.SOURCE_CLOUD + "')",
                siteId, deviceId, obs.entityId(), obs.stream(), Timestamp.from(at),
                Timestamp.from(at), obs.mode(), obs.path(), obs.whyKind(), obs.whyRef(),
                obs.commandedKw(), obs.commandedKw(), obs.commandedKw(), obs.commandedKw(),
                obs.verdict(), obs.controlEnabled(), obs.released(), obs.foreignInfluence(),
                toJson(obs.detail()));
    }

    /**
     * Die offene Periode fortschreiben: Frische, Aggregat, Roh-Detail - und die
     * Komponente NACHTRAGEN, sobald sie auflösbar wird (sonst bliebe eine
     * Periode, die vor der Zuordnung begann, für immer ohne sie).
     *
     * <p>{@code LEAST}/{@code GREATEST} ignorieren NULL, ein erster Wert nach
     * einer wertlosen Phase setzt also alle vier Spalten korrekt.
     */
    public void extendPeriod(long id, CommandLog.Observation obs, Instant at) {
        jdbc.update("UPDATE device_command_log SET last_seen_at = ?, "
                + "entity_id = coalesce(entity_id, ?), "
                + "commanded_kw_first = coalesce(commanded_kw_first, ?), "
                + "commanded_kw_last = coalesce(?, commanded_kw_last), "
                + "commanded_kw_min = LEAST(commanded_kw_min, ?), "
                + "commanded_kw_max = GREATEST(commanded_kw_max, ?), "
                + "detail = coalesce(?::jsonb, detail) WHERE id = ?",
                Timestamp.from(at), obs.entityId(), obs.commandedKw(), obs.commandedKw(),
                obs.commandedKw(), obs.commandedKw(), toJson(obs.detail()), id);
    }

    /** Eine Periode an genau diesem Zeitpunkt schliessen. */
    public void closePeriod(long id, Instant endedAt) {
        jdbc.update("UPDATE device_command_log SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
                Timestamp.from(endedAt), id);
    }

    /**
     * Offene Perioden eines Stroms schliessen, die dieser Herzschlag NICHT mehr
     * trägt - geschlossen wird an ihrem letzten belegten Zeitpunkt, damit nie
     * eine Zeit behauptet wird, in der niemand hingesehen hat. Es entsteht KEIN
     * Ereignis: Verschwinden ist kein Stopp.
     */
    public void closeOpenExcept(UUID deviceId, String stream, Collection<UUID> keep) {
        // Als Array-LITERAL, nicht als Java-Array: der Treiber muss den
        // Elementtyp sonst erraten, und ein leeres Array hätte gar keinen.
        String literal = "{" + keep.stream().map(UUID::toString)
                .collect(java.util.stream.Collectors.joining(",")) + "}";
        jdbc.update("UPDATE device_command_log SET ended_at = last_seen_at "
                + "WHERE device_id = ? AND stream = ? AND kind = '" + CommandLog.KIND_PERIODE
                + "' AND ended_at IS NULL AND entity_id IS NOT NULL "
                + "AND NOT (entity_id = ANY(?::uuid[]))",
                deviceId, stream, literal);
    }

    /**
     * Die KOMPONENTE, an die der Schreibweg dieses Geräts geht: ihr Steuer-Punkt
     * (heute die Batterie-Hybrid-Zeile). {@code null} heisst ehrlich „keiner
     * einzelnen Komponente zuzuordnen" - die Zeile bleibt gerätebezogen und
     * erscheint an jeder Komponente dieses Geräts, statt eine geratene zu
     * beanspruchen. RLS-gefenced wie jeder andere Lesepfad hier.
     */
    public Optional<UUID> controlPointOf(UUID deviceId) {
        return jdbc.query("SELECT id FROM measurement_point WHERE device_id = ? AND control "
                        + "ORDER BY created_at, id LIMIT 1",
                        (rs, i) -> rs.getObject("id", UUID.class), deviceId)
                .stream().findFirst();
    }

    /** Ein Punkt-Ereignis anhängen. */
    public void appendEvent(UUID siteId, UUID deviceId, UUID entityId, String stream,
            String eventKind, Instant startedAt, Instant endedAt) {
        jdbc.update("INSERT INTO device_command_log (tenant_id, site_id, device_id, entity_id, "
                + "stream, kind, event_kind, started_at, ended_at, last_seen_at, source) VALUES ("
                + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, '"
                + CommandLog.KIND_EREIGNIS + "', ?, ?, ?, ?, '" + CommandLog.SOURCE_CLOUD + "')",
                siteId, deviceId, entityId, stream, eventKind, Timestamp.from(startedAt),
                Timestamp.from(endedAt), Timestamp.from(endedAt));
    }

    /**
     * Den Aufzeichnungs-Beginn festhalten. Der ERSTE Eintrag gewinnt
     * ({@code DO NOTHING}) - er ist die Aussage „ab hier haben wir hingesehen"
     * und darf sich nie nach hinten verschieben.
     */
    public void markRecording(UUID siteId, Instant startedAt) {
        jdbc.update("INSERT INTO device_command_recording (site_id, tenant_id, started_at) VALUES ("
                + "?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?) "
                + "ON CONFLICT (site_id) DO NOTHING", siteId, Timestamp.from(startedAt));
    }

    /** Seit wann für diese Anlage aufgezeichnet wird; leer = noch gar nicht. */
    public Optional<Instant> recordingSince(UUID siteId) {
        return jdbc.query("SELECT started_at FROM device_command_recording WHERE site_id = ?",
                        (rs, i) -> rs.getTimestamp("started_at").toInstant(), siteId)
                .stream().findFirst();
    }

    /** Wie viele Zeilen die Anlage seit {@code dayStart} schon getragen hat. */
    public int countSince(UUID siteId, Instant dayStart) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM device_command_log WHERE site_id = ? AND started_at >= ?",
                Integer.class, siteId, Timestamp.from(dayStart));
        return n == null ? 0 : n;
    }

    /** Ob der Deckel-Vermerk für diesen Tag schon steht (er wird nur EINMAL geschrieben). */
    public boolean cappedSince(UUID siteId, Instant dayStart) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM device_command_log WHERE site_id = ? AND started_at >= ? "
                        + "AND event_kind = ?",
                Integer.class, siteId, Timestamp.from(dayStart), CommandLog.EVENT_GEDECKELT);
        return n != null && n > 0;
    }

    /**
     * Aufräumen: alles älter als {@code cutoff}, GEDECKELT je Aufruf. Der Deckel
     * ist Absicht - ein Aufräumen, das im Schreibpfad reitet, darf nie eine
     * lange Transaktion werden; was übrig bleibt, holt der nächste Lauf. Läuft
     * ohne Mandanten-Prädikat, weil RLS es setzt.
     *
     * <p>Eine noch OFFENE Periode wird nie entfernt - sie beschreibt die
     * Gegenwart, egal wann sie begann.
     */
    public int prune(Instant cutoff, int limit) {
        return jdbc.update("DELETE FROM device_command_log WHERE ctid IN ("
                + "SELECT ctid FROM device_command_log WHERE started_at < ? "
                + "AND ended_at IS NOT NULL LIMIT ?)", Timestamp.from(cutoff), limit);
    }

    // -- Lesen ----------------------------------------------------------------

    /**
     * Der Ausschnitt einer Anlage im Fenster {@code [from, to)}, ÄLTESTE zuerst.
     *
     * <p>Ist eine Komponente gewählt, kommen ihre eigenen Zeilen UND die
     * gerätebezogenen Zeilen ihres Geräts ({@code entity_id IS NULL}) - die
     * betreffen den Schreibweg, über den sie gesteuert wird, und wären sonst
     * nirgends sichtbar.
     *
     * <p>Der Deckel greift am NEUESTEN Ende (die Abfrage sortiert absteigend und
     * dreht danach um): wer einen vollen Tag ansieht, will nie die letzten
     * Stunden verlieren.
     */
    public List<Row> entries(UUID siteId, UUID entityId, UUID deviceId, Instant from, Instant to,
            int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + COLUMNS + " FROM device_command_log "
                + "WHERE site_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at >= ?)");
        List<Object> args = new java.util.ArrayList<>(
                List.of(siteId, Timestamp.from(to), Timestamp.from(from)));
        if (entityId != null) {
            sql.append(" AND (entity_id = ?");
            args.add(entityId);
            if (deviceId != null) {
                sql.append(" OR (entity_id IS NULL AND device_id = ?)");
                args.add(deviceId);
            }
            sql.append(')');
        }
        sql.append(" ORDER BY started_at DESC, id DESC LIMIT ?");
        args.add(limit);
        List<Row> rows = jdbc.query(sql.toString(), (rs, i) -> map(rs), args.toArray());
        Collections.reverse(rows);
        return rows;
    }

    private Row map(ResultSet rs) throws SQLException {
        return new Row(rs.getLong("id"), rs.getObject("device_id", UUID.class),
                rs.getObject("entity_id", UUID.class), rs.getString("stream"), rs.getString("kind"),
                rs.getString("event_kind"), rs.getTimestamp("started_at").toInstant(),
                rs.getTimestamp("ended_at") == null ? null : rs.getTimestamp("ended_at").toInstant(),
                rs.getTimestamp("last_seen_at").toInstant(), rs.getString("mode"),
                rs.getString("path"), rs.getString("why_kind"), rs.getString("why_ref"),
                (Double) rs.getObject("commanded_kw_first"),
                (Double) rs.getObject("commanded_kw_last"),
                (Double) rs.getObject("commanded_kw_min"),
                (Double) rs.getObject("commanded_kw_max"), rs.getString("verdict"),
                (Integer) rs.getObject("cycles"), (Integer) rs.getObject("cycles_confirmed"),
                (Integer) rs.getObject("cycles_no_answer"), (Integer) rs.getObject("cycles_mismatch"),
                rs.getObject("control_enabled", Boolean.class),
                rs.getObject("released", Boolean.class),
                rs.getObject("foreign_influence", Boolean.class), fromJson(rs.getString("detail")),
                rs.getString("source"));
    }

    // -- Der Roh-Blick als JSON ----------------------------------------------

    /**
     * {@code null}, wenn es nichts zu erzählen gibt - eine leere Hülle im
     * {@code detail} wäre die Behauptung „hier ist der Roh-Blick" über eine
     * Zeile, die keinen hat.
     */
    private String toJson(Detail detail) {
        if (detail == null || detail.isEmpty()) {
            return null;
        }
        ObjectNode node = mapper.createObjectNode();
        putIf(node, "mismatch_roles", detail.mismatchRoles());
        putIf(node, "cert_source", detail.certSource());
        putIf(node, "state", detail.state());
        putIf(node, "reason_code", detail.reasonCode());
        if (detail.units() != null) {
            node.put("units", detail.units());
        }
        if (detail.certifiedUnits() != null) {
            node.put("certified_units", detail.certifiedUnits());
        }
        return node.toString();
    }

    private static void putIf(ObjectNode node, String field, String value) {
        if (value != null && !value.isBlank()) {
            node.put(field, value);
        }
    }

    private Detail fromJson(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            var node = mapper.readTree(raw);
            return new Detail(text(node, "mismatch_roles"), text(node, "cert_source"),
                    number(node, "units"), number(node, "certified_units"), text(node, "state"),
                    text(node, "reason_code"));
        } catch (Exception e) {
            // Ein unlesbares Detail darf nie die ZEILE verschlucken - der
            // Verlauf ist die Aussage, der Roh-Blick die Vertiefung.
            log.debug("Roh-Blick einer Kommando-Zeile nicht lesbar: {}", e.getMessage());
            return null;
        }
    }

    private static String text(com.fasterxml.jackson.databind.JsonNode node, String field) {
        var v = node.get(field);
        return v == null || !v.isTextual() ? null : v.asText();
    }

    private static Integer number(com.fasterxml.jackson.databind.JsonNode node, String field) {
        var v = node.get(field);
        return v == null || !v.isInt() ? null : v.asInt();
    }
}
