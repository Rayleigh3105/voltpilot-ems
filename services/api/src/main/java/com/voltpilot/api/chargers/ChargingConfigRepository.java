package com.voltpilot.api.chargers;

import com.voltpilot.api.web.dto.ChargingConfigDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Die im Portal gepflegte Lastmanagement-Konfiguration (Migration
 * V20260829000000): eine Zeile je Anlage plus die VORRANG-Menge je Säule.
 * RLS-gefenced wie alle Kundendaten einer Anlage.
 *
 * <p>Der Vorrang ist eine MENGE, und die ANWESENHEIT der Zeile IST die Aussage
 * (das {@code device_control_activation}-Muster) - kein {@code priority}-Flag,
 * das auf false stehen und trotzdem Historie vortäuschen könnte.
 */
@Repository
public class ChargingConfigRepository {

    private final JdbcTemplate jdbc;

    public ChargingConfigRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Die gepflegte Konfiguration; leere Felder = noch nichts gepflegt. */
    public ChargingConfigDto forSite(UUID siteId) {
        List<Object[]> head = jdbc.query(
                "SELECT grid_limit_kw, updated_at, updated_by FROM site_charging_config "
                        + "WHERE site_id = ?",
                (rs, n) -> new Object[] {rs.getObject("grid_limit_kw"),
                        rs.getTimestamp("updated_at"), rs.getString("updated_by")},
                siteId);
        List<String> priorities = jdbc.query(
                "SELECT charge_point_id FROM site_charge_point_priority WHERE site_id = ? "
                        + "ORDER BY charge_point_id",
                (rs, n) -> rs.getString("charge_point_id"), siteId);
        if (head.isEmpty()) {
            return new ChargingConfigDto(null, List.copyOf(priorities), null, null);
        }
        Object[] row = head.get(0);
        Timestamp at = (Timestamp) row[1];
        return new ChargingConfigDto((Double) row[0], List.copyOf(priorities),
                at == null ? null : at.toInstant(), (String) row[2]);
    }

    /** Setzt die Anschlussgrenze (Upsert, mit Papier-Spur wer und wann). */
    @Transactional
    public void saveGridLimit(UUID tenantId, UUID siteId, double gridLimitKw, String actor) {
        jdbc.update("INSERT INTO site_charging_config (site_id, tenant_id, grid_limit_kw, "
                + "updated_at, updated_by) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id) DO UPDATE SET grid_limit_kw = EXCLUDED.grid_limit_kw, "
                + "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
                siteId, tenantId, gridLimitKw, Timestamp.from(Instant.now()), actor);
    }

    /** Ersetzt die Vorrang-Menge (leer = ausdrücklich keine Vorrang-Säule). */
    @Transactional
    public void replacePriorities(UUID tenantId, UUID siteId, List<String> chargePointIds) {
        jdbc.update("DELETE FROM site_charge_point_priority WHERE site_id = ?", siteId);
        for (String id : chargePointIds) {
            jdbc.update("INSERT INTO site_charge_point_priority (site_id, charge_point_id, "
                    + "tenant_id) VALUES (?, ?, ?)", siteId, id, tenantId);
        }
    }

    /** Die Geräte dieser Anlage - die Empfänger des retained Dokuments. */
    public List<UUID> deviceIds(UUID siteId) {
        return new ArrayList<>(jdbc.query("SELECT id FROM device WHERE site_id = ? ORDER BY id",
                (rs, n) -> rs.getObject("id", UUID.class), siteId));
    }
}
