package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die 15-min-Lastspitze (Netzbezugsleistung) je Anlage aus der Telemetrie für
 * das Portfolio-Kachelraster. Anders als {@link PeakShavingRepository} (nur
 * module-aktive Anlagen mit Leistungspreis, Beweiszahlen) ist dies die REINE
 * gemessene Spitze jeder sichtbaren Anlage: {@code max(grid_import_kwh)·4} (kWh
 * je Viertelstunde × 4 = mittlere Leistung in kW, dieselbe Formel wie dort).
 *
 * <p>{@code JOIN site} zieht den Zugriffs-Zaun mit: {@code telemetry_rollup_15m}
 * trägt nur die Mandantengrenze (RLS, Migration V2), nicht den Standort-Zaun -
 * der JOIN auf {@code site} (das trägt beides) fencet eine fleet-weite Lesung
 * sauber, wie {@code OverviewRepository.storageTotals}. Anlagen ohne gemessenen
 * Netzbezug im Fenster fehlen in der Map (kein erfundener 0-Wert).
 */
@Repository
public class PortfolioKpiRepository {

    private final JdbcTemplate jdbc;

    public PortfolioKpiRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Je sichtbarer Anlage ihre höchste 15-min-Netzbezugsleistung (kW) im Fenster {@code [von, bis)}. */
    public Map<UUID, BigDecimal> importSpitzeKw(Instant von, Instant bis) {
        Map<UUID, BigDecimal> out = new HashMap<>();
        jdbc.query(
                "SELECT r.site_id, max(GREATEST(r.grid_import_kwh, 0)) * 4.0 AS peak "
                        + "FROM telemetry_rollup_15m r JOIN site s ON s.id = r.site_id "
                        + "WHERE r.bucket >= ? AND r.bucket < ? AND r.grid_import_kwh IS NOT NULL "
                        + "GROUP BY r.site_id",
                rs -> {
                    BigDecimal peak = rs.getBigDecimal("peak");
                    if (peak != null) {
                        out.put(rs.getObject("site_id", UUID.class), peak);
                    }
                },
                Timestamp.from(von), Timestamp.from(bis));
        return out;
    }
}
