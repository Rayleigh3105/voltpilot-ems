package com.voltpilot.api.measurement;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** RLS-scoped persistence for current desired selections and their paper trail. */
@Repository
public class MeasurementSelectionRepository {

    public record DeviceScope(UUID tenantId, UUID siteId, UUID deviceId) {}

    public record Row(UUID tenantId, UUID siteId, UUID deviceId, String pointKey,
            boolean enabled, Integer cadenceS, long desiredRevision, Instant enabledAt,
            Instant disabledAt, String catalogVersion, String changedBy, String changedByName,
            Instant changedAt, String applyStatus, String applyReason, Instant appliedAt,
            String customDefinitionJson, String retentionClass, int rawRetentionDays,
            Integer longTermCadenceS, String longTermStrategy) {
        MeasurementRetention retention() {
            return new MeasurementRetention(retentionClass, rawRetentionDays,
                    longTermCadenceS, longTermStrategy);
        }
    }

    public record Event(long id, UUID tenantId, UUID siteId, UUID deviceId, String pointKey,
            long desiredRevision, String eventKind, UUID idempotencyKey, Instant requestedAt,
            boolean requestedEnabled, Integer requestedCadenceS, Instant enabledAt,
            Instant disabledAt, String catalogVersion, String actor, String actorName,
            String applyStatus, String applyReason, Instant appliedAt,
            String customDefinitionJson, String retentionClass, int rawRetentionDays,
            Integer longTermCadenceS, String longTermStrategy) {}

    private static final String ROW_COLUMNS =
            "tenant_id, site_id, device_id, point_key, enabled, cadence_s, desired_revision, "
            + "enabled_at, disabled_at, catalog_version, changed_by, changed_by_name, "
            + "changed_at, apply_status, apply_reason, applied_at, custom_definition::text AS custom_json, "
            + "retention_class, raw_retention_days, long_term_cadence_s, long_term_strategy";

    private static final String EVENT_COLUMNS =
            "id, tenant_id, site_id, device_id, point_key, desired_revision, event_kind, idempotency_key, "
            + "requested_at, requested_enabled, requested_cadence_s, enabled_at, disabled_at, "
            + "catalog_version, actor, "
            + "actor_name, apply_status, apply_reason, applied_at, custom_definition::text AS custom_json, "
            + "retention_class, raw_retention_days, long_term_cadence_s, long_term_strategy";

    private final JdbcTemplate jdbc;

