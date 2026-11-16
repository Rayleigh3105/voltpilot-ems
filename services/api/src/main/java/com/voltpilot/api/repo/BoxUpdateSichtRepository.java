package com.voltpilot.api.repo;

import com.voltpilot.api.ota.BoxUpdateSicht;
import com.voltpilot.api.ota.Erstverbindung;
import com.voltpilot.api.ota.RolloutStates;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das Update der EIGENEN Box für Kunde und Installateur (Erstverbindung S2,
 * {@code ota.BoxUpdateSicht}).
 *
 * <p>Auf der App-Rolle mit dem Mandanten der Sitzung, nach dem Muster
 * {@code AnmeldungDto}: Die Gerätezeile und {@code device_update_status} sind
 * mandantengeprüft (RLS); nur über DIESE Zeile werden die mandantenfreien
 * Update-Tabellen ({@code device_update_target}, {@code rollout_event}) nach
 * ihrer eigenen Box gefragt. Eine fremde Box liefert keine Zeile. Gelesen wird
 * nur, was die Sicht braucht: Fassung, Urheber und Zeit der Zuweisung und das
 * letzte Wort der Automatik - kein Manifest, kein Grund aus dem Betrieb.
 */
@Repository
public class BoxUpdateSichtRepository {

    private final JdbcTemplate jdbc;

    public BoxUpdateSichtRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die Rohdaten der Sicht einer Box.
     *
     * @param zielRelease      Fassung der Zuweisung ({@code null} = keine)
     * @param automatik        letztes Ereignis der Automatik ohne die Zuweisung selbst
     * @param automatikRelease seine Fassung (bei „aktuell")
     */
    public record Zeile(UUID siteId, String zielRelease, String zielVon, Instant zielAm, String automatik,
            String automatikRelease, Instant ersteMeldung, RolloutStates.Reported gemeldet, Instant laeuftSeit) {

        /** Die Sicht dieser Box zum Zeitpunkt {@code now} ({@link BoxUpdateSicht}). */
        public BoxUpdateSicht.Sicht sicht(Instant now) {
            return BoxUpdateSicht.of(zielRelease == null ? null
                            : new BoxUpdateSicht.Ziel(zielRelease, zielVon, zielAm),
                    automatik, automatikRelease, ersteMeldung, gemeldet, laeuftSeit, now);
        }
    }

    public Optional<Zeile> zeile(UUID deviceId) {
        return jdbc.query("""
                SELECT d.site_id, d.device_status_seen_at,
                       u.version, u.current_version, u.target_version, u.state, u.target_verdict,
                       u.reason, u.blocker, u.reported_at, u.current_since, u.erste_meldung_am,
                       t.release_version, t.assigned_by, t.assigned_at,
                       a.event AS automatik, a.detail AS automatik_detail
                  FROM device d
                  LEFT JOIN device_update_status u ON u.device_id = d.id
                  LEFT JOIN device_update_target t ON t.device_id = d.id
                  LEFT JOIN LATERAL (SELECT e.event, e.detail FROM rollout_event e
                                      WHERE e.device_id = d.id AND e.actor = ?
                                        AND e.event IN (?, ?, ?, ?)
                                      ORDER BY e.id DESC LIMIT 1) a ON true
                 WHERE d.id = ? AND d.ausgebaut_am IS NULL
                """, BoxUpdateSichtRepository::map, Erstverbindung.URHEBER, Erstverbindung.EREIGNIS_AKTUELL,
                Erstverbindung.EREIGNIS_GESPERRT, Erstverbindung.EREIGNIS_AUS, Erstverbindung.EREIGNIS_AUFGEGEBEN,
                deviceId).stream().findFirst();
    }

    private static Zeile map(ResultSet rs, int n) throws SQLException {
        Instant reportedAt = instant(rs, "reported_at");
        RolloutStates.Reported gemeldet = reportedAt == null ? null : new RolloutStates.Reported(
                rs.getString("version"), rs.getString("current_version"), rs.getString("target_version"),
                rs.getString("state"), rs.getString("target_verdict"), rs.getString("reason"),
                rs.getString("blocker"), reportedAt, instant(rs, "device_status_seen_at"));
        return new Zeile(rs.getObject("site_id", UUID.class), rs.getString("release_version"),
                rs.getString("assigned_by"), instant(rs, "assigned_at"), rs.getString("automatik"),
                rs.getString("automatik_detail"), instant(rs, "erste_meldung_am"), gemeldet,
                instant(rs, "current_since"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
