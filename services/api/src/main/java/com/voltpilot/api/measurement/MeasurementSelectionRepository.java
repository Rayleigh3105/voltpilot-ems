package com.voltpilot.api.measurement;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** RLS-scoped persistence for current desired selections and their paper trail. */
@Repository
public class MeasurementSelectionRepository {

    public record DeviceScope(UUID tenantId, UUID siteId, UUID deviceId) {}

    public record Row(UUID tenantId, UUID siteId, UUID deviceId, UUID entityId, String pointKey,
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

    public record Event(long id, UUID tenantId, UUID siteId, UUID deviceId, UUID entityId,
            String pointKey,
            long desiredRevision, String eventKind, UUID idempotencyKey, Instant requestedAt,
            boolean requestedEnabled, Integer requestedCadenceS, Instant enabledAt,
            Instant disabledAt, String catalogVersion, String actor, String actorName,
            String applyStatus, String applyReason, Instant appliedAt,
            String customDefinitionJson, String retentionClass, int rawRetentionDays,
            Integer longTermCadenceS, String longTermStrategy) {}

    public record Observation(Instant lastReadAt, String rawValue, String decodedValue,
            String quality, boolean gap, long droppedSamples) {}

    private static final String ROW_COLUMNS =
            "tenant_id, site_id, device_id, entity_id, point_key, enabled, cadence_s, "
            + "desired_revision, "
            + "enabled_at, disabled_at, catalog_version, changed_by, changed_by_name, "
            + "changed_at, apply_status, apply_reason, applied_at, custom_definition::text AS custom_json, "
            + "retention_class, raw_retention_days, long_term_cadence_s, long_term_strategy";

    private static final String EVENT_COLUMNS =
            "id, tenant_id, site_id, device_id, entity_id, point_key, desired_revision, "
            + "event_kind, idempotency_key, "
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

    /**
     * The cadences a catalog view must mark as selected. Scoped to ONE
     * component when entityId is given, otherwise to the whole device (the
     * pre-3b box semantics).
     */
    public Map<String, Integer> selectedCadences(UUID deviceId, UUID entityId) {
        Map<String, Integer> out = new LinkedHashMap<>();
        jdbc.query("SELECT point_key, cadence_s FROM device_measurement_selection "
                        + "WHERE device_id = ? AND enabled" + entityFilter(entityId),
                (org.springframework.jdbc.core.RowCallbackHandler) rs ->
                        out.put(rs.getString("point_key"),
                                (Integer) rs.getObject("cadence_s")),
                args(deviceId, entityId));
        return out;
    }

    /**
     * The binding families a catalog view may offer. With a component the
     * answer is ITS family; without one it stays the pre-3b union over the
     * points that carry this device_id - which on a multi-component box is the
     * composed hybrid's family and therefore the wrong question per component.
     */
    public Set<String> availableFamilies(UUID deviceId, UUID entityId) {
        Set<String> out = new LinkedHashSet<>();
        if (entityId != null) {
            jdbc.query("SELECT family FROM measurement_point WHERE id = ? AND family IS NOT NULL",
                    (org.springframework.jdbc.core.RowCallbackHandler) rs ->
                            out.add(rs.getString(1)), entityId);
            return Set.copyOf(out);
        }
        jdbc.query("SELECT DISTINCT family FROM measurement_point "
                        + "WHERE device_id = ? AND family IS NOT NULL ORDER BY family",
                (org.springframework.jdbc.core.RowCallbackHandler) rs ->
                        out.add(rs.getString(1)), deviceId);
        return Set.copyOf(out);
    }

    /**
     * The RLS-visible component's site, or null when it is not visible at all.
     * The site is the caller's fence check: a component of ANOTHER plant is not
     * a valid selection owner even inside the same tenant.
     */
    public UUID entitySiteId(UUID entityId) {
        List<UUID> rows = jdbc.query("SELECT site_id FROM measurement_point WHERE id = ?",
                (rs, n) -> rs.getObject("site_id", UUID.class), entityId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    public Set<String> recordedPointKeys(UUID deviceId) {
        DeviceScope scope = deviceScope(deviceId);
        if (scope == null) return Set.of();
        Set<String> out = new LinkedHashSet<>();
        jdbc.query("SELECT point_key FROM device_measurement_selection WHERE device_id = ? "
                        + "UNION SELECT point_key FROM device_measurement_point_state "
                        + "WHERE tenant_id=? AND site_id=? AND device_id=?",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> {
                    String pointKey = rs.getString(1);
                    out.add(pointKey);
                    out.add(templateKey(pointKey));
                },
                deviceId, scope.tenantId(), scope.siteId(), deviceId);
        return Set.copyOf(out);
    }

    public Map<String, Observation> latestObservations(UUID deviceId) {
        DeviceScope scope = deviceScope(deviceId);
        if (scope == null) return Map.of();
        Map<String, Observation> out = new LinkedHashMap<>();
        jdbc.query("SELECT point_key, last_read_at, "
                        + "COALESCE(raw_text, raw_numeric::text) raw_value, "
                        + "COALESCE(decoded_text, decoded_numeric::text) decoded_value, "
                        + "quality, gap, dropped_samples FROM device_measurement_point_state "
                        + "WHERE tenant_id=? AND site_id=? AND device_id=? ORDER BY point_key",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> {
                    String pointKey = rs.getString("point_key");
                    Observation observation = new Observation(
                            rs.getTimestamp("last_read_at").toInstant(),
                            rs.getString("raw_value"), rs.getString("decoded_value"),
                            rs.getString("quality"), rs.getBoolean("gap"),
                            rs.getLong("dropped_samples"));
                    out.merge(pointKey, observation, MeasurementSelectionRepository::latest);
                    out.merge(templateKey(pointKey), observation,
                            MeasurementSelectionRepository::latest);
                }, scope.tenantId(), scope.siteId(), deviceId);
        return Map.copyOf(out);
    }

    /**
     * NULL entity_id is a VALUE here (the box semantics), so an absent entity
     * means "the whole device" rather than "the unbound rows"; the unique key
     * follows the same rule through NULLS NOT DISTINCT.
     */
    private static String entityFilter(UUID entityId) {
        return entityId == null ? "" : " AND entity_id = ?";
    }

    private static Object[] args(UUID deviceId, UUID entityId) {
        return entityId == null ? new Object[] {deviceId} : new Object[] {deviceId, entityId};
    }

    static String templateKey(String pointKey) {
        return pointKey == null ? null : pointKey.replaceAll("\\[[^]\\r\\n]+]", "[*]");
    }

    private static Observation latest(Observation left, Observation right) {
        return left.lastReadAt().isAfter(right.lastReadAt()) ? left : right;
    }

    public long revision(UUID deviceId) {
        Long value = jdbc.queryForObject(
                "SELECT COALESCE(MAX(desired_revision), 0) "
                        + "FROM device_measurement_selection_event WHERE device_id = ?",
                Long.class, deviceId);
        return value == null ? 0L : value;
    }

    /** Highest full-plan acknowledgement already applied for this device. */
    public long acknowledgedRevision(UUID deviceId) {
        Long value = jdbc.queryForObject(
                "SELECT COALESCE(MAX(desired_revision), 0) "
                        + "FROM device_measurement_selection_event "
                        + "WHERE device_id = ? AND event_kind = 'edge_ack'",
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

    public List<Event> events(UUID deviceId, UUID entityId, int limit) {
        int bounded = Math.max(1, Math.min(limit, 250));
        Object[] args = entityId == null ? new Object[] {deviceId, bounded}
                : new Object[] {deviceId, entityId, bounded};
        return jdbc.query("SELECT " + EVENT_COLUMNS
                        + " FROM device_measurement_selection_event WHERE device_id = ?"
                        + entityFilter(entityId)
                        + " ORDER BY desired_revision DESC, id DESC LIMIT ?",
                MeasurementSelectionRepository::mapEvent, args);
    }

    /**
     * Upserts desired state. The transition timestamps come only from DB now():
     * enabling starts now, disabling preserves enabled_at and never deletes.
     */
    public Row save(DeviceScope scope, UUID entityId, String pointKey, boolean enabled,
            Integer cadenceS,
            long revision, String catalogVersion, String actor, String actorName,
            String applyReason, String customJson, MeasurementRetention retention) {
        return jdbc.queryForObject(
                "INSERT INTO device_measurement_selection (tenant_id, site_id, device_id, "
                        + "entity_id, "
                        + "point_key, enabled, cadence_s, desired_revision, enabled_at, disabled_at, "
                        + "catalog_version, changed_by, changed_by_name, changed_at, apply_status, "
                        + "apply_reason, applied_at, custom_definition, retention_class, "
                        + "raw_retention_days, long_term_cadence_s, long_term_strategy) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN now() ELSE NULL END, "
                        + "CASE WHEN ? THEN NULL ELSE now() END, ?, ?, ?, now(), 'pending_edge', ?, "
                        + "NULL, ?::jsonb, ?, ?, ?, ?) "
                        // NULLS NOT DISTINCT makes the box-semantics row (entity_id
                        // NULL) exactly one row per point_key again, so the arbiter
                        // needs no invented sentinel uuid.
                        + "ON CONFLICT (device_id, entity_id, point_key) DO UPDATE SET "
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
                scope.tenantId(), scope.siteId(), scope.deviceId(), entityId, pointKey, enabled,
                cadenceS,
                revision, enabled, enabled, catalogVersion, actor, actorName, applyReason,
                customJson, retention.retentionClass(), retention.rawRetentionDays(),
                retention.longTermCadenceS(), retention.longTermStrategy());
    }

    public Event appendEvent(DeviceScope scope, UUID entityId, String pointKey, long revision,
            UUID requestId,
            boolean enabled, Integer cadenceS, Instant enabledAt, Instant disabledAt,
            String catalogVersion, String actor, String actorName, String applyReason, String customJson,
            MeasurementRetention retention) {
        return jdbc.queryForObject(
                "INSERT INTO device_measurement_selection_event (tenant_id, site_id, device_id, "
                        + "entity_id, "
                        + "point_key, desired_revision, event_kind, idempotency_key, requested_at, "
                        + "requested_enabled, requested_cadence_s, enabled_at, disabled_at, "
                        + "catalog_version, actor, actor_name, "
                        + "apply_status, apply_reason, applied_at, custom_definition, retention_class, "
                        + "raw_retention_days, long_term_cadence_s, long_term_strategy) "
                        + "VALUES (?, ?, ?, ?, ?, ?, 'selection_requested', ?, now(), ?, ?, ?, ?, ?, ?, ?, "
                        + "'pending_edge', ?, NULL, "
                        + "?::jsonb, ?, ?, ?, ?) RETURNING " + EVENT_COLUMNS,
                MeasurementSelectionRepository::mapEvent,
                scope.tenantId(), scope.siteId(), scope.deviceId(), entityId, pointKey, revision,
                requestId,
                enabled, cadenceS, timestamp(enabledAt), timestamp(disabledAt), catalogVersion,
                actor, actorName,
                applyReason, customJson,
                retention.retentionClass(), retention.rawRetentionDays(),
                retention.longTermCadenceS(), retention.longTermStrategy());
    }

    /**
     * Apply one monotone full-plan acknowledgement atomically.
     *
     * <p>⚠ The edge acknowledges POINT KEYS, not components - it has no
     * component binding before Stufe 3c. An acknowledgement therefore reaches
     * every row of this device carrying that key. That is the honest reflection
     * of what the box did (it reads a register once, over the primary
     * inverter's connection); the per-component precision follows with the edge
     * release that also consumes {@code entity_id} from the desired state.
     */
    @Transactional
    public int applyAcknowledgement(UUID deviceId, long revision, Instant appliedAt,
            Collection<String> accepted, Map<String, String> rejected, String edgeVersion) {
        int updated = jdbc.update("UPDATE device_measurement_selection SET "
                        + "apply_status = CASE "
                        + " WHEN NOT enabled THEN 'applied' "
                        + " WHEN point_key = ANY (string_to_array(?, E'\\x1f')) THEN 'applied' "
                        + " WHEN point_key = ANY (string_to_array(?, E'\\x1f')) THEN 'rejected' "
                        + " ELSE apply_status END, "
                        + "apply_reason = CASE "
                        + " WHEN NOT enabled OR point_key = ANY (string_to_array(?, E'\\x1f')) THEN ? "
                        + " WHEN point_key = ANY (string_to_array(?, E'\\x1f')) THEN ?::jsonb ->> point_key "
                        + " ELSE apply_reason END, "
                        // ⚠ A bare ? in a CASE whose other branch is an untyped
                        // NULL resolves to text, and the assignment to the
                        // timestamptz column then fails. Cast every timestamp
                        // parameter of this statement explicitly.
                        + "applied_at = CASE WHEN NOT enabled OR point_key = ANY (string_to_array(?, E'\\x1f')) "
                        + " THEN CAST(? AS timestamptz) ELSE NULL END "
                        + "WHERE device_id = ? AND desired_revision <= ?",
                joined(accepted), joined(rejected.keySet()), joined(accepted),
                "Vom Edge " + edgeVersion + " angewendet.", joined(rejected.keySet()),
                jsonObject(rejected), joined(accepted), Timestamp.from(appliedAt), deviceId,
                revision);

        jdbc.update("INSERT INTO device_measurement_selection_event "
                        + "(tenant_id,site_id,device_id,entity_id,point_key,desired_revision,event_kind,"
                        + "requested_at,requested_enabled,requested_cadence_s,enabled_at,disabled_at,"
                        + "catalog_version,actor,actor_name,apply_status,apply_reason,applied_at,"
                        + "custom_definition,retention_class,raw_retention_days,long_term_cadence_s,"
                        + "long_term_strategy) "
                        + "SELECT e.tenant_id,e.site_id,e.device_id,e.entity_id,e.point_key,"
                        + "e.desired_revision,"
                        + "'edge_ack',CAST(? AS timestamptz),e.requested_enabled,"
                        + "e.requested_cadence_s,e.enabled_at,"
                        + "e.disabled_at,e.catalog_version,'edge',?,"
                        + "CASE WHEN jsonb_exists(?::jsonb,e.point_key) THEN 'rejected' ELSE 'applied' END,"
                        + "COALESCE(?::jsonb ->> e.point_key, ?),"
                        + "CASE WHEN jsonb_exists(?::jsonb,e.point_key) THEN NULL "
                        + "ELSE CAST(? AS timestamptz) END,"
                        + "e.custom_definition,"
                        + "e.retention_class,e.raw_retention_days,e.long_term_cadence_s,"
                        + "e.long_term_strategy FROM device_measurement_selection_event e "
                        + "WHERE e.device_id=? AND e.desired_revision=? "
                        + "AND e.event_kind='selection_requested' ON CONFLICT DO NOTHING",
                Timestamp.from(appliedAt), edgeVersion, jsonObject(rejected), jsonObject(rejected),
                "Vom Edge " + edgeVersion + " angewendet.", jsonObject(rejected),
                Timestamp.from(appliedAt), deviceId, revision);
        return updated;
    }

    private static String joined(Collection<String> values) {
        return String.join("\u001f", values);
    }

    private static String jsonObject(Map<String, String> values) {
        StringBuilder out = new StringBuilder("{");
        for (Map.Entry<String, String> e : values.entrySet()) {
            if (out.length() > 1) out.append(',');
            out.append('"').append(escape(e.getKey())).append("\":\"")
                    .append(escape(e.getValue())).append('"');
        }
        return out.append('}').toString();
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static Row mapRow(ResultSet rs, int n) throws SQLException {
        return new Row(rs.getObject("tenant_id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getObject("device_id", UUID.class), rs.getObject("entity_id", UUID.class),
                rs.getString("point_key"),
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
                rs.getObject("entity_id", UUID.class),
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
