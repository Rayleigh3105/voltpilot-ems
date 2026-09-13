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
     * @param mode      the precise execution path, including {@code idle_follow},
     *                  the general {@code deficit_cover}, the bounded
     *                  {@code high_soc_charge} (and its retired discharge
     *                  sibling {@code high_soc_follow}, which only a box on an
     *                  older image still reports), the REDUCE-only
     *                  {@code limit} (the cloud's unpriced
     *                  {@code limit_discharge_to_load} right) and the separately
     *                  certified {@code autonomous_discharge}.
     * @param direction {@code deepen|reduce}, only for {@code follow} and
     *                  {@code limit} (where it is always {@code reduce}).
     * @param plannedKw the setpoint BEFORE the correction.
     * @param targetKw  the MEASURED value the correction tracks (house deficit
     *                  for follower modes, PV surplus for {@code trim}/{@code absorb}/
     *                  {@code high_soc_charge}).
     */
    public record Execution(String source, String mode, String direction,
            Double plannedKw, Double targetKw, Double effectiveFloorSocPct,
            Boolean measurementsFresh) {

        public static final Execution NONE = new Execution(null, null, null, null, null, null, null);
    }

    /**
     * WHY the control is (not) released - the platform-register half of the
     * heartbeat (Plattform-Register, 10.08.2026).
     *
     * <p>Every field is nullable, and ⚠ a null {@code verdict} is "the device
     * said nothing" (an older edge, or one that never saw a cloud document) -
     * NEVER "not covered". Only this distinction lets a surface tell "a bench
     * run is needed" from "one click is needed".
     *
     * @param source  {@code env|device|platform}: which source granted it.
     * @param verdict {@code granted|covered_not_activated|not_covered|unknown}.
     * @param model   the register entry that matched, when one did.
     * @param reason  the plain-German cause of a refusal.
     */
    public record CertState(String source, String verdict, String model, String reason) {

        public static final CertState NONE = new CertState(null, null, null, null);
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
            String mismatchRoles, Instant slotStart, Instant checkedAt, Execution execution,
            CertState cert) {
        Execution ex = execution == null ? Execution.NONE : execution;
        CertState ct = cert == null ? CertState.NONE : cert;
        jdbc.update(
                "INSERT INTO device_control_status (device_id, tenant_id, site_id, commanded_kw, "
                        + "confirmed_kw, all_match, control_enabled, certified, mismatch_roles, "
                        + "slot_start, checked_at, control_source, execution_mode, execution_direction, "
                        + "execution_planned_kw, execution_target_kw, execution_floor_soc_pct, "
                        + "execution_measurements_fresh, cert_source, platform_cert_verdict, "
                        + "platform_cert_model, platform_cert_reason, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (device_id) DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, commanded_kw = EXCLUDED.commanded_kw, "
                        + "confirmed_kw = EXCLUDED.confirmed_kw, all_match = EXCLUDED.all_match, "
                        + "control_enabled = EXCLUDED.control_enabled, certified = EXCLUDED.certified, "
                        + "mismatch_roles = EXCLUDED.mismatch_roles, slot_start = EXCLUDED.slot_start, "
                        + "checked_at = EXCLUDED.checked_at, control_source = EXCLUDED.control_source, "
                        + "execution_mode = EXCLUDED.execution_mode, "
                        + "execution_direction = EXCLUDED.execution_direction, "
                        + "execution_planned_kw = EXCLUDED.execution_planned_kw, "
                        + "execution_target_kw = EXCLUDED.execution_target_kw, "
                        + "execution_floor_soc_pct = EXCLUDED.execution_floor_soc_pct, "
                        + "execution_measurements_fresh = EXCLUDED.execution_measurements_fresh, "
                        + "cert_source = EXCLUDED.cert_source, "
                        + "platform_cert_verdict = EXCLUDED.platform_cert_verdict, "
                        + "platform_cert_model = EXCLUDED.platform_cert_model, "
                        + "platform_cert_reason = EXCLUDED.platform_cert_reason, updated_at = now()",
                deviceId, siteId, commandedKw, confirmedKw, allMatch, controlEnabled, certified,
                mismatchRoles, slotStart == null ? null : Timestamp.from(slotStart), Timestamp.from(checkedAt),
                ex.source(), ex.mode(), ex.direction(), ex.plannedKw(), ex.targetKw(),
                ex.effectiveFloorSocPct(), ex.measurementsFresh(),
                ct.source(), ct.verdict(), ct.model(), ct.reason());
    }

    /**
     * The newest control confirmation for a site (across its devices), or empty. Only a box that
     * takes part in operation counts (UEMS AP-07 IP-11): the row of an ausgebaut box stays stored,
     * but its last report is never the site's current state.
     */
    public Optional<ControlStatusDto> latestForSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, commanded_kw, confirmed_kw, all_match, control_enabled, certified, "
                        + "mismatch_roles, slot_start, checked_at, control_source, execution_mode, "
                        + "execution_direction, execution_planned_kw, execution_target_kw, "
                        + "execution_floor_soc_pct, execution_measurements_fresh, cert_source, "
                        + "platform_cert_verdict, platform_cert_model, platform_cert_reason, "
                        // Die Ausnahme dieser ANLAGE (nicht des Geräts): sie steht in der
                        // gespeicherten Anbindung einer Komponente und beantwortet genau die
                        // Frage, die diese Zeile sonst falsch beantwortet - „warum steuert
                        // die Anlage nicht?". Ein Unterausdruck statt eines JOINs, damit die
                        // eine Zeile eine Zeile bleibt.
                        + "(SELECT mp.connection_json -> 'reading_override' ->> 'channel' "
                        + "   FROM measurement_point mp "
                        + "  WHERE mp.site_id = s.site_id "
                        + "    AND mp.connection_json -> 'reading_override' ->> 'channel' IS NOT NULL "
                        + "  LIMIT 1) AS missing_reading_channel "
                        + "FROM device_control_status s WHERE s.site_id = ? "
                        + "AND EXISTS (SELECT 1 FROM device d WHERE d.id = s.device_id AND d.ausgebaut_am IS NULL) "
                        + "ORDER BY s.checked_at DESC LIMIT 1",
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
                        (Double) rs.getObject("execution_target_kw"),
                        (Double) rs.getObject("execution_floor_soc_pct"),
                        (Boolean) rs.getObject("execution_measurements_fresh"),
                        rs.getString("cert_source"),
                        rs.getString("platform_cert_verdict"),
                        rs.getString("platform_cert_model"),
                        rs.getString("platform_cert_reason"),
                        rs.getString("missing_reading_channel")),
                siteId).stream().findFirst();
    }
}
