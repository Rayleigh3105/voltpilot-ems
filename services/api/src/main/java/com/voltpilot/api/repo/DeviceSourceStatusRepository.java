package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SiteSourceDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The edge-reported per-measurement-point Ist ({@code device_source_status},
 * migration V20260721000000): per (device, source) the latest own reading +
 * freshness, written by {@link com.voltpilot.api.sources.SourceStatusListener}
 * from the heartbeat's {@code sources} block and read by the portal to render
 * the PV breakdown. RLS-scoped like every device-owned table.
 */
@Repository
public class DeviceSourceStatusRepository {

    /** One reported measurement point (the row shape of the heartbeat entry). */
    public record SourceRow(String sourceId, String kind, String role, String label, String brand,
            String model, Double pvKw, Double powerKw, Double loadKw, String health,
            Instant readAt) {}

    private final JdbcTemplate jdbc;

    public DeviceSourceStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Replace the device's whole reported set with one heartbeat's view -
     * wholesale, because the heartbeat carries the COMPLETE Ist: a source the
     * customer removed on the device must disappear here too, and a merge would
     * keep ghosts in the breakdown forever.
     */
    @Transactional
    public void replaceForDevice(UUID deviceId, UUID tenantId, UUID siteId, Instant reportedAt,
            List<SourceRow> rows) {
        jdbc.update("DELETE FROM device_source_status WHERE device_id = ?", deviceId);
        for (SourceRow r : rows) {
            jdbc.update(
                    "INSERT INTO device_source_status (device_id, source_id, tenant_id, site_id, "
                            + "kind, role, label, brand, model, pv_kw, power_kw, load_kw, health, "
                            + "read_at, reported_at) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    deviceId, r.sourceId(), tenantId, siteId, r.kind(), r.role(), r.label(),
                    r.brand(), r.model(), r.pvKw(), r.powerKw(), r.loadKw(), r.health(),
                    r.readAt() == null ? null : Timestamp.from(r.readAt()),
                    Timestamp.from(reportedAt));
        }
    }

    /** Every reported measurement point of a site, primary first, stable order. */
    public List<SiteSourceDto> forSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, source_id, kind, role, label, brand, model, pv_kw, power_kw, "
                        + "load_kw, health, read_at, reported_at FROM device_source_status "
                        + "WHERE site_id = ? "
                        + "ORDER BY (kind <> 'primary'), device_id, source_id",
                DeviceSourceStatusRepository::mapRow, siteId);
    }

    private static SiteSourceDto mapRow(ResultSet rs, int rowNum) throws SQLException {
        Timestamp readAt = rs.getTimestamp("read_at");
        return new SiteSourceDto(
                rs.getObject("device_id", UUID.class),
                rs.getString("source_id"),
                rs.getString("kind"),
                rs.getString("role"),
                rs.getString("label"),
                rs.getString("brand"),
                rs.getString("model"),
                (Double) rs.getObject("pv_kw"),
                (Double) rs.getObject("power_kw"),
                (Double) rs.getObject("load_kw"),
                rs.getString("health"),
                readAt == null ? null : readAt.toInstant(),
                rs.getTimestamp("reported_at").toInstant());
    }
}
