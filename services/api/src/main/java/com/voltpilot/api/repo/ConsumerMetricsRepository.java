package com.voltpilot.api.repo;

import com.voltpilot.api.consumers.ConsumerRequirementLedger.State;
import com.voltpilot.api.metrics.ConsumerMetrics.ConsumerRow;
import com.voltpilot.api.metrics.ConsumerMetrics.TaskRow;
import java.time.Instant;
import java.util.List;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The raw cross-tenant rows behind the consumer §18 metrics
 * ({@link com.voltpilot.api.metrics.ConsumerMetricsCollector}). Read-only, and -
 * like {@link FleetMetricsRepository} - on the BYPASSRLS {@code voltpilot_admin}
 * role: the collector runs on a timer with no {@code TenantContext}, so under the
 * tenant-scoped datasource RLS' default-deny would return an empty fleet. The
 * admin role's SELECT on these Flyway-created tables comes from V4's ALTER
 * DEFAULT PRIVILEGES (no explicit grant needed).
 */
@Repository
public class ConsumerMetricsRepository {

    private final JdbcTemplate admin;

    public ConsumerMetricsRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /**
     * Every controllable consumer joined with its live runtime state - a state only an ausgebaut
     * box reported is no live state (UEMS AP-07 IP-11), the consumer then counts as unconfirmed.
     */
    public List<ConsumerRow> consumers() {
        return admin.query(
                "SELECT cp.enabled, "
                        + "EXISTS (SELECT 1 FROM consumer_policy pol WHERE pol.entity_id = "
                        + "cp.entity_id AND pol.lifecycle = 'active') AS active_policy, "
                        + "(mp.device_id IS NOT NULL OR mp.edge_source_id IS NOT NULL "
                        + "OR cp.io_entity_id IS NOT NULL) AS connected, "
                        + "crs.state, crs.confirmed, crs.reason_code "
                        + "FROM consumer_profile cp "
                        + "JOIN measurement_point mp ON mp.id = cp.entity_id "
                        + "LEFT JOIN consumer_runtime_status crs ON crs.entity_id = cp.entity_id "
                        + "AND EXISTS (SELECT 1 FROM device d WHERE d.id = crs.device_id AND d.ausgebaut_am IS NULL)",
                (rs, i) -> new ConsumerRow(rs.getBoolean("enabled"), rs.getBoolean("active_policy"),
                        rs.getBoolean("connected"), rs.getString("state"),
                        (Boolean) rs.getObject("confirmed"), rs.getString("reason_code")));
    }

    /** Every current recurring-requirement instance across the fleet. */
    public List<TaskRow> tasks() {
        return admin.query(
                "SELECT deadline, state, required_runtime_seconds, actual_runtime_seconds "
                        + "FROM consumer_requirement_state",
                (rs, i) -> new TaskRow(rs.getTimestamp("deadline").toInstant(),
                        State.fromLabel(rs.getString("state")),
                        (Integer) rs.getObject("required_runtime_seconds"),
                        rs.getInt("actual_runtime_seconds")));
    }

    /** Connected consumer devices fleet-wide, grouped by entity_type (§D11 list). */
    public java.util.Map<String, Integer> connectedCountByType() {
        java.util.Map<String, Integer> out = new java.util.LinkedHashMap<>();
        List<Object[]> rows = admin.query(
                "SELECT mp.entity_type, count(*) AS n FROM consumer_profile cp "
                        + "JOIN measurement_point mp ON mp.id = cp.entity_id "
                        + "WHERE mp.device_id IS NOT NULL OR mp.edge_source_id IS NOT NULL "
                        + "OR cp.io_entity_id IS NOT NULL "
                        + "GROUP BY mp.entity_type",
                (rs, i) -> new Object[] {rs.getString("entity_type"), rs.getInt("n")});
        for (Object[] r : rows) {
            out.put((String) r[0], (Integer) r[1]);
        }
        return out;
    }

    /** The number of ACTIVE (unexpired) manual overrides across the fleet. */
    public int activeOverrides(Instant now) {
        Integer n = admin.queryForObject(
                "SELECT count(*) FROM consumer_override WHERE ends_at > ?", Integer.class,
                java.sql.Timestamp.from(now));
        return n == null ? 0 : n;
    }
}
