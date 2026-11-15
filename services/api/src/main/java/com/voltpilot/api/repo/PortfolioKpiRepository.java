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
 * <p>{@code FROM site} zieht den Zugriffs-Zaun mit: {@code telemetry_rollup_15m}
 * trägt nur die Mandantengrenze (RLS, Migration V2), nicht den Standort-Zaun -
 * der Griff je Zeile von {@code site} (das trägt beides) fencet eine fleet-weite
 * Lesung sauber, wie {@code OverviewRepository.storageTotals}. Anlagen ohne POSITIVEN
 * Netzbezug im Fenster (reine Einspeiser) fehlen in der Map (kein erfundener 0-Wert).
 */
@Repository
public class PortfolioKpiRepository {

    private final JdbcTemplate jdbc;

    public PortfolioKpiRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die höchste gemessene 15-min-Netzbezugsleistung (kW) samt ihrem Zeitpunkt (Slot-Beginn). */
    public record Spitze(BigDecimal kw, Instant zeitpunkt) {}

    /**
     * Je sichtbarer Anlage ihre höchste 15-min-Netzbezugsleistung (kW) UND den
     * Zeitpunkt (Slot-Beginn) dieser Spitze im Fenster {@code [von, bis)}: je
     * Anlage die Zeile mit dem höchsten Netzbezug, bei Gleichstand die früheste;
     * Anlagen ohne positiven Netzbezug fehlen in der Map (kein 0-Wert).
     *
     * <p>H5 (vp-perf3-server): je Anlage EIN Griff über den Index
     * {@code idx_telemetry_rollup_15m_netzbezug_spitze} ({@code site_id, grid_import_kwh DESC, bucket}), statt
     * alle Viertelstunden des Jahresfensters aller Anlagen zu lesen und zu sortieren ({@code DISTINCT ON}) - der
     * größte Einzelposten von {@code /portfolio/kpis}. Dieselbe Zeile wie vorher: {@code ORDER BY grid_import_kwh
     * DESC, bucket LIMIT 1} ist die erste Zeile der Gruppe unter {@code ORDER BY site_id, grid_import_kwh DESC,
     * bucket} ({@code PortfolioKpiSpitzeGleichheitTest} hält die alte Form als Orakel).
     */
    public Map<UUID, Spitze> importSpitzen(Instant von, Instant bis) {
        Map<UUID, Spitze> out = new HashMap<>();
        jdbc.query(
                // Review R2 §B6: nur ECHTER Netzbezug (> 0) zählt. Eine im Fenster reine Einspeiser-Anlage
                // (grid_import_kwh ≤ 0) fällt damit aus der Map, statt mit einer 0-kW-Spitze zu erscheinen -
                // „kein erfundener 0-Wert". `> 0` schließt NULL mit ein; `GREATEST(..,0)` ist dadurch unnötig.
                "SELECT s.id AS site_id, x.bucket, x.grid_import_kwh * 4.0 AS peak "
                        + "FROM site s CROSS JOIN LATERAL ("
                        + "SELECT r.bucket, r.grid_import_kwh FROM telemetry_rollup_15m r "
                        + "WHERE r.site_id = s.id AND r.bucket >= ? AND r.bucket < ? AND r.grid_import_kwh > 0 "
                        + "ORDER BY r.grid_import_kwh DESC, r.bucket LIMIT 1) x",
                rs -> {
                    BigDecimal peak = rs.getBigDecimal("peak");
                    if (peak != null) {
                        Timestamp ts = rs.getTimestamp("bucket");
                        out.put(rs.getObject("site_id", UUID.class),
                                new Spitze(peak, ts != null ? ts.toInstant() : null));
                    }
                },
                Timestamp.from(von), Timestamp.from(bis));
        return out;
    }
}
