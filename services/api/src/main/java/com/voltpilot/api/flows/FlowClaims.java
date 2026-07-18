package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The D-13 claim derivation - the SERVER twin of the portal's
 * {@code src/flows/claims.ts} (shared vectors pin both, the EdgeRef
 * precedent). Claims are derived from the catalog {@code claim_template} +
 * node parameters, with ONE structural rule: an entity-control node whose
 * {@code plan} input is fed by a DELEGATED strategy claiming the SAME entity
 * derives NO own claim - the strategy's delegated claim covers the entity
 * (otherwise the pilot chain strategy → control would conflict with itself
 * under V-5).
 *
 * <p>The editor fills the document's {@code claims} from this derivation; the
 * validator re-derives and refuses a document whose stored claims disagree -
 * exclusive-resource validation must not be cheatable by hand-editing claims.
 */
public final class FlowClaims {

    /** One derived claim, attached to the node that carries it. */
    public record DerivedClaim(String nodeId, String entityId, List<String> commands,
            boolean delegated) {}

    private FlowClaims() {
    }

    /** Derive the claim set of a document against the catalog. */
    public static List<DerivedClaim> derive(JsonNode doc, FlowCatalog catalog) {
        List<DerivedClaim> claims = new ArrayList<>();
        // Pass 1: nodes with fixed command templates (strategies) - they never
        // suppress and are what plan-fed suppression checks against.
        Set<String> delegatedByEntity = new HashSet<>();
        for (JsonNode node : doc.path("nodes")) {
            DerivedClaim claim = templateClaim(node, catalog);
            if (claim != null && claim.delegated()) {
                claims.add(claim);
                delegatedByEntity.add(claim.entityId());
            }
        }
        // Pass 2: direct claims, minus the plan-fed suppression.
        for (JsonNode node : doc.path("nodes")) {
            DerivedClaim claim = templateClaim(node, catalog);
            if (claim == null || claim.delegated()) {
                continue;
            }
            if (planFedByDelegated(doc, catalog, node, claim.entityId(), delegatedByEntity)) {
                continue;
            }
            claims.add(claim);
        }
        return claims;
    }

    private static DerivedClaim templateClaim(JsonNode node, FlowCatalog catalog) {
        JsonNode type = catalog.type(node.path("type").asText());
        if (type == null || !type.has("claim_template")) {
            return null;
        }
        JsonNode template = type.get("claim_template");
        String entityParam = template.path("entity_parameter").asText();
        String entityId = node.path("parameters").path(entityParam).asText("");
        if (entityId.isEmpty()) {
            return null; // parameter validation reports the missing entity
        }
        List<String> commands = new ArrayList<>();
        if (template.has("commands")) {
            for (JsonNode command : template.get("commands")) {
                commands.add(command.asText());
            }
        } else if (template.has("command_parameter")) {
            String command = node.path("parameters")
                    .path(template.get("command_parameter").asText()).asText("");
            if (command.isEmpty()) {
                return null;
            }
            commands.add(command);
        }
        if (commands.isEmpty()) {
            return null;
        }
        return new DerivedClaim(node.path("id").asText(), entityId, commands,
                template.path("delegated").asBoolean(false));
    }

    /**
     * True when this node's {@code plan} input is fed (directly) by a node
     * whose delegated claim covers the same entity.
     */
    private static boolean planFedByDelegated(JsonNode doc, FlowCatalog catalog, JsonNode node,
            String entityId, Set<String> delegatedByEntity) {
        if (!delegatedByEntity.contains(entityId)) {
            return false;
        }
        String nodeId = node.path("id").asText();
        for (JsonNode edge : doc.path("edges")) {
            if (!edge.path("to").path("node").asText().equals(nodeId)
                    || !edge.path("to").path("port").asText().equals("plan")) {
                continue;
            }
            String fromNode = edge.path("from").path("node").asText();
            for (JsonNode other : doc.path("nodes")) {
                if (!other.path("id").asText().equals(fromNode)) {
                    continue;
                }
                DerivedClaim feeder = templateClaim(other, catalog);
                if (feeder != null && feeder.delegated() && feeder.entityId().equals(entityId)) {
                    return true;
                }
            }
        }
        return false;
    }
}
