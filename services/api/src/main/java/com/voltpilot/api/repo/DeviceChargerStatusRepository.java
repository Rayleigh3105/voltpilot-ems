package com.voltpilot.api.repo;

import com.voltpilot.api.web.dto.SiteChargingDto;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargeConnectorDto;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargePointDto;
import com.voltpilot.api.web.dto.SiteChargingDto.ChargingBudgetDto;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Der edge-gemeldete Ist der OCPP-Ladepunkte (Migration V20260828000000):
 * das Standort-Budget, die Säulen und ihre Stecker, geschrieben von
 * {@link com.voltpilot.api.chargers.ChargerStatusListener} aus dem
 * {@code chargers}-Block des Herzschlags und gelesen von der Portal-Fläche.
 * RLS-gefenced wie jede geräte-eigene Tabelle.
 *
 * <p>⚠ Je Herzschlag wird der ganze Satz eines Geräts ERSETZT: der Herzschlag
 * trägt das vollständige Ist, ein Merge hinterließe Geister (eine entfernte
 * Säule bliebe für immer in der Liste stehen). Genau die
 * {@code device_source_status}-Disziplin.
 */
@Repository
public class DeviceChargerStatusRepository {

    /** Das Standort-Budget einer Box, so wie sie es gemeldet hat. */
    public record BudgetRow(boolean enabled, boolean controlEnabled, String controlNote,
            Double gridLimitKw, Double marginPct, Double minPowerKw, Double budgetKw,
            Double allocatedKw, Double reservedKw, Double measuredKw, Double siteLoadKw,
            Double siteGridKw, String budgetMode, String budgetNote, boolean budgetBlind,
            Double effLimitKw, Double safeDefaultKw, String safeDefaultNote,
            Boolean safeDefaultHolds, Double safeWorstCaseKw, Double maxHouseLoadKw,
            int connectorCount, String surplusPolicy, String storagePriority,
            boolean surplusActive, Double surplusKw, String surplusMode, String surplusNote,
            boolean surplusBlind, Double surplusTotalKw, Double surplusBatteryKw,
            Double sourceAllocatedKw,
            // ⚠ Port und Pfad des OCPP-Servers sind DREIWERTIG: null heisst
            // "eine aeltere Box meldet es nicht" ODER "der Server lauscht gerade
            // nicht" - nie Port 0. Eine Flaeche, die einen Port nennt, auf dem
            // niemand antwortet, ist schlimmer als eine, die nichts nennt.
            Integer ocppPort, String ocppUrlPath) {}

    /** Eine gemeldete Ladesäule. */
    public record ChargePointRow(String chargePointId, String label, boolean priority,
            boolean connected, String vendor, String model, String firmware, boolean ready,
            String note, Instant lastSeen,
            /*
             * connection = WO die Saeule laut BOX haengt ("haus"/"eigen",
             * Cockpit Phase 1 / C1). null = eine aeltere Box meldet es nicht -
             * NIE "eigen", und auch nicht "haus": erst eine Meldung belegt,
             * dass die Unterscheidung dort angekommen ist.
             */
            String connection,
            List<ConnectorRow> connectors) {}

    /** Ein gemeldeter Stecker. */
    public record ConnectorRow(int connectorId, String status, boolean charging, Double allocatedKw,
            String reason, String reasonText, Instant nextTurn, Double powerKw, Double energyKwh,
            Double socPct, String commandStatus, String readback, String readbackNote,
            Instant sessionSince, Double sessionKwh, Instant meteredAt, boolean boost) {}

    private final JdbcTemplate jdbc;

