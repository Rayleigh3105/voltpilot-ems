package com.voltpilot.api.repo;

import com.voltpilot.api.repo.AdminFleetRepository.EdgeVersionRow;
import com.voltpilot.api.repo.AdminFleetRepository.UpdateStatusRow;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Der Geräte-Teil der Geräteakte in EINER Abfrage (Lücke L3, Adminview-Konzept
 * Abschnitt 3.4/4.4): dieselbe Form wie {@link AdminFleetRepository#boxes()},
 * nur auf GENAU eine Box eingeschränkt und um Mandant/Anlage, LAN-Adresse und
 * den Zertifikats-Stand erweitert - die Felder, die {@code AdminGeraeteAkteController}
 * zu EINER Antwort zusammenführt, statt dass die Akte sechs Listen laden
 * müsste.
 *
 * <p>RLS-Umgehung wie überall in diesem Paket: BYPASSRLS-Rolle
 * {@code voltpilot_admin}, erreichbar ausschließlich aus einem
 * {@code @PreAuthorize("hasRole('platform-admin')")}-Endpunkt. Read-only.
 */
@Repository
public class AdminGeraeteAkteRepository {

    private final JdbcTemplate jdbc;

    public AdminGeraeteAkteRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    /** Die Box, wie geklaimed - {@code null}-Felder, wenn die Box nie geklaimed wurde. */
    public record AkteBoxRow(UUID deviceId, String externalRef, String name, UUID siteId,
            String siteName, UUID tenantId, String tenantName, Instant herzschlagAm,
            Instant messwertAm, Instant lastSeenAt, String lanHost, Instant lanSeenAt,
            EdgeVersionRow edge, UpdateStatusRow update, List<String> supports,
            Instant ausgebautAm) {
    }

    public Optional<AkteBoxRow> box(String externalRef) {
        return jdbc.query("""
                SELECT d.id AS device_id, d.external_ref, d.name, d.site_id, s.name AS site_name,
                       t.id AS tenant_id, t.name AS tenant_name, d.supports, d.ausgebaut_am,
                       d.device_status_seen_at AS herzschlag_am,
                       telemetry.last_seen AS messwert_am,
                       coalesce(d.device_status_seen_at, telemetry.last_seen) AS last_seen,
                       d.lan_host, d.lan_seen_at,
                       edge.core_version, edge.palette_version, edge.reported_at AS edge_reported_at,
                       update.version, update.backend, update.current_version,
                       update.target_version, update.state, update.reason,
                       update.last_known_good, update.reported_at AS update_reported_at
                  FROM device d
                  JOIN site s ON s.id = d.site_id
                  JOIN tenant t ON t.id = s.tenant_id
                  LEFT JOIN LATERAL (
                       SELECT max(tl.received_at) AS last_seen
                         FROM telemetry tl WHERE tl.device_id = d.id
                  ) telemetry ON true
                  LEFT JOIN LATERAL (
                       SELECT e.core_version, e.palette_version, e.reported_at
                         FROM device_edge_version e WHERE e.device_id = d.id
                        ORDER BY e.reported_at DESC LIMIT 1
                  ) edge ON true
                  LEFT JOIN LATERAL (
                       SELECT u.version, u.backend, u.current_version, u.target_version,
                              u.state, u.reason, u.last_known_good, u.reported_at
                         FROM device_update_status u WHERE u.device_id = d.id
                        ORDER BY u.reported_at DESC LIMIT 1
                  ) update ON true
                 WHERE d.external_ref = ?
                """, AdminGeraeteAkteRepository::map, externalRef).stream().findFirst();
    }

    private static AkteBoxRow map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp lastSeen = rs.getTimestamp("last_seen");
        Timestamp herzschlagAm = rs.getTimestamp("herzschlag_am");
        Timestamp messwertAm = rs.getTimestamp("messwert_am");
        Timestamp edgeReported = rs.getTimestamp("edge_reported_at");
        Timestamp updateReported = rs.getTimestamp("update_reported_at");
        Timestamp lanSeenAt = rs.getTimestamp("lan_seen_at");
        Timestamp ausgebautAm = rs.getTimestamp("ausgebaut_am");
        return new AkteBoxRow(
                rs.getObject("device_id", UUID.class),
                rs.getString("external_ref"),
                rs.getString("name"),
                rs.getObject("site_id", UUID.class),
                rs.getString("site_name"),
                rs.getObject("tenant_id", UUID.class),
                rs.getString("tenant_name"),
                herzschlagAm == null ? null : herzschlagAm.toInstant(),
                messwertAm == null ? null : messwertAm.toInstant(),
                lastSeen == null ? null : lastSeen.toInstant(),
                rs.getString("lan_host"),
                lanSeenAt == null ? null : lanSeenAt.toInstant(),
                edgeReported == null ? null : new EdgeVersionRow(
                        rs.getString("core_version"), rs.getString("palette_version"),
                        edgeReported.toInstant()),
                updateReported == null ? null : new UpdateStatusRow(
                        rs.getString("version"), rs.getString("backend"),
                        rs.getString("current_version"), rs.getString("target_version"),
                        rs.getString("state"), rs.getString("reason"),
                        rs.getString("last_known_good"), updateReported.toInstant()),
                com.voltpilot.api.uems.EdgeSupports.fromJson(rs.getString("supports")),
                ausgebautAm == null ? null : ausgebautAm.toInstant());
    }
}
