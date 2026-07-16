package com.voltpilot.api.repo;

import com.voltpilot.api.web.Speicherschonung;
import com.voltpilot.api.web.dto.MastrApplyRequest;
import com.voltpilot.api.web.dto.SiteAssetDto;
import java.math.BigDecimal;
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

    private static final String COLUMNS = "id, type, device_id, capacity_kwh, max_charge_kw, "
            + "max_discharge_kw, roundtrip_efficiency_pct, wear_cost_ct_per_kwh, pv_capacity_kwp, "
            + "module_count, azimuth_deg, tilt_deg, commissioned_on, registry, registry_unit_id, "
            + "registry_fetched_at";

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

    /**
     * Create-or-update the site's battery asset from customer-entered values (the
     * manual, non-MaStR path - the only way to maintain a plant that is not in
     * the registry). Same atomic upsert on {@code (site_id, type)} as {@link
     * #applyBattery}, but it writes {@code roundtrip_efficiency_pct} too and
     * leaves the registry provenance columns untouched: a manually-maintained
     * battery keeps a NULL registry, a MaStR one keeps its 'mastr' provenance.
     * The device link is maintained separately ({@link #linkBatteryDevice} /
     * {@link #autoLinkBatteryDevice}).
     */
    public void saveBattery(UUID tenantId, UUID siteId, BigDecimal capacityKwh,
            BigDecimal maxChargeKw, BigDecimal maxDischargeKw, BigDecimal roundtripEfficiencyPct) {
        jdbc.update(
                "INSERT INTO asset (tenant_id, site_id, type, capacity_kwh, max_charge_kw, "
                        + "max_discharge_kw, roundtrip_efficiency_pct) "
                        + "VALUES (?, ?, 'battery', ?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, type) DO UPDATE SET "
                        + "capacity_kwh = EXCLUDED.capacity_kwh, "
                        + "max_charge_kw = EXCLUDED.max_charge_kw, "
                        + "max_discharge_kw = EXCLUDED.max_discharge_kw, "
                        + "roundtrip_efficiency_pct = EXCLUDED.roundtrip_efficiency_pct",
                tenantId, siteId, capacityKwh, maxChargeKw, maxDischargeKw, roundtripEfficiencyPct);
    }

    /**
     * Set the battery's wear cost from a customer Speicherschonung preset (FK4).
     * Deliberately touches ONLY {@code wear_cost_ct_per_kwh} - the other admin
     * optimizer overrides on the same row ({@code soc_min_pct}/{@code
     * soc_max_pct}) and the site's backup reserve are never part of a preset
     * write (unlike the full-representation admin optimizer-config PUT). The
     * optimizer reads exactly this column per 15-min cycle, so the preset takes
     * effect on the next plan. RLS-scoped like every write here.
     */
    public boolean setBatteryWearCost(UUID siteId, BigDecimal wearCostCtPerKwh) {
        return jdbc.update(
                "UPDATE asset SET wear_cost_ct_per_kwh = ? WHERE site_id = ? AND type = 'battery'",
                wearCostCtPerKwh, siteId) > 0;
    }

    /**
     * Explicitly link the site's battery asset to a device the caller chose (the
     * multi-device case, where the auto-link deliberately doesn't guess). RLS
     * scopes both the asset and - since the device id is validated to belong to
     * the site by the caller - the write to the caller's tenant. Returns true if
     * a battery row was updated.
     */
    public boolean linkBatteryDevice(UUID siteId, UUID deviceId) {
        return jdbc.update(
                "UPDATE asset SET device_id = ? WHERE site_id = ? AND type = 'battery'",
                deviceId, siteId) > 0;
    }

    /**
     * Self-maintaining battery-asset <-> device link (the core of this feature).
     * When the site has EXACTLY ONE device and its battery asset is still
     * unlinked, link them - the battery is controlled by the inverter, which is
     * that one device. A site with several devices is left alone on purpose (we
     * never guess which inverter controls the battery; the owner picks in the
     * portal), and an already-linked battery is never re-pointed. RLS-scoped, so
     * it only ever touches the caller's tenant. Returns true if a link was made.
     *
     * <p>Called after a device claim (a claim may make a site single-device) and
     * after a battery asset write (MaStR-apply or the manual editor), so a fresh
     * plant converges without any manual step. The one-time catch-up for rows
     * that predate the hooks is migration V20260707010000.
     */
    public boolean autoLinkBatteryDevice(UUID siteId) {
        // (array_agg(id))[1] picks the site's one device (HAVING count = 1 makes
        // it unambiguous); Postgres has no max(uuid) to select it directly.
        return jdbc.update(
                "UPDATE asset SET device_id = single.device_id "
                        + "FROM (SELECT (array_agg(id))[1] AS device_id FROM device WHERE site_id = ? "
                        + "  HAVING count(*) = 1) single "
                        + "WHERE asset.site_id = ? AND asset.type = 'battery' "
                        + "  AND asset.device_id IS NULL",
                siteId, siteId) > 0;
    }

    /**
     * Adjust the site's AGGREGATE PV nameplate by {@code deltaKwp} (multi-source
     * Anlage): adding an additional Erzeuger measurement point adds its kWp, and
     * removing one subtracts it, so {@code asset.pv.pv_capacity_kwp} stays
     * "primary PV + Σ additional Erzeuger" - the total the forecast + physical
     * envelope need. Never drops below 0. Exact per-operation deltas (create adds,
     * delete subtracts) keep it consistent WITHOUT clobbering a MaStR- or
     * manually-set primary kWp (unlike a full recompute). Creates the {@code pv}
     * asset row on first positive delta if the site has none yet; RLS-scoped.
     * Returns true if a row was updated or created.
     */
    public boolean addPvCapacity(UUID tenantId, UUID siteId, BigDecimal deltaKwp) {
        if (deltaKwp == null || deltaKwp.signum() == 0) {
            return false;
        }
        int updated = jdbc.update(
                "UPDATE asset SET pv_capacity_kwp = GREATEST(COALESCE(pv_capacity_kwp, 0) + ?, 0) "
                        + "WHERE site_id = ? AND type = 'pv'",
                deltaKwp, siteId);
        if (updated == 0 && deltaKwp.signum() > 0) {
            // No PV asset yet: create it carrying just the additional generation.
            jdbc.update(
                    "INSERT INTO asset (tenant_id, site_id, type, pv_capacity_kwp) "
                            + "VALUES (?, ?, 'pv', ?)",
                    tenantId, siteId, deltaKwp);
            return true;
        }
        return updated > 0;
    }

    private static SiteAssetDto mapAsset(ResultSet rs, int rowNum) throws SQLException {
        Timestamp fetched = rs.getTimestamp("registry_fetched_at");
        java.sql.Date commissioned = rs.getDate("commissioned_on");
        String type = rs.getString("type");
        return new SiteAssetDto(
                rs.getObject("id", UUID.class),
                type,
                rs.getObject("device_id", UUID.class),
                rs.getBigDecimal("capacity_kwh"),
                rs.getBigDecimal("max_charge_kw"),
                rs.getBigDecimal("max_discharge_kw"),
                rs.getBigDecimal("roundtrip_efficiency_pct"),
                // The effective customer preset; the raw ct value stays admin-only.
                "battery".equals(type)
                        ? Speicherschonung.presetFor(rs.getBigDecimal("wear_cost_ct_per_kwh"))
                        : null,
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
