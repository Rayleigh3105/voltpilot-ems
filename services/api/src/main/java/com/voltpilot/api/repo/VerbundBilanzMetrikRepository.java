package com.voltpilot.api.repo;

import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Stand der Verbund-Bilanz je Anlage für die Metrik (AP-15 IP-12) — über die BYPASSRLS-Admin-Rolle, weil der
 * Sammler keinen Kundenbereich hat (Muster {@link BoxMetrikRepository}; unter RLS zählte er null und meldete Ruhe).
 * Nur Anlagen mit einer Gemeinsamen Steuerung, die JETZT Mitglieder hat, und mit mindestens einem gerechneten Tag;
 * eine aufgelöste Gemeinsame Steuerung meldet ihren letzten Tag nicht mehr.
 */
@Repository
public class VerbundBilanzMetrikRepository {

    /** Das jüngste Ergebnis einer Anlage. */
    public record Stand(UUID tenantId, UUID siteId, String zustand) {}

    private final JdbcTemplate admin;

    public VerbundBilanzMetrikRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    public List<Stand> staende() {
        return admin.query("SELECT DISTINCT ON (b.steuerungsverbund_id) b.tenant_id, b.site_id, b.zustand "
                + "FROM steuerungsverbund_bilanz b WHERE EXISTS (SELECT 1 FROM steuerungsverbund_mitglied m "
                + "WHERE m.steuerungsverbund_id = b.steuerungsverbund_id AND m.aufgehoben_am IS NULL "
                + "AND m.gueltig_ab <= now() AND (m.gueltig_bis IS NULL OR m.gueltig_bis > now())) "
                + "ORDER BY b.steuerungsverbund_id, b.tag DESC",
                (rs, n) -> new Stand(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3)));
    }
}
