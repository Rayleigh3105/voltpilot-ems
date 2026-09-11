package com.voltpilot.api.repo;

import com.voltpilot.api.tenant.Betriebsart;
import com.voltpilot.api.web.dto.TenantDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Tenant CRUD for the platform-admin API.
 *
 * <p>Unlike the customer repositories (which use the tenant-scoped
 * {@code voltpilot_app} datasource and rely on RLS), this repository uses the
 * dedicated {@code adminJdbcTemplate} bound to the {@code voltpilot_admin}
 * BYPASSRLS role - so a Portal-Admin can list and create tenants across the
 * whole platform. This is the ONLY cross-tenant data path and it is reached only
 * from {@code @PreAuthorize("hasRole('platform-admin')")} endpoints.
 */
@Repository
public class TenantRepository {

    private final JdbcTemplate jdbc;

    public TenantRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbcTemplate) {
        this.jdbc = adminJdbcTemplate;
    }

    public List<TenantDto> findAll() {
        return jdbc.query(
                "SELECT id, name, segment, plan, betriebsart, created_at FROM tenant "
                        + "ORDER BY created_at",
                TenantRepository::map);
    }

    /**
     * Create a tenant - and, in the SAME statement (one transaction), its one
     * UEMS {@code unternehmen} plus that company's "angelegt" log entry (AP-00
     * E2, AP-02 §4.1: exactly one company per Kundenbereich, created
     * automatically with it). This is the same row the migration
     * V20260911100000 backfilled for every tenant that existed before it: name =
     * tenant name brought onto the naming rule, zone Europe/Berlin, no person
     * ({@code created_by}/{@code akteur_sub} NULL). The log names the actor
     * "VoltPilot" - not "(Bestandsübernahme)": a new Kundenbereich takes over no
     * existing stock. The app role has no INSERT on {@code unternehmen} at all;
     * this admin connection (BYPASSRLS) is the only way one comes into being.
     */
    public TenantDto create(String name, String segment) {
        return jdbc.queryForObject(
                "WITH t AS ("
                        + " INSERT INTO tenant (name, segment) VALUES (?, ?)"
                        + " RETURNING id, name, segment, plan, betriebsart, created_at),"
                        + " u AS ("
                        + " INSERT INTO unternehmen (tenant_id, name, zeitzone)"
                        + " SELECT t.id, COALESCE(NULLIF(btrim(left(btrim(t.name), 120)), ''),"
                        + " 'Unternehmen'), 'Europe/Berlin' FROM t"
                        + " RETURNING id, tenant_id, name, zeitzone, created_at),"
                        + " p AS ("
                        + " INSERT INTO ort_aenderung (tenant_id, objekt_art, objekt_id, art, alt,"
                        + " neu, gilt_ab, rueckwirkend, akteur_sub, akteur_name)"
                        + " SELECT u.tenant_id, 'unternehmen', u.id, 'angelegt', NULL,"
                        + " jsonb_build_object('name', u.name, 'zeitzone', u.zeitzone),"
                        + " (u.created_at AT TIME ZONE u.zeitzone)::date, false, NULL, 'VoltPilot'"
                        + " FROM u)"
                        + " SELECT id, name, segment, plan, betriebsart, created_at FROM t",
                TenantRepository::map, name, segment);
    }

    /**
     * Update a tenant's master data. Null when the tenant does not exist.
     * {@code betriebsart} is the full-representation U0 override: 'endkunde' /
     * 'betreiber' set it, null clears it back to the segment-derived automatic.
     */
    public TenantDto update(UUID tenantId, String name, String segment, String betriebsart) {
        List<TenantDto> updated = jdbc.query(
                "UPDATE tenant SET name = ?, segment = ?, betriebsart = ? WHERE id = ? "
                        + "RETURNING id, name, segment, plan, betriebsart, created_at",
                TenantRepository::map, name, segment, betriebsart, tenantId);
        return updated.isEmpty() ? null : updated.get(0);
    }

    /** The tenant by id, or null. */
    public TenantDto findById(UUID tenantId) {
        List<TenantDto> found = jdbc.query(
                "SELECT id, name, segment, plan, betriebsart, created_at FROM tenant WHERE id = ?",
                TenantRepository::map, tenantId);
        return found.isEmpty() ? null : found.get(0);
    }

    /**
     * Delete a tenant row. Used only to compensate a failed self-registration
     * (the tenant was just created and owns no data yet); child rows would make
     * this fail by FK, which is the safety we want. The ONE exception is the
     * {@code unternehmen} {@link #create} made with it (FK ON DELETE RESTRICT):
     * it goes first, in the same transaction - so a tenant that has grown any
     * other data still refuses. Its log entry stays (append-only, no FK - the
     * offboarding rule).
     */
    public void deleteById(UUID tenantId) {
        jdbc.execute((java.sql.Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                deleteByTenant(con, "unternehmen", tenantId);
                deleteByTenant(con, "tenant", tenantId, "id");
                con.commit();
                return null;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof java.sql.SQLException sql ? sql
                        : new java.sql.SQLException("tenant compensation failed", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    /** A device row of the tenant, as needed for the MQTT retained-topic cleanup. */
    public record TenantDevice(UUID id, UUID siteId, String externalRef) {
    }

    public List<TenantDevice> devicesOfTenant(UUID tenantId) {
        return jdbc.query(
                "SELECT id, site_id, external_ref FROM device WHERE tenant_id = ?",
                (rs, i) -> new TenantDevice(
                        rs.getObject("id", UUID.class),
                        rs.getObject("site_id", UUID.class),
                        rs.getString("external_ref")),
                tenantId);
    }

    /** What the database cascade of {@link #offboard} removed. */
    public record OffboardCounts(int sites, int devices, long telemetryRows) {
    }

    /**
     * Offboard a tenant: remove every series row of the tenant (the hypertables
     * carry no FKs) and then the tenant row itself, whose FKs cascade
     * site/device/asset - all in ONE database transaction, so a failure leaves
     * the tenant fully intact. Keycloak cleanup is separate and best-effort
     * (see the controller): the directory is another system and must not be
     * able to roll back the data deletion the operator confirmed.
     */
    public OffboardCounts offboard(UUID tenantId) {
        return jdbc.execute((java.sql.Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                for (String table : new String[] {
                        "ocpp_station", "ocpp_connector_state", "ocpp_protocol_event",
                        "ocpp_connector_status_event", "ocpp_authorization_event", "ocpp_transaction",
                        "ocpp_meter_sample", "ocpp_station_status_event", "ocpp_configuration_key",
                        "ocpp_configuration_unknown_key", "ocpp_station_capability", "ocpp_action",
                        "ocpp_action_audit", "ocpp_action_intent"}) {
                    deleteByTenant(con, table, tenantId);
                }
                long telemetryRows = deleteByTenant(con, "telemetry", tenantId);
                for (String table : new String[] {
                        "telemetry_rollup_15m", "telemetry_rollup_1h", "telemetry_rollup_1d",
                        "weather_forecast", "schedule", "forecast",
                        "forecast_model_state", "forecast_accuracy", "plan_accuracy"}) {
                    deleteByTenant(con, table, tenantId);
                }
                int sites = count(con, "SELECT count(*) FROM site WHERE tenant_id = ?", tenantId);
                int devices = count(con, "SELECT count(*) FROM device WHERE tenant_id = ?", tenantId);
                // The UEMS master data (V20260911100000, V20260911110000,
                // V20260911140000, V20260911150000, V20260911210000) references
                // tenant/site/standort/ort with ON DELETE RESTRICT - never a cascade.
                // Offboarding is the ONE way a company ends, so it removes them
                // explicitly, children first: a Messstelle before the Orte it will point
                // to, floor areas and parent intervals before the buildings/areas they
                // point at, those before the Standort; the Zustaendigkeiten before their
                // Datenquelle; the Kurzzeichen occupancy and counter of the Orte (no FK
                // to the Orte, only to the tenant) with them. The
                // append-only logs ort_aenderung, messstelle_aenderung and
                // data_source_aenderung carry no FK and stay (the component_change_event
                // pattern). The components go with the
                // tenant cascade below, but their data_source_id is RESTRICT too: they
                // let go of their source first.
                try (java.sql.PreparedStatement st = con.prepareStatement(
                        "UPDATE measurement_point SET data_source_id = NULL "
                                + "WHERE tenant_id = ? AND data_source_id IS NOT NULL")) {
                    st.setObject(1, tenantId);
                    st.executeUpdate();
                }
                for (String table : new String[] {
                        "data_source_assignment", "data_source", "data_source_kennzeichen_seq",
                        "messstelle_groesse", "messstelle_kennzeichen", "messstelle",
                        "messstelle_kennzeichen_seq",
                        "flaeche_gueltigkeit", "ort_zuordnung", "ort",
                        "anlage_standort", "standort", "ort_kurzzeichen", "ort_kurzzeichen_seq",
                        "unternehmen"}) {
                    deleteByTenant(con, table, tenantId);
                }
                deleteByTenant(con, "tenant", tenantId, "id");
                con.commit();
                return new OffboardCounts(sites, devices, telemetryRows);
            } catch (Exception e) {
                con.rollback();
                throw e instanceof java.sql.SQLException sql ? sql
                        : new java.sql.SQLException("tenant offboarding failed", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    private static long deleteByTenant(java.sql.Connection con, String table, UUID tenantId)
            throws java.sql.SQLException {
        return deleteByTenant(con, table, tenantId, "tenant_id");
    }

    private static long deleteByTenant(java.sql.Connection con, String table, UUID tenantId,
            String column) throws java.sql.SQLException {
        try (java.sql.PreparedStatement st = con.prepareStatement(
                "DELETE FROM " + table + " WHERE " + column + " = ?")) {
            st.setObject(1, tenantId);
            return st.executeUpdate();
        }
    }

    private static int count(java.sql.Connection con, String sql, UUID tenantId)
            throws java.sql.SQLException {
        try (java.sql.PreparedStatement st = con.prepareStatement(sql)) {
            st.setObject(1, tenantId);
            try (java.sql.ResultSet rs = st.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    public boolean existsById(UUID tenantId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM tenant WHERE id = ?", Integer.class, tenantId);
        return count != null && count > 0;
    }

    private static TenantDto map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        OffsetDateTime created = rs.getObject("created_at", OffsetDateTime.class);
        String segment = rs.getString("segment");
        String betriebsart = rs.getString("betriebsart");
        return new TenantDto(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                segment,
                rs.getString("plan"),
                betriebsart,
                Betriebsart.effective(betriebsart, segment),
                created != null ? created.toInstant() : null);
    }
}
