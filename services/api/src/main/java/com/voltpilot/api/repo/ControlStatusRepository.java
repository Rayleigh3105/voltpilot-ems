package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ControlStatusDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Inverter control confirmations (device_control_status, migrations
 * V20260708000000 + V20260802000000), RLS-scoped to the current tenant exactly
 * like every device-owned table. The status listener upserts one row per device
 * from the heartbeat's {@code control} block; the portal reads the newest row
 * per site.
 */
@Repository
public class ControlStatusRepository {

    /**
     * The in-slot EXECUTION truth of one heartbeat (migration
     * V20260802000000): WHY the commanded setpoint is what it is.
     *
     * <p>Every field is nullable and an absent one means "the device did not
     * report it" - never a fabricated value. {@link #NONE} is the honest empty
     * case (an older edge, or a heartbeat whose block could not be parsed).
     *
     * @param source    the device's COARSE truth {@code "schedule"|"default"}
     *                  - it collapses every non-schedule mode into
     *                  {@code default}, so it may never be read as "the
     *                  built-in safety rule is running".
     * @param mode      {@code plan|follow|trim|fallback}, the PRECISE reason.
     * @param direction {@code deepen|reduce}, only for {@code follow}.
     * @param plannedKw the setpoint BEFORE the correction.
     * @param targetKw  the MEASURED value the correction tracks (house deficit
     *                  for {@code follow}, PV surplus for {@code trim}).
     */
    public record Execution(String source, String mode, String direction,
            Double plannedKw, Double targetKw) {

        public static final Execution NONE = new Execution(null, null, null, null, null);
    }

    private final JdbcTemplate jdbc;

    public ControlStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Upsert the latest control confirmation for a device. RLS' WITH CHECK
     * guarantees the row lands in the session tenant (the listener sets it from
     * the topic), so a mismatched tenant can never be written.
     *
     * <p>The whole row is REPLACED per heartbeat, execution columns included -
     * a device that stops correcting must not keep an old direction on file.
     */
    public void upsert(UUID deviceId, UUID siteId, Double commandedKw, Double confirmedKw,
            boolean allMatch, boolean controlEnabled, boolean certified,
            String mismatchRoles, Instant slotStart, Instant checkedAt, Execution execution) {
        Execution ex = execution == null ? Execution.NONE : execution;
        jdbc.update(
                "INSERT INTO device_control_status (device_id, tenant_id, site_id, commanded_kw, "
                        + "confirmed_kw, all_match, control_enabled, certified, mismatch_roles, "
                        + "slot_start, checked_at, control_source, execution_mode, execution_direction, "
                        + "execution_planned_kw, execution_target_kw, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                        + "?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, commanded_kw = EXCLUDED.commanded_kw, "
                        + "confirmed_kw = EXCLUDED.confirmed_kw, all_match = EXCLUDED.all_match, "
                        + "control_enabled = EXCLUDED.control_enabled, certified = EXCLUDED.certified, "
                        + "mismatch_roles = EXCLUDED.mismatch_roles, slot_start = EXCLUDED.slot_start, "
                        + "checked_at = EXCLUDED.checked_at, control_source = EXCLUDED.control_source, "
                        + "execution_mode = EXCLUDED.execution_mode, "
                        + "execution_direction = EXCLUDED.execution_direction, "
                        + "execution_planned_kw = EXCLUDED.execution_planned_kw, "
                        + "execution_target_kw = EXCLUDED.execution_target_kw, updated_at = now()",
                deviceId, siteId, commandedKw, confirmedKw, allMatch, controlEnabled, certified,
                mismatchRoles, slotStart == null ? null : Timestamp.from(slotStart), Timestamp.from(checkedAt),
                ex.source(), ex.mode(), ex.direction(), ex.plannedKw(), ex.targetKw());
    }

    /** The newest control confirmation for a site (across its devices), or empty. */
    public Optional<ControlStatusDto> latestForSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, commanded_kw, confirmed_kw, all_match, control_enabled, certified, "
                        + "mismatch_roles, slot_start, checked_at, control_source, execution_mode, "
                        + "execution_direction, execution_planned_kw, execution_target_kw "
                        + "FROM device_control_status WHERE site_id = ? ORDER BY checked_at DESC LIMIT 1",
                (rs, i) -> new ControlStatusDto(
                        rs.getObject("device_id", UUID.class),
                        (Double) rs.getObject("commanded_kw"),
                        (Double) rs.getObject("confirmed_kw"),
                        rs.getBoolean("all_match"),
                        rs.getBoolean("control_enabled"),
                        rs.getBoolean("certified"),
                        rs.getString("mismatch_roles"),
                        rs.getTimestamp("slot_start") == null ? null : rs.getTimestamp("slot_start").toInstant(),
                        rs.getTimestamp("checked_at").toInstant(),
                        rs.getString("control_source"),
                        rs.getString("execution_mode"),
                        rs.getString("execution_direction"),
                        (Double) rs.getObject("execution_planned_kw"),
                        (Double) rs.getObject("execution_target_kw")),
                siteId).stream().findFirst();
    }
}
