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
    public record Vorschlag(UUID id, UUID siteId, String name, String zeitzone, LocalDate gueltigAb,
            Instant createdAt, String createdBy) {}

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
        return List.copyOf(jdbc.query("SELECT id, site_id, name, zeitzone, gueltig_ab, created_at, created_by "
                + "FROM standort_vorschlag ORDER BY created_at, id",
                (rs, n) -> new Vorschlag(
                        rs.getObject("id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getString("name"),
                        rs.getString("zeitzone"),
                        rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getTimestamp("created_at").toInstant(),
                        rs.getString("created_by"))));
    }
}
