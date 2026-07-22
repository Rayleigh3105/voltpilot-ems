package com.voltpilot.api.repo;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The portal's canvas layout per flow (flow_layout, migration
 * V20260723010000), RLS-scoped like every tenant-owned table.
 *
 * <p>Positions live HERE and nowhere else: the flow-graph schema is
 * {@code additionalProperties: false} and flowc assigns the artifact bundle's
 * x/y itself inside {@code content_hash}, so a dragged position that reached
 * the document would change the hash and re-deploy the device on every mouse
 * move. Keyed on {@code flow_id} (not the version), so a forked draft inherits
 * the arrangement the customer made.
 */
@Repository
public class FlowLayoutRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper = new ObjectMapper();

    public FlowLayoutRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** One node's saved position. */
    public record Position(double x, double y) {
    }

    /** The saved positions of a flow (empty map = never arranged). */
    public Map<String, Position> find(UUID flowId) {
        return jdbc.query(
                "SELECT positions FROM flow_layout WHERE flow_id = ?",
                rs -> {
                    if (!rs.next()) {
                        return new LinkedHashMap<>();
                    }
                    return parse(rs.getString("positions"));
                },
                flowId);
    }

    /**
     * Replace the flow's layout wholesale (the client always sends the complete
     * arrangement). RLS' WITH CHECK stamps the tenant, so a foreign flow can
     * never be written; the caller has already proven the flow belongs to the
     * site.
     */
    public void save(UUID flowId, UUID siteId, Map<String, Position> positions) {
        jdbc.update(
                "INSERT INTO flow_layout (flow_id, tenant_id, site_id, positions, updated_at) "
                        + "VALUES (?, NULLIF(current_setting('app.tenant_id', true), '')::uuid, ?, ?::jsonb, now()) "
                        + "ON CONFLICT (flow_id) DO UPDATE SET site_id = EXCLUDED.site_id, "
                        + "positions = EXCLUDED.positions, updated_at = now()",
                flowId, siteId, json(positions));
    }

    public void delete(UUID flowId) {
        jdbc.update("DELETE FROM flow_layout WHERE flow_id = ?", flowId);
    }

    private Map<String, Position> parse(String raw) {
        Map<String, Position> out = new LinkedHashMap<>();
        if (raw == null || raw.isBlank()) {
            return out;
        }
        try {
            var tree = mapper.readTree(raw);
            tree.fields().forEachRemaining(e -> {
                var node = e.getValue();
                if (node != null && node.has("x") && node.has("y")) {
                    out.put(e.getKey(), new Position(node.get("x").asDouble(), node.get("y").asDouble()));
                }
            });
        } catch (Exception e) {
            return out; // a corrupt layout degrades to the deterministic auto-layout
        }
        return out;
    }

    private String json(Map<String, Position> positions) {
        try {
            return mapper.writeValueAsString(positions);
        } catch (Exception e) {
            throw new IllegalStateException("layout could not be serialized", e);
        }
    }
}
