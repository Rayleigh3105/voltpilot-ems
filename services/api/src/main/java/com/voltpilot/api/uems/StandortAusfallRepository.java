package com.voltpilot.api.uems;

import java.sql.Array;
import java.sql.PreparedStatement;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Liest ausschließlich festgehaltene offene {@code data_gap}-Fakten. */
@Repository
public class StandortAusfallRepository {

    private final JdbcTemplate jdbc;

    public StandortAusfallRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Box(UUID id, String name, UUID siteId, Instant seit) {}
    public record Messstelle(UUID id, String kennzeichen, String name, UUID boxId, String box, Instant seit) {}

    public List<Box> boxen(List<UUID> anlagen) {
        if (anlagen.isEmpty()) return List.of();
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement("""
                    WITH juengste AS (
                        SELECT DISTINCT ON (e.ereignis_id) e.ereignis_id, e.site_id, e.device_id,
                               e.data_source_id, e.von, e.bis, e.nutzlast
                          FROM messreihe_ereignis e
                         WHERE e.art = 'data_gap' AND e.site_id = ANY (?)
                         ORDER BY e.ereignis_id, e.eingang DESC, e.zeit DESC)
                    SELECT d.id, coalesce(nullif(d.name, ''), d.external_ref) AS name,
                           d.site_id, j.von
                      FROM juengste j
                      JOIN device d ON d.id = j.device_id AND d.site_id = j.site_id
                     WHERE j.data_source_id IS NULL AND j.bis IS NULL
                       AND j.nutzlast ->> 'fehlerklasse' = 'box_meldet_sich_nicht'
                       AND d.ausgebaut_am IS NULL
                     ORDER BY j.von, d.id
                    """);
            ps.setArray(1, uuidArray(con, anlagen));
            return ps;
        }, (rs, n) -> new Box(rs.getObject("id", UUID.class), rs.getString("name"),
                rs.getObject("site_id", UUID.class), rs.getTimestamp("von").toInstant()));
    }

    public List<Messstelle> messstellen(List<UUID> anlagen) {
        if (anlagen.isEmpty()) return List.of();
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement("""
                    WITH juengste AS (
                        SELECT DISTINCT ON (e.ereignis_id) e.ereignis_id, e.site_id, e.device_id,
                               e.data_source_id, e.von, e.bis, e.nutzlast
                          FROM messreihe_ereignis e
                         WHERE e.art = 'data_gap' AND e.site_id = ANY (?)
                         ORDER BY e.ereignis_id, e.eingang DESC, e.zeit DESC)
                    SELECT DISTINCT m.id, m.kennzeichen, m.name, d.id AS box_id,
                           coalesce(nullif(d.name, ''), d.external_ref) AS box, j.von
                      FROM juengste j
                      JOIN device d ON d.id = j.device_id AND d.site_id = j.site_id
                      JOIN measurement_point p ON p.data_source_id = j.data_source_id
                      JOIN messstelle_quelle q ON q.entity_id = p.id AND q.rolle = 'fuehrend'
                           AND q.gueltig_ab <= now() AND (q.gueltig_bis IS NULL OR q.gueltig_bis > now())
                      JOIN messstelle m ON m.id = q.messstelle_id AND m.archiviert_am IS NULL
                     WHERE j.data_source_id IS NOT NULL AND j.bis IS NULL
                       AND j.nutzlast ->> 'fehlerklasse' = 'box_meldet_sich_nicht'
                       AND d.ausgebaut_am IS NULL
                     ORDER BY m.kennzeichen, j.von, d.id
                    """);
            ps.setArray(1, uuidArray(con, anlagen));
            return ps;
        }, (rs, n) -> new Messstelle(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                rs.getString("name"), rs.getObject("box_id", UUID.class), rs.getString("box"),
                rs.getTimestamp("von").toInstant()));
    }

    public int boxenGesamt(List<UUID> anlagen) {
        if (anlagen.isEmpty()) return 0;
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "SELECT count(*) FROM device WHERE site_id = ANY (?) AND ausgebaut_am IS NULL");
            ps.setArray(1, uuidArray(con, anlagen));
            return ps;
        }, rs -> rs.next() ? rs.getInt(1) : 0);
    }

    private static Array uuidArray(java.sql.Connection con, List<UUID> ids) throws java.sql.SQLException {
        return con.createArrayOf("uuid", ids.toArray(UUID[]::new));
    }
}
