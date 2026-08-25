package com.voltpilot.api.repo;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * The materialized claims of the site's ACTIVE flows (Steuerung Stufe 3,
 * Konzept vp-steuerung-konzept-b3 §3.7 A3/A4). {@link
 * com.voltpilot.api.flows.FlowClaims} stays the ONE derivation - this table is
 * only its persisted projection, written in the activation transaction so two
 * consumers OUTSIDE this process can read it: the registry push (which stamps
 * {@code owner_claimed} per entity, so the box injects no plan setpoint for a
 * claimed component) and the optimizer (which planned every battery blindly
 * until now).
 *
 * <p>RLS-scoped through the tenant-aware app datasource like every customer
 * repo; a foreign site's claims are simply invisible.
 */
@Repository
public class FlowClaimRepository {

    /** One persisted claim - (entity, command) held by exactly one active flow. */
    public record ClaimRow(UUID entityId, String command, UUID flowId, int flowVersion,
            String flowName, boolean delegated, Instant claimedAt) {

        /**
         * Eine NEUE Beanspruchung. Die Startzeit vergibt die DATENBANK
         * ({@code claimed_at DEFAULT now()}) - der Schreibpfad nennt sie
         * deshalb gar nicht erst, damit es keine zweite Uhr gibt.
         */
        public ClaimRow(UUID entityId, String command, UUID flowId, int flowVersion,
                String flowName, boolean delegated) {
            this(entityId, command, flowId, flowVersion, flowName, delegated, null);
        }
    }

    private final JdbcTemplate jdbc;

    public FlowClaimRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Every claim of one site. */
    public List<ClaimRow> forSite(UUID siteId) {
        return jdbc.query(
                "SELECT entity_id, command, flow_id, flow_version, flow_name, delegated, "
                        + "claimed_at FROM flow_claim WHERE site_id = ? "
                        + "ORDER BY entity_id, command",
                (rs, n) -> new ClaimRow(rs.getObject("entity_id", UUID.class),
                        rs.getString("command"), rs.getObject("flow_id", UUID.class),
                        rs.getInt("flow_version"), rs.getString("flow_name"),
                        rs.getBoolean("delegated"),
                        // Der Anker des Nachteil-Belegs (Stufe 7): seit WANN diese
                        // Regel den Speicher hält. Er kommt aus der Zeile, die den
                        // Anspruch materialisiert - jede andere Uhr (etwa
                        // `flow_definition.updated_at`) verschöbe sich beim
                        // Bearbeiten und machte den Nachteil kleiner, als er ist.
                        rs.getObject("claimed_at", java.sql.Timestamp.class) == null ? null
                                : rs.getObject("claimed_at", java.sql.Timestamp.class)
                                        .toInstant()),
                siteId);
    }

    /**
     * The entities an ACTIVE customer rule OWNS, mapped to the NAME of the
     * holding flow. A component claimed by several commands keeps the one
     * holder (V-5 makes that unambiguous: one flow controls one entity).
     *
     * <p>⚠ DELEGATED claims are EXCLUDED, and that is the whole point: a
     * {@code vp.strategy.*} node claims its entity in order to hand dispatch
     * to the PLAN. Stamping {@code owner_claimed} for one would make the box
     * skip the plan for exactly the component the Betriebsmodell wants planned
     * - the feature inverted. Only a DIRECT claim (a customer rule that
     * commands the component itself) takes the component away from the plan.
     */
    public Map<UUID, String> claimedEntities(UUID siteId) {
        Map<UUID, String> out = new HashMap<>();
        for (ClaimRow row : forSite(siteId)) {
            if (!row.delegated()) {
                out.putIfAbsent(row.entityId(), row.flowName());
            }
        }
        return out;
    }

    /**
     * Replace the claims of ONE flow. Called in the activation transaction with
     * the freshly derived set, and with an empty list when a flow is retired or
     * deleted - so a claim never outlives the flow that holds it.
     */
    public void replaceForFlow(UUID tenantId, UUID siteId, UUID flowId, int flowVersion,
            String flowName, List<ClaimRow> claims) {
        jdbc.update("DELETE FROM flow_claim WHERE flow_id = ?", flowId);
        for (ClaimRow claim : claims) {
            jdbc.update(
                    "INSERT INTO flow_claim (entity_id, command, tenant_id, site_id, flow_id, "
                            + "flow_version, flow_name, delegated) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                            + "ON CONFLICT (entity_id, command) DO UPDATE SET "
                            + "tenant_id = EXCLUDED.tenant_id, site_id = EXCLUDED.site_id, "
                            + "flow_id = EXCLUDED.flow_id, flow_version = EXCLUDED.flow_version, "
                            + "flow_name = EXCLUDED.flow_name, delegated = EXCLUDED.delegated, "
                            + "claimed_at = now()",
                    claim.entityId(), claim.command(), tenantId, siteId, flowId, flowVersion,
                    flowName, claim.delegated());
        }
    }

    /** Drop every claim of one flow (deactivate / delete). */
    public void clearForFlow(UUID flowId) {
        jdbc.update("DELETE FROM flow_claim WHERE flow_id = ?", flowId);
    }
}
