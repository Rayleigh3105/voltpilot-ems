package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.ScheduleSlotDto;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Optimizer plans for the current tenant's sites. The {@code schedule}
 * hypertable carries {@code tenant_id} and is RLS-scoped (migration
 * V20260701020000), so - like telemetry/weather - every query is transparently
 * narrowed to the caller's tenant. Written by services/optimization (one row
 * per plan slot); the api only reads the latest run per site.
 */
@Repository
public class ScheduleRepository {

    private final JdbcTemplate jdbc;

    public ScheduleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The most recent plan for a site, or {@code null} if none stored. */
    public SchedulePlanDto latestForSite(UUID siteId) {
        List<Instant> runs = jdbc.query(
                "SELECT max(generated_at) AS generated_at FROM schedule WHERE site_id = ?",
                (rs, i) -> {
                    var ts = rs.getTimestamp("generated_at");
                    return ts == null ? null : ts.toInstant();
                },
                siteId);
        Instant generatedAt = runs.isEmpty() ? null : runs.get(0);
        if (generatedAt == null) {
            return null;
        }
        List<ScheduleSlotDto> slots = jdbc.query(
                "SELECT time, battery_kw, grid_kw, soc_pct, price_eur_mwh, cost_eur, baseline_cost_eur "
                        + "FROM schedule WHERE site_id = ? AND generated_at = ? "
                        + "ORDER BY time ASC",
                (rs, i) -> new ScheduleSlotDto(
                        rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("battery_kw"),
                        rs.getBigDecimal("grid_kw"),
                        rs.getBigDecimal("soc_pct"),
                        rs.getBigDecimal("price_eur_mwh"),
                        rs.getBigDecimal("cost_eur"),
                        rs.getBigDecimal("baseline_cost_eur")),
                siteId, Timestamp.from(generatedAt));
        List<Object[]> meta = jdbc.query(
                "SELECT plan_id, device_id FROM schedule "
                        + "WHERE site_id = ? AND generated_at = ? LIMIT 1",
                (rs, i) -> new Object[] {
                        rs.getObject("plan_id", UUID.class),
                        rs.getObject("device_id", UUID.class)
                },
                siteId, Timestamp.from(generatedAt));
        UUID planId = meta.isEmpty() ? null : (UUID) meta.get(0)[0];
        UUID deviceId = meta.isEmpty() ? null : (UUID) meta.get(0)[1];
        BigDecimal savings = slots.stream()
                .map(s -> nz(s.baselineCostEur()).subtract(nz(s.costEur())))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return new SchedulePlanDto(planId, deviceId, generatedAt, 15, savings, slots);
    }

    private static BigDecimal nz(BigDecimal v) {
        return v == null ? BigDecimal.ZERO : v;
    }
}
