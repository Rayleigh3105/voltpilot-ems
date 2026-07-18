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
            UUID deviceId, String entityType, String capabilitiesJson, String guardConfigJson) {}

    /** The site's battery asset slice the battery-hybrid entity derives from. */
    public record BatteryAsset(UUID deviceId, BigDecimal maxChargeKw, BigDecimal maxDischargeKw,
            BigDecimal socMinPct, BigDecimal socMaxPct) {}

    private static final String ROW_COLUMNS =
            "id, role, label, brand, model, family, communication, connection_json::text AS conn, "
                    + "capacity_kwp, device_id, entity_type, capabilities::text AS caps, "
                    + "guard_config::text AS guards";

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
     * Create the battery-hybrid registry row for the primary inverter: the ONE
     * control point of the site (control = TRUE satisfies the v1 CHECK, which
     * reserves control for exactly this role, and the one-control-per-site
     * partial unique index).
     */
    public UUID createBatteryHybridPoint(UUID tenantId, UUID siteId, String label, UUID deviceId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, device_id, control) "
                        + "VALUES (?, ?, 'battery-hybrid', ?, ?, TRUE) RETURNING id",
                UUID.class, tenantId, siteId, label, deviceId);
    }

    /** The site's battery asset slice, or null when the site has no battery. */
    public BatteryAsset batteryAsset(UUID siteId) {
        List<BatteryAsset> rows = jdbc.query(
                "SELECT device_id, max_charge_kw, max_discharge_kw, soc_min_pct, soc_max_pct "
                        + "FROM asset WHERE site_id = ? AND type = 'battery'",
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
                rs.getString("entity_type"),
                rs.getString("caps"),
                rs.getString("guards"));
    }
}
