package com.voltpilot.api.repo;

import com.voltpilot.api.optimizer.SlotEconomics.MarketValue;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Read side of the admin optimizer diagnostics: persisted plan runs
 * ({@code schedule} hypertable) plus the pricing master data the per-slot
 * €-decomposition needs. Every query runs through the RLS-scoped app
 * datasource WITHOUT a tenant predicate - the admin reaches a tenant's site
 * via the {@code X-Tenant-Id} switcher exactly like every other
 * admin-reads-customer-data feature, so a foreign (or unselected) tenant's
 * site is simply invisible (=&gt; 404), never BYPASSRLS.
 * {@code monthly_market_value} is market-wide (no tenant, no RLS - the
 * EarningsRepository precedent) and read per Berlin month.
 */
@Repository
public class OptimizerDiagnosticsRepository {

    /** One persisted plan slot with every column the decomposition consumes. */
    public record SlotRow(
            Instant time,
            BigDecimal batteryKw,
            BigDecimal gridKw,
            BigDecimal socPct,
            BigDecimal loadKw,
            BigDecimal pvKw,
            BigDecimal priceEurMwh,
            BigDecimal costEur,
            BigDecimal baselineCostEur,
            BigDecimal curtailKw,
            BigDecimal wearCostEur) {
    }

    /**
     * The site's optimizer-relevant master data in one row: pricing fields,
     * the battery asset's parameters ({@code hasBattery} false when the site
     * has no battery asset - the optimizer then never plans it) and the PV
     * asset's remuneration inputs (MaStR commissioning date + kWp).
     */
    public record SiteContext(
            UUID siteId,
            String plantKind,
            boolean netzladenErlaubt,
            String tarifArt,
            BigDecimal tarifParamCtKwh,
            BigDecimal anzulegenderWertCtKwh,
            BigDecimal backupReserveSocPct,
            boolean hasBattery,
            BigDecimal batteryCapacityKwh,
            BigDecimal roundtripEfficiencyPct,
            BigDecimal wearCostCtPerKwh,
            BigDecimal socMinPct,
            BigDecimal socMaxPct,
            LocalDate pvCommissionedOn,
            BigDecimal pvCapacityKwp) {
    }

    private final JdbcTemplate jdbc;

    public OptimizerDiagnosticsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The site + battery + PV context, or null when RLS hides the site (=> 404). */
    public SiteContext siteContext(UUID siteId) {
        List<SiteContext> found = jdbc.query(
                "SELECT s.id, s.plant_kind, s.netzladen_erlaubt, s.tarif_art,"
                        + " s.tarif_param_ct_kwh, s.anzulegender_wert_ct_kwh,"
                        + " s.backup_reserve_soc_pct,"
                        + " b.id AS battery_id, b.capacity_kwh, b.roundtrip_efficiency_pct,"
                        + " b.wear_cost_ct_per_kwh, b.soc_min_pct, b.soc_max_pct,"
                        + " pv.commissioned_on, pv.pv_capacity_kwp "
                        + "FROM site s "
                        + "LEFT JOIN asset b ON b.site_id = s.id AND b.type = 'battery' "
                        + "LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' "
                        + "WHERE s.id = ?",
                OptimizerDiagnosticsRepository::mapContext, siteId);
        return found.isEmpty() ? null : found.get(0);
    }

    /**
     * Resolve the run to diagnose: the requested {@code generatedAt} when it
     * exists for this site, else null; a null request resolves to the LATEST
     * run (null when the site has no plan at all).
     */
    public Instant resolveRun(UUID siteId, Instant generatedAt) {
        if (generatedAt != null) {
            List<Instant> exact = jdbc.query(
                    "SELECT generated_at FROM schedule WHERE site_id = ? AND generated_at = ? LIMIT 1",
                    (rs, i) -> rs.getTimestamp("generated_at").toInstant(),
                    siteId, Timestamp.from(generatedAt));
            return exact.isEmpty() ? null : exact.get(0);
        }
        List<Instant> latest = jdbc.query(
                "SELECT max(generated_at) AS generated_at FROM schedule WHERE site_id = ?",
                (rs, i) -> {
                    Timestamp ts = rs.getTimestamp("generated_at");
                    return ts == null ? null : ts.toInstant();
                },
                siteId);
        return latest.isEmpty() ? null : latest.get(0);
    }

