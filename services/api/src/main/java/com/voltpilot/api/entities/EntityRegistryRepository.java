package com.voltpilot.api.entities;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * v2 entity-registry queries over {@code measurement_point} (a row with a
 * non-NULL {@code entity_type} IS a v2 entity) plus the master-data lookups the
 * bootstrap/push need (battery asset, site devices, netzladen posture).
 *
 * <p>RLS-scoped like every customer repository: no tenant predicate anywhere -
 * the session's {@code app.tenant_id} fences reads and RLS' WITH CHECK fences
 * writes. Admins reach a tenant through the {@code X-Tenant-Id} switcher.
 */
@Repository
public class EntityRegistryRepository {

    /** One measurement_point row seen as a v2 entity (or bootstrap candidate). */
    public record EntityRow(UUID id, String role, String label, String brand, String model,
            String family, String communication, String connectionJson, BigDecimal capacityKwp,
            UUID deviceId, boolean control, String entityType, String capabilitiesJson,
            String guardConfigJson, String edgeSourceId) {}

    /** The site's battery asset slice the battery-hybrid entity derives from. */
    public record BatteryAsset(UUID deviceId, BigDecimal maxChargeKw, BigDecimal maxDischargeKw,
            BigDecimal socMinPct, BigDecimal socMaxPct) {}

    private static final String ROW_COLUMNS =
            "id, role, label, brand, model, family, communication, connection_json::text AS conn, "
                    + "capacity_kwp, device_id, control, entity_type, capabilities::text AS caps, "
                    + "guard_config::text AS guards, edge_source_id";

    private final JdbcTemplate jdbc;

