package com.voltpilot.api.repo;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Liest {@code forecast_rueckblick} (Migration V20261111170000, S3): je
 * Anlage, Tag, Art und Modell "am Vortag erwartet" gegen "gemessen" -
 * geschrieben vom Rückblick-Lauf ({@code voltpilot_forecast.rueckblick}) als
 * vertraute Backend-Rolle, hier nur gelesen über die RLS-gebundene App-Rolle
 * (dasselbe Bild wie {@link ForecastQualityRepository}).
 *
 * <p>Zwei Leser derselben Tabelle: das Blatt "Rückblick" (E5 = A, je Tag
 * erwartet neben gemessen, dazu das 0,8-Quantil der Abweichung) und S5s
 * Automatik ({@link #vergleich}, der Vortagsvergleich über alle Modelle einer
 * Anlage, nicht nur das aktive).
 */
@Repository
public class ForecastRueckblickRepository {

    /** Eine Zeile des Rückblicks - ein Tag, eine Art, ein Modell. */
    public record RueckblickTag(
            LocalDate day, String kind, String model,
            double erwartetKwh, double gemessenKwh) {
    }

    /** Der Vortagsvergleich EINES Modells über das Fenster (S5, Bericht R.4). */
    public record ModellVergleich(
            String model, double meanMaeKw, double meanTagesfehlerKwh, int tage) {
    }

    private final JdbcTemplate jdbc;

    public ForecastRueckblickRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die jüngsten Tage EINES Modells einer Art, älteste zuerst (fürs Blatt). */
    public List<RueckblickTag> tage(UUID siteId, String kind, String model, int leadDays, int limitTage) {
        List<RueckblickTag> rows = jdbc.query(
                "SELECT day, erwartet_kwh, gemessen_kwh FROM forecast_rueckblick "
                        + "WHERE site_id = ? AND kind = ? AND model = ? AND lead_days = ? "
                        + "ORDER BY day DESC LIMIT ?",
                (rs, i) -> new RueckblickTag(
                        rs.getObject("day", LocalDate.class),
                        kind,
                        model,
                        toDouble(rs.getBigDecimal("erwartet_kwh")),
                        toDouble(rs.getBigDecimal("gemessen_kwh"))),
                siteId, kind, model, leadDays, limitTage);
        return rows.reversed();
    }

    /**
     * Das 0,8-Quantil des Betrags "am Vortag erwartet minus gekommen" (kWh)
     * über die letzten Tage - der Rückblick-Satz ("An 8 von 10 Tagen
     * höchstens X kWh daneben", Bericht 6.1). {@code null} ohne eine Zeile.
     */
    public Double quantil80Kwh(UUID siteId, String kind, String model, int leadDays, LocalDate since) {
        BigDecimal v = jdbc.queryForObject(
                "SELECT percentile_cont(0.8) WITHIN GROUP (ORDER BY ABS(erwartet_kwh - gemessen_kwh)) "
                        + "FROM forecast_rueckblick "
                        + "WHERE site_id = ? AND kind = ? AND model = ? AND lead_days = ? AND day >= ?",
                BigDecimal.class, siteId, kind, model, leadDays, since);
        return toDouble(v);
    }

    /** Wie viele Tage EINES Modells im Fenster bewertet sind. */
    public int bewertetTage(UUID siteId, String kind, String model, int leadDays, LocalDate since) {
        Integer n = jdbc.queryForObject(
                "SELECT count(*) FROM forecast_rueckblick "
                        + "WHERE site_id = ? AND kind = ? AND model = ? AND lead_days = ? AND day >= ?",
                Integer.class, siteId, kind, model, leadDays, since);
        return n == null ? 0 : n;
    }

    /**
     * Der Vortagsvergleich JEDES Modells dieser Anlage und Art (S5, Bericht
     * R.4) - nicht nur des aktiven, weil die Automatik Kandidaten dagegen
     * misst.
     */
    public List<ModellVergleich> vergleich(UUID siteId, String kind, int leadDays, LocalDate since) {
        return jdbc.query(
                "SELECT model, AVG(mae_kw) AS mean_mae, "
                        + "AVG(ABS(erwartet_kwh - gemessen_kwh)) AS mean_tagesfehler, count(*) AS tage "
                        + "FROM forecast_rueckblick "
                        + "WHERE site_id = ? AND kind = ? AND lead_days = ? AND day >= ? "
                        + "GROUP BY model",
                (rs, i) -> new ModellVergleich(
                        rs.getString("model"),
                        toDouble(rs.getBigDecimal("mean_mae")),
                        toDouble(rs.getBigDecimal("mean_tagesfehler")),
                        rs.getInt("tage")),
                siteId, kind, leadDays, since);
    }

    private static Double toDouble(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }
}
