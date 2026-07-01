package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.DeviceDto;
import java.util.List;
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
        return jdbc.query(
                "SELECT id, site_id, external_ref, kind, status FROM device ORDER BY created_at",
                DeviceRepository::mapDevice);
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
                        + "RETURNING id, site_id, external_ref, kind, status",
                DeviceRepository::mapDevice,
                tenantId, siteId, externalRef, kind == null || kind.isBlank() ? "inverter" : kind);
    }

    private static DeviceDto mapDevice(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new DeviceDto(
                rs.getObject("id", UUID.class),
                rs.getObject("site_id", UUID.class),
                rs.getString("external_ref"),
                rs.getString("kind"),
                rs.getString("status"));
    }
}
