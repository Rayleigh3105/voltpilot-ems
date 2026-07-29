package com.voltpilot.api.entities;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The edge-reported entity Ist ({@code entity_observed_state}, E1b
 * bidirectional sync): per (device, entity) the applied type/health/telemetry
 * plus the edge-local commissioning view (source='local'). Written by
 * {@link EntityStatusListener} under the topic tenant; read by the entities
 * surface to render drift. RLS-scoped like every customer repository.
 */
@Repository
public class EntityObservedRepository {

    /** One observed row. channelsJson is the raw JSON array of channel names.
     *  edgeRole/edgeBrand/edgeModel are the reported role/brand/model of a
     *  source='local' item (U2 adoption: they seed the "als Entität übernehmen"
     *  type suggestion and the display-name fallback chain). label carries ONLY
     *  the operator-given name - never a brand/model/role concatenation. */
    public record ObservedRow(UUID deviceId, String entityId, String source, String entityType,
            String health, String label, Instant lastTelemetryAt, String appliedRevision,
            String channelsJson, Instant reportedAt, String edgeRole, String edgeBrand,
            String edgeModel) {}

    private final JdbcTemplate jdbc;

    public EntityObservedRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Replace the device's whole observed set with one heartbeat's report -
     * wholesale, so entities that vanished from the report vanish here too
     * (the heartbeat carries the COMPLETE Ist; a partial merge would keep
     * ghosts forever).
     */
    @Transactional
    public void replaceForDevice(UUID deviceId, UUID tenantId, UUID siteId, Instant reportedAt,
            List<ObservedRow> rows) {
        jdbc.update("DELETE FROM entity_observed_state WHERE device_id = ?", deviceId);
        for (ObservedRow row : rows) {
            jdbc.update(
                    "INSERT INTO entity_observed_state (device_id, entity_id, tenant_id, site_id, "
                            + "source, entity_type, health, label, last_telemetry_at, "
                            + "applied_revision, channels, reported_at, edge_role, edge_brand, "
                            + "edge_model) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)",
                    deviceId, row.entityId(), tenantId, siteId, row.source(), row.entityType(),
                    row.health(), row.label(),
                    row.lastTelemetryAt() == null ? null
                            : java.sql.Timestamp.from(row.lastTelemetryAt()),
                    row.appliedRevision(), row.channelsJson(),
                    java.sql.Timestamp.from(reportedAt), row.edgeRole(), row.edgeBrand(),
                    row.edgeModel());
        }
    }

    /** All observed rows of a site's devices, stable order. */
    public List<ObservedRow> forSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, entity_id, source, entity_type, health, label, "
                        + "last_telemetry_at, applied_revision, channels::text AS channels_json, "
                        + "reported_at, edge_role, edge_brand, edge_model "
                        + "FROM entity_observed_state "
                        + "WHERE site_id = ? ORDER BY source, entity_id",
                EntityObservedRepository::mapRow, siteId);
    }

    private static ObservedRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        java.sql.Timestamp last = rs.getTimestamp("last_telemetry_at");
        return new ObservedRow(
                rs.getObject("device_id", UUID.class),
                rs.getString("entity_id"),
                rs.getString("source"),
                rs.getString("entity_type"),
                rs.getString("health"),
                rs.getString("label"),
                last == null ? null : last.toInstant(),
                rs.getString("applied_revision"),
                rs.getString("channels_json"),
                rs.getTimestamp("reported_at").toInstant(),
                rs.getString("edge_role"),
                rs.getString("edge_brand"),
                rs.getString("edge_model"));
    }
}
