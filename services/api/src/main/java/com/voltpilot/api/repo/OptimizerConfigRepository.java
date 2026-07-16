package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Write side of the admin optimizer-config panel: the per-site / per-asset
 * override columns the optimizer resolves against its platform defaults
 * ({@code asset.wear_cost_ct_per_kwh} V20260710000000,
 * {@code asset.soc_min_pct}/{@code soc_max_pct} V20260710020000,
 * {@code site.backup_reserve_soc_pct} V20260710010000). NULL always means
 * "platform default applies" - writing null CLEARS an override.
 *
 * <p>RLS-scoped like every customer repository: the admin writes through the
 * tenant-switched app datasource, WITH CHECK pins the row to the selected
 * tenant, and a foreign site updates zero rows (=&gt; 404 upstream).
 */
@Repository
public class OptimizerConfigRepository {

    private final JdbcTemplate jdbc;

    public OptimizerConfigRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Set (or clear, with nulls) the battery asset's optimizer overrides.
     * Returns false when the site has no battery asset row (nothing to tune).
     */
    public boolean updateBatteryOverrides(UUID siteId, BigDecimal wearCostCtPerKwh,
            BigDecimal socMinPct, BigDecimal socMaxPct) {
        return jdbc.update(
                "UPDATE asset SET wear_cost_ct_per_kwh = ?, soc_min_pct = ?, soc_max_pct = ? "
                        + "WHERE site_id = ? AND type = 'battery'",
                wearCostCtPerKwh, socMinPct, socMaxPct, siteId) > 0;
    }

    /** Set (or clear) the site's backup-reserve floor. False when RLS hides it. */
    public boolean updateBackupReserve(UUID siteId, BigDecimal backupReserveSocPct) {
        return jdbc.update(
                "UPDATE site SET backup_reserve_soc_pct = ? WHERE id = ?",
                backupReserveSocPct, siteId) > 0;
    }

    /**
     * Set (or clear) the site's peak-shaving module (PS-1/PS-2,
     * V20260716020000): null {@code leistungspreisEurKw} switches the module
     * off, null {@code abrechnungLeistung} resets the NOT-NULL column to its
     * {@code jahr} default. False when RLS hides the site.
     */
    public boolean updatePeakShaving(UUID siteId, BigDecimal leistungspreisEurKw,
            String abrechnungLeistung, BigDecimal peakReserveSocPct) {
        return jdbc.update(
                "UPDATE site SET leistungspreis_eur_kw = ?,"
                        + " abrechnung_leistung = COALESCE(?, 'jahr'),"
                        + " peak_reserve_soc_pct = ? WHERE id = ?",
                leistungspreisEurKw, abrechnungLeistung, peakReserveSocPct, siteId) > 0;
    }
}
