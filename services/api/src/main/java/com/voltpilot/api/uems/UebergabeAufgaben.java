package com.voltpilot.api.uems;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Getrennte Verwaltungsverbindung: ausschließlich Arbeitsadressen, Ausführung danach unter RLS. */
@Repository
public class UebergabeAufgaben {
    public record Anlage(UUID tenant, UUID site) {}
    private final JdbcTemplate admin;
    public UebergabeAufgaben(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) { this.admin = admin; }

    public List<Anlage> faellig(Instant jetzt) {
        return admin.query("""
                SELECT DISTINCT q.tenant_id, q.site_id
                FROM data_source q JOIN data_source_assignment a ON a.data_source_id=q.id
                LEFT JOIN data_source_handover h ON h.tenant_id=q.tenant_id AND h.data_source_id=q.id
                WHERE q.archiviert_am IS NULL AND a.zurueckgenommen_am IS NULL AND a.effective_from<=?
                  AND (a.effective_to IS NULL OR a.effective_to>?)
                  AND (h.assignment_id IS DISTINCT FROM a.id OR h.phase<>'active')
                  AND EXISTS (SELECT 1 FROM measurement_point m WHERE m.data_source_id=q.id
                      AND m.entity_type IS NOT NULL)
                ORDER BY q.tenant_id,q.site_id
                """, (rs,n) -> new Anlage(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)),
                Timestamp.from(jetzt), Timestamp.from(jetzt));
    }
}