    /** Recent run timestamps (newest first) - the UI's run/date picker. */
    public List<Instant> availableRuns(UUID siteId, int limit) {
        return jdbc.query(
                "SELECT DISTINCT generated_at FROM schedule WHERE site_id = ? "
                        + "ORDER BY generated_at DESC LIMIT ?",
                (rs, i) -> rs.getTimestamp("generated_at").toInstant(),
                siteId, limit);
    }

    /** The run's slots in time order, with every persisted economics column. */
    public List<SlotRow> slots(UUID siteId, Instant generatedAt) {
        return jdbc.query(
                "SELECT time, battery_kw, grid_kw, soc_pct, load_kw, pv_kw, price_eur_mwh,"
                        + " cost_eur, baseline_cost_eur, curtail_kw, wear_cost_eur "
                        + "FROM schedule WHERE site_id = ? AND generated_at = ? ORDER BY time",
                (rs, i) -> new SlotRow(
                        rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("battery_kw"),
                        rs.getBigDecimal("grid_kw"),
                        rs.getBigDecimal("soc_pct"),
                        rs.getBigDecimal("load_kw"),
                        rs.getBigDecimal("pv_kw"),
                        rs.getBigDecimal("price_eur_mwh"),
                        rs.getBigDecimal("cost_eur"),
                        rs.getBigDecimal("baseline_cost_eur"),
                        rs.getBigDecimal("curtail_kw"),
                        rs.getBigDecimal("wear_cost_eur")),
                siteId, Timestamp.from(generatedAt));
    }

    /** The plan_id of the run (first row's - constant per run). */
    public UUID planId(UUID siteId, Instant generatedAt) {
        List<UUID> ids = jdbc.query(
                "SELECT plan_id FROM schedule WHERE site_id = ? AND generated_at = ? LIMIT 1",
                (rs, i) -> rs.getObject("plan_id", UUID.class),
                siteId, Timestamp.from(generatedAt));
        return ids.isEmpty() ? null : ids.get(0);
    }

    /**
     * Monatsmarktwert Solar for the Berlin months in {@code [from, to]}
     * (inclusive month keys). Market-wide data, no tenant.
     */
    public Map<LocalDate, MarketValue> marketValues(LocalDate fromMonth, LocalDate toMonth) {
        Map<LocalDate, MarketValue> result = new HashMap<>();
        jdbc.query(
                "SELECT month, value_ct_kwh, provisional FROM monthly_market_value "
                        + "WHERE technology = 'solar' AND month >= ? AND month <= ?",
                rs -> {
                    result.put(rs.getObject("month", LocalDate.class),
                            new MarketValue(rs.getBigDecimal("value_ct_kwh").doubleValue(),
                                    rs.getBoolean("provisional")));
                },
                fromMonth, toMonth);
        return result;
    }

    private static SiteContext mapContext(ResultSet rs, int rowNum) throws SQLException {
        java.sql.Date commissioned = rs.getDate("commissioned_on");
        return new SiteContext(
                rs.getObject("id", UUID.class),
                rs.getString("plant_kind"),
                rs.getBoolean("netzladen_erlaubt"),
                rs.getString("tarif_art"),
                rs.getBigDecimal("tarif_param_ct_kwh"),
                rs.getBigDecimal("anzulegender_wert_ct_kwh"),
                rs.getBigDecimal("backup_reserve_soc_pct"),
                rs.getObject("battery_id", UUID.class) != null,
                rs.getBigDecimal("capacity_kwh"),
                rs.getBigDecimal("roundtrip_efficiency_pct"),
                rs.getBigDecimal("wear_cost_ct_per_kwh"),
                rs.getBigDecimal("soc_min_pct"),
                rs.getBigDecimal("soc_max_pct"),
                commissioned != null ? commissioned.toLocalDate() : null,
                rs.getBigDecimal("pv_capacity_kwp"));
    }
}
