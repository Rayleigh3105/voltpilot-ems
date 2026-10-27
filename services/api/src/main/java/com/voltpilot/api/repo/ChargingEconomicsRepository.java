package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die beiden Zutaten, die eine Ladung zusätzlich zur eigenen Wallbox-Zählung
 * braucht (Konzept „Ein Ort fürs Laden" e1, Scheibe 2 - „Ladungen" mit
 * Herkunft und Geld): die Börsenpreis-Spur je Viertelstunde (dieselbe Reihe,
 * die {@code EarningsRepository}/{@code PriceSlots} der Anlage schon ziehen)
 * und die Mischung aus Sonne/Speicher/Netz der ganzen Anlage je Viertelstunde
 * ({@code telemetry_rollup_15m}) - der anteilige Schluss, mit dem die
 * Wallbox-Ladung ihre eigene Herkunft NIE selbst misst, sondern aus der
 * Hausbilanz übernimmt (dieselbe Ehrlichkeitsregel wie {@code quellenAnteil}
 * im Portal).
 *
 * <p>Die Geldrechnung selbst liegt bei {@code SlotEconomics}
 * ({@link com.voltpilot.api.optimizer.OptimizerDiagnosticsService#economicsFor}) -
 * diese Klasse liefert nur die Rohdaten, nie eine zweite Preisregel.
 */
@Repository
public class ChargingEconomicsRepository {
    private final JdbcTemplate jdbc;

    public ChargingEconomicsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die Gebotszone der Anlage - {@code null}, wenn RLS sie verdeckt. */
    public String biddingZone(UUID siteId) {
        List<String> rows = jdbc.query("SELECT bidding_zone FROM site WHERE id=?",
                (rs, n) -> rs.getString("bidding_zone"), siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public record SpotSlot(Instant slot, Double priceEurMwh) {}

    /**
     * Der Börsenpreis je Viertelstunde in {@code [from, to)} - dieselbe
     * materialisierte Reihe wie {@code EarningsRepository} ({@link PriceSlots}),
     * hier nur für eine einzelne Gebotszone und ein kleineres Fenster gelesen.
     */
    public List<SpotSlot> spotPrices(String biddingZone, Instant from, Instant to) {
        String sql = "WITH " + PriceSlots.forZone() + "SELECT slot, price_eur_mwh FROM price_slot";
        return jdbc.query(sql, (rs, n) -> new SpotSlot(rs.getTimestamp("slot").toInstant(),
                        nullableDouble(rs, "price_eur_mwh")),
                biddingZone, Timestamp.from(from), Timestamp.from(to));
    }

    public record SlotMix(Instant bucket, Double pvKwh, Double loadKwh,
            Double gridImportKwh, Double gridExportKwh, Double batteryDischargeKwh) {}

    /**
     * Die Hausbilanz je Viertelstunde in {@code [from, to)] - die Grundlage des
     * anteiligen Schlusses, wie viel einer Ladung aus Sonne/Speicher statt aus
     * dem Netz kam.
     */
    public List<SlotMix> slotMix(UUID siteId, Instant from, Instant to) {
        return jdbc.query("SELECT bucket, pv_kwh, load_kwh, grid_import_kwh, grid_export_kwh,"
                        + " battery_discharge_kwh FROM telemetry_rollup_15m"
                        + " WHERE site_id=? AND bucket>=? AND bucket<? ORDER BY bucket",
                (rs, n) -> new SlotMix(rs.getTimestamp("bucket").toInstant(),
                        nullableDouble(rs, "pv_kwh"), nullableDouble(rs, "load_kwh"),
                        nullableDouble(rs, "grid_import_kwh"), nullableDouble(rs, "grid_export_kwh"),
                        nullableDouble(rs, "battery_discharge_kwh")),
                siteId, Timestamp.from(from), Timestamp.from(to));
    }

    private static Double nullableDouble(ResultSet rs, String field) throws SQLException {
        double value = rs.getDouble(field);
        return rs.wasNull() ? null : value;
    }
}
