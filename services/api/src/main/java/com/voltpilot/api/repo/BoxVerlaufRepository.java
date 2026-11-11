package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Verlauf EINER Box (Geräte &amp; Updates G3): was das Portal angefragt hat
 * ({@code rollout_event}, nach Gerät indiziert) und was die Box gemeldet hat
 * ({@code box_update_verlauf}, vom Trigger auf {@code device_update_status}
 * angehängt). Neueste zuerst.
 *
 * <p>Liest über die BYPASSRLS-Rolle wie {@link RolloutRepository} - erreichbar
 * nur aus der Plattform-Route. Rein lesend; geschrieben wird der Box-Teil allein
 * vom Trigger (Migration V20261105220000), der Portal-Teil von
 * {@link RolloutRepository#appendEvent}.
 */
@Repository
public class BoxVerlaufRepository {

    /** Die Portal-Ereignisse, die zu EINER Box gehören (nicht der abgeleitete Zustand). */
    private static final String PORTAL_EREIGNISSE =
            "'target_assigned', 'target_reverted', 'target_republished', 'target_cleared_on_unclaim'";

    private final JdbcTemplate jdbc;

    public BoxVerlaufRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /**
     * Eine rohe Zeile: {@code quelle = portal} ({@code art} = das Journal-Ereignis,
     * {@code wert} = sein Detail, {@code von} = Akteur) oder {@code quelle = box}
     * ({@code art} = stand | urteil | zustand mit wert/vorher/ziel/grund).
     */
    public record Zeile(Instant am, String quelle, String art, String wert, String vorher,
            String ziel, String grund, String von, UUID rolloutId) {
    }

    /** Die jüngsten {@code limit} Einträge einer Box, neueste zuerst. */
    public List<Zeile> verlauf(UUID deviceId, int limit) {
        return jdbc.query("SELECT am, quelle, art, wert, vorher, ziel, grund, von, rollout_id FROM ("
                        + "SELECT at AS am, 'portal' AS quelle, event AS art, detail AS wert, "
                        + "NULL::text AS vorher, NULL::text AS ziel, NULL::text AS grund, actor AS von, "
                        + "rollout_id FROM rollout_event WHERE device_id = ? AND event IN ("
                        + PORTAL_EREIGNISSE + ") "
                        + "UNION ALL "
                        + "SELECT am, 'box', art, wert, vorher, ziel, grund, NULL::text, NULL::uuid "
                        + "FROM box_update_verlauf WHERE device_id = ?"
                        + ") v ORDER BY am DESC LIMIT ?",
                BoxVerlaufRepository::map, deviceId, deviceId, limit);
    }

    private static Zeile map(ResultSet rs, int n) throws SQLException {
        return new Zeile(rs.getTimestamp("am").toInstant(), rs.getString("quelle"),
                rs.getString("art"), rs.getString("wert"), rs.getString("vorher"),
                rs.getString("ziel"), rs.getString("grund"), rs.getString("von"),
                rs.getObject("rollout_id", UUID.class));
    }
}
