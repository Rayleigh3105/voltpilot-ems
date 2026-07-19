package com.voltpilot.api.repo;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Flow definitions (E3a flow editor): one row per (flow_id, flow_version),
 * document = the flow-graph contract JSON verbatim, lifecycle = the
 * AUTHORITATIVE state machine (contract §5). RLS-scoped through the tenant-
 * aware app datasource like every customer repo - platform-admin surfaces
 * reach it via the X-Tenant-Id switcher, foreign rows are simply invisible.
 */
@Repository
public class FlowRepository {

    /** One stored flow version. */
    public record FlowVersionRow(UUID flowId, int flowVersion, UUID siteId, String name,
            String runtime, String lifecycle, String documentJson, String simulationJson,
            String artifactJson, Instant createdAt, Instant updatedAt, Instant simulatedAt,
            Instant activatedAt) {}

    private static final String COLUMNS =
            "flow_id, flow_version, site_id, name, runtime, lifecycle, document::text AS doc, "
                    + "simulation::text AS sim, artifact::text AS art, created_at, updated_at, "
                    + "simulated_at, activated_at";

    private final JdbcTemplate jdbc;

    public FlowRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** All versions of all flows of one site, newest flow first, versions descending. */
    public List<FlowVersionRow> versionsForSite(UUID siteId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM flow_definition WHERE site_id = ? "
                        + "ORDER BY created_at DESC, flow_id, flow_version DESC",
                FlowRepository::mapRow, siteId);
    }

    /** All versions of one flow, descending. */
    public List<FlowVersionRow> versionsForFlow(UUID flowId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM flow_definition WHERE flow_id = ? "
                        + "ORDER BY flow_version DESC",
                FlowRepository::mapRow, flowId);
    }

    /** One version, or null (also null for a foreign tenant's flow - RLS). */
    public FlowVersionRow find(UUID flowId, int version) {
        List<FlowVersionRow> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM flow_definition WHERE flow_id = ? AND "
                        + "flow_version = ?",
                FlowRepository::mapRow, flowId, version);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The active version of a flow, or null. */
    public FlowVersionRow findActive(UUID flowId) {
        List<FlowVersionRow> rows = jdbc.query(
                "SELECT " + COLUMNS + " FROM flow_definition WHERE flow_id = ? AND "
                        + "lifecycle = 'active'",
                FlowRepository::mapRow, flowId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** The ACTIVE versions of all OTHER flows of a site+runtime (V-5 cross-flow). */
    public List<FlowVersionRow> activeVersionsForSiteExcept(UUID siteId, String runtime,
            UUID exceptFlowId) {
        return jdbc.query(
                "SELECT " + COLUMNS + " FROM flow_definition WHERE site_id = ? AND runtime = ? "
                        + "AND lifecycle = 'active' AND flow_id <> ?",
                FlowRepository::mapRow, siteId, runtime, exceptFlowId);
    }

    /** The documents (JSON text) of all ACTIVE flows of a site - the AE7 profile
     * derivation reads the strategy nodes lying on the site's storages. */
    public List<String> activeDocuments(UUID siteId) {
        return jdbc.query(
                "SELECT document::text FROM flow_definition WHERE site_id = ? AND "
                        + "lifecycle = 'active'",
                (rs, rowNum) -> rs.getString(1), siteId);
    }

    public int maxVersion(UUID flowId) {
        Integer max = jdbc.queryForObject(
                "SELECT COALESCE(MAX(flow_version), 0) FROM flow_definition WHERE flow_id = ?",
                Integer.class, flowId);
        return max == null ? 0 : max;
    }

    /** Insert a new draft version. RLS WITH CHECK guarantees the tenant stamp. */
    public void insertDraft(UUID tenantId, UUID siteId, UUID flowId, int version, String name,
            String runtime, String documentJson) {
        jdbc.update(
                "INSERT INTO flow_definition (flow_id, flow_version, tenant_id, site_id, name, "
                        + "runtime, lifecycle, document) VALUES (?, ?, ?, ?, ?, ?, 'draft', "
                        + "?::jsonb)",
                flowId, version, tenantId, siteId, name, runtime, documentJson);
    }

    /** Update a DRAFT version in place (no-op when the version left draft). */
    public boolean updateDraft(UUID flowId, int version, String name, String documentJson) {
        return jdbc.update(
                "UPDATE flow_definition SET name = ?, document = ?::jsonb, updated_at = now() "
                        + "WHERE flow_id = ? AND flow_version = ? AND lifecycle = 'draft'",
                name, documentJson, flowId, version) > 0;
    }

    /** draft -> simulated, recording the dry-run summary. Idempotent. */
    public void markSimulated(UUID flowId, int version, String simulationJson) {
        jdbc.update(
                "UPDATE flow_definition SET lifecycle = CASE WHEN lifecycle = 'draft' THEN "
                        + "'simulated' ELSE lifecycle END, simulation = ?::jsonb, "
                        + "simulated_at = now(), updated_at = now() "
                        + "WHERE flow_id = ? AND flow_version = ?",
                simulationJson, flowId, version);
    }

    /** The previously active version is superseded (contract: atomic replace). */
    public void retireActive(UUID flowId) {
        jdbc.update(
                "UPDATE flow_definition SET lifecycle = 'retired', updated_at = now() "
                        + "WHERE flow_id = ? AND lifecycle = 'active'",
                flowId);
    }

    /** Mark one version active, storing the compiled artifact when present. */
    public void markActive(UUID flowId, int version, String artifactJson) {
        jdbc.update(
                "UPDATE flow_definition SET lifecycle = 'active', artifact = ?::jsonb, "
                        + "activated_at = now(), updated_at = now() "
                        + "WHERE flow_id = ? AND flow_version = ?",
                artifactJson, flowId, version);
    }

    /** Delete a whole flow (all versions). Refused upstream while active. */
    public int deleteFlow(UUID flowId) {
        return jdbc.update("DELETE FROM flow_definition WHERE flow_id = ?", flowId);
    }

    private static FlowVersionRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new FlowVersionRow(
                rs.getObject("flow_id", UUID.class),
                rs.getInt("flow_version"),
                rs.getObject("site_id", UUID.class),
                rs.getString("name"),
                rs.getString("runtime"),
                rs.getString("lifecycle"),
                rs.getString("doc"),
                rs.getString("sim"),
                rs.getString("art"),
                instant(rs, "created_at"),
                instant(rs, "updated_at"),
                instant(rs, "simulated_at"),
                instant(rs, "activated_at"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        java.sql.Timestamp ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
