package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Cross-tenant site CRUD for the platform-admin API.
 *
 * <p>Like {@link TenantRepository}, this uses the dedicated {@code adminJdbcTemplate}
 * bound to the {@code voltpilot_admin} BYPASSRLS role - so a Portal-Admin can list
 * and create sites for ANY tenant. This is the cross-tenant path and it is reached
 * only from {@code @PreAuthorize("hasRole('platform-admin')")} endpoints; the
 * tenant is taken from the request PATH, never from client-controlled data, and
 * the tenant's existence is checked before insert. Customer site access stays on
 * the RLS-scoped {@link SiteRepository}.
 */
@Repository
public class AdminSiteRepository {

    private final JdbcTemplate jdbc;

    public AdminSiteRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<SiteDto> findByTenant(UUID tenantId) {
        return jdbc.query(
                "SELECT id, name, bidding_zone, latitude, longitude FROM site "
                        + "WHERE tenant_id = ? ORDER BY name",
                AdminSiteRepository::map, tenantId);
    }

    public SiteDto create(UUID tenantId, String name, String biddingZone,
            BigDecimal latitude, BigDecimal longitude) {
        return jdbc.queryForObject(
                "INSERT INTO site (tenant_id, name, bidding_zone, latitude, longitude) "
                        + "VALUES (?, ?, ?, ?, ?) "
                        + "RETURNING id, name, bidding_zone, latitude, longitude",
                AdminSiteRepository::map, tenantId, name, biddingZone, latitude, longitude);
    }

    private static SiteDto map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new SiteDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("bidding_zone"),
                rs.getBigDecimal("latitude"),
                rs.getBigDecimal("longitude"));
    }
}
