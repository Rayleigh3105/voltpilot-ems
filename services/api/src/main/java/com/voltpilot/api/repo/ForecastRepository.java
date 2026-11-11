package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ForecastSeriesDto;
import com.voltpilot.api.web.dto.ForecastValueDto;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * S1 ("der Lesepunkt", report vp-prognosen-konzept section 9): reads the
 * quarter-hour {@code forecast} hypertable for the portal.
 *
 * <p><b>The fence.</b> {@code forecast} is the one customer-data table with
 * {@code tenant_id} but NO RLS - and it cannot get one any more (compressed
 * since V20260809000000; RLS and compression are mutually exclusive in every
 * available TimescaleDB version). Every method here is called with a
 * {@code siteId} the CALLER has already resolved through
 * {@code Geltungsbereich.requireSite} (a foreign site is a 404 before this
 * class ever runs a query) - the {@code SeriesRepository.previewForSite}
 * pattern (vp-scale-readiness-p4 §4.2), not a {@code site}-join. See
 * {@code ForecastTableDisciplineTest} for the enforced allowlist.
 */
@Repository
public class ForecastRepository {

    private final JdbcTemplate jdbc;

    public ForecastRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The newest run's full series for one site/kind/model, or an empty,
     * {@code null}-run series if that model has never run for the site. */
    public ForecastSeriesDto latest(UUID siteId, String kind, String model) {
        List<Instant> runs = jdbc.query(
                "SELECT max(run_at) AS run_at FROM forecast "
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
                "SELECT time, value_kw FROM forecast "
                        + "WHERE site_id = ? AND kind = ? AND model = ? AND run_at = ? "
                        + "ORDER BY time ASC",
                (rs, i) -> new ForecastValueDto(
                        rs.getTimestamp("time").toInstant(), rs.getBigDecimal("value_kw")),
                siteId, kind, model, Timestamp.from(runAt));
        return new ForecastSeriesDto(runAt, points);
    }

    /**
     * "Gestern erwartet": the run closest to {@code target} within
     * {@code tolerance} (never the newer of two candidates, only the
     * closer - the {@code storage_release.evening_runs}/
     * {@code night_reserve._evening_run_target} convention, 17:45 Europe/
     * Berlin of the previous day ± 15 min), restricted to the slots in
     * {@code [dayStart, dayEnd)}. An empty, {@code null}-run series when no
     * run landed inside the tolerance window.
     */
    public ForecastSeriesDto evening(
            UUID siteId, String kind, String model,
            Instant target, Duration tolerance, Instant dayStart, Instant dayEnd) {
        List<Instant> candidates = jdbc.query(
                "SELECT run_at FROM forecast "
                        + "WHERE site_id = ? AND kind = ? AND model = ? "
                        + "AND run_at BETWEEN ? AND ? "
                        + "ORDER BY abs(extract(epoch FROM (run_at - ?))), run_at "
                        + "LIMIT 1",
                (rs, i) -> rs.getTimestamp("run_at").toInstant(),
                siteId, kind, model,
                Timestamp.from(target.minus(tolerance)), Timestamp.from(target.plus(tolerance)),
                Timestamp.from(target));
        if (candidates.isEmpty()) {
            return new ForecastSeriesDto(null, List.of());
        }
        Instant runAt = candidates.get(0);
        List<ForecastValueDto> points = jdbc.query(
                "SELECT time, value_kw FROM forecast "
                        + "WHERE site_id = ? AND kind = ? AND model = ? AND run_at = ? "
                        + "AND time >= ? AND time < ? ORDER BY time ASC",
                (rs, i) -> new ForecastValueDto(
                        rs.getTimestamp("time").toInstant(), rs.getBigDecimal("value_kw")),
                siteId, kind, model, Timestamp.from(runAt),
                Timestamp.from(dayStart), Timestamp.from(dayEnd));
        return new ForecastSeriesDto(runAt, points);
    }
}
