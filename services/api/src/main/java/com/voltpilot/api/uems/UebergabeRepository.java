package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** RLS-Pfad der Ausführung. Planzeiträume und Messwerte werden niemals geändert. */
@Repository
public class UebergabeRepository {
    static final String REVISION_PREFIX = "uems-registry:";
    private final JdbcTemplate jdbc;
    public UebergabeRepository(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public record Stand(UUID quelle, UUID anlage, UUID assignment, UUID leser, UUID ziel,
            String phase, Instant faellig, Instant begonnen, String revision, UUID ereignis) {}
    public record Rueckmeldung(String revision, Instant eingang) {}

    /** Reihenfolge unabhängig von Wanduhr und Rollback; die Box behandelt Revisionen opak. */
    public String naechsteRevision() {
        return REVISION_PREFIX + jdbc.queryForObject("SELECT nextval('data_source_registry_revision_seq')", Long.class);
    }

    public boolean sperren(UUID anlage) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0))", Boolean.class,
                "quellen-uebergabe:" + TenantContext.get() + ":" + anlage));
    }

    public Stand stand(UUID quelle) {
        return jdbc.query("SELECT * FROM data_source_handover WHERE data_source_id=?", (rs, n) ->
                new Stand(quelle, rs.getObject("site_id", UUID.class), rs.getObject("assignment_id", UUID.class),
                        rs.getObject("reader_id", UUID.class), rs.getObject("target_id", UUID.class),
                        rs.getString("phase"), rs.getTimestamp("due_at").toInstant(),
                        rs.getTimestamp("started_at") == null ? null : rs.getTimestamp("started_at").toInstant(),
                        rs.getString("sent_revision"), rs.getObject("event_id", UUID.class)), quelle)
                .stream().findFirst().orElse(null);
    }

    /** Ein Entzug muss COMMITTED sein, bevor ein weiterer Aufruf die Zielbox freigibt. */
    public boolean inDieserTransaktionGeschrieben(UUID quelle) {
        // pg_current_xact_id bleibt auch innerhalb eines SAVEPOINTs die äußere Transaktion.
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT written_xid=pg_current_xact_id() "
                + "FROM data_source_handover WHERE data_source_id=?", Boolean.class, quelle));
    }

    public void speichern(Stand s) {
        jdbc.update("""
                INSERT INTO data_source_handover (tenant_id,data_source_id,site_id,assignment_id,
                    reader_id,target_id,phase,due_at,started_at,sent_revision,event_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (tenant_id,data_source_id) DO UPDATE SET
                    assignment_id=EXCLUDED.assignment_id,reader_id=EXCLUDED.reader_id,
                    target_id=EXCLUDED.target_id,phase=EXCLUDED.phase,due_at=EXCLUDED.due_at,
                    started_at=EXCLUDED.started_at,sent_revision=EXCLUDED.sent_revision,event_id=EXCLUDED.event_id,
                    written_xid=pg_current_xact_id()
                """, TenantContext.get(), s.quelle(), s.anlage(), s.assignment(), s.leser(), s.ziel(),
                s.phase(), ts(s.faellig()), ts(s.begonnen()), s.revision(), s.ereignis());
    }

    /** component_apply ist präziser; ältere Boxen quittieren im Registry-Herzschlag. */
    public Rueckmeldung rueckmeldung(UUID box) {
        return jdbc.query("""
                SELECT CASE WHEN a.device_id IS NOT NULL THEN
                    CASE WHEN a.authority='portal' THEN a.applied_revision END ELSE r.revision END AS revision,
                    r.received_at
                FROM data_source_box_receipt r JOIN device d ON d.id=r.device_id
                LEFT JOIN device_component_apply a ON a.device_id=r.device_id
                WHERE r.device_id=? AND d.ausgebaut_am IS NULL
                """, (rs,n) -> new Rueckmeldung(rs.getString("revision"),
                        rs.getTimestamp("received_at").toInstant()), box).stream().findFirst().orElse(null);
    }

    @org.springframework.transaction.annotation.Transactional(
            propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void herzschlag(UUID tenant, UUID box, String revision, Instant eingang) {
        jdbc.update("""
                INSERT INTO data_source_box_receipt (tenant_id,device_id,revision,received_at) VALUES (?,?,?,?)
                ON CONFLICT (tenant_id,device_id) DO UPDATE SET revision=EXCLUDED.revision,
                    received_at=EXCLUDED.received_at
                """, tenant, box, revision, ts(eingang));
    }

    public List<UUID> boxen(UUID anlage) {
        return jdbc.queryForList("SELECT id FROM device WHERE site_id=? AND ausgebaut_am IS NULL",
                UUID.class, anlage);
    }

    /** Fehlend oder durch RLS unsichtbar ist KEIN Beleg für einen Ausbau. */
    public boolean nachweislichAusgebaut(UUID box) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM device WHERE id=? AND ausgebaut_am IS NOT NULL)",
                Boolean.class, box));
    }
    private static Timestamp ts(Instant t) { return t == null ? null : Timestamp.from(t); }
}
