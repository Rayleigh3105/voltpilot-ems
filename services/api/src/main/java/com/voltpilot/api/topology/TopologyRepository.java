package com.voltpilot.api.topology;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Queries backing the Anlagen-Topologie-Read-Model (AE1): the latest live value
 * per (entity, channel) from {@code telemetry_v2}, and the capability→role
 * assignment overrides. RLS-scoped like every customer repository (no tenant
 * predicate; the site_id predicate anchors the read to the caller-visible site).
 */
@Repository
public class TopologyRepository {

    /**
     * Latest sample of one entity channel: value + arrival time (liveness).
     * entityId is a String - telemetry_v2.entity_id is TEXT by contract (any
     * MQTT-topic-safe id; the registry UUID is the recommended form, not a
     * constraint), so it must NOT be read as a UUID.
     */
    public record LatestValue(String entityId, String channel, double value, Instant receivedAt) {}

    /** One stored capability→role override. */
    public record RoleOverride(UUID entityId, String capability, String role, boolean primary) {}

    private final JdbcTemplate jdbc;

    public TopologyRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * The newest telemetry_v2 sample per (entity, channel) of a site. Uses
     * received_at for liveness (the store-and-forward rule), value for display.
     */
    public List<LatestValue> latestValues(UUID siteId) {
        return jdbc.query(
                "SELECT DISTINCT ON (entity_id, channel) entity_id, channel, value, received_at "
                        + "FROM telemetry_v2 WHERE site_id = ? "
                        + "ORDER BY entity_id, channel, time DESC",
                (rs, n) -> new LatestValue(
                        rs.getString("entity_id"),
                        rs.getString("channel"),
                        rs.getDouble("value"),
                        rs.getTimestamp("received_at").toInstant()),
                siteId);
    }

    /** The site's stored role overrides (empty for a defaults-only site). */
    public List<RoleOverride> overrides(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, capability, role, is_primary FROM entity_role_assignment "
                        + "WHERE site_id = ? ORDER BY entity_id, capability",
                (rs, n) -> new RoleOverride(
                        rs.getObject("entity_id", UUID.class),
                        rs.getString("capability"),
                        rs.getString("role"),
                        rs.getBoolean("is_primary")),
                siteId);
    }

    /** Upsert one capability's role override (re-assignment is idempotent). */
    public void upsertOverride(UUID tenantId, UUID siteId, UUID entityId, String capability,
            String role, boolean primary) {
        jdbc.update(
                "INSERT INTO entity_role_assignment "
                        + "(tenant_id, site_id, entity_id, capability, role, is_primary) "
                        + "VALUES (?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (entity_id, capability) DO UPDATE SET "
                        + "role = EXCLUDED.role, is_primary = EXCLUDED.is_primary",
                tenantId, siteId, entityId, capability, role, primary);
    }

    /** Drop one capability's override (revert to the DefaultRole mapping). */
    public void deleteOverride(UUID siteId, UUID entityId, String capability) {
        jdbc.update(
                "DELETE FROM entity_role_assignment WHERE site_id = ? AND entity_id = ? "
                        + "AND capability = ?",
                siteId, entityId, capability);
    }
}
