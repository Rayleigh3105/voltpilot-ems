package com.voltpilot.api.entities;

import com.voltpilot.api.entities.WechselrichterUntergrenze.Lesung;
import com.voltpilot.api.entities.WechselrichterUntergrenze.Stand;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die übernommene Entladegrenze des Wechselrichters je Anlage ({@code wechselrichter_untergrenze}, V20261109090000)
 * und die Lesungen der Box, aus denen sie kommt ({@code device_measurement_sample}). Mandantenbezogen: der
 * {@code @Primary}-{@link JdbcTemplate} läuft unter der Zeilensicherheit des gesetzten Mandanten.
 */
@Repository
public class WechselrichterUntergrenzeRepository {

    /** Eine gespeicherte Zeile, wie die Anzeige sie braucht. */
    public record Eintrag(UUID entityId, UUID deviceId, String pointKey, Stand stand, Instant letzteLesungAm,
            BigDecimal letzteLesungPct, String letzteLesungVerworfen) {}

    private final JdbcTemplate jdbc;

    public WechselrichterUntergrenzeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Zeile der Anlage, oder null, wenn nie etwas übernommen wurde. */
    public Eintrag eintrag(UUID siteId) {
        List<Eintrag> rows = jdbc.query("""
                SELECT entity_id, device_id, point_key, soc_min_pct, gelesen_am, seit,
                       letzte_lesung_am, letzte_lesung_pct, letzte_lesung_verworfen
                  FROM wechselrichter_untergrenze WHERE site_id = ?
                """, (rs, n) -> new Eintrag(rs.getObject("entity_id", UUID.class),
                rs.getObject("device_id", UUID.class), rs.getString("point_key"),
                new Stand(rs.getBigDecimal("soc_min_pct"), instant(rs.getTimestamp("gelesen_am")),
                        instant(rs.getTimestamp("seit"))),
                instant(rs.getTimestamp("letzte_lesung_am")), rs.getBigDecimal("letzte_lesung_pct"),
                rs.getString("letzte_lesung_verworfen")), siteId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Schreibt den Stand der Anlage (eine Zeile je Anlage) samt der jüngsten Lesung und ihrem Verwurfsgrund. */
    public void speichern(UUID tenantId, UUID siteId, UUID entityId, UUID deviceId, String pointKey, Stand stand,
            Lesung juengste, String verworfen) {
        jdbc.update("""
                INSERT INTO wechselrichter_untergrenze (site_id, tenant_id, entity_id, device_id, point_key,
                       soc_min_pct, gelesen_am, seit, letzte_lesung_am, letzte_lesung_pct, letzte_lesung_verworfen,
                       aktualisiert_am)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
                ON CONFLICT (site_id) DO UPDATE SET
                       entity_id = EXCLUDED.entity_id, device_id = EXCLUDED.device_id,
                       point_key = EXCLUDED.point_key, soc_min_pct = EXCLUDED.soc_min_pct,
                       gelesen_am = EXCLUDED.gelesen_am, seit = EXCLUDED.seit,
                       letzte_lesung_am = EXCLUDED.letzte_lesung_am,
                       letzte_lesung_pct = EXCLUDED.letzte_lesung_pct,
                       letzte_lesung_verworfen = EXCLUDED.letzte_lesung_verworfen,
                       aktualisiert_am = now()
                """, siteId, tenantId, entityId, deviceId, pointKey, stand.socMinPct(),
                Timestamp.from(stand.gelesenAm()), Timestamp.from(stand.seit()),
                juengste == null ? null : ts(juengste.zeit()), juengste == null ? null : juengste.pct(),
                verworfen);
    }

    /**
     * Die jüngsten Lesungen eines Punkts dieser Box für die Komponente, jüngste zuerst. Eine Lesung ohne
     * Komponente zählt mit: die Box nennt sie nur bei einem geteilten Punkt, und der Abgleich nimmt nur Anlagen mit
     * genau einem Deye-Speicher an dieser Box.
     */
    public List<Lesung> juengsteLesungen(UUID tenantId, UUID deviceId, UUID entityId, String pointKey, Instant ab,
            int hoechstens) {
        return jdbc.query("""
                SELECT time, coalesce(decoded_numeric, raw_numeric) AS pct, quality
                  FROM device_measurement_sample
                 WHERE tenant_id = ? AND device_id = ? AND point_key = ?
                   AND (entity_id IS NULL OR entity_id = ?)
                   AND role IS DISTINCT FROM 'spiegel'
                   AND time >= ?
                 ORDER BY time DESC
                 LIMIT ?
                """, (rs, n) -> new Lesung(instant(rs.getTimestamp("time")), rs.getBigDecimal("pct"),
                rs.getString("quality")), tenantId, deviceId, pointKey, entityId, Timestamp.from(ab), hoechstens);
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }
}
