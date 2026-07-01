package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.TelemetryPointDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Telemetry reads for the current tenant (RLS-scoped, see migration V2). */
@Repository
public class TelemetryRepository {

    private final JdbcTemplate jdbc;

    public TelemetryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<TelemetryPointDto> findForSite(UUID siteId, Instant from, Instant to, int limit) {
        return jdbc.query(
                "SELECT time, power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw "
                        + "FROM telemetry "
                        + "WHERE site_id = ? AND time >= ? AND time <= ? "
                        + "ORDER BY time ASC "
                        + "LIMIT ?",
                (rs, i) -> new TelemetryPointDto(
                        rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("power_kw"),
                        rs.getBigDecimal("soc_pct"),
                        rs.getBigDecimal("pv_power_kw"),
                        rs.getBigDecimal("load_kw"),
                        rs.getBigDecimal("grid_limit_kw")),
                siteId, Timestamp.from(from), Timestamp.from(to), limit);
    }
}
