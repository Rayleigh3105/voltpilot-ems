package com.voltpilot.api.repo;

import com.voltpilot.api.consumers.ConsumerRequirementLedger.EnergyConfirmation;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.Row;
import com.voltpilot.api.consumers.ConsumerRequirementLedger.State;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The fulfilment ledger of recurring consumer requirements
 * (consumer_requirement_state, migration V20260813000000; Inkrement 5 / §9.4),
 * RLS-scoped to the current tenant through the {@code @Primary} datasource like
 * every consumer table. The WRITER (driven by the consumers heartbeat listener)
 * upserts one row per requirement instance; the read paths list per entity / per
 * site. Idempotent on {@code requirement_instance_id}, so a re-computation - and
 * later telemetry - overwrites the same row honestly (§9.4).
 */
@Repository
public class ConsumerRequirementStateRepository {

    private final JdbcTemplate jdbc;

    public ConsumerRequirementStateRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The (rated power, confirmation channel) of every ENABLED consumer of a site. */
    public record ProfileRow(UUID entityId, BigDecimal ratedPowerKw, String confirmationChannel) {}

    public List<ProfileRow> enabledProfiles(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, rated_power_kw, confirmation_channel "
                        + "FROM consumer_profile WHERE site_id = ? AND enabled = true",
                (rs, i) -> new ProfileRow(rs.getObject("entity_id", UUID.class),
                        rs.getBigDecimal("rated_power_kw"), rs.getString("confirmation_channel")),
                siteId);
    }

    /** The active policy document of a consumer, or null (no active policy). */
    public String activePolicyDocument(UUID siteId, UUID entityId) {
        List<String> docs = jdbc.queryForList(
                "SELECT document FROM consumer_policy "
                        + "WHERE site_id = ? AND entity_id = ? AND lifecycle = 'active' LIMIT 1",
                String.class, siteId, entityId);
        return docs.isEmpty() ? null : docs.get(0);
    }

    /**
     * The MEASURED/INTEGRATED energy of an entity over a period, from
     * telemetry_v2 (RLS-scoped). {@code integrated}=true integrates a power
     * channel (left-Riemann, kWh); false sums an energy channel as a delta
     * (max-min, for a cumulative kWh channel). Null when no telemetry covers the
     * period - the caller then downgrades the confirmation to ASSUMED (§9.4), so
     * a "measured" label is never claimed without data.
     */
    public BigDecimal energyOverPeriod(UUID entityId, String channel, Instant from, Instant to,
            boolean integrated) {
        if (channel == null || channel.isBlank()) {
            return null;
        }
        String sql = integrated
                ? "SELECT sum(value * extract(epoch from (next_t - time)) / 3600.0) AS kwh FROM ("
                        + "  SELECT time, value, lead(time) OVER (ORDER BY time) AS next_t "
                        + "  FROM telemetry_v2 WHERE entity_id = ? AND channel = ? "
                        + "    AND time >= ? AND time < ?) s WHERE next_t IS NOT NULL"
                : "SELECT max(value) - min(value) AS kwh FROM telemetry_v2 "
                        + "WHERE entity_id = ? AND channel = ? AND time >= ? AND time < ?";
        List<BigDecimal> rows = jdbc.query(sql,
                (rs, i) -> rs.getBigDecimal("kwh"),
                entityId, channel, Timestamp.from(from), Timestamp.from(to));
        if (rows.isEmpty() || rows.get(0) == null || rows.get(0).signum() < 0) {
            return null;
        }
        return rows.get(0);
    }

    /** Idempotent upsert of one requirement instance (RLS stamps the tenant). */
    public void upsert(UUID siteId, UUID entityId, Row row) {
        jdbc.update(
                "INSERT INTO consumer_requirement_state (requirement_instance_id, requirement_id, "
                        + "entity_id, tenant_id, site_id, period_start, deadline, required_energy_kwh, "
                        + "required_runtime_seconds, actual_energy_kwh, actual_runtime_seconds, "
                        + "energy_confirmation, state, reason_code, updated_at) VALUES (?, ?, ?, "
                        + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, ?, "
                        + "?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (requirement_instance_id) DO UPDATE SET "
                        + "period_start = EXCLUDED.period_start, deadline = EXCLUDED.deadline, "
                        + "required_energy_kwh = EXCLUDED.required_energy_kwh, "
                        + "required_runtime_seconds = EXCLUDED.required_runtime_seconds, "
                        + "actual_energy_kwh = EXCLUDED.actual_energy_kwh, "
                        + "actual_runtime_seconds = EXCLUDED.actual_runtime_seconds, "
                        + "energy_confirmation = EXCLUDED.energy_confirmation, "
                        + "state = EXCLUDED.state, reason_code = EXCLUDED.reason_code, "
                        + "updated_at = now()",
                row.instanceId(), row.requirementId(), entityId, siteId,
                Timestamp.from(row.periodStart()), Timestamp.from(row.deadline()),
                row.requiredEnergyKwh(), row.requiredRuntimeSeconds(), row.actualEnergyKwh(),
                row.actualRuntimeSeconds(),
                row.energyConfirmation() == null ? null : row.energyConfirmation().label(),
                row.state().label(), row.reasonCode());
    }

    /** The recent instances of one consumer (newest deadline first, small cap). */
    public List<Row> listForEntity(UUID siteId, UUID entityId) {
        return jdbc.query(select() + "WHERE site_id = ? AND entity_id = ? "
                + "ORDER BY deadline DESC LIMIT 14", (rs, i) -> map(rs), siteId, entityId);
    }

    /** All CURRENT/recent instances of a site (for the cockpit / metrics). */
    public List<Row> listForSite(UUID siteId) {
        return jdbc.query(select() + "WHERE site_id = ? ORDER BY entity_id, deadline DESC",
                (rs, i) -> map(rs), siteId);
    }

    private static String select() {
        return "SELECT requirement_instance_id, requirement_id, period_start, deadline, "
                + "required_energy_kwh, required_runtime_seconds, actual_energy_kwh, "
                + "actual_runtime_seconds, energy_confirmation, state, reason_code "
                + "FROM consumer_requirement_state ";
    }

    private static Row map(java.sql.ResultSet rs) {
        try {
            String levelRaw = rs.getString("energy_confirmation");
            EnergyConfirmation level = levelRaw == null ? null
                    : EnergyConfirmation.valueOf(levelRaw.toUpperCase());
            return new Row(
                    rs.getObject("requirement_instance_id", UUID.class),
                    rs.getString("requirement_id"),
                    rs.getTimestamp("period_start").toInstant(),
                    rs.getTimestamp("deadline").toInstant(),
                    rs.getBigDecimal("required_energy_kwh"),
                    (Integer) rs.getObject("required_runtime_seconds"),
                    rs.getBigDecimal("actual_energy_kwh"),
                    rs.getInt("actual_runtime_seconds"),
                    level,
                    State.fromLabel(rs.getString("state")),
                    rs.getString("reason_code"));
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }
}
