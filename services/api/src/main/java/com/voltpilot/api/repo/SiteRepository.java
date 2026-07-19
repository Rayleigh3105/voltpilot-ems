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
            "id, name, bidding_zone, latitude, longitude, plant_kind, anzulegender_wert_ct_kwh,"
                    + " marktpraemie_ct_kwh, tarif_art, tarif_param_ct_kwh, netzladen_erlaubt,"
                    + " max_feed_in_kw, leistungspreis_eur_kw, abrechnung_leistung,"
                    + " peak_reserve_soc_pct, usage_profile_override";

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
            BigDecimal anzulegenderWertCtKwh, String tarifArt, BigDecimal tarifParamCtKwh,
            Boolean netzladenErlaubt, BigDecimal maxFeedInKw) {
        return jdbc.queryForObject(
                "INSERT INTO site (tenant_id, name, bidding_zone, latitude, longitude, plant_kind,"
                        + " anzulegender_wert_ct_kwh, tarif_art, tarif_param_ct_kwh, netzladen_erlaubt,"
                        + " max_feed_in_kw) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'ohne'), ?, COALESCE(?, FALSE), ?) "
                        + "RETURNING " + COLUMNS,
                SiteRepository::mapSite, tenantId, name, biddingZone, latitude, longitude, plantKind,
                anzulegenderWertCtKwh, tarifArt, tarifParamCtKwh, netzladenErlaubt, maxFeedInKw);
    }

    /**
     * Update a site's editable fields. RLS both hides foreign sites (no row
     * updated => empty => 404) and - via WITH CHECK - forbids moving the row to
     * another tenant, so the update can never cross a tenant boundary.
     */
    public SiteDto update(UUID siteId, String name, String biddingZone,
            BigDecimal latitude, BigDecimal longitude, String plantKind,
            BigDecimal anzulegenderWertCtKwh, String tarifArt, BigDecimal tarifParamCtKwh,
            Boolean netzladenErlaubt, BigDecimal maxFeedInKw) {
        // tarif_art is a full-representation field like plant_kind (the controller
        // fills the 'ohne' default), so it overwrites; tarif_param_ct_kwh is set
        // directly (null clears it - the controller already nulls it for 'ohne').
        // netzladen_erlaubt and max_feed_in_kw: null = keep the stored value, so
        // a caller that omits either field never flips the flag / clears the cap
        // by accident. The deprecated marktpraemie_ct_kwh column is deliberately
        // untouched (kept one release for manual recovery, then dropped).
        List<SiteDto> updated = jdbc.query(
                "UPDATE site SET name = ?, bidding_zone = ?, latitude = ?, longitude = ?, plant_kind = ?,"
                        + " anzulegender_wert_ct_kwh = ?, tarif_art = COALESCE(?, 'ohne'),"
                        + " tarif_param_ct_kwh = ?,"
                        + " netzladen_erlaubt = COALESCE(?, netzladen_erlaubt),"
                        + " max_feed_in_kw = COALESCE(?, max_feed_in_kw) "
                        + "WHERE id = ? "
                        + "RETURNING " + COLUMNS,
                SiteRepository::mapSite, name, biddingZone, latitude, longitude, plantKind,
                anzulegenderWertCtKwh, tarifArt, tarifParamCtKwh, netzladenErlaubt, maxFeedInKw,
                siteId);
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
                rs.getBigDecimal("anzulegender_wert_ct_kwh"),
                rs.getBigDecimal("marktpraemie_ct_kwh"),
                rs.getString("tarif_art"),
                rs.getBigDecimal("tarif_param_ct_kwh"),
                rs.getBoolean("netzladen_erlaubt"),
                rs.getBigDecimal("max_feed_in_kw"),
                // Peak-shaving master data (V20260716020000): read-only echo -
                // written ONLY via the admin optimizer-config endpoint.
                rs.getBigDecimal("leistungspreis_eur_kw"),
                rs.getString("abrechnung_leistung"),
                rs.getBigDecimal("peak_reserve_soc_pct"),
                // AE7 Nutzungsprofil override (V20260719050000).
                rs.getString("usage_profile_override"));
    }

    /**
     * Set (or clear, with {@code null}) the site's usage-profile override
     * (AE7). Full-set semantics: {@code null} reverts the site to auto-derive.
     * RLS scopes the write to the caller's tenant (foreign site => 0 rows).
     */
    public boolean setUsageProfileOverride(UUID siteId, String override) {
        return jdbc.update(
                "UPDATE site SET usage_profile_override = ? WHERE id = ?", override, siteId) > 0;
    }
}
