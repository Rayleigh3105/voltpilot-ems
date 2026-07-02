package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.DeviceDto;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Devices for the current tenant (RLS-scoped, see migration V2). */
@Repository
public class DeviceRepository {

    private final JdbcTemplate jdbc;

    public DeviceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<DeviceDto> findAll() {
        // last_seen = newest telemetry sample per device (RLS-scoped like the
        // device rows themselves); null until the first sample arrives.
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, "
                        + "(SELECT max(t.time) FROM telemetry t WHERE t.device_id = d.id) AS last_seen "
                        + "FROM device d ORDER BY d.created_at",
                DeviceRepository::mapDevice);
    }

    /** The current tenant's device, or empty when RLS hides it (=> 404). */
    public Optional<DeviceDto> findById(UUID deviceId) {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, "
                        + "(SELECT max(t.time) FROM telemetry t WHERE t.device_id = d.id) AS last_seen "
                        + "FROM device d WHERE d.id = ?",
                DeviceRepository::mapDevice, deviceId).stream().findFirst();
    }

    /**
     * The current tenant's device with this external ref, if it has one. RLS
     * hides other tenants' devices, so a hit always means "already claimed by
     * the caller's own account".
     */
    public Optional<DeviceDto> findByExternalRef(String externalRef) {
        return jdbc.query(
                "SELECT d.id, d.site_id, d.external_ref, d.kind, d.name, d.status, t.last_seen "
                        + "FROM device d "
                        + "LEFT JOIN LATERAL (SELECT time AS last_seen FROM telemetry "
                        + "  WHERE device_id = d.id ORDER BY time DESC LIMIT 1) t ON true "
                        + "WHERE d.external_ref = ?",
                DeviceRepository::mapDevice,
                externalRef).stream().findFirst();
    }

    /**
     * Claim a device into a site for the current tenant - a single insert. RLS'
     * WITH CHECK enforces {@code tenant_id = app.tenant_id}; the global unique
     * index on {@code external_ref} makes claiming another tenant's device fail
     * with a duplicate-key error (surfaced as HTTP 409).
     */
    public DeviceDto claim(UUID tenantId, UUID siteId, String externalRef, String kind) {
        return jdbc.queryForObject(
                "INSERT INTO device (tenant_id, site_id, external_ref, kind, status) "
                        + "VALUES (?, ?, ?, ?, 'claimed') "
                        + "RETURNING id, site_id, external_ref, kind, name, status, "
                        + "NULL::timestamptz AS last_seen",
                DeviceRepository::mapDevice,
                tenantId, siteId, externalRef, kind == null || kind.isBlank() ? "inverter" : kind);
    }

    /**
     * Update the editable device fields (kind + label). The external_ref is the
     * device's identity and deliberately NOT updatable. Returns the updated
     * device, or empty when RLS hides it (=> 404).
     */
    public Optional<DeviceDto> update(UUID deviceId, String kind, String name) {
        return jdbc.query(
                "UPDATE device SET kind = ?, name = ? WHERE id = ? "
                        + "RETURNING id, site_id, external_ref, kind, name, status, "
                        + "(SELECT max(t.time) FROM telemetry t WHERE t.device_id = device.id) AS last_seen",
                DeviceRepository::mapDevice, kind, name, deviceId).stream().findFirst();
    }

    /** Delete (unclaim) a device row. False when RLS hides it (=> 404). */
    public boolean delete(UUID deviceId) {
        return jdbc.update("DELETE FROM device WHERE id = ?", deviceId) > 0;
    }

    /** Devices at a site (for the site-delete guard/preview), RLS-scoped. */
    public int countForSite(UUID siteId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM device WHERE site_id = ?", Integer.class, siteId);
        return count == null ? 0 : count;
    }

    private static DeviceDto mapDevice(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        java.sql.Timestamp lastSeen = rs.getTimestamp("last_seen");
        return new DeviceDto(
                rs.getObject("id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("external_ref"),
                rs.getString("kind"),
                rs.getString("name"),
                rs.getString("status"),
                lastSeen == null ? null : lastSeen.toInstant());
    }
}
