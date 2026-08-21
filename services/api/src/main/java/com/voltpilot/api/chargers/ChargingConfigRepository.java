package com.voltpilot.api.chargers;

import com.voltpilot.api.web.dto.ChargingConfigDto;
import com.voltpilot.api.web.dto.ChargingConfigDto.AllowedChargePointDto;
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
                "SELECT grid_limit_kw, surplus_policy, storage_priority, updated_at, updated_by "
                        + "FROM site_charging_config WHERE site_id = ?",
                (rs, n) -> new Object[] {rs.getObject("grid_limit_kw"),
                        rs.getTimestamp("updated_at"), rs.getString("updated_by"),
                        rs.getString("surplus_policy"), rs.getString("storage_priority")},
                siteId);
        List<String> priorities = jdbc.query(
                "SELECT charge_point_id FROM site_charge_point_priority WHERE site_id = ? "
                        + "ORDER BY charge_point_id",
                (rs, n) -> rs.getString("charge_point_id"), siteId);
        List<AllowedChargePointDto> allowed = allowlist(siteId);
        if (head.isEmpty()) {
            return new ChargingConfigDto(null, List.copyOf(priorities), null, null, allowed,
                    null, null);
        }
        Object[] row = head.get(0);
        Timestamp at = (Timestamp) row[1];
        return new ChargingConfigDto((Double) row[0], List.copyOf(priorities),
                (String) row[3], (String) row[4], allowed,
                at == null ? null : at.toInstant(), (String) row[2]);
    }

    /** Die eingetragenen Kennungen dieser Anlage (aelteste zuerst). */
    public List<AllowedChargePointDto> allowlist(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT charge_point_id, label, rated_kw, connectors, added_at, added_by "
                        + "FROM site_charge_point_allowlist WHERE site_id = ? "
                        + "ORDER BY added_at, charge_point_id",
                (rs, n) -> new AllowedChargePointDto(rs.getString("charge_point_id"),
                        rs.getString("label"), (Double) rs.getObject("rated_kw"),
                        (Integer) rs.getObject("connectors"),
                        rs.getTimestamp("added_at") == null ? null
                                : rs.getTimestamp("added_at").toInstant(),
                        rs.getString("added_by")),
                siteId));
    }

    /**
     * Traegt eine Kennung ein bzw. frischt ihre Angaben auf.
     *
     * <p>⚠ Es gibt hier bewusst KEIN Loeschen. Eine Kennung zu entfernen wirft
     * die Saeule beim naechsten Verbindungsaufbau vom Broker - eine Entscheidung
     * mit Folgen fuer eine laufende Anlage, und die bleibt eine ausdrueckliche
     * Handlung am Geraet (dieselbe Regel, die auch die Box selbst fuehrt).
     */
    @Transactional
    public void admitChargePoint(UUID tenantId, UUID siteId, String chargePointId, String label,
            Double ratedKw, Integer connectors, String actor) {
        jdbc.update("INSERT INTO site_charge_point_allowlist (site_id, charge_point_id, tenant_id, "
                + "label, rated_kw, connectors, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id, charge_point_id) DO UPDATE SET "
                + "label = COALESCE(EXCLUDED.label, site_charge_point_allowlist.label), "
                + "rated_kw = COALESCE(EXCLUDED.rated_kw, site_charge_point_allowlist.rated_kw), "
                + "connectors = COALESCE(EXCLUDED.connectors, "
                + "site_charge_point_allowlist.connectors)",
                siteId, chargePointId, tenantId, label, ratedKw, connectors,
                Timestamp.from(Instant.now()), actor);
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

    /**
     * Setzt die QUELLEN-Wahl (Stufe 4). Beide Felder sind einzeln optional:
     * null heißt „dazu sagt der Kunde nichts" und der gespeicherte Wert bleibt
     * stehen - dieselbe PATCH-Semantik wie überall auf diesem Pfad.
     */
    @Transactional
    public void saveSourceChoice(UUID tenantId, UUID siteId, String surplusPolicy,
            String storagePriority, String actor) {
        jdbc.update("INSERT INTO site_charging_config (site_id, tenant_id, surplus_policy, "
                + "storage_priority, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) "
                + "ON CONFLICT (site_id) DO UPDATE SET "
                + "surplus_policy = COALESCE(EXCLUDED.surplus_policy, site_charging_config.surplus_policy), "
                + "storage_priority = COALESCE(EXCLUDED.storage_priority, site_charging_config.storage_priority), "
                + "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
                siteId, tenantId, surplusPolicy, storagePriority, Timestamp.from(Instant.now()),
                actor);
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
