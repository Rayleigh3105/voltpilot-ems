package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
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

    private static final String COLUMNS =
            "id, name, bidding_zone, latitude, longitude, plant_kind, marktpraemie_ct_kwh,"
                    + " netzladen_erlaubt";

    private final JdbcTemplate jdbc;

    public SiteRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<SiteDto> findAll() {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM site ORDER BY name",
                SiteRepository::mapSite);
    }

    /** The site for the current tenant, or {@code null} when RLS hides it (=> 404). */
    public SiteDto findById(UUID siteId) {
        List<SiteDto> found = jdbc.query(
                "SELECT " + COLUMNS + " FROM site WHERE id = ?",
                SiteRepository::mapSite, siteId);
        return found.isEmpty() ? null : found.get(0);
    }

    /**
     * Create a site for the current tenant - a single insert. {@code tenantId}
     * comes from the request's {@link com.voltpilot.api.tenant.TenantContext}
     * (the JWT {@code tenant_id} claim), never from client input, and RLS' WITH
     * CHECK on {@code site} (migration V2) both permits the write and guarantees
     * the row's {@code tenant_id} equals the session tenant - so a customer can
     * never create a site for another tenant even with a crafted request.
     */
    public SiteDto create(UUID tenantId, String name, String biddingZone,
            BigDecimal latitude, BigDecimal longitude, String plantKind,
            BigDecimal marktpraemieCtKwh, Boolean netzladenErlaubt) {
        return jdbc.queryForObject(
                "INSERT INTO site (tenant_id, name, bidding_zone, latitude, longitude, plant_kind,"
                        + " marktpraemie_ct_kwh, netzladen_erlaubt) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, FALSE)) "
                        + "RETURNING " + COLUMNS,
                SiteRepository::mapSite, tenantId, name, biddingZone, latitude, longitude, plantKind,
                marktpraemieCtKwh, netzladenErlaubt);
    }

    /**
     * Update a site's editable fields. RLS both hides foreign sites (no row
     * updated => empty => 404) and - via WITH CHECK - forbids moving the row to
     * another tenant, so the update can never cross a tenant boundary.
     */
    public SiteDto update(UUID siteId, String name, String biddingZone,
            BigDecimal latitude, BigDecimal longitude, String plantKind,
            BigDecimal marktpraemieCtKwh, Boolean netzladenErlaubt) {
        // netzladen_erlaubt: null = keep the stored value (customer edits never
        // carry it - the controller rejects a non-admin non-null value anyway).
        List<SiteDto> updated = jdbc.query(
                "UPDATE site SET name = ?, bidding_zone = ?, latitude = ?, longitude = ?, plant_kind = ?,"
                        + " marktpraemie_ct_kwh = ?,"
                        + " netzladen_erlaubt = COALESCE(?, netzladen_erlaubt) "
                        + "WHERE id = ? "
                        + "RETURNING " + COLUMNS,
                SiteRepository::mapSite, name, biddingZone, latitude, longitude, plantKind,
                marktpraemieCtKwh, netzladenErlaubt, siteId);
        return updated.isEmpty() ? null : updated.get(0);
    }

    /**
     * Delete a site row. Assets cascade by FK; devices must be gone already
     * (the controller refuses while any exist); series rows are removed by
     * {@link SeriesRepository} in the same transaction. False when RLS hides
     * the site (=> 404).
     */
    public boolean delete(UUID siteId) {
        return jdbc.update("DELETE FROM site WHERE id = ?", siteId) > 0;
    }

    public boolean existsForCurrentTenant(UUID siteId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM site WHERE id = ?", Integer.class, siteId);
        return count != null && count > 0;
    }

    static SiteDto mapSite(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new SiteDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("bidding_zone"),
                rs.getBigDecimal("latitude"),
                rs.getBigDecimal("longitude"),
                rs.getString("plant_kind"),
                rs.getBigDecimal("marktpraemie_ct_kwh"),
                rs.getBoolean("netzladen_erlaubt"));
    }
}
