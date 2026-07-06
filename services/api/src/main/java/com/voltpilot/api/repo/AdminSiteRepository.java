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

    private static final String COLUMNS =
            "id, name, bidding_zone, latitude, longitude, plant_kind, marktpraemie_ct_kwh";

    private final JdbcTemplate jdbc;

    public AdminSiteRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<SiteDto> findByTenant(UUID tenantId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM site WHERE tenant_id = ? ORDER BY name",
                SiteRepository::mapSite, tenantId);
    }

    public SiteDto create(UUID tenantId, String name, String biddingZone,
            BigDecimal latitude, BigDecimal longitude, String plantKind,
            BigDecimal marktpraemieCtKwh) {
        return jdbc.queryForObject(
                "INSERT INTO site (tenant_id, name, bidding_zone, latitude, longitude, plant_kind,"
                        + " marktpraemie_ct_kwh) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?) "
                        + "RETURNING " + COLUMNS,
                SiteRepository::mapSite, tenantId, name, biddingZone, latitude, longitude, plantKind,
                marktpraemieCtKwh);
    }
}
