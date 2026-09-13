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
     *  the operator-given name - never a brand/model/role concatenation.
     *  edgeLink is the Stufe-2 connection half - {@code null} whenever the box
     *  did not report one. */
    public record ObservedRow(UUID deviceId, String entityId, String source, String entityType,
            String health, String label, Instant lastTelemetryAt, String appliedRevision,
            String channelsJson, Instant reportedAt, String edgeRole, String edgeBrand,
            String edgeModel, EdgeLink edgeLink) {}

    /**
     * WIE ein gemeldetes Gerät erreicht wird (Einheitsmodell Stufe 2): die
     * Verbindungs-Hälfte eines {@code local_setup}-Eintrags, genau die Felder,
     * die {@code sources.Source}/{@code inverter.Selection} auf der Box
     * speichern.
     *
     * <p><b>Die Ehrlichkeitsregel:</b> ein {@code null} hier heißt „diese Box
     * meldet (noch) keine Verbindungen" - NIE „dieses Gerät hat keine". Ein
     * älterer Box-Stand lässt die Felder weg, und daraus darf nur „Übernahme
     * noch nicht möglich" folgen, nie ein halbes Soll.
     */
    public record EdgeLink(String communication, String family, String connectionJson,
            Integer intervalS, java.math.BigDecimal capacityKwp, String registryUnitId) {

        /**
         * Ob dieser Eintrag für eine Übernahme AUSREICHT. Transport und
         * Verbindungsfelder sind das Minimum - ohne sie kann die Cloud kein Soll
         * schreiben, das die Box zeichengleich wieder herleitet.
         */
        public boolean complete() {
            return communication != null && !communication.isBlank()
                    && connectionJson != null && !connectionJson.isBlank();
        }
    }

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
            EdgeLink link = row.edgeLink();
            jdbc.update(
                    "INSERT INTO entity_observed_state (device_id, entity_id, tenant_id, site_id, "
                            + "source, entity_type, health, label, last_telemetry_at, "
                            + "applied_revision, channels, reported_at, edge_role, edge_brand, "
                            + "edge_model, edge_communication, edge_family, edge_connection, "
                            + "edge_interval_s, edge_capacity_kwp, edge_registry_unit_id) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, "
                            + "?::jsonb, ?, ?, ?)",
                    deviceId, row.entityId(), tenantId, siteId, row.source(), row.entityType(),
                    row.health(), row.label(),
                    row.lastTelemetryAt() == null ? null
                            : java.sql.Timestamp.from(row.lastTelemetryAt()),
                    row.appliedRevision(), row.channelsJson(),
                    java.sql.Timestamp.from(reportedAt), row.edgeRole(), row.edgeBrand(),
                    row.edgeModel(),
                    link == null ? null : link.communication(),
                    link == null ? null : link.family(),
                    link == null ? null : link.connectionJson(),
                    link == null ? null : link.intervalS(),
                    link == null ? null : link.capacityKwp(),
                    link == null ? null : link.registryUnitId());
        }
    }

    /**
     * All observed rows of a site's active devices, stable order. What an ausgebaut box last
     * reported stays stored (UEMS AP-07 IP-11) but is no longer what the site reports now.
     */
    public List<ObservedRow> forSite(UUID siteId) {
        return jdbc.query(
                "SELECT device_id, entity_id, source, entity_type, health, label, "
                        + "last_telemetry_at, applied_revision, channels::text AS channels_json, "
                        + "reported_at, edge_role, edge_brand, edge_model, edge_communication, "
                        + "edge_family, edge_connection::text AS edge_connection_json, "
                        + "edge_interval_s, edge_capacity_kwp, edge_registry_unit_id "
                        + "FROM entity_observed_state "
                        + "WHERE site_id = ? AND EXISTS (SELECT 1 FROM device d "
                        + "  WHERE d.id = entity_observed_state.device_id AND d.ausgebaut_am IS NULL) "
                        + "ORDER BY source, entity_id",
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
                rs.getString("edge_model"),
                mapLink(rs));
    }

    /**
     * Die Verbindungs-Hälfte, oder {@code null}. Sie ist ENTWEDER da ODER nicht:
     * ohne Transport gibt es nichts zu übernehmen, also entsteht dann auch keine
     * halb gefüllte {@link EdgeLink}, die später wie ein Angebot aussähe.
     */
    private static EdgeLink mapLink(ResultSet rs) throws SQLException {
        String communication = rs.getString("edge_communication");
        String connection = rs.getString("edge_connection_json");
        if ((communication == null || communication.isBlank())
                && (connection == null || connection.isBlank())) {
            return null;
        }
        int interval = rs.getInt("edge_interval_s");
        return new EdgeLink(communication, rs.getString("edge_family"), connection,
                rs.wasNull() ? null : interval,
                rs.getBigDecimal("edge_capacity_kwp"),
                rs.getString("edge_registry_unit_id"));
    }
}
