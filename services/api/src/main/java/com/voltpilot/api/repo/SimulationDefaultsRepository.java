package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * One RLS-scoped read of everything the Ersparnis-Simulation pre-fills from a
 * site's master data (site tariff/coords/netzladen + the battery asset's
 * params incl. the RAW wear ct - the customer-facing SiteAssetDto only carries
 * the Speicherschonung preset, but an admin-configured "individuell" wear
 * must flow into the simulation verbatim + the PV asset's kWp/orientation).
 * Returns {@code null} when RLS hides the site (foreign tenant = 404).
 */
@Repository
public class SimulationDefaultsRepository {

    public record SimulationDefaults(
            String biddingZone,
            BigDecimal latitude,
            BigDecimal longitude,
            String plantKind,
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            BigDecimal anzulegenderWertCtKwh,
            boolean netzladenErlaubt,
            BigDecimal backupReserveSocPct,
            BigDecimal batteryCapacityKwh,
            BigDecimal batteryMaxChargeKw,
            BigDecimal batteryMaxDischargeKw,
            BigDecimal batteryRoundtripEfficiencyPct,
            BigDecimal batteryWearCostCtPerKwh,
            BigDecimal batterySocMinPct,
            BigDecimal batterySocMaxPct,
            BigDecimal pvCapacityKwp,
            BigDecimal pvAzimuthDeg,
            BigDecimal pvTiltDeg,
            LocalDate pvCommissionedOn) {
    }

    private final JdbcTemplate jdbc;

    public SimulationDefaultsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public SimulationDefaults findForSite(UUID siteId) {
        List<SimulationDefaults> rows = jdbc.query(
                """
                SELECT s.bidding_zone, s.latitude, s.longitude, s.plant_kind,
                       s.tarif_art, s.tarif_param_ct_kwh, s.anzulegender_wert_ct_kwh,
                       s.netzladen_erlaubt, s.backup_reserve_soc_pct,
                       b.capacity_kwh, b.max_charge_kw, b.max_discharge_kw,
                       b.roundtrip_efficiency_pct, b.wear_cost_ct_per_kwh,
                       b.soc_min_pct, b.soc_max_pct,
                       pv.pv_capacity_kwp, pv.azimuth_deg, pv.tilt_deg, pv.commissioned_on
                FROM site s
                LEFT JOIN asset b ON b.site_id = s.id AND b.type = 'battery' AND b.is_primary
                LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' AND pv.is_primary
                WHERE s.id = ?
                """,
                (rs, i) -> new SimulationDefaults(
                        rs.getString("bidding_zone"),
                        rs.getBigDecimal("latitude"),
                        rs.getBigDecimal("longitude"),
                        rs.getString("plant_kind"),
                        rs.getString("tarif_art"),
                        rs.getBigDecimal("tarif_param_ct_kwh"),
                        rs.getBigDecimal("anzulegender_wert_ct_kwh"),
                        rs.getBoolean("netzladen_erlaubt"),
                        rs.getBigDecimal("backup_reserve_soc_pct"),
                        rs.getBigDecimal("capacity_kwh"),
                        rs.getBigDecimal("max_charge_kw"),
                        rs.getBigDecimal("max_discharge_kw"),
                        rs.getBigDecimal("roundtrip_efficiency_pct"),
                        rs.getBigDecimal("wear_cost_ct_per_kwh"),
                        rs.getBigDecimal("soc_min_pct"),
                        rs.getBigDecimal("soc_max_pct"),
                        rs.getBigDecimal("pv_capacity_kwp"),
                        rs.getBigDecimal("azimuth_deg"),
                        rs.getBigDecimal("tilt_deg"),
                        rs.getObject("commissioned_on", LocalDate.class)),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }
}
