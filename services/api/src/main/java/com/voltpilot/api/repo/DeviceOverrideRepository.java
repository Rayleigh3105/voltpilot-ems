package com.voltpilot.api.repo;

import com.voltpilot.api.uems.RuheRegel;
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
 *
 * <p><b>Die Ruhe bis zum Start</b> (UEMS AP-01 IP-4, Regel R0, migration
 * V20260914193000) is the plant pause with {@code herkunft = 'funktion'} and
 * NO end - it rests until revoked ({@link com.voltpilot.api.uems.RuheRegel}).
 * It is not a manual intervention: the manual pause paths ({@link #putPause},
 * {@link #clearPause}) never overwrite or lift it, and every expiry filter
 * ({@code ends_at > now()}, {@code ends_at <= now()}) skips it by construction.
 */
@Repository
public class DeviceOverrideRepository {

    /** „Ladestand halten" - the battery neither charges nor discharges. */
    public static final String KIND_HOLD = "speicher_halten";
    /** „Speicher jetzt laden" - a charge setpoint (solar-clamped on the box). */
    public static final String KIND_CHARGE = "speicher_laden";
    /** „Automatik pausieren" - plant-wide, no entity. */
    public static final String KIND_PAUSE = "pause";

    /**
     * One live intervention. {@code entityId} is null for a plant pause; {@code herkunft} is null
     * for every manual intervention, and {@code endsAt} is null exactly for the Ruhe (R0).
     */
    public record Row(long id, UUID siteId, String kind, UUID entityId, BigDecimal targetValue,
            Instant endsAt, Instant renewedAt, String createdBy, Instant createdAt,
            String herkunft) {

        /** A plant-wide pause (no component). */
        public boolean isPause() {
            return entityId == null;
        }

        /** Die Ruhe der Funktion (R0) - no end, not a manual intervention. */
        public boolean ausFunktion() {
            return RuheRegel.HERKUNFT_FUNKTION.equals(herkunft);
        }
    }

    private static final String COLUMNS =
            "id, site_id, kind, entity_id, target_value, ends_at, renewed_at, created_by, "
                    + "created_at, herkunft";

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

    /**
     * Upsert the plant-wide MANUAL pause. Returns false - and writes nothing - while the plant
     * rests in its Ruhe (R0): a timed manual pause must never shorten a rest until revoked.
     */
    public boolean putPause(UUID siteId, Instant endsAt, String createdBy) {
        return jdbc.update(
                "INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, "
                        + "renewed_at, created_by, created_at) VALUES "
                        + "(NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, '"
                        + KIND_PAUSE + "', NULL, ?, now(), ?, now()) "
                        + "ON CONFLICT (site_id) WHERE entity_id IS NULL DO UPDATE SET "
                        + "ends_at = EXCLUDED.ends_at, renewed_at = now(), "
                        + "created_by = EXCLUDED.created_by, created_at = now() "
                        + "WHERE device_override.herkunft IS NULL",
                siteId, Timestamp.from(endsAt), createdBy) > 0;
    }

    /**
     * Die Ruhe bis zum Start setzen (R0): the plant pause WITHOUT an end. A running manual pause
     * becomes the Ruhe; an existing Ruhe stays as it is (its start, creator and send stamp).
     * {@code renewed_at} starts empty, so the renewal loop pushes it on its next tick even when the
     * caller's own push failed. Returns whether a row was written.
     */
    public boolean putRuhe(UUID siteId, String createdBy) {
        return jdbc.update(
                "INSERT INTO device_override (tenant_id, site_id, kind, entity_id, ends_at, "
                        + "renewed_at, created_by, created_at, herkunft) VALUES "
                        + "(NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, '"
                        + KIND_PAUSE + "', NULL, NULL, NULL, ?, now(), '"
                        + RuheRegel.HERKUNFT_FUNKTION + "') "
                        + "ON CONFLICT (site_id) WHERE entity_id IS NULL DO UPDATE SET "
                        + "ends_at = NULL, herkunft = EXCLUDED.herkunft, renewed_at = NULL, "
                        + "created_by = EXCLUDED.created_by, created_at = now() "
                        + "WHERE device_override.herkunft IS NULL",
                siteId, createdBy) > 0;
    }

    /** Die Ruhe aufheben („Steuerung starten"/„fortsetzen"). A manual pause stays untouched. */
    public int clearRuhe(UUID siteId) {
        return jdbc.update("DELETE FROM device_override WHERE site_id = ? AND entity_id IS NULL "
                + "AND herkunft = '" + RuheRegel.HERKUNFT_FUNKTION + "'", siteId);
    }

    /** End one component's intervention now („Automatik fortsetzen"). */
    public int clearEntity(UUID siteId, UUID entityId) {
        return jdbc.update("DELETE FROM device_override WHERE site_id = ? AND entity_id = ?",
                siteId, entityId);
    }

    /** End the plant's MANUAL pause now. The Ruhe (R0) is never lifted here. */
    public int clearPause(UUID siteId) {
        return jdbc.update(
                "DELETE FROM device_override WHERE site_id = ? AND entity_id IS NULL "
                        + "AND herkunft IS NULL", siteId);
    }

    /** Every LIVE intervention of one site (expired rows read as absent, the Ruhe as live). */
    public List<Row> active(UUID siteId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM device_override WHERE site_id = ? "
                        + "AND (ends_at IS NULL OR ends_at > now()) "
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

    /**
     * Every Ruhe (R0) of EVERY tenant whose registry push must be sent again, so the rolling end an
     * OLDER box reads never passes while the cloud runs. Due-ness is {@link
     * RuheRegel#erneuernFaellig} - one rule, pinned by the vectors - not a second SQL copy of it.
     */
    public List<RuheErneuerung> ruheZuErneuern(JdbcTemplate adminJdbc, Instant jetzt) {
        return adminJdbc.query(
                        "SELECT id, tenant_id, site_id, renewed_at FROM device_override "
                                + "WHERE entity_id IS NULL AND ends_at IS NULL AND herkunft = '"
                                + RuheRegel.HERKUNFT_FUNKTION + "' ORDER BY id",
                        (rs, i) -> {
                            Timestamp renewed = rs.getTimestamp("renewed_at");
                            return new RuheErneuerung(rs.getLong("id"),
                                    rs.getObject("tenant_id", UUID.class),
                                    rs.getObject("site_id", UUID.class),
                                    renewed == null ? null : renewed.toInstant());
                        })
                .stream()
                .filter(r -> RuheRegel.erneuernFaellig(r.zuletztGesendet(), jetzt))
                .toList();
    }

    /** One Ruhe the renewal loop must push again. */
    public record RuheErneuerung(long id, UUID tenantId, UUID siteId, Instant zuletztGesendet) {}

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
        Timestamp ends = rs.getTimestamp("ends_at");
        return new Row(rs.getLong("id"), rs.getObject("site_id", UUID.class), rs.getString("kind"),
                rs.getObject("entity_id", UUID.class), rs.getBigDecimal("target_value"),
                ends == null ? null : ends.toInstant(),
                renewed == null ? null : renewed.toInstant(), rs.getString("created_by"),
                rs.getTimestamp("created_at").toInstant(), rs.getString("herkunft"));
    }
}
