package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SiteDto;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Sites for the current tenant. Every query is transparently scoped by RLS
 * (migration V2) via the {@code app.tenant_id} session variable, so no explicit
 * tenant predicate is needed or trusted here.
 */
@Repository
public class SiteRepository {

    private final JdbcTemplate jdbc;

    public SiteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<SiteDto> findAll() {
        return jdbc.query(
                "SELECT id, name, bidding_zone, latitude, longitude FROM site ORDER BY name",
                SiteRepository::mapSite);
    }

    /** The site for the current tenant, or {@code null} when RLS hides it (=> 404). */
    public SiteDto findById(UUID siteId) {
        List<SiteDto> found = jdbc.query(
                "SELECT id, name, bidding_zone, latitude, longitude FROM site WHERE id = ?",
                SiteRepository::mapSite, siteId);
        return found.isEmpty() ? null : found.get(0);
    }

    public boolean existsForCurrentTenant(UUID siteId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM site WHERE id = ?", Integer.class, siteId);
        return count != null && count > 0;
    }

    private static SiteDto mapSite(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new SiteDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("bidding_zone"),
                rs.getBigDecimal("latitude"),
                rs.getBigDecimal("longitude"));
    }
}
