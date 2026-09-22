package com.voltpilot.api.uems;

import java.sql.Date;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Ergänzende reine Lesedaten für IP-13: sichtbarer Ort und Quellenlücke einer Messstelle. */
@Repository
public class BewertungMessabdeckungRepository {
    public record Info(UUID id, String ortArt, UUID ortId, String ort, LocalDate seit,
            boolean ohneDatenquelle) {}

    private final JdbcTemplate jdbc;

    public BewertungMessabdeckungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Map<UUID, Info> infos(Set<UUID> ids, LocalDate von, LocalDate bis) {
        Map<UUID, Info> aus = new LinkedHashMap<>();
        for (UUID id : ids) {
            var zeile = jdbc.query("""
                    SELECT m.id, o.ziel_art, o.ziel_id, o.ort, o.gueltig_ab,
                      NOT EXISTS (
                        SELECT 1 FROM messstelle_quelle q
                        WHERE q.messstelle_id=m.id AND q.rolle='fuehrend'
                          AND q.gueltig_ab < (?::date + 1)
                          AND (q.gueltig_bis IS NULL OR q.gueltig_bis >= ?::date)
                      ) AS ohne_quelle
                    FROM messstelle m
                    LEFT JOIN LATERAL (
                      SELECT CASE WHEN mo.ort_id IS NOT NULL THEN ort.art
                                  WHEN mo.standort_id IS NOT NULL THEN 'standort'
                                  ELSE 'unternehmen' END AS ziel_art,
                             coalesce(mo.ort_id,mo.standort_id,mo.unternehmen_id) AS ziel_id,
                             CASE WHEN mo.ort_id IS NOT NULL THEN concat_ws(' ',ort.kurzzeichen,ort.name)
                                  WHEN mo.standort_id IS NOT NULL THEN concat_ws(' ',s.kurzzeichen,s.name)
                                  ELSE 'Unternehmen' END AS ort,
                             mo.gueltig_ab
                      FROM messstelle_ort mo
                      LEFT JOIN ort ON ort.id=mo.ort_id AND ort.tenant_id=mo.tenant_id
                      LEFT JOIN standort s ON s.id=mo.standort_id AND s.tenant_id=mo.tenant_id
                      WHERE mo.messstelle_id=m.id AND mo.aufgehoben_am IS NULL
                      ORDER BY CASE WHEN daterange(mo.gueltig_ab,mo.gueltig_bis,'[]') @> ?::date THEN 0
                                    WHEN mo.gueltig_ab > ?::date THEN 1 ELSE 2 END,
                               CASE WHEN mo.gueltig_ab > ?::date THEN mo.gueltig_ab END,
                               mo.gueltig_ab DESC LIMIT 1
                    ) o ON true
                    WHERE m.id=?
                    """, (rs, n) -> new Info(rs.getObject("id", UUID.class), rs.getString("ziel_art"),
                            rs.getObject("ziel_id", UUID.class), rs.getString("ort"),
                            rs.getObject("gueltig_ab", LocalDate.class), rs.getBoolean("ohne_quelle")),
                    Date.valueOf(bis), Date.valueOf(von), Date.valueOf(bis), Date.valueOf(bis),
                    Date.valueOf(bis), id);
            if (!zeile.isEmpty()) aus.put(id, zeile.getFirst());
        }
        return Map.copyOf(aus);
    }
}
