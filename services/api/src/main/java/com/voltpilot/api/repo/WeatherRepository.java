package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.WeatherForecastDto;
import com.voltpilot.api.web.dto.WeatherPointDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Weather forecasts for the current tenant's sites. The {@code weather_forecast}
 * table carries {@code tenant_id} and is RLS-scoped (migration V20260701010000),
 * so - like telemetry - every query is transparently narrowed to the caller's
 * tenant; no tenant predicate is needed or trusted here. Written by
 * services/forecast (Open-Meteo); the api only reads the latest run per site.
 */
@Repository
public class WeatherRepository {

    private final JdbcTemplate jdbc;

    public WeatherRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The most recent forecast run for a site, or {@code null} if none stored. */
    public WeatherForecastDto latestForSite(UUID siteId) {
        List<Instant> runs = jdbc.query(
                "SELECT max(run_at) AS run_at FROM weather_forecast WHERE site_id = ?",
                (rs, i) -> {
                    var ts = rs.getTimestamp("run_at");
                    return ts == null ? null : ts.toInstant();
                },
                siteId);
        Instant runAt = runs.isEmpty() ? null : runs.get(0);
        if (runAt == null) {
            return null;
        }
        List<WeatherPointDto> points = jdbc.query(
                "SELECT time, temperature_c, cloud_cover_pct, ghi_w_m2, dni_w_m2, dhi_w_m2 "
                        + "FROM weather_forecast WHERE site_id = ? AND run_at = ? "
                        + "ORDER BY time ASC",
                (rs, i) -> new WeatherPointDto(
                        rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("temperature_c"),
                        rs.getBigDecimal("cloud_cover_pct"),
                        rs.getBigDecimal("ghi_w_m2"),
                        rs.getBigDecimal("dni_w_m2"),
                        rs.getBigDecimal("dhi_w_m2")),
                siteId, java.sql.Timestamp.from(runAt));
        return new WeatherForecastDto(runAt, points);
    }
}
