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
                "SELECT id, name, bidding_zone FROM site ORDER BY name",
                (rs, i) -> new SiteDto(
                        rs.getObject("id", UUID.class),
                        rs.getString("name"),
                        rs.getString("bidding_zone")));
    }

    public boolean existsForCurrentTenant(UUID siteId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM site WHERE id = ?", Integer.class, siteId);
        return count != null && count > 0;
    }
}
