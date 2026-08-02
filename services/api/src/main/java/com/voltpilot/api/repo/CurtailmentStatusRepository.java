package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Feed-in curtailment confirmations (device_curtailment_status, migration
 * V20260802020000), RLS-scoped to the current tenant exactly like every
 * device-owned table. The curtailment listener upserts one row per device from
 * the heartbeat's {@code curtailment} block; the portal reads the newest row
 * per site.
 */
@Repository
public class CurtailmentStatusRepository {

    private final JdbcTemplate jdbc;

    public CurtailmentStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Upsert the latest curtailment truth for a device. RLS' WITH CHECK
     * guarantees the row lands in the session tenant (the listener sets it from
     * the topic), so a mismatched tenant can never be written.
     *
     * <p>The whole row is REPLACED per heartbeat - a device that stops applying
     * a cap must not keep an old {@code applied_cap_kw} on file.
     */
    public void upsert(UUID deviceId, UUID siteId, int units, int certifiedUnits,
            boolean controlEnabled, boolean active, Double appliedCapKw, Boolean allMatch,
            boolean possibleOverride, Instant checkedAt) {
        jdbc.update(
                "INSERT INTO device_curtailment_status (device_id, tenant_id, site_id, units, "
                        + "certified_units, control_enabled, active, applied_cap_kw, all_match, "
                        + "possible_override, checked_at, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, units = EXCLUDED.units, "
                        + "certified_units = EXCLUDED.certified_units, "
                        + "control_enabled = EXCLUDED.control_enabled, active = EXCLUDED.active, "
                        + "applied_cap_kw = EXCLUDED.applied_cap_kw, all_match = EXCLUDED.all_match, "
                        + "possible_override = EXCLUDED.possible_override, "
                        + "checked_at = EXCLUDED.checked_at, updated_at = now()",
                deviceId, siteId, units, certifiedUnits, controlEnabled, active, appliedCapKw,
                allMatch, possibleOverride, Timestamp.from(checkedAt));
    }

    /** The newest curtailment truth for a site (across its devices), or empty. */
    public Optional<CurtailmentStatusDto> latestForSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, units, certified_units, control_enabled, active, "
                        + "applied_cap_kw, all_match, possible_override, checked_at "
                        + "FROM device_curtailment_status WHERE site_id = ? "
                        + "ORDER BY checked_at DESC LIMIT 1",
                (rs, i) -> new CurtailmentStatusDto(
                        rs.getObject("device_id", UUID.class),
                        rs.getInt("units"),
                        rs.getInt("certified_units"),
                        rs.getBoolean("control_enabled"),
                        rs.getBoolean("active"),
                        (Double) rs.getObject("applied_cap_kw"),
                        // Nullable on purpose: "nothing applied" must not read as
                        // "the readback disagreed" (getBoolean would say false).
                        rs.getObject("all_match", Boolean.class),
                        rs.getBoolean("possible_override"),
                        rs.getTimestamp("checked_at").toInstant()),
                siteId).stream().findFirst();
    }
}