    public DeviceChargerStatusRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ersetzt den ganzen gemeldeten Satz eines Geräts durch die Sicht EINES Herzschlags. */
    @Transactional
    public void replaceForDevice(UUID deviceId, UUID tenantId, UUID siteId, Instant reportedAt,
            BudgetRow budget, List<ChargePointRow> chargers) {
        jdbc.update("DELETE FROM device_charge_connector WHERE device_id = ?", deviceId);
        // ⚠ Die Komponenten-Bindung überlebt das Ersetzen: sie ist eine
        // Zuordnung der PLATTFORM, keine Meldung des Geräts. Sie erst zu lesen
        // und dann wieder einzusetzen hält den Zuhörer frei davon, die
        // Komponente bei jedem Herzschlag neu erfinden zu müssen.
        Map<String, UUID> entityIds = entityIdsByChargePoint(deviceId);
        jdbc.update("DELETE FROM device_charge_point WHERE device_id = ?", deviceId);
        jdbc.update("DELETE FROM device_charging_budget WHERE device_id = ?", deviceId);
        jdbc.update(
                "INSERT INTO device_charging_budget (device_id, tenant_id, site_id, enabled, "
                        + "control_enabled, control_note, grid_limit_kw, margin_pct, min_power_kw, "
                        + "budget_kw, allocated_kw, reserved_kw, measured_kw, site_load_kw, "
                        + "site_grid_kw, budget_mode, budget_note, budget_blind, eff_limit_kw, "
                        + "safe_default_kw, safe_default_note, safe_default_holds, "
                        + "safe_worst_case_kw, max_house_load_kw, connector_count, "
                        + "surplus_policy, storage_priority, surplus_active, surplus_kw, "
                        + "surplus_mode, surplus_note, surplus_blind, surplus_total_kw, "
                        + "surplus_battery_kw, source_allocated_kw, ocpp_port, ocpp_url_path, "
                        + "reported_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                deviceId, tenantId, siteId, budget.enabled(), budget.controlEnabled(),
                budget.controlNote(), budget.gridLimitKw(), budget.marginPct(), budget.minPowerKw(),
                budget.budgetKw(), budget.allocatedKw(), budget.reservedKw(), budget.measuredKw(),
                budget.siteLoadKw(), budget.siteGridKw(), budget.budgetMode(), budget.budgetNote(),
                budget.budgetBlind(), budget.effLimitKw(), budget.safeDefaultKw(),
                budget.safeDefaultNote(), budget.safeDefaultHolds(), budget.safeWorstCaseKw(),
                budget.maxHouseLoadKw(), budget.connectorCount(), budget.surplusPolicy(),
                budget.storagePriority(), budget.surplusActive(), budget.surplusKw(),
                budget.surplusMode(), budget.surplusNote(), budget.surplusBlind(),
                budget.surplusTotalKw(), budget.surplusBatteryKw(), budget.sourceAllocatedKw(),
                budget.ocppPort(), budget.ocppUrlPath(),
                Timestamp.from(reportedAt));
        for (ChargePointRow c : chargers) {
            jdbc.update(
                    "INSERT INTO device_charge_point (device_id, charge_point_id, tenant_id, "
                            + "site_id, label, priority, connected, vendor, model, firmware, "
                            + "ready, note, last_seen, connection, entity_id, reported_at) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    deviceId, c.chargePointId(), tenantId, siteId, c.label(), c.priority(),
                    c.connected(), c.vendor(), c.model(), c.firmware(), c.ready(), c.note(),
                    ts(c.lastSeen()), c.connection(), entityIds.get(c.chargePointId()),
                    Timestamp.from(reportedAt));
            for (ConnectorRow con : c.connectors()) {
                jdbc.update(
                        "INSERT INTO device_charge_connector (device_id, charge_point_id, "
                                + "connector_id, tenant_id, site_id, status, charging, "
                                + "allocated_kw, reason, reason_text, next_turn, power_kw, "
                                + "energy_kwh, soc_pct, command_status, readback, readback_note, "
                                + "session_since, session_kwh, metered_at, boost, "
                                + "reported_at) "
                                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                                + "?, ?, ?, ?, ?, ?, ?, ?)",
                        deviceId, c.chargePointId(), con.connectorId(), tenantId, siteId,
                        con.status(), con.charging(), con.allocatedKw(), con.reason(),
                        con.reasonText(), ts(con.nextTurn()), con.powerKw(), con.energyKwh(),
                        con.socPct(), con.commandStatus(), con.readback(), con.readbackNote(),
                        ts(con.sessionSince()), con.sessionKwh(), ts(con.meteredAt()),
                        con.boost(), Timestamp.from(reportedAt));
            }
        }
    }

    /** Die Komponenten-Bindungen eines Geräts (charge_point_id -> entity_id). */
    public Map<String, UUID> entityIdsByChargePoint(UUID deviceId) {
        Map<String, UUID> out = new LinkedHashMap<>();
        jdbc.query("SELECT charge_point_id, entity_id FROM device_charge_point "
                + "WHERE device_id = ? AND entity_id IS NOT NULL", rs -> {
                    out.put(rs.getString("charge_point_id"), rs.getObject("entity_id", UUID.class));
                }, deviceId);
        return out;
    }

    /** Bindet eine Säule an die Komponente, die die Plattform für sie komponiert hat. */
    public void bindEntity(UUID deviceId, String chargePointId, UUID entityId) {
        jdbc.update("UPDATE device_charge_point SET entity_id = ? "
                + "WHERE device_id = ? AND charge_point_id = ?", entityId, deviceId, chargePointId);
    }

