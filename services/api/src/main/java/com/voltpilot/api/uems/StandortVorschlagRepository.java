package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die VORSCHLAGSZEILEN der Bestandsübernahme ({@code standort_vorschlag}, Migration
 * V20260911290000), unter RLS: je Anlage eines Kundenbereichs mit mehreren Anlagen ein
 * Vorschlag „ein Standort gleichen Namens, Zuordnung ab dem Tag des Anlegens" (AP-02 E5).
 *
 * <p>Ein Vorschlag ist keine Zuordnung und ändert die Ortsstruktur nicht: kein Protokoll,
 * und mit seiner Anlage geht er (Fremdschlüssel CASCADE). Die App-Rolle liest und legt an;
 * was die Vorschau mit ihm tut (bestätigen, zusammenlegen, umbenennen), bringt IP-10.
 */
@Repository
public class StandortVorschlagRepository {

    private final JdbcTemplate jdbc;

    public StandortVorschlagRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** {@code createdBy} {@code null} = VoltPilot selbst (die Bestandsübernahme). */
    public record Vorschlag(UUID id, UUID siteId, String siteName, String name, String zeitzone,
            LocalDate gueltigAb, Instant createdAt, String createdBy) {}

    /**
     * Legt den Vorschlag einer Anlage an — {@code false}, wenn sie schon einen hat (ein
     * erneuter Lauf schreibt keinen doppelt und überschreibt keinen).
     */
    public boolean anlegen(UUID tenantId, UUID siteId, String name, String zeitzone, LocalDate gueltigAb) {
        return jdbc.update("INSERT INTO standort_vorschlag (tenant_id, site_id, name, zeitzone, gueltig_ab) "
                + "VALUES (?,?,?,?,?) ON CONFLICT (tenant_id, site_id) DO NOTHING",
                tenantId, siteId, name, zeitzone, gueltigAb) == 1;
    }

    /** Alle Vorschläge des Mandanten, in der Reihenfolge des Schreibens. */
    public List<Vorschlag> alle() {
        return List.copyOf(jdbc.query("SELECT v.id, v.site_id, s.name AS site_name, v.name, v.zeitzone, "
                + "v.gueltig_ab, v.created_at, v.created_by FROM standort_vorschlag v "
                + "JOIN site s ON s.id = v.site_id AND s.tenant_id = v.tenant_id ORDER BY v.created_at, v.id",
                (rs, n) -> new Vorschlag(
                        rs.getObject("id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getString("site_name"),
                        rs.getString("name"),
                        rs.getString("zeitzone"),
                        rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getTimestamp("created_at").toInstant(),
                        rs.getString("created_by"))));
    }

    /** Entfernt genau die bestätigten Vorschläge; {@code false} bedeutet: Vorschau war veraltet. */
    public boolean entfernen(List<UUID> ids) {
        if (ids.isEmpty()) return true;
        String marker = String.join(",", java.util.Collections.nCopies(ids.size(), "?"));
        return jdbc.update("DELETE FROM standort_vorschlag WHERE id IN (" + marker + ")", ids.toArray())
                == ids.size();
    }
}
