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

    /** Der Deckel des Kontrakts fuer die Grabstein-Liste. */
    private static final int MAX_REMOVED = 64;

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
        List<String> removed = removedChargePointIds(siteId);
        if (head.isEmpty()) {
            return new ChargingConfigDto(null, List.copyOf(priorities), null, null, allowed,
                    removed, null, null);
        }
        Object[] row = head.get(0);
        Timestamp at = (Timestamp) row[1];
        return new ChargingConfigDto((Double) row[0], List.copyOf(priorities),
                (String) row[3], (String) row[4], allowed, removed,
                at == null ? null : at.toInstant(), (String) row[2]);
    }

    /** Die eingetragenen Kennungen dieser Anlage (aelteste zuerst). */
    public List<AllowedChargePointDto> allowlist(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT charge_point_id, label, rated_kw, connectors, added_at, added_by "
                        + "FROM site_charge_point_allowlist WHERE site_id = ? "
                        + "AND removed_at IS NULL ORDER BY added_at, charge_point_id",
                (rs, n) -> new AllowedChargePointDto(rs.getString("charge_point_id"),
                        rs.getString("label"), (Double) rs.getObject("rated_kw"),
                        (Integer) rs.getObject("connectors"),
                        rs.getTimestamp("added_at") == null ? null
                                : rs.getTimestamp("added_at").toInstant(),
                        rs.getString("added_by")),
                siteId));
    }

    /**
     * Die zurueckgenommenen Kennungen dieser Anlage - die GRABSTEIN-Liste, die
     * in jedem folgenden Dokument mitreist (neueste zuerst).
     *
     * <p>⚠ Sie ist gedeckelt wie die Allowlist selbst: der Kontrakt traegt
     * hoechstens so viele Zeilen, und was hier still wegfiele, kaeme bei der Box
     * nie an. Gekappt wird deshalb die AELTESTE Ruecknahme - eine Loeschung, die
     * so lange her ist, hat jede lebende Box laengst gesehen.
     */
    public List<String> removedChargePointIds(UUID siteId) {
        return List.copyOf(jdbc.query(
                "SELECT charge_point_id FROM site_charge_point_allowlist WHERE site_id = ? "
                        + "AND removed_at IS NOT NULL ORDER BY removed_at DESC, charge_point_id "
                        + "LIMIT " + MAX_REMOVED,
                (rs, n) -> rs.getString("charge_point_id"), siteId));
    }

    /**
     * Traegt eine Kennung ein bzw. frischt ihre Angaben auf.
     *
     * <p>⚠ Ein erneutes Eintragen BELEBT eine zurueckgenommene Zeile wieder
     * ({@code removed_at = NULL}) - sie verschwindet damit aus der
     * Grabstein-Liste und steht wieder in {@code charge_points}. Eine Kennung
     * steht deshalb nie in beiden Listen.
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
                + "site_charge_point_allowlist.connectors), "
                + "removed_at = NULL, removed_by = NULL",
                siteId, chargePointId, tenantId, label, ratedKw, connectors,
                Timestamp.from(Instant.now()), actor);
    }

    /**
     * Nimmt eine Kennung zurueck - als GRABSTEIN, nicht als Loeschung.
     *
     * <p>⚠ Die Zeile BLEIBT stehen. Das retained Dokument wird als Ganzes
     * ersetzt, also wuerde eine Kennung nur wegzulassen von einer Box, die
     * gerade offline war, nie gesehen ({@code charge_points} fuegt nur hinzu).
     * Die Ruecknahme muss deshalb dauerhaft gefuehrt und in jedem folgenden
     * Dokument genannt werden.
     *
     * <p>Idempotent: eine schon zurueckgenommene Kennung behaelt ihren ersten
     * Stempel (die Papier-Spur nennt, wer sie WIRKLICH entfernt hat).
     *
     * @return true, wenn diese Kennung eingetragen WAR
     */
    @Transactional
    public boolean removeChargePoint(UUID siteId, String chargePointId, String actor) {
        return jdbc.update("UPDATE site_charge_point_allowlist SET removed_at = ?, removed_by = ? "
                + "WHERE site_id = ? AND charge_point_id = ? AND removed_at IS NULL",
                Timestamp.from(Instant.now()), actor, siteId, chargePointId) > 0;
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