    public EntityRegistryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The site's v2 entities (entity_type set), stable order. */
    public List<EntityRow> entitiesForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point "
                        + "WHERE site_id = ? AND entity_type IS NOT NULL ORDER BY created_at, id",
                EntityRegistryRepository::mapRow, siteId);
    }

    /** ALL measurement points of the site (bootstrap candidates), stable order. */
    public List<EntityRow> pointsForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point WHERE site_id = ? "
                        + "ORDER BY created_at, id",
                EntityRegistryRepository::mapRow, siteId);
    }

    /** Whether the site has any v2 entity rows. */
    public boolean hasEntities(UUID siteId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM measurement_point WHERE site_id = ? AND entity_type IS NOT NULL",
                Integer.class, siteId);
        return n != null && n > 0;
    }

    /**
     * Stamp a point as a v2 entity (or refresh its config). capabilities /
     * guard_config carry the contract JSON verbatim
     * (docs/contracts/v2/edge-entity.schema.json $defs).
     */
    public void setEntityConfig(UUID pointId, String entityType, String capabilitiesJson,
            String guardConfigJson) {
        jdbc.update(
                "UPDATE measurement_point SET entity_type = ?, capabilities = ?::jsonb, "
                        + "guard_config = ?::jsonb WHERE id = ?",
                entityType, capabilitiesJson, guardConfigJson, pointId);
    }

    /** The site's battery-hybrid registry row id, or null when none exists yet. */
    public UUID batteryHybridPointId(UUID siteId) {
        List<UUID> ids = jdbc.query(
                "SELECT id FROM measurement_point WHERE site_id = ? AND role = 'battery-hybrid'",
                (rs, n) -> rs.getObject("id", UUID.class), siteId);
        return ids.isEmpty() ? null : ids.get(0);
    }

    /**
     * Create the battery-hybrid registry row for the primary inverter
     * (control = TRUE; since E1b control is granted per the type catalog's
     * controllable flag - the v1 control-only-battery CHECK and the
     * one-control-per-site index fell with V20260719010000).
     */
    public UUID createBatteryHybridPoint(UUID tenantId, UUID siteId, String label, UUID deviceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id, control) "
                        + "VALUES (?, ?, 'battery-hybrid', ?, ?, TRUE) RETURNING id",
                UUID.class, tenantId, siteId, label, deviceId);
    }

    /** The site's measurement point of this role, or null when none exists. */
    public UUID pointIdByRole(UUID siteId, String role) {
        List<UUID> ids = jdbc.query(
                "SELECT id FROM measurement_point WHERE site_id = ? AND role = ? "
                        + "ORDER BY created_at, id",
                (rs, n) -> rs.getObject("id", UUID.class), siteId, role);
        return ids.isEmpty() ? null : ids.get(0);
    }

    /**
     * Create a COMPOSED measure-only point bound to the gateway device (MIG
     * §2.3/§2.4: the synthesized grid-meter / house-load). {@code control} is
     * FALSE - the DB CHECK forbids control on a non-battery role anyway, so
     * nothing composed here can carry an actuate capability to a device.
     */
    public UUID createComposedPoint(UUID tenantId, UUID siteId, String role, String label,
            UUID deviceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id, control) "
                        + "VALUES (?, ?, ?, ?, ?, FALSE) RETURNING id",
                UUID.class, tenantId, siteId, role, label, deviceId);
    }

    /** One entity row of the site, or null (RLS: a foreign site yields null). */
    public EntityRow entityForSite(UUID siteId, UUID pointId) {
        List<EntityRow> rows = jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point "
                        + "WHERE site_id = ? AND id = ? AND entity_type IS NOT NULL",
                EntityRegistryRepository::mapRow, siteId, pointId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Create a v2-native entity row (E1b admin CRUD: the open catalog types -
     * wallbox/heating-rod/generic-load/...). role mirrors the entity type;
     * control comes from the catalog's controllable flag.
     */
    public UUID createEntityPoint(UUID tenantId, UUID siteId, String role, String label,
            boolean control) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, control) "
                        + "VALUES (?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, siteId, role, label, control);
    }

    /**
     * Create a v2-native entity row FROM an edge-reported source (U2 adoption):
     * role mirrors the entity type, {@code edgeSourceId} pins it to the source
     * it was adopted from so re-adoption is idempotent and drift is detectable.
     * capacity/registry carry the customer-only master data (kWp, MaStR SEE #).
     */
    public UUID createAdoptedPoint(UUID tenantId, UUID siteId, String role, String label,
            boolean control, String brand, BigDecimal capacityKwp, String registryUnitId,
            String edgeSourceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, control, brand, "
                        + "capacity_kwp, registry_unit_id, edge_source_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenantId, siteId, role, label, control, brand, capacityKwp,
                registryUnitId, edgeSourceId);
    }

    /** Pin an existing entity row to the edge source it was adopted from. */
    public void setEdgeSource(UUID pointId, String edgeSourceId) {
        jdbc.update("UPDATE measurement_point SET edge_source_id = ? WHERE id = ?",
                edgeSourceId, pointId);
    }

    /**
     * The site's measurement point pinned to this edge source, entity or not.
     *
     * <p>Deliberately NOT filtered on {@code entity_type IS NOT NULL}: deleting a
     * COMPOSED entity (producer / grid-meter) only clears its entity config and
     * leaves the point (v1 master data) with its {@code edge_source_id} in place.
     * A re-adoption must find exactly that row and re-compose it - creating a
     * second row would violate {@code uq_measurement_point_edge_source} (HTTP 500)
     * and double-count the producer's kWp.
     */
    public EntityRow pointByEdgeSource(UUID siteId, String edgeSourceId) {
        List<EntityRow> rows = jdbc.query(
                "SELECT " + ROW_COLUMNS + " FROM measurement_point "
                        + "WHERE site_id = ? AND edge_source_id = ?",
                EntityRegistryRepository::mapRow, siteId, edgeSourceId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Re-point an adopted measurement point at a (possibly changed) role and
     * master data before its entity config is re-composed. Only rows created by
     * adoption carry an {@code edge_source_id}, so the role is ours to maintain.
     */
    public void updateAdoptedPoint(UUID pointId, String role, String label,
            BigDecimal capacityKwp, String registryUnitId) {
        jdbc.update(
                "UPDATE measurement_point SET role = ?, label = ?, capacity_kwp = ?, "
                        + "registry_unit_id = ? WHERE id = ?",
                role, label, capacityKwp, registryUnitId, pointId);
    }

    /** The edge source ids already adopted into a v2 entity of the site. */
    public List<String> adoptedEdgeSourceIds(UUID siteId) {
        return jdbc.query(
                "SELECT edge_source_id FROM measurement_point WHERE site_id = ? "
                        + "AND edge_source_id IS NOT NULL AND entity_type IS NOT NULL",
                (rs, n) -> rs.getString(1), siteId);
    }

    /** Update an entity row's display label. */
    public void updateLabel(UUID pointId, String label) {
        jdbc.update("UPDATE measurement_point SET label = ? WHERE id = ?", label, pointId);
    }

    /**
     * Un-entity a v1-backed measurement point: the point (v1 master data)
     * stays, only its v2 entity config is cleared.
     */
    public void clearEntityConfig(UUID pointId) {
        jdbc.update(
                "UPDATE measurement_point SET entity_type = NULL, capabilities = NULL, "
                        + "guard_config = NULL WHERE id = ?",
                pointId);
    }

    /** Delete a v2-native entity row outright. */
    public boolean deletePoint(UUID pointId) {
        return jdbc.update("DELETE FROM measurement_point WHERE id = ?", pointId) > 0;
    }

    // ---- Bidirectional sync state (E1b) ------------------------------------

    /** The last composed Soll of one site (entity_registry_state), or null. */
    public record RegistryState(UUID deviceId, String revision, java.time.Instant composedAt) {}

    /**
     * Record the freshly composed Soll revision - on EVERY compose, even when
     * the best-effort publish fails (the Soll changed regardless; the edge's
     * echoed revision is compared against exactly this value).
     */
    public void upsertRegistryState(UUID siteId, UUID tenantId, UUID deviceId, String revision) {
        jdbc.update(
                "INSERT INTO entity_registry_state (site_id, tenant_id, device_id, revision, composed_at) "
                        + "VALUES (?, ?, ?, ?, now()) "
                        + "ON CONFLICT (site_id) DO UPDATE SET device_id = EXCLUDED.device_id, "
                        + "revision = EXCLUDED.revision, composed_at = EXCLUDED.composed_at",
                siteId, tenantId, deviceId, revision);
    }

    public RegistryState registryState(UUID siteId) {
        List<RegistryState> rows = jdbc.query(
                "SELECT device_id, revision, composed_at FROM entity_registry_state WHERE site_id = ?",
                (rs, n) -> new RegistryState(
                        rs.getObject("device_id", UUID.class),
                        rs.getString("revision"),
                        rs.getTimestamp("composed_at").toInstant()),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The site's battery asset slice, or null when the site has no battery. */
    public BatteryAsset batteryAsset(UUID siteId) {
        List<BatteryAsset> rows = jdbc.query(
                "SELECT device_id, max_charge_kw, max_discharge_kw, soc_min_pct, soc_max_pct "
                        + "FROM asset WHERE site_id = ? AND type = 'battery' AND is_primary",
                (rs, n) -> new BatteryAsset(
                        rs.getObject("device_id", UUID.class),
                        rs.getBigDecimal("max_charge_kw"),
                        rs.getBigDecimal("max_discharge_kw"),
                        rs.getBigDecimal("soc_min_pct"),
                        rs.getBigDecimal("soc_max_pct")),
                siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Ids of the site's claimed devices, stable order. */
    public List<UUID> siteDeviceIds(UUID siteId) {
        return jdbc.query("SELECT id FROM device WHERE site_id = ? ORDER BY created_at, id",
                (rs, n) -> rs.getObject("id", UUID.class), siteId);
    }

    /**
     * Set (or clear, with null) the site's v1->v2 history cutover instant (MIG).
     * RLS-scoped: only a row visible under the session tenant is updated.
     * Returns true when a row was affected (the site exists for the tenant).
     */
    public boolean setV2HistoryCutover(UUID siteId, java.time.Instant at) {
        return jdbc.update("UPDATE site SET v2_history_cutover_at = ? WHERE id = ?",
                at == null ? null : java.sql.Timestamp.from(at), siteId) > 0;
    }

    /** The site's history cutover instant, or null (un-migrated / pure v1). */
    public java.time.Instant v2HistoryCutover(UUID siteId) {
        List<java.time.Instant> rows = jdbc.query(
                "SELECT v2_history_cutover_at FROM site WHERE id = ?",
                (rs, n) -> {
                    java.sql.Timestamp ts = rs.getTimestamp("v2_history_cutover_at");
                    return ts == null ? null : ts.toInstant();
                }, siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Stamp the site as auto-backfilled (MIG §6). The marker is what makes the
     * rollback STICK: the runner only touches sites where it is NULL, so
     * deleting a site's entities is not silently undone by the next api restart.
     * Clearing the column re-arms the runner for that site.
     */
    public boolean markV2Backfilled(UUID siteId, java.time.Instant at) {
        return jdbc.update("UPDATE site SET v2_backfilled_at = ? WHERE id = ?",
                java.sql.Timestamp.from(at), siteId) > 0;
    }

    /** The site's backfill marker, or null (never auto-backfilled). */
    public java.time.Instant v2BackfilledAt(UUID siteId) {
        List<java.time.Instant> rows = jdbc.query(
                "SELECT v2_backfilled_at FROM site WHERE id = ?",
                (rs, n) -> {
                    java.sql.Timestamp ts = rs.getTimestamp("v2_backfilled_at");
                    return ts == null ? null : ts.toInstant();
                }, siteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The site's grid-charging posture (D-8: feeds charge_from_grid_allowed). */
    public boolean netzladenErlaubt(UUID siteId) {
        Boolean b = jdbc.queryForObject(
                "SELECT netzladen_erlaubt FROM site WHERE id = ?", Boolean.class, siteId);
        return Boolean.TRUE.equals(b);
    }

    private static EntityRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new EntityRow(
                rs.getObject("id", UUID.class),
                rs.getString("role"),
                rs.getString("label"),
                rs.getString("brand"),
                rs.getString("model"),
                rs.getString("family"),
                rs.getString("communication"),
                rs.getString("conn"),
                rs.getBigDecimal("capacity_kwp"),
                rs.getObject("device_id", UUID.class),
                rs.getBoolean("control"),
                rs.getString("entity_type"),
                rs.getString("caps"),
                rs.getString("guards"),
                rs.getString("edge_source_id"));
    }
}