    /** Die Säulen einer Anlage, die noch KEINE Komponente haben (Geräte-Id + Kennung + Name). */
    public List<UnboundCharger> unbound(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, charge_point_id, label FROM device_charge_point "
                        + "WHERE site_id = ? AND entity_id IS NULL "
                        + "ORDER BY device_id, charge_point_id",
                (rs, n) -> new UnboundCharger(rs.getObject("device_id", UUID.class),
                        rs.getString("charge_point_id"), rs.getString("label")),
                siteId);
    }

    /** Eine Säule ohne Komponente. */
    public record UnboundCharger(UUID deviceId, String chargePointId, String label) {}

    /**
     * Die ganze Ladepunkt-Sicht einer Anlage. {@code budget} ist null, solange
     * kein Gerät den Block gemeldet hat - der ehrliche Zustand einer Anlage
     * ohne Ladesäulen, nie ein Budget von 0.
     */
    public SiteChargingDto forSite(UUID siteId) {
        List<ChargePointDto> points = new ArrayList<>();
        Map<String, List<ChargeConnectorDto>> byPoint = new LinkedHashMap<>();
        jdbc.query("SELECT device_id, charge_point_id, connector_id, status, charging, "
                + "allocated_kw, reason, reason_text, next_turn, power_kw, energy_kwh, soc_pct, "
                + "command_status, readback, readback_note, session_since, session_kwh, "
                + "metered_at, boost "
                + "FROM device_charge_connector WHERE site_id = ? "
                + "ORDER BY device_id, charge_point_id, connector_id", rs -> {
                    byPoint.computeIfAbsent(key(rs.getObject("device_id", UUID.class),
                            rs.getString("charge_point_id")), k -> new ArrayList<>())
                            .add(mapConnector(rs));
                }, siteId);
        jdbc.query("SELECT cp.device_id, cp.charge_point_id, "
                + "CASE WHEN cp.entity_id IS NULL THEN cp.label ELSE mp.label END AS display_label, "
                + "cp.priority, cp.connected, cp.vendor, cp.model, cp.firmware, cp.ready, cp.note, "
                + "cp.last_seen, cp.connection, cp.entity_id, cp.reported_at "
                + "FROM device_charge_point cp "
                + "LEFT JOIN measurement_point mp ON mp.id = cp.entity_id "
                + "WHERE cp.site_id = ? ORDER BY cp.device_id, cp.charge_point_id", rs -> {
                    UUID deviceId = rs.getObject("device_id", UUID.class);
                    String id = rs.getString("charge_point_id");
                    points.add(new ChargePointDto(deviceId, id, rs.getString("display_label"),
                            rs.getBoolean("priority"), rs.getBoolean("connected"),
                            rs.getString("vendor"), rs.getString("model"), rs.getString("firmware"),
                            rs.getBoolean("ready"), rs.getString("note"),
                            instant(rs.getTimestamp("last_seen")),
                            rs.getString("connection"),
                            rs.getObject("entity_id", UUID.class),
                            instant(rs.getTimestamp("reported_at")),
                            byPoint.getOrDefault(key(deviceId, id), List.of())));
                }, siteId);
        List<ChargingBudgetDto> budgets = jdbc.query(
                "SELECT * FROM device_charging_budget WHERE site_id = ? ORDER BY device_id",
                DeviceChargerStatusRepository::mapBudget, siteId);
        return new SiteChargingDto(budgets.isEmpty() ? null : budgets.get(0), points);
    }

    private static String key(UUID deviceId, String chargePointId) {
        return deviceId + "#" + chargePointId;
    }

    private static ChargeConnectorDto mapConnector(ResultSet rs) throws SQLException {
        return new ChargeConnectorDto(rs.getInt("connector_id"), rs.getString("status"),
                rs.getBoolean("charging"), (Double) rs.getObject("allocated_kw"),
                rs.getString("reason"), rs.getString("reason_text"),
                instant(rs.getTimestamp("next_turn")), (Double) rs.getObject("power_kw"),
                (Double) rs.getObject("energy_kwh"), (Double) rs.getObject("soc_pct"),
                rs.getString("command_status"), rs.getString("readback"),
                rs.getString("readback_note"), instant(rs.getTimestamp("session_since")),
                (Double) rs.getObject("session_kwh"), instant(rs.getTimestamp("metered_at")),
                rs.getBoolean("boost"));
    }

    private static ChargingBudgetDto mapBudget(ResultSet rs, int rowNum) throws SQLException {
        return new ChargingBudgetDto(rs.getObject("device_id", UUID.class),
                rs.getBoolean("enabled"), rs.getBoolean("control_enabled"),
                rs.getString("control_note"), (Double) rs.getObject("grid_limit_kw"),
                (Double) rs.getObject("margin_pct"), (Double) rs.getObject("min_power_kw"),
                (Double) rs.getObject("budget_kw"), (Double) rs.getObject("allocated_kw"),
                (Double) rs.getObject("reserved_kw"), (Double) rs.getObject("measured_kw"),
                (Double) rs.getObject("site_load_kw"), (Double) rs.getObject("site_grid_kw"),
                rs.getString("budget_mode"), rs.getString("budget_note"),
                rs.getBoolean("budget_blind"), (Double) rs.getObject("eff_limit_kw"),
                (Double) rs.getObject("safe_default_kw"), rs.getString("safe_default_note"),
                (Boolean) rs.getObject("safe_default_holds"),
                (Double) rs.getObject("safe_worst_case_kw"),
                (Double) rs.getObject("max_house_load_kw"), rs.getInt("connector_count"),
                rs.getString("surplus_policy"), rs.getString("storage_priority"),
                rs.getBoolean("surplus_active"), (Double) rs.getObject("surplus_kw"),
                rs.getString("surplus_mode"), rs.getString("surplus_note"),
                rs.getBoolean("surplus_blind"), (Double) rs.getObject("surplus_total_kw"),
                (Double) rs.getObject("surplus_battery_kw"),
                (Double) rs.getObject("source_allocated_kw"),
                (Integer) rs.getObject("ocpp_port"), rs.getString("ocpp_url_path"),
                instant(rs.getTimestamp("reported_at")));
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
