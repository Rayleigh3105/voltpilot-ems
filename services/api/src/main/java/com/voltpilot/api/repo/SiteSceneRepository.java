package com.voltpilot.api.repo;

import java.sql.Array;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die laufende Szene einer Anlage (Migration V20260929120000): welches Wort
 * und welche Geräte DIESE Szene pausiert hat. Höchstens eine Zeile je Anlage.
 *
 * <p>RLS-gefenced über den {@code @Primary} mandantenbezogenen
 * {@link JdbcTemplate} wie jedes Kunden-Repository; {@code tenant_id} kommt
 * aus der RLS-Sitzung, nie aus dem Aufruf.
 */
@Repository
public class SiteSceneRepository {

    public record Row(String key, List<UUID> pausiert, Instant seit, String von) {}

    private final JdbcTemplate jdbc;

    public SiteSceneRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public Row find(UUID siteId) {
        List<Row> rows = new ArrayList<>();
        jdbc.query("SELECT scene_key, paused_entity_ids, started_at, started_by "
                + "FROM site_scene WHERE site_id = ?", rs -> {
                    rows.add(new Row(rs.getString("scene_key"), uuids(rs.getArray("paused_entity_ids")),
                            instant(rs.getTimestamp("started_at")), rs.getString("started_by")));
                }, siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Die Szene setzen (eine laufende wird ersetzt). */
    public void upsert(UUID siteId, String key, List<UUID> pausiert, String by) {
        jdbc.update("INSERT INTO site_scene "
                + "(site_id, scene_key, paused_entity_ids, started_at, started_by, tenant_id) "
                + "VALUES (?, ?, ?::uuid[], now(), ?, "
                + "NULLIF(current_setting('app.tenant_id', true), '')::uuid) "
                + "ON CONFLICT (site_id) DO UPDATE SET scene_key = EXCLUDED.scene_key, "
                + "paused_entity_ids = EXCLUDED.paused_entity_ids, started_at = now(), "
                + "started_by = EXCLUDED.started_by",
                siteId, key, feld(pausiert), by);
    }

    /** Nur die Geräte nachführen, die noch pausiert sind (Beenden mit Rest). */
    public void setzePausiert(UUID siteId, List<UUID> pausiert) {
        jdbc.update("UPDATE site_scene SET paused_entity_ids = ?::uuid[] WHERE site_id = ?",
                feld(pausiert), siteId);
    }

    public void delete(UUID siteId) {
        jdbc.update("DELETE FROM site_scene WHERE site_id = ?", siteId);
    }

    /** Als Postgres-Feldliteral: `{a,b}` - UUIDs brauchen keine Maskierung. */
    private static String feld(List<UUID> ids) {
        StringBuilder sb = new StringBuilder("{");
        for (int i = 0; i < ids.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(ids.get(i));
        }
        return sb.append('}').toString();
    }

    private static List<UUID> uuids(Array a) throws java.sql.SQLException {
        if (a == null) {
            return List.of();
        }
        List<UUID> out = new ArrayList<>();
        for (Object o : (Object[]) a.getArray()) {
            out.add(o instanceof UUID u ? u : UUID.fromString(String.valueOf(o)));
        }
        return out;
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
