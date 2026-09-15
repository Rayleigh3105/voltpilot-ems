package com.voltpilot.writer;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.writer.EreignisVokabular.Art;
import com.voltpilot.writer.EreignisVokabular.Grund;
import com.voltpilot.writer.EreignisVokabular.Urheber;
import com.voltpilot.writer.EreignisVokabular.Urteil;
import com.voltpilot.writer.EreignisVokabular.Zeitform;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Append-only persistence into {@code messreihe_ereignis} (UEMS AP-07 IP-8, migration
 * V20260911260000 in services/api): the event table per tenant that is never updated and never
 * deleted (only tenant offboarding clears it).
 *
 * <p>Two ways in, one table:
 *
 * <ul>
 *   <li>{@link #spiegeln} — the Bestand mirror: every event {@link MeasurementWriteRepository}
 *       newly writes to {@code device_measurement_event} is written here too, in the SAME
 *       transaction but inside its OWN SAVEPOINT, marked {@code aus_bestand}. A failing mirror
 *       (any CHECK, the tenant FK, a future vocabulary drift) is rolled back alone, logged and
 *       counted in {@code voltpilot_writer_events_mirror_total{ergebnis="fehler",grund}} - the
 *       Bestand write commits exactly as before, the partition never stalls on the mirror. That
 *       path knows the box and the point, never the component, and its {@code _pipeline} gap
 *       has no time span.
 *   <li>{@link #anhaengen} — a contract event from {@code events.raw} ({@link EventsRawConsumer}):
 *       judged by {@link EreignisVokabular} (the writer twin of the api class), a repeat of a
 *       stored report is a no-op, a Fortschreibung (same {@code ereignis_id}) must extend the
 *       latest report ({@link EreignisVokabular#pruefeFortschreibung}) and becomes ANOTHER row.
 * </ul>
 *
 * <p>Idempotency is the database's: {@code meldung} (trigger: md5 of the whole report without
 * its arrival time) is unique per tenant, so a redelivered identical report is dropped by {@code
 * ON CONFLICT DO NOTHING}. The twin of this class for the api is {@code
 * services/api/.../uems/MessreiheEreignisRepository}.
 */
@Repository
public class MessreiheEreignisRepository {

    private static final Logger log = LoggerFactory.getLogger(MessreiheEreignisRepository.class);
    static final String SPIEGEL_METRIK = "voltpilot.writer.events.mirror";
    static final String WRITER_METRIK = "voltpilot.writer.events.writer";
    /** TimescaleDB names a chunk's copy of a FK "<hypertable>_<n>_<name>" - the label keeps <name>. */
    private static final Pattern CONSTRAINT =
            Pattern.compile("constraint \"(?:[0-9]+_[0-9]+_)?([a-z][a-z0-9_]*)\"");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern UUID_FORM =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final List<String> KENNUNGEN = List.of("box", "datenquelle", "komponente", "messstelle",
            "bezugsgroesse", "bericht");
    private static final List<String> KEIN_NUTZFELD = List.of("ereignis_id", "art", "zeitpunkt", "von",
            "bis", "box", "datenquelle", "komponente", "messkanal", "messstelle", "bezugsgroesse", "bericht");
    private static final String INSERT = "INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, "
            + "art, urheber, von, bis, site_id, kennungen, device_id, data_source_id, entity_id, "
            + "messkanal, messstelle_id, nutzlast, aus_bestand, eingang) "
            + "VALUES (?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?::jsonb,?,COALESCE(?, now())) "
            + "ON CONFLICT DO NOTHING";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate savepoint;
    private final MeterRegistry meters;

    public MessreiheEreignisRepository(JdbcTemplate jdbc, PlatformTransactionManager transactions,
            MeterRegistry meters) {
        this.jdbc = jdbc;
        this.meters = meters;
        // NESTED = a JDBC savepoint inside the caller's transaction (DataSourceTransactionManager);
        // rolling it back leaves the caller's transaction intact and NOT rollback-only.
        this.savepoint = new TransactionTemplate(transactions);
        this.savepoint.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
    }

    public enum Ausgang { ANGEHAENGT, WIEDERHOLUNG, VERWORFEN }

    /** The outcome; {@code grund} is a code of {@link Grund} when VERWORFEN. */
    public record Ergebnis(Ausgang ausgang, String grund, String hinweis) {
        static final Ergebnis ANGEHAENGT = new Ergebnis(Ausgang.ANGEHAENGT, null, null);
        static final Ergebnis WIEDERHOLUNG = new Ergebnis(Ausgang.WIEDERHOLUNG, null, null);

        static Ergebnis verworfen(Urteil u) {
            return new Ergebnis(Ausgang.VERWORFEN, u.grund().code(), u.hinweis());
        }
    }

    // ---- the Bestand mirror ------------------------------------------------------------

    /**
     * Mirrors ONE event the Bestand path just wrote to {@code device_measurement_event}; runs in
     * the caller's transaction ({@code app.tenant_id} already set), inside its own savepoint, and
     * NEVER throws: a failure rolls back to the savepoint, is logged and counted, and the caller
     * goes on. The {@code ereignis_id} is derived from the Bestand idempotency key {@code
     * (device_id, point_key, occurred_at, edge_sequence, event_kind)}, so the same Bestand event
     * always is the same event here (and {@code ON CONFLICT DO NOTHING} keeps it one row).
     * {@code _pipeline} is the Bestand pseudo point of a gap, never a channel.
     */
    void spiegeln(MeasurementRawEvent event, String pointKey, Instant at, String kind,
            ObjectNode nutzlast) {
        try {
            Integer rows = savepoint.execute(status -> {
                boolean luecke = "data_gap".equals(kind);
                UUID ereignisId = UUID.nameUUIDFromBytes(("device_measurement_event|"
                        + event.device_id() + "|" + pointKey + "|" + at + "|" + event.sequence()
                        + "|" + kind).getBytes(StandardCharsets.UTF_8));
                ObjectNode kennungen = JSON.createObjectNode().put("box", event.device_id().toString());
                return jdbc.update(INSERT, Timestamp.from(at), event.tenant_id(), ereignisId, kind,
                        luecke ? Urheber.BOX.code() : Urheber.WRITER.code(), null, null,
                        event.site_id(), kennungen.toString(), event.device_id(), null, null,
                        luecke ? null : pointKey, null, nutzlast.toString(), true,
                        Timestamp.from(event.ingested_at()));
            });
            spiegelZaehler(rows != null && rows > 0 ? "gespiegelt" : "schon_da", "");
        } catch (RuntimeException e) {
            String grund = grund(e);
            log.error("Mirror of Bestand event {} (device {}, point {}, at {}) into "
                    + "messreihe_ereignis failed ({}); rolled back to its savepoint, the Bestand "
                    + "write goes on", kind, event.device_id(), pointKey, at, grund, e);
            spiegelZaehler("fehler", grund);
        }
    }

    /**
     * A bounded label: the refusing constraint of the hypertable (not of the chunk), else the SQL
     * state, else the exception type.
     */
    static String grund(Throwable e) {
        Throwable c = NestedExceptionUtils.getMostSpecificCause(e);
        String text = c.getMessage() == null ? "" : c.getMessage();
        Matcher m = CONSTRAINT.matcher(text);
        if (m.find()) {
            return m.group(1);
        }
        if (c instanceof SQLException sql && sql.getSQLState() != null) {
            return "sqlstate_" + sql.getSQLState();
        }
        return c.getClass().getSimpleName();
    }

    private void spiegelZaehler(String ergebnis, String grund) {
        Counter.builder(SPIEGEL_METRIK)
                .description("Bestand events mirrored into messreihe_ereignis, by outcome")
                .tag("ergebnis", ergebnis)
                .tag("grund", grund)
                .register(meters)
                .increment();
    }

    // ---- an event the writer itself judged (AP-07 IP-7) --------------------------------

    /**
     * Appends ONE report the writer itself produced while judging a measurement (UEMS AP-07 IP-7:
     * {@code sequence_gap}, {@code sequence_reset}, {@code rejected}, {@code unassigned_reader},
     * {@code duplicate_conflict}). It takes the SAME way in as a box report - {@link #anhaengen},
     * so {@link EreignisVokabular} is the gate and the closed vocabulary is the only vocabulary -
     * but inside its OWN SAVEPOINT and it NEVER throws: a refused or failing report is rolled back
     * alone, logged and counted in
     * {@code voltpilot_writer_events_writer_total&#123;ergebnis,grund&#125;}, and the measurement
     * write commits. An event is a statement ABOUT a value; losing the statement must never cost
     * the value.
     */
    void vomWriter(UUID tenantId, UUID siteId, JsonNode ereignis, Instant eingang) {
        String art = ereignis.path("art").asText("");
        try {
            Ergebnis e = savepoint.execute(status ->
                    anhaengen(tenantId, siteId, Urheber.WRITER, ereignis, eingang));
            if (e == null) {
                return;
            }
            writerZaehler(e.ausgang().name().toLowerCase(Locale.ROOT),
                    e.grund() == null ? "" : e.grund());
            if (e.ausgang() == Ausgang.VERWORFEN) {
                log.warn("Writer report {} refused by the vocabulary ({}: {}); the measurement "
                        + "write is untouched", art, e.grund(), e.hinweis());
            }
        } catch (RuntimeException ex) {
            String grund = grund(ex);
            log.error("Writer report {} could not be appended to messreihe_ereignis ({}); rolled "
                    + "back to its savepoint, the measurement write goes on", art, grund, ex);
            writerZaehler("fehler", grund);
        }
    }

    /**
     * Zählt die Meldungen, die die Ableitung erzeugt hat, deren Urheber laut Vokabular aber NICHT
     * der Writer ist ({@code clock_ahead}, {@code too_old}, {@code clock_jump} — sie gehören der
     * Datenannahme). Der Writer meldet sie nie; still verschwinden sollen sie trotzdem nicht.
     */
    void nichtVomWriter(int anzahl) {
        Counter.builder(WRITER_METRIK)
                .description("Reports the writer produced while judging measurements, by outcome")
                .tag("ergebnis", "fremder_urheber")
                .tag("grund", "")
                .register(meters)
                .increment(anzahl);
    }

    private void writerZaehler(String ergebnis, String grund) {
        Counter.builder(WRITER_METRIK)
                .description("Reports the writer produced while judging measurements, by outcome")
                .tag("ergebnis", ergebnis)
                .tag("grund", grund)
                .register(meters)
                .increment();
    }

    // ---- a contract event (events.raw) -------------------------------------------------

    /** Appends ONE contract event of the tenant; {@code eingang} is its arrival time. */
    @Transactional
    public Ergebnis anhaengen(UUID tenantId, UUID siteId, Urheber urheber, JsonNode ereignis,
            Instant eingang) {
        Urteil urteil = EreignisVokabular.pruefe(ereignis, urheber);
        if (!urteil.angenommen()) {
            return Ergebnis.verworfen(urteil);
        }
        jdbc.queryForObject("SELECT set_config('app.tenant_id', ?, true)", String.class,
                tenantId.toString());
        UUID ereignisId = UUID.fromString(ereignis.get("ereignis_id").asText());
        // Reports of one event one after the other: "already there?" and "append" in one go.
        jdbc.queryForList("SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(?, 0))",
                Integer.class, "messreihe_ereignis:" + tenantId + ":" + ereignisId);
        List<Gespeichert> vorher = jdbc.query("SELECT " + SPALTEN + " FROM messreihe_ereignis "
                + "WHERE tenant_id = ? AND ereignis_id = ? AND NOT aus_bestand ORDER BY eingang, zeit",
                MessreiheEreignisRepository::map, tenantId, ereignisId);
        for (Gespeichert g : vorher) {
            if (g.urheber().equals(urheber.code()) && EreignisVokabular.gleich(g.ereignis(), ereignis)) {
                return Ergebnis.WIEDERHOLUNG;
            }
        }
        if (!vorher.isEmpty()) {
            Gespeichert juengste = vorher.get(vorher.size() - 1);
            Urteil f = !juengste.urheber().equals(urheber.code())
                    ? new Urteil(false, Grund.FORTSCHREIBUNG_UNZULAESSIG, "anderer Urheber")
                    : EreignisVokabular.pruefeFortschreibung(juengste.ereignis(), ereignis, urheber);
            if (!f.angenommen()) {
                return Ergebnis.verworfen(f);
            }
        }
        Art art = Art.vonCode(ereignis.get("art").asText());
        boolean zeitraum = art.zeitform() == Zeitform.ZEITRAUM;
        Instant von = zeitraum ? Instant.parse(ereignis.get("von").asText()) : null;
        Instant bis = zeitraum && ereignis.hasNonNull("bis")
                ? Instant.parse(ereignis.get("bis").asText()) : null;
        Instant zeit = zeitraum ? von : Instant.parse(ereignis.get("zeitpunkt").asText());
        ObjectNode kennungen = JSON.createObjectNode();
        ObjectNode nutzlast = JSON.createObjectNode();
        ereignis.fields().forEachRemaining(f -> {
            if (KENNUNGEN.contains(f.getKey())) {
                kennungen.set(f.getKey(), f.getValue());
            } else if (!KEIN_NUTZFELD.contains(f.getKey())) {
                nutzlast.set(f.getKey(), f.getValue());
            }
        });
        int rows = jdbc.update(INSERT, Timestamp.from(zeit), tenantId, ereignisId, art.code(),
                urheber.code(), ts(von), ts(bis), siteId, kennungen.toString(),
                uuidForm(ereignis, "box"), datenquelle(ereignis), uuidForm(ereignis, "komponente"),
                ereignis.path("messkanal").asText(null), messstelle(ereignis), nutzlast.toString(),
                false, ts(eingang));
        return rows > 0 ? Ergebnis.ANGEHAENGT : Ergebnis.WIEDERHOLUNG;
    }

    /**
     * A code resolves only when unambiguous: the UUID form verbatim (the object may be gone by
     * now - events outlive it), {@code DQ-n} via {@code data_source.kennzeichen}, {@code MS-n}
     * via {@code messstelle_kennzeichen}; otherwise the column stays NULL, never guessed.
     */
    private UUID datenquelle(JsonNode e) {
        UUID direkt = uuidForm(e, "datenquelle");
        if (direkt != null || !e.has("datenquelle")) {
            return direkt;
        }
        return jdbc.queryForList("SELECT id FROM data_source WHERE kennzeichen = ?", UUID.class,
                e.get("datenquelle").asText()).stream().findFirst().orElse(null);
    }

    private UUID messstelle(JsonNode e) {
        UUID direkt = uuidForm(e, "messstelle");
        if (direkt != null || !e.has("messstelle")) {
            return direkt;
        }
        return jdbc.queryForList("SELECT messstelle_id FROM messstelle_kennzeichen WHERE kennzeichen = ?",
                UUID.class, e.get("messstelle").asText()).stream().findFirst().orElse(null);
    }

    private static UUID uuidForm(JsonNode e, String feld) {
        String w = e.path(feld).asText("");
        return UUID_FORM.matcher(w).matches() ? UUID.fromString(w) : null;
    }

    private static Timestamp ts(Instant t) {
        return t == null ? null : Timestamp.from(t);
    }

    // ---- a stored row back into the contract form ----------------------------------------

    private static final String SPALTEN = "ereignis_id, art, urheber, zeit, von, bis, "
            + "kennungen::text AS kennungen, messkanal, nutzlast::text AS nutzlast";

    private record Gespeichert(String urheber, JsonNode ereignis) {}

    private static Gespeichert map(ResultSet rs, int n) throws SQLException {
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", rs.getObject("ereignis_id", UUID.class).toString());
        String art = rs.getString("art");
        e.put("art", art);
        if (Art.vonCode(art).zeitform() == Zeitform.ZEITRAUM) {
            e.put("von", rs.getTimestamp("von").toInstant().toString());
            Timestamp bis = rs.getTimestamp("bis");
            if (bis == null) {
                e.putNull("bis");
            } else {
                e.put("bis", bis.toInstant().toString());
            }
        } else {
            e.put("zeitpunkt", rs.getTimestamp("zeit").toInstant().toString());
        }
        try {
            e.setAll((ObjectNode) JSON.readTree(rs.getString("kennungen")));
            if (rs.getString("messkanal") != null) {
                e.put("messkanal", rs.getString("messkanal"));
            }
            e.setAll((ObjectNode) JSON.readTree(rs.getString("nutzlast")));
        } catch (JsonProcessingException ex) {
            throw new SQLException("messreihe_ereignis: unreadable JSON", ex);
        }
        return new Gespeichert(rs.getString("urheber"), e);
    }
}
