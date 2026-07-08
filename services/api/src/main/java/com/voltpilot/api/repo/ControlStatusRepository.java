package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.ControlStatusDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Inverter control confirmations (device_control_status, migration
 * V20260708000000), RLS-scoped to the current tenant exactly like every
 * device-owned table. The status listener upserts one row per device from the
 * heartbeat's {@code control} block; the portal reads the newest row per site.
 */
@Repository
public class ControlStatusRepository {

    private final JdbcTemplate jdbc;

    public ControlStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Upsert the latest control confirmation for a device. RLS' WITH CHECK
     * guarantees the row lands in the session tenant (the listener sets it from
     * the topic), so a mismatched tenant can never be written.
     */
    public void upsert(UUID deviceId, UUID siteId, Double commandedKw, Double confirmedKw,
            boolean allMatch, boolean controlEnabled, boolean certified,
            String mismatchRoles, Instant slotStart, Instant checkedAt) {
        jdbc.update(
                "INSERT INTO device_control_status (device_id, tenant_id, site_id, commanded_kw, "
                        + "confirmed_kw, all_match, control_enabled, certified, mismatch_roles, "
                        + "slot_start, checked_at, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, commanded_kw = EXCLUDED.commanded_kw, "
                        + "confirmed_kw = EXCLUDED.confirmed_kw, all_match = EXCLUDED.all_match, "
                        + "control_enabled = EXCLUDED.control_enabled, certified = EXCLUDED.certified, "
                        + "mismatch_roles = EXCLUDED.mismatch_roles, slot_start = EXCLUDED.slot_start, "
                        + "checked_at = EXCLUDED.checked_at, updated_at = now()",
                deviceId, siteId, commandedKw, confirmedKw, allMatch, controlEnabled, certified,
                mismatchRoles, slotStart == null ? null : Timestamp.from(slotStart), Timestamp.from(checkedAt));
    }

    /** The newest control confirmation for a site (across its devices), or empty. */
    public Optional<ControlStatusDto> latestForSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, commanded_kw, confirmed_kw, all_match, control_enabled, certified, "
                        + "mismatch_roles, slot_start, checked_at "
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
                        rs.getTimestamp("checked_at").toInstant()),
                siteId).stream().findFirst();
    }
}
