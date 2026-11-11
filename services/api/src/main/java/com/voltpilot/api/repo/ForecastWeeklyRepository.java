package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ForecastSeriesDto;
import com.voltpilot.api.web.dto.ForecastValueDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * S4 ("die Woche je Stunde"): reads the hourly {@code forecast_weekly}
 * hypertable (migration V20261111140000) for the portal.
 *
 * <p>Unlike {@code forecast}, this table carries RLS (it is not compressed -
 * the weather_forecast precedent), so - like {@link WeatherRepository} and
 * {@link ScheduleRepository} - every query here is transparently narrowed to
 * the caller's tenant; no tenant predicate is needed or trusted here.
 * Written by services/forecast as the trusted backend role; the api only
 * reads.
 */
@Repository
public class ForecastWeeklyRepository {

    private final JdbcTemplate jdbc;

    public ForecastWeeklyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The newest outlook run's full series for one site/kind/model, or an
     * empty, {@code null}-run series if none exists yet. */
    public ForecastSeriesDto latest(UUID siteId, String kind, String model) {
        List<Instant> runs = jdbc.query(
                "SELECT max(run_at) AS run_at FROM forecast_weekly "
                        + "WHERE site_id = ? AND kind = ? AND model = ?",
                (rs, i) -> {
                    var ts = rs.getTimestamp("run_at");
                    return ts == null ? null : ts.toInstant();
                },
                siteId, kind, model);
        Instant runAt = runs.isEmpty() ? null : runs.get(0);
        if (runAt == null) {
            return new ForecastSeriesDto(null, List.of());
        }
        List<ForecastValueDto> points = jdbc.query(
                "SELECT time, value_kw FROM forecast_weekly "
                        + "WHERE site_id = ? AND kind = ? AND model = ? AND run_at = ? "
                        + "ORDER BY time ASC",
                (rs, i) -> new ForecastValueDto(
                        rs.getTimestamp("time").toInstant(), rs.getBigDecimal("value_kw")),
                siteId, kind, model, Timestamp.from(runAt));
        return new ForecastSeriesDto(runAt, points);
    }
}
