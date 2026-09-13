package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.CurtailmentStatusDto;
import com.voltpilot.api.web.dto.CurtailmentUnitDto;
import com.voltpilot.api.web.dto.DeviceExportLimitDto;
import com.voltpilot.api.web.dto.ExportGuardDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
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
     * The row was reported by a box that takes part in operation - not ausgebaut, and still there
     * (UEMS AP-07 IP-11). Shared with {@code AdminFleetRepository} like {@link #COLUMNS}: the fleet
     * aggregate asks the same question of the same row.
     */
    static final String BOX_AKTIV = "EXISTS (SELECT 1 FROM device d "
            + "WHERE d.id = device_curtailment_status.device_id AND d.ausgebaut_am IS NULL)";

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

    /**
     * Replace a device's per-unit curtailment breakdown (R4a / E2). The
     * heartbeat carries the COMPLETE list, so the set is replaced wholesale -
     * exactly like {@code device_source_status}: a unit that disappeared must
     * not linger as a ghost.
     *
     * <p>An EMPTY list therefore deletes: an older edge reports none, and the
     * consumer's honest reading of "no rows" is "not reported", never
     * "no units" (the count lives in {@code device_curtailment_status.units}).
     */
    public void replaceUnits(UUID siteId, UUID deviceId, List<CurtailmentUnitDto> units) {
        jdbc.update("DELETE FROM device_curtailment_unit WHERE device_id = ?", deviceId);
        for (CurtailmentUnitDto u : units) {
            jdbc.update(
                    "INSERT INTO device_curtailment_unit (device_id, source_id, tenant_id, "
                            + "site_id, certified, applied_cap_kw, match) VALUES (?, ?, "
                            + "NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?)",
                    deviceId, u.sourceId(), siteId, u.certified(), u.appliedCapKw(), u.match());
        }
    }

    /**
     * The newest curtailment truth for a site (across its devices), or empty -
     * WITH the reporting device's per-unit list attached.
     *
     * <p>The units are a SECOND query on purpose: they belong to the one device
     * this row came from, and folding them into the aggregate row's SELECT
     * would either duplicate the row per unit or need a join the fleet
     * aggregate (which shares {@link #COLUMNS}) must not pay for.
     *
     * <p>Only a box that takes part in operation counts (UEMS AP-07 IP-11): the row of an
     * ausgebaut box stays stored, but its last report is never the site's current state.
     */
    public Optional<CurtailmentStatusDto> latestForSite(UUID siteId) {
        Optional<CurtailmentStatusDto> row = jdbc.query(
                "SELECT " + COLUMNS + " FROM device_curtailment_status WHERE site_id = ? "
                        + "AND " + BOX_AKTIV + " ORDER BY checked_at DESC LIMIT 1",
                (rs, i) -> map(rs), siteId).stream().findFirst();
        return row.map(r -> r.withPerUnit(unitsForDevice(r.deviceId())));
    }

    /** One device's per-unit breakdown, ordered by its join key (stable). */
    public List<CurtailmentUnitDto> unitsForDevice(UUID deviceId) {
        return jdbc.query(
                "SELECT source_id, certified, applied_cap_kw, match FROM device_curtailment_unit "
                        + "WHERE device_id = ? ORDER BY source_id",
                (rs, i) -> new CurtailmentUnitDto(
                        rs.getString("source_id"),
                        rs.getBoolean("certified"),
                        (Double) rs.getObject("applied_cap_kw"),
                        // Nullable on purpose: "nothing commanded" must not read
                        // as "the readback disagreed" (getBoolean would say false).
                        rs.getObject("match", Boolean.class)),
                deviceId);
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
