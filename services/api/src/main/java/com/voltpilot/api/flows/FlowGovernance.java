package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Pure AE7 node-governance rules (spec adaptive-ems-ui-v1-spec.md §3, contract
 * docs/contracts/v2/usage-profile.md): a flow may carry GATED strategy nodes in
 * a draft, but stays inactive until a Portal-Admin enables that node type for
 * the site. This helper answers "which gated node types / node ids in this flow
 * are not yet enabled for the site" - the rule the activation gate + the editor
 * consult. It never touches the DB; the caller supplies the enabled set.
 */
public final class FlowGovernance {

    private FlowGovernance() {}

    /** The gated node TYPES used in the document (deduplicated, catalog-driven). */
    public static Set<String> gatedNodeTypes(JsonNode doc, FlowCatalog catalog) {
        List<String> types = new ArrayList<>();
        for (JsonNode node : doc.path("nodes")) {
            String type = node.path("type").asText();
            if (catalog.isGated(type) && !types.contains(type)) {
                types.add(type);
            }
        }
        return Set.copyOf(types);
    }

    /**
     * The gated node types in the document that are NOT in {@code enabled} - a
     * non-empty result means the flow may not be activated yet. {@code enabled}
     * is the per-site enablement set (see {@code flow_gated_node_enablement}).
     */
    public static List<String> notEnabledNodeTypes(JsonNode doc, FlowCatalog catalog,
            Set<String> enabled) {
        Set<String> enabledSet = enabled == null ? Set.of() : enabled;
        List<String> missing = new ArrayList<>();
        for (String type : gatedNodeTypes(doc, catalog)) {
            if (!enabledSet.contains(type)) {
                missing.add(type);
            }
        }
        missing.sort(String::compareTo);
        return missing;
    }
}
