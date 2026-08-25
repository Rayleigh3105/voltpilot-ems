package com.voltpilot.api.repo;

import java.math.BigDecimal;
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
 * The TTL-bound manual intervention on a COMPONENT and the plant-wide
 * „Automatik pausieren" (device_override, migration V20260845000000; Steuerung
 * Stufe 4), RLS-scoped through the {@code @Primary} datasource.
 *
 * <p>An EXPIRED row ({@code ends_at <= now}) is treated as ABSENT by every read
 * - a stale intervention never lingers (§16). The row itself is kept until the
 * renewal loop or the next write clears it, so the audit trail can still be
 * reconstructed from {@code consumer_audit_event}.
 */
@Repository
public class DeviceOverrideRepository {

    /** „Ladestand halten" - the battery neither charges nor discharges. */
    public static final String KIND_HOLD = "speicher_halten";
    /** „Speicher jetzt laden" - a charge setpoint (solar-clamped on the box). */
    public static final String KIND_CHARGE = "speicher_laden";
    /** „Automatik pausieren" - plant-wide, no entity. */
    public static final String KIND_PAUSE = "pause";

    /** One live intervention. {@code entityId} is null for a plant pause. */
    public record Row(long id, UUID siteId, String kind, UUID entityId, BigDecimal targetValue,
            Instant endsAt, Instant renewedAt, String createdBy, Instant createdAt) {

        /** A plant-wide pause (no component). */
        public boolean isPause() {
            return entityId == null;
        }
    }

    private static final String COLUMNS =
            "id, site_id, kind, entity_id, target_value, ends_at, renewed_at, created_by, "
                    + "created_at";

    private final JdbcTemplate jdbc;

    public DeviceOverrideRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Upsert the intervention of ONE component (RLS stamps the tenant). */
    public void putForEntity(UUID siteId, UUID entityId, String kind, BigDecimal value,
            Instant endsAt, String createdBy) {
        jdbc.update(
                "INSERT INTO device_override (tenant_id, site_id, kind, entity_id, target_value, "
                        + "ends_at, renewed_at, created_by, created_at) VALUES "
                        + "(NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?, ?, ?, "
                        + "?, now(), ?, now()) "
                        + "ON CONFLICT (entity_id) WHERE entity_id IS NOT NULL DO UPDATE SET "
                        + "site_id = EXCLUDED.site_id, kind = EXCLUDED.kind, "
                        + "target_value = EXCLUDED.target_value, ends_at = EXCLUDED.ends_at, "
                        + "renewed_at = now(), created_by = EXCLUDED.created_by, "
                        + "created_at = now()",
                siteId, kind, entityId, value, Timestamp.from(endsAt), createdBy);
    }

    /** Upsert the plant-wide pause. */
    public void putPause(UUID siteId, Instant endsAt, String createdBy) {
        jdbc.update(
                "INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, "
                        + "renewed_at, created_by, created_at) VALUES "
                        + "(NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, '"
                        + KIND_PAUSE + "', NULL, ?, now(), ?, now()) "
                        + "ON CONFLICT (site_id) WHERE entity_id IS NULL DO UPDATE SET "
                        + "ends_at = EXCLUDED.ends_at, renewed_at = now(), "
                        + "created_by = EXCLUDED.created_by, created_at = now()",
                siteId, Timestamp.from(endsAt), createdBy);
    }

    /** End one component's intervention now („Automatik fortsetzen"). */
    public int clearEntity(UUID siteId, UUID entityId) {
        return jdbc.update("DELETE FROM device_override WHERE site_id = ? AND entity_id = ?",
                siteId, entityId);
    }

    /** End the plant pause now. */
    public int clearPause(UUID siteId) {
        return jdbc.update(
                "DELETE FROM device_override WHERE site_id = ? AND entity_id IS NULL", siteId);
    }

    /** Every LIVE intervention of one site (expired rows read as absent). */
    public List<Row> active(UUID siteId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM device_override WHERE site_id = ? AND ends_at > now() "
                        + "ORDER BY entity_id NULLS FIRST",
                DeviceOverrideRepository::map, siteId);
    }

    /** The live pause of one site, or empty. */
    public Optional<Row> activePause(UUID siteId) {
        return active(siteId).stream().filter(Row::isPause).findFirst();
    }

    /** The live intervention on ONE component, or empty. */
    public Optional<Row> activeForEntity(UUID siteId, UUID entityId) {
        return jdbc.query(
                        "SELECT " + COLUMNS + " FROM device_override WHERE site_id = ? "
                                + "AND entity_id = ? AND ends_at > now()",
                        DeviceOverrideRepository::map, siteId, entityId)
                .stream().findFirst();
    }

    /**
     * Every LIVE intervention of EVERY tenant that needs re-sending (B6: a
     * duration beyond the arbiter's 4-h override cap is renewed rather than
     * pushed as one long TTL). Read through the BYPASSRLS admin template by the
     * scheduler - it has no tenant context - which is why the tenant rides
     * along in the row.
     */
    public List<Renewal> dueForRenewal(JdbcTemplate adminJdbc, Instant renewBefore) {
        return adminJdbc.query(
                "SELECT id, tenant_id, site_id, kind, entity_id, target_value, ends_at, "
                        + "renewed_at FROM device_override "
                        + "WHERE ends_at > now() AND (renewed_at IS NULL OR renewed_at < ?) "
                        + "ORDER BY id",
                (rs, i) -> new Renewal(rs.getLong("id"), rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class), rs.getString("kind"),
                        rs.getObject("entity_id", UUID.class), rs.getBigDecimal("target_value"),
                        rs.getTimestamp("ends_at").toInstant()),
                Timestamp.from(renewBefore));
    }

    /** One row the renewal loop must re-send. */
    public record Renewal(long id, UUID tenantId, UUID siteId, String kind, UUID entityId,
            BigDecimal targetValue, Instant endsAt) {}

    /** Stamp a successful re-send (admin template - the scheduler has no tenant). */
    public void markRenewed(JdbcTemplate adminJdbc, long id) {
        adminJdbc.update("UPDATE device_override SET renewed_at = now() WHERE id = ?", id);
    }

    /** Drop every EXPIRED row of every tenant (housekeeping in the same loop). */
    public int purgeExpired(JdbcTemplate adminJdbc) {
        return adminJdbc.update("DELETE FROM device_override WHERE ends_at <= now()");
    }

    /** Drop everything of one site (unclaim / offboarding hygiene). */
    public int clearSite(UUID siteId) {
        return jdbc.update("DELETE FROM device_override WHERE site_id = ?", siteId);
    }

    private static Row map(ResultSet rs, int rowNum) throws SQLException {
        Timestamp renewed = rs.getTimestamp("renewed_at");
        return new Row(rs.getLong("id"), rs.getObject("site_id", UUID.class), rs.getString("kind"),
                rs.getObject("entity_id", UUID.class), rs.getBigDecimal("target_value"),
                rs.getTimestamp("ends_at").toInstant(),
                renewed == null ? null : renewed.toInstant(), rs.getString("created_by"),
                rs.getTimestamp("created_at").toInstant());
    }
}
