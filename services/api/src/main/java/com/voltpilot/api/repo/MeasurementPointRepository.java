package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.MeasurementPointDto;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * A site's additional measurement points (multi-source Anlage), RLS-scoped like
 * every customer repository: no tenant predicate, the session's {@code
 * app.tenant_id} scopes reads and RLS' WITH CHECK guarantees writes land in the
 * caller's tenant. Phase 1 records read-only Erzeuger (PV) sources whose kWp
 * sums into the aggregate {@code asset.pv}.
 */
@Repository
public class MeasurementPointRepository {

    private static final String COLUMNS =
            "id, role, label, brand, model, capacity_kwp, registry_unit_id, control, created_at";

    private final JdbcTemplate jdbc;

    public MeasurementPointRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<MeasurementPointDto> findForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM measurement_point WHERE site_id = ? "
                        + "ORDER BY created_at, id",
                MeasurementPointRepository::map, siteId);
    }

    /** Insert an additional measurement point and return its generated id. */
    public UUID create(UUID tenantId, UUID siteId, String role, String label, String brand,
            String model, BigDecimal capacityKwp, String registryUnitId) {
        return jdbc.queryForObject(
                "INSERT INTO measurement_point (tenant_id, site_id, role, label, brand, model, "
                        + "capacity_kwp, registry_unit_id, control) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, FALSE) RETURNING id",
                UUID.class, tenantId, siteId, role, label, brand, model, capacityKwp, registryUnitId);
    }

    /**
     * Delete a measurement point of this site, returning its capacity_kwp
     * (COALESCEd to 0, so a deleted point ALWAYS yields a non-null value even when
     * its kWp was unset) so the caller can subtract it from the aggregate; returns
     * null ONLY when no row was deleted (the id does not exist in the caller's
     * tenant/site) - that is the 404 signal.
     */
    public BigDecimal deleteReturningCapacity(UUID siteId, UUID id) {
        List<BigDecimal> caps = jdbc.query(
                "DELETE FROM measurement_point WHERE id = ? AND site_id = ? "
                        + "RETURNING COALESCE(capacity_kwp, 0) AS cap",
                (rs, n) -> rs.getBigDecimal("cap"), id, siteId);
        return caps.isEmpty() ? null : caps.get(0);
    }

    /** Σ capacity_kwp over the site's Erzeuger measurement points (0 when none). */
    public BigDecimal sumErzeugerKwp(UUID siteId) {
        BigDecimal sum = jdbc.queryForObject(
                "SELECT COALESCE(SUM(capacity_kwp), 0) FROM measurement_point "
                        + "WHERE site_id = ? AND role = 'pv-generation'",
                BigDecimal.class, siteId);
        return sum != null ? sum : BigDecimal.ZERO;
    }

    private static MeasurementPointDto map(ResultSet rs, int rowNum) throws SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        return new MeasurementPointDto(
                rs.getObject("id", UUID.class),
                rs.getString("role"),
                rs.getString("label"),
                rs.getString("brand"),
                rs.getString("model"),
                rs.getBigDecimal("capacity_kwp"),
                rs.getString("registry_unit_id"),
                rs.getBoolean("control"),
                created != null ? created.toInstant() : null);
    }
}
