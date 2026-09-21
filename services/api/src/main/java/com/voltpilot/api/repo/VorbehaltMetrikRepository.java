package com.voltpilot.api.repo;

import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die selbsttätigen Erhöhungen des Vorbehalts je Anlage für den Zähler (AP-15 IP-13) — über die BYPASSRLS-Admin-Rolle
 * wie {@link VerbundBilanzMetrikRepository}. Jede Anlage mit einer Gemeinsamen Steuerung, die JETZT Mitglieder hat,
 * bekommt eine Reihe, auch mit 0 — sonst sähe {@code increase()} die erste Erhöhung nicht.
 */
@Repository
public class VorbehaltMetrikRepository {

    /** Die Zahl der Erhöhungen einer Anlage seit Beginn (nur anhängen: sie fällt nie). */
    public record Stand(UUID tenantId, UUID siteId, long erhoeht) {}

    private final JdbcTemplate admin;

    public VorbehaltMetrikRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    public List<Stand> staende() {
        return admin.query("SELECT v.tenant_id, v.site_id, (SELECT count(*) FROM steuerungsverbund_vorbehalt z "
                + "WHERE z.steuerungsverbund_id = v.id AND z.art = 'erhoeht') FROM steuerungsverbund v "
                + "WHERE EXISTS (SELECT 1 FROM steuerungsverbund_mitglied m WHERE m.steuerungsverbund_id = v.id "
                + "AND m.aufgehoben_am IS NULL AND m.gueltig_ab <= now() "
                + "AND (m.gueltig_bis IS NULL OR m.gueltig_bis > now())) ORDER BY v.tenant_id, v.site_id",
                (rs, n) -> new Stand(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getLong(3)));
    }
}
