package com.voltpilot.api.repo;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Per-site enablement of GATED strategy nodes (AE7 governance, spec §3): a
 * market-/grid-near node type stays inactive until a Portal-Admin enables it for
 * the site. A row = an explicit decision; no row = disabled (fail-safe). RLS-
 * scoped through the app datasource like every customer repo (admin reaches it
 * via the X-Tenant-Id switcher).
 */
@Repository
public class FlowGatedNodeRepository {

    public record Enablement(String nodeType, boolean enabled) {}

    private final JdbcTemplate jdbc;

    public FlowGatedNodeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The node types explicitly ENABLED for the site. */
    public Set<String> enabledNodeTypes(UUID siteId) {
        List<String> types = jdbc.query(
                "SELECT node_type FROM flow_gated_node_enablement WHERE site_id = ? AND enabled = TRUE",
                (rs, rowNum) -> rs.getString(1), siteId);
        return new LinkedHashSet<>(types);
    }

    /** All enablement rows for the site (enabled + explicitly-disabled). */
    public List<Enablement> forSite(UUID siteId) {
        return jdbc.query(
                "SELECT node_type, enabled FROM flow_gated_node_enablement WHERE site_id = ? "
                        + "ORDER BY node_type",
                (rs, rowNum) -> new Enablement(rs.getString("node_type"), rs.getBoolean("enabled")),
                siteId);
    }

    /**
     * Set the enablement of a gated node type for a site. RLS WITH CHECK stamps
     * the tenant; the UNIQUE (site_id, node_type) makes it an upsert.
     */
    public void upsert(UUID tenantId, UUID siteId, String nodeType, boolean enabled) {
        jdbc.update(
                "INSERT INTO flow_gated_node_enablement (tenant_id, site_id, node_type, enabled) "
                        + "VALUES (?, ?, ?, ?) "
                        + "ON CONFLICT (site_id, node_type) DO UPDATE SET enabled = EXCLUDED.enabled, "
                        + "updated_at = now()",
                tenantId, siteId, nodeType, enabled);
    }
}
