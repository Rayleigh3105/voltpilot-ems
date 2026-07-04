package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.MastrApplyRequest;
import com.voltpilot.api.web.dto.SiteAssetDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * A site's asset master data, RLS-scoped like every customer repository: the
 * queries carry no tenant predicate, the session's {@code app.tenant_id} does
 * the scoping, and RLS' WITH CHECK guarantees writes land in the caller's
 * tenant. The registry-apply upserts keep ONE asset row per (site, type):
 * update-in-place preserves the row id and any device link the dev seed or a
 * previous apply established (the optimizer keys off exactly these rows).
 */
@Repository
public class AssetRepository {

    private static final String COLUMNS = "id, type, capacity_kwh, max_charge_kw, "
            + "max_discharge_kw, pv_capacity_kwp, module_count, azimuth_deg, tilt_deg, "
            + "commissioned_on, registry, registry_unit_id, registry_fetched_at";

    private final JdbcTemplate jdbc;

    public AssetRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<SiteAssetDto> findForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM asset WHERE site_id = ? ORDER BY type, created_at",
                AssetRepository::mapAsset, siteId);
    }

    /**
     * Create-or-update the site's PV asset from confirmed registry values. One
     * atomic {@code INSERT ... ON CONFLICT (site_id, type) DO UPDATE} (backed by
     * the {@code uq_asset_site_type} unique index, migration V20260703010000):
     * update-in-place preserves the existing row id and its device link, and a
     * concurrent double-submit can never create a duplicate row.
     */
    public void applyPv(UUID tenantId, UUID siteId, MastrApplyRequest.PvApply pv,
            String registry, Instant fetchedAt) {
        jdbc.update(
                "INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp, module_count, "
                        + "azimuth_deg, tilt_deg, commissioned_on, registry, registry_unit_id, "
                        + "registry_fetched_at) VALUES (?, ?, 'pv', ?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, type) DO UPDATE SET "
                        + "pv_capacity_kwp = EXCLUDED.pv_capacity_kwp, "
                        + "module_count = EXCLUDED.module_count, "
                        + "azimuth_deg = EXCLUDED.azimuth_deg, tilt_deg = EXCLUDED.tilt_deg, "
                        + "commissioned_on = EXCLUDED.commissioned_on, registry = EXCLUDED.registry, "
                        + "registry_unit_id = EXCLUDED.registry_unit_id, "
                        + "registry_fetched_at = EXCLUDED.registry_fetched_at",
                tenantId, siteId, pv.capacityKwp(), pv.moduleCount(), pv.azimuthDeg(),
                pv.tiltDeg(), pv.commissionedOn(), registry, pv.mastrNummer(),
                Timestamp.from(fetchedAt));
    }

    /**
     * Create-or-update the site's battery asset. Lands in the SAME columns the
     * optimizer reads ({@code capacity_kwh}/{@code max_charge_kw}/{@code
     * max_discharge_kw}); {@code roundtrip_efficiency_pct} is untouched - the
     * registry has no efficiency, the platform default applies. Atomic upsert on
     * {@code (site_id, type)} like {@link #applyPv}.
     */
    public void applyBattery(UUID tenantId, UUID siteId, MastrApplyRequest.StorageApply st,
            String registry, Instant fetchedAt) {
        jdbc.update(
                "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                        + "max_discharge_kw, commissioned_on, registry, registry_unit_id, "
                        + "registry_fetched_at) VALUES (?, ?, 'battery', ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, type) DO UPDATE SET "
                        + "capacity_kwh = EXCLUDED.capacity_kwh, "
                        + "max_charge_kw = EXCLUDED.max_charge_kw, "
                        + "max_discharge_kw = EXCLUDED.max_discharge_kw, "
                        + "commissioned_on = EXCLUDED.commissioned_on, registry = EXCLUDED.registry, "
                        + "registry_unit_id = EXCLUDED.registry_unit_id, "
                        + "registry_fetched_at = EXCLUDED.registry_fetched_at",
                tenantId, siteId, st.capacityKwh(), st.maxChargeKw(), st.maxDischargeKw(),
                st.commissionedOn(), registry, st.mastrNummer(), Timestamp.from(fetchedAt));
    }

    private static SiteAssetDto mapAsset(ResultSet rs, int rowNum) throws SQLException {
        Timestamp fetched = rs.getTimestamp("registry_fetched_at");
        java.sql.Date commissioned = rs.getDate("commissioned_on");
        return new SiteAssetDto(
                rs.getObject("id", UUID.class),
                rs.getString("type"),
                rs.getBigDecimal("capacity_kwh"),
                rs.getBigDecimal("max_charge_kw"),
                rs.getBigDecimal("max_discharge_kw"),
                rs.getBigDecimal("pv_capacity_kwp"),
                rs.getObject("module_count", Integer.class),
                rs.getBigDecimal("azimuth_deg"),
                rs.getBigDecimal("tilt_deg"),
                commissioned != null ? commissioned.toLocalDate() : null,
                rs.getString("registry"),
                rs.getString("registry_unit_id"),
                fetched != null ? fetched.toInstant() : null);
    }
}
