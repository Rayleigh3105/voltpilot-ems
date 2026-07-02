package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.TenantDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Tenant CRUD for the platform-admin API.
 *
 * <p>Unlike the customer repositories (which use the tenant-scoped
 * {@code voltpilot_app} datasource and rely on RLS), this repository uses the
 * dedicated {@code adminJdbcTemplate} bound to the {@code voltpilot_admin}
 * BYPASSRLS role - so a Portal-Admin can list and create tenants across the
 * whole platform. This is the ONLY cross-tenant data path and it is reached only
 * from {@code @PreAuthorize("hasRole('platform-admin')")} endpoints.
 */
@Repository
public class TenantRepository {

    private final JdbcTemplate jdbc;

    public TenantRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<TenantDto> findAll() {
        return jdbc.query(
                "SELECT id, name, segment, plan, created_at FROM tenant ORDER BY created_at",
                TenantRepository::map);
    }

    public TenantDto create(String name, String segment) {
        return jdbc.queryForObject(
                "INSERT INTO tenant (name, segment) VALUES (?, ?) "
                        + "RETURNING id, name, segment, plan, created_at",
                TenantRepository::map, name, segment);
    }

    /**
     * Delete a tenant row. Used only to compensate a failed self-registration
     * (the tenant was just created and owns no data yet); child rows would make
     * this fail by FK, which is the safety we want.
     */
    public void deleteById(UUID tenantId) {
        jdbc.update("DELETE FROM tenant WHERE id = ?", tenantId);
    }

    public boolean existsById(UUID tenantId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM tenant WHERE id = ?", Integer.class, tenantId);
        return count != null && count > 0;
    }

    private static TenantDto map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        OffsetDateTime created = rs.getObject("created_at", OffsetDateTime.class);
        return new TenantDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("segment"),
                rs.getString("plan"),
                created != null ? created.toInstant() : null);
    }
}
