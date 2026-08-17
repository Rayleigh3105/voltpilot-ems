package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import com.voltpilot.api.web.dto.DeviceExportLimitDto;
import com.voltpilot.api.web.dto.ExportGuardDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Feed-in curtailment confirmations (device_curtailment_status, migrations
 * V20260802020000 + V20260822000000), RLS-scoped to the current tenant exactly
 * like every device-owned table. The curtailment listener upserts one row per
 * device from the heartbeat's {@code curtailment} block; the portal reads the
 * newest row per site.
 *
 * <p>Write and read share ONE shape ({@link CurtailmentStatusDto}) on purpose:
 * the row IS the block, and a separate write record would be a second place to
 * forget a field. Only {@code siteId} travels beside it - the read is already
 * site-scoped, so the DTO does not carry it.
 */
@Repository
public class CurtailmentStatusRepository {

    /**
     * The columns {@link #map(ResultSet)} needs. Shared with
     * {@code AdminFleetRepository} (same package) so the fleet aggregate and the
     * per-site read can never disagree about the same row.
     */
    static final String COLUMNS =
            "device_id, units, certified_units, control_enabled, active, applied_cap_kw, "
                    + "all_match, possible_override, checked_at, guard_limit_kw, guard_state, "
                    + "guard_reason, guard_cap_kw, guard_limiting, guard_blind, guard_effective, "
                    + "guard_reach, device_export_limit_kw, device_export_limit_register, "
                    + "device_export_limit_read_at";

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
     * a cap must not keep an old {@code applied_cap_kw} on file, and a device
     * whose watchdog went away must not keep an old guard verdict on file
     * either. That is why every nested block is written as NULLs when absent
     * rather than left untouched.
     */
    public void upsert(UUID siteId, CurtailmentStatusDto row) {
        ExportGuardDto g = row.exportGuard();
        DeviceExportLimitDto d = row.deviceExportLimit();
        jdbc.update(
                "INSERT INTO device_curtailment_status (device_id, tenant_id, site_id, units, "
                        + "certified_units, control_enabled, active, applied_cap_kw, all_match, "
                        + "possible_override, checked_at, guard_limit_kw, guard_state, "
                        + "guard_reason, guard_cap_kw, guard_limiting, guard_blind, "
                        + "guard_effective, guard_reach, device_export_limit_kw, "
                        + "device_export_limit_register, device_export_limit_read_at, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, units = EXCLUDED.units, "
                        + "certified_units = EXCLUDED.certified_units, "
                        + "control_enabled = EXCLUDED.control_enabled, active = EXCLUDED.active, "
                        + "applied_cap_kw = EXCLUDED.applied_cap_kw, all_match = EXCLUDED.all_match, "
                        + "possible_override = EXCLUDED.possible_override, "
                        + "checked_at = EXCLUDED.checked_at, "
                        + "guard_limit_kw = EXCLUDED.guard_limit_kw, "
                        + "guard_state = EXCLUDED.guard_state, "
                        + "guard_reason = EXCLUDED.guard_reason, "
                        + "guard_cap_kw = EXCLUDED.guard_cap_kw, "
                        + "guard_limiting = EXCLUDED.guard_limiting, "
                        + "guard_blind = EXCLUDED.guard_blind, "
                        + "guard_effective = EXCLUDED.guard_effective, "
                        + "guard_reach = EXCLUDED.guard_reach, "
                        + "device_export_limit_kw = EXCLUDED.device_export_limit_kw, "
                        + "device_export_limit_register = EXCLUDED.device_export_limit_register, "
                        + "device_export_limit_read_at = EXCLUDED.device_export_limit_read_at, "
                        + "updated_at = now()",
                row.deviceId(), siteId, row.units(), row.certifiedUnits(), row.controlEnabled(),
                row.active(), row.appliedCapKw(), row.allMatch(), row.possibleOverride(),
                Timestamp.from(row.checkedAt()),
                g == null ? null : g.limitKw(),
                g == null ? null : g.state(),
                g == null ? null : g.reason(),
                g == null ? null : g.capKw(),
                g == null ? null : g.limiting(),
                g == null ? null : g.blind(),
                g == null ? null : g.effective(),
                g == null ? null : g.reach(),
                d == null ? null : d.limitKw(),
                d == null ? null : d.register(),
                d == null ? null : Timestamp.from(d.readAt()));
    }

    /** The newest curtailment truth for a site (across its devices), or empty. */
    public Optional<CurtailmentStatusDto> latestForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM device_curtailment_status WHERE site_id = ? "
                        + "ORDER BY checked_at DESC LIMIT 1",
                (rs, i) -> map(rs), siteId).stream().findFirst();
    }

    /** One {@link #COLUMNS} row -> the DTO. Package-visible: see {@link #COLUMNS}. */
    static CurtailmentStatusDto map(ResultSet rs) throws SQLException {
        return new CurtailmentStatusDto(
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
                rs.getTimestamp("checked_at").toInstant(),
                guard(rs),
                deviceLimit(rs));
    }

    /**
     * The guard block, or null when the device did not report one. The STATE is
     * the discriminator: the ingest only ever stores it together with a valid
     * limit, so a null state means "no watchdog reported", never "a watchdog
     * with an unknown state".
     */
    private static ExportGuardDto guard(ResultSet rs) throws SQLException {
        String state = rs.getString("guard_state");
        if (state == null) {
            return null;
        }
        return new ExportGuardDto(
                rs.getDouble("guard_limit_kw"),
                state,
                rs.getString("guard_reason"),
                (Double) rs.getObject("guard_cap_kw"),
                Boolean.TRUE.equals(rs.getObject("guard_limiting", Boolean.class)),
                Boolean.TRUE.equals(rs.getObject("guard_blind", Boolean.class)),
                Boolean.TRUE.equals(rs.getObject("guard_effective", Boolean.class)),
                rs.getString("guard_reach"));
    }

    /** The device's own feed-in limit, or null when it was never read. */
    private static DeviceExportLimitDto deviceLimit(ResultSet rs) throws SQLException {
        Double kw = (Double) rs.getObject("device_export_limit_kw");
        Timestamp readAt = rs.getTimestamp("device_export_limit_read_at");
        if (kw == null || readAt == null) {
            return null;
        }
        Instant at = readAt.toInstant();
        return new DeviceExportLimitDto(kw, rs.getString("device_export_limit_register"), at);
    }
}