    public MeasurementSelectionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The RLS-visible device without taking a write lock (GET paths). */
    public DeviceScope deviceScope(UUID deviceId) {
        List<DeviceScope> rows = jdbc.query(
                "SELECT tenant_id, site_id, id FROM device WHERE id = ?",
                (rs, n) -> new DeviceScope(rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class), rs.getObject("id", UUID.class)),
                deviceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Locks the RLS-visible device, serializing revision checks per device. */
    public DeviceScope lockDevice(UUID deviceId) {
        List<DeviceScope> rows = jdbc.query(
                "SELECT tenant_id, site_id, id FROM device WHERE id = ? FOR UPDATE",
                (rs, n) -> new DeviceScope(rs.getObject("tenant_id", UUID.class),
                        rs.getObject("site_id", UUID.class), rs.getObject("id", UUID.class)),
                deviceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public List<Row> current(UUID deviceId) {
        return jdbc.query("SELECT " + ROW_COLUMNS
                        + " FROM device_measurement_selection WHERE device_id = ? "
                        + "ORDER BY point_key",
                MeasurementSelectionRepository::mapRow, deviceId);
    }

    public Map<String, Integer> selectedCadences(UUID deviceId) {
        Map<String, Integer> out = new LinkedHashMap<>();
        jdbc.query("SELECT point_key, cadence_s FROM device_measurement_selection "
                        + "WHERE device_id = ? AND enabled",
                (org.springframework.jdbc.core.RowCallbackHandler) rs ->
                        out.put(rs.getString("point_key"),
                                (Integer) rs.getObject("cadence_s")),
                deviceId);
        return out;
    }

    public Set<String> availableFamilies(UUID deviceId) {
        Set<String> out = new LinkedHashSet<>();
        jdbc.query("SELECT DISTINCT family FROM measurement_point "
                        + "WHERE device_id = ? AND family IS NOT NULL ORDER BY family",
                (org.springframework.jdbc.core.RowCallbackHandler) rs ->
                        out.add(rs.getString(1)), deviceId);
        return Set.copyOf(out);
    }

    public long revision(UUID deviceId) {
        Long value = jdbc.queryForObject(
                "SELECT COALESCE(MAX(desired_revision), 0) "
                        + "FROM device_measurement_selection_event WHERE device_id = ?",
                Long.class, deviceId);
        return value == null ? 0L : value;
    }

    public Event eventByRequest(UUID deviceId, UUID requestId) {
        List<Event> rows = jdbc.query("SELECT " + EVENT_COLUMNS
                        + " FROM device_measurement_selection_event "
                        + "WHERE device_id = ? AND idempotency_key = ?",
                MeasurementSelectionRepository::mapEvent, deviceId, requestId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public List<Event> events(UUID deviceId, int limit) {
        return jdbc.query("SELECT " + EVENT_COLUMNS
                        + " FROM device_measurement_selection_event WHERE device_id = ? "
                        + "ORDER BY desired_revision DESC, id DESC LIMIT ?",
                MeasurementSelectionRepository::mapEvent, deviceId, Math.max(1, Math.min(limit, 250)));
    }

    /**
     * Upserts desired state. The transition timestamps come only from DB now():
     * enabling starts now, disabling preserves enabled_at and never deletes.
     */
    public Row save(DeviceScope scope, String pointKey, boolean enabled, Integer cadenceS,
            long revision, String catalogVersion, String actor, String actorName,
            String applyReason, String customJson, MeasurementRetention retention) {
        return jdbc.queryForObject(
                "INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "point_key, enabled, cadence_s, desired_revision, enabled_at, disabled_at, "
                        + "catalog_version, changed_by, changed_by_name, changed_at, apply_status, "
                        + "apply_reason, applied_at, custom_definition, retention_class, "
                        + "raw_retention_days, long_term_cadence_s, long_term_strategy) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN now() ELSE NULL END, "
                        + "CASE WHEN ? THEN NULL ELSE now() END, ?, ?, ?, now(), 'pending_edge', ?, "
                        + "NULL, ?::jsonb, ?, ?, ?, ?) "
                        + "ON CONFLICT (device_id, point_key) DO UPDATE SET "
                        + "enabled = EXCLUDED.enabled, cadence_s = EXCLUDED.cadence_s, "
                        + "desired_revision = EXCLUDED.desired_revision, "
                        + "enabled_at = CASE WHEN EXCLUDED.enabled THEN "
                        + "  CASE WHEN device_measurement_selection.enabled "
                        + "       THEN device_measurement_selection.enabled_at ELSE now() END "
                        + "  ELSE device_measurement_selection.enabled_at END, "
                        + "disabled_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE "
                        + "  CASE WHEN device_measurement_selection.enabled THEN now() "
                        + "       ELSE COALESCE(device_measurement_selection.disabled_at, now()) END END, "
                        + "catalog_version = EXCLUDED.catalog_version, changed_by = EXCLUDED.changed_by, "
                        + "changed_by_name = EXCLUDED.changed_by_name, changed_at = now(), "
                        + "apply_status = 'pending_edge', apply_reason = EXCLUDED.apply_reason, "
                        + "applied_at = NULL, custom_definition = EXCLUDED.custom_definition, "
                        + "retention_class = EXCLUDED.retention_class, "
                        + "raw_retention_days = EXCLUDED.raw_retention_days, "
                        + "long_term_cadence_s = EXCLUDED.long_term_cadence_s, "
                        + "long_term_strategy = EXCLUDED.long_term_strategy "
                        + "RETURNING " + ROW_COLUMNS,
                MeasurementSelectionRepository::mapRow,
                scope.tenantId(), scope.siteId(), scope.deviceId(), pointKey, enabled, cadenceS,
                revision, enabled, enabled, catalogVersion, actor, actorName, applyReason,
                customJson, retention.retentionClass(), retention.rawRetentionDays(),
                retention.longTermCadenceS(), retention.longTermStrategy());
    }

    public Event appendEvent(DeviceScope scope, String pointKey, long revision, UUID requestId,
            boolean enabled, Integer cadenceS, Instant enabledAt, Instant disabledAt,
            String catalogVersion, String actor, String actorName, String applyReason, String customJson,
            MeasurementRetention retention) {
        return jdbc.queryForObject(
                "INSERT INTO device_measurement_selection_event (tenant_id, site_id, device_id, "
                        + "point_key, desired_revision, event_kind, idempotency_key, requested_at, "
                        + "requested_enabled, requested_cadence_s, enabled_at, disabled_at, "
                        + "catalog_version, actor, actor_name, "
                        + "apply_status, apply_reason, applied_at, custom_definition, retention_class, "
                        + "raw_retention_days, long_term_cadence_s, long_term_strategy) "
                        + "VALUES (?, ?, ?, ?, ?, 'selection_requested', ?, now(), ?, ?, ?, ?, ?, ?, ?, "
                        + "'pending_edge', ?, NULL, "
                        + "?::jsonb, ?, ?, ?, ?) RETURNING " + EVENT_COLUMNS,
                MeasurementSelectionRepository::mapEvent,
                scope.tenantId(), scope.siteId(), scope.deviceId(), pointKey, revision, requestId,
                enabled, cadenceS, timestamp(enabledAt), timestamp(disabledAt), catalogVersion,
                actor, actorName,
                applyReason, customJson,
                retention.retentionClass(), retention.rawRetentionDays(),
                retention.longTermCadenceS(), retention.longTermStrategy());
    }

    private static Row mapRow(ResultSet rs, int n) throws SQLException {
        return new Row(rs.getObject("tenant_id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getObject("device_id", UUID.class), rs.getString("point_key"),
                rs.getBoolean("enabled"), (Integer) rs.getObject("cadence_s"),
                rs.getLong("desired_revision"), instant(rs, "enabled_at"),
                instant(rs, "disabled_at"), rs.getString("catalog_version"),
                rs.getString("changed_by"), rs.getString("changed_by_name"),
                instant(rs, "changed_at"), rs.getString("apply_status"),
                rs.getString("apply_reason"), instant(rs, "applied_at"),
                rs.getString("custom_json"), rs.getString("retention_class"),
                rs.getInt("raw_retention_days"), (Integer) rs.getObject("long_term_cadence_s"),
                rs.getString("long_term_strategy"));
    }

    private static Event mapEvent(ResultSet rs, int n) throws SQLException {
        return new Event(rs.getLong("id"), rs.getObject("tenant_id", UUID.class),
                rs.getObject("site_id", UUID.class), rs.getObject("device_id", UUID.class),
                rs.getString("point_key"), rs.getLong("desired_revision"),
                rs.getString("event_kind"), rs.getObject("idempotency_key", UUID.class),
                instant(rs, "requested_at"),
                rs.getBoolean("requested_enabled"),
                (Integer) rs.getObject("requested_cadence_s"), instant(rs, "enabled_at"),
                instant(rs, "disabled_at"), rs.getString("catalog_version"),
                rs.getString("actor"), rs.getString("actor_name"),
                rs.getString("apply_status"), rs.getString("apply_reason"),
                instant(rs, "applied_at"), rs.getString("custom_json"),
                rs.getString("retention_class"), rs.getInt("raw_retention_days"),
                (Integer) rs.getObject("long_term_cadence_s"),
                rs.getString("long_term_strategy"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }

    private static Timestamp timestamp(Instant value) {
        return value == null ? null : Timestamp.from(value);
    }
}
