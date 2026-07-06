package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.TelemetryPointDto;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/** Telemetry reads for the current tenant (RLS-scoped, see migration V2). */
@Repository
public class TelemetryRepository {

    /**
     * Windows up to this length return raw samples; longer windows are
     * downsampled server-side to per-minute averages via {@code time_bucket}.
     * A chatty edge (~10 s cadence, ~8.6k rows/day) then yields at most 1440
     * points for the default 24 h window - complete AND current - instead of
     * running into the row limit.
     */
    private static final Duration RAW_WINDOW = Duration.ofHours(3);

    private static final String COLUMNS = "power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw";

    private static final RowMapper<TelemetryPointDto> MAPPER = (rs, i) -> new TelemetryPointDto(
            rs.getTimestamp("time").toInstant(),
            rs.getBigDecimal("power_kw"),
            rs.getBigDecimal("soc_pct"),
            rs.getBigDecimal("pv_power_kw"),
            rs.getBigDecimal("load_kw"),
            rs.getBigDecimal("grid_limit_kw"));

    private final JdbcTemplate jdbc;

    public TelemetryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * The site's telemetry in {@code [from, to]}, ascending, at most {@code limit}
     * points. Both paths query {@code ORDER BY time DESC LIMIT} and reverse, so
     * when the limit bites it drops the OLDEST points - the previous
     * {@code ORDER BY time ASC LIMIT} truncated away the NEWEST samples, freezing
     * the "Live-Daten" view hours in the past on any normally-chatty site.
     */
    public List<TelemetryPointDto> findForSite(UUID siteId, Instant from, Instant to, int limit) {
        boolean raw = Duration.between(from, to).compareTo(RAW_WINDOW) <= 0;
        String sql = raw
                ? "SELECT time, " + COLUMNS + " FROM telemetry "
                        + "WHERE site_id = ? AND time >= ? AND time <= ? "
                        + "ORDER BY time DESC LIMIT ?"
                : "SELECT time_bucket(interval '1 minute', time) AS time, "
                        + "round(avg(power_kw), 3) AS power_kw, "
                        + "round(avg(soc_pct), 1) AS soc_pct, "
                        + "round(avg(pv_power_kw), 3) AS pv_power_kw, "
                        + "round(avg(load_kw), 3) AS load_kw, "
                        + "round(avg(grid_limit_kw), 3) AS grid_limit_kw "
                        + "FROM telemetry "
                        + "WHERE site_id = ? AND time >= ? AND time <= ? "
                        + "GROUP BY 1 ORDER BY 1 DESC LIMIT ?";
        List<TelemetryPointDto> points =
                jdbc.query(sql, MAPPER, siteId, Timestamp.from(from), Timestamp.from(to), limit);
        Collections.reverse(points);
        return points;
    }
}
