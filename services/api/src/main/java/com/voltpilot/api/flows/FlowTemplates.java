package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.profile.UsageProfileDeriver;

/**
 * AE7 auto-start-flow templates (spec §3, contract usage-profile.md): the
 * profile → starter-flow mapping. A new/converted site gets a starter DRAFT
 * matching its derived profile ("kein leerer Start"), refinable in the editor -
 * reusing the E3a flow-graph shape, not a new engine.
 *
 * <p>Each starter is the pilot chain (price/PV/SoC read → strategy → battery
 * control) with the inputs the chosen strategy declares. Claims + identity are
 * stamped by {@code FlowTemplateService} (it derives claims against the catalog,
 * like the editor). The strategy node type per profile:
 * arbitrage → {@code vp.strategy.market}, peak → {@code vp.strategy.peakshaving}.
 * The {@code private} household profile (and any unknown profile) has NO starter
 * flow: self-consumption is the platform's BASE behaviour, not a strategy node -
 * so {@code strategyNodeType} returns {@code null} and the service skips seeding
 * with {@code no_template}.
 */
public final class FlowTemplates {

    private FlowTemplates() {}

    /**
     * The strategy node type a profile's starter flow places on the battery, or
     * {@code null} when the profile has no starter (the {@code private}
     * household default + any unknown profile).
     */
    public static String strategyNodeType(String profile) {
        switch (profile == null ? "" : profile) {
            case UsageProfileDeriver.ARBITRAGE:
                return UsageProfileDeriver.NODE_MARKET;
            case UsageProfileDeriver.PEAK:
                return UsageProfileDeriver.NODE_PEAKSHAVING;
            default:
                return null;
        }
    }

    /** The customer-facing name of a profile's starter flow, or {@code null}. */
    public static String templateName(String profile) {
        switch (profile == null ? "" : profile) {
            case UsageProfileDeriver.ARBITRAGE:
                return "Marktoptimierung";
            case UsageProfileDeriver.PEAK:
                return "Lastspitzenkappung";
            default:
                return null;
        }
    }

    /**
     * Build the starter flow document for a profile (nodes/edges/trigger, no
     * claims/identity yet). {@code batteryEntityId} is the target
     * battery-hybrid entity id.
     */
    public static ObjectNode starterFlow(ObjectMapper mapper, String profile,
            String batteryEntityId) {
        String strategyType = strategyNodeType(profile);
        boolean needsPrice = UsageProfileDeriver.NODE_MARKET.equals(strategyType);
        boolean usesPv = needsPrice;

        ObjectNode doc = mapper.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("name", templateName(profile));
        doc.put("runtime", "edge");
        ArrayNode nodes = doc.putArray("nodes");
        ArrayNode edges = doc.putArray("edges");

        // SoC read (always) + optional price/PV feeds.
        nodes.add(node(mapper, "soc1", "vp.entity.read",
                param(mapper, "entity_id", batteryEntityId, "channel", "soc_pct")));
        if (needsPrice) {
            nodes.add(node(mapper, "price1", "vp.price.dayahead", mapper.createObjectNode()));
        }
        if (usesPv) {
            nodes.add(node(mapper, "pv1", "vp.forecast.pv", mapper.createObjectNode()));
        }

        ObjectNode strategyParams = mapper.createObjectNode();
        strategyParams.put("entity_id", batteryEntityId);
        if (UsageProfileDeriver.NODE_MARKET.equals(strategyType)) {
            strategyParams.put("speicherschonung", "ausgewogen");
        }
        nodes.add(node(mapper, "strat1", strategyType, strategyParams));

        ObjectNode controlParams = param(mapper, "entity_id", batteryEntityId, "command",
                "setpoint_kw");
        controlParams.put("ttl_s", 180);
        nodes.add(node(mapper, "ctl1", "vp.entity.control", controlParams));

        edges.add(edge(mapper, "e_soc", "soc1", "value", "strat1", "soc"));
        if (needsPrice) {
            edges.add(edge(mapper, "e_price", "price1", "prices", "strat1", "price_in"));
        }
        if (usesPv) {
            edges.add(edge(mapper, "e_pv", "pv1", "forecast", "strat1", "pv_forecast"));
        }
        edges.add(edge(mapper, "e_plan", "strat1", "wunsch", "ctl1", "plan"));

        ObjectNode trigger = doc.putArray("triggers").addObject();
        trigger.put("id", "t1");
        trigger.put("kind", "slot-boundary");
        return doc;
    }

    /**
     * Stamp the editor-derived claims onto the document's nodes (the V-5 stored
     * claims the validator re-derives). Clears any existing {@code claims} first,
     * so it is idempotent.
     */
    public static void applyDerivedClaims(ObjectNode doc, FlowCatalog catalog) {
        for (com.fasterxml.jackson.databind.JsonNode node : doc.path("nodes")) {
            if (node instanceof ObjectNode obj) {
                obj.remove("claims");
            }
        }
        for (FlowClaims.DerivedClaim claim : FlowClaims.derive(doc, catalog)) {
            for (com.fasterxml.jackson.databind.JsonNode node : doc.path("nodes")) {
                if (!(node instanceof ObjectNode obj)
                        || !obj.path("id").asText().equals(claim.nodeId())) {
                    continue;
                }
                ArrayNode claims = obj.withArray("claims");
                ObjectNode c = claims.addObject();
                c.put("entity_id", claim.entityId());
                ArrayNode commands = c.putArray("commands");
                claim.commands().forEach(commands::add);
                c.put("delegated", claim.delegated());
            }
        }
    }

    private static ObjectNode node(ObjectMapper mapper, String id, String type,
            ObjectNode parameters) {
        ObjectNode node = mapper.createObjectNode();
        node.put("id", id);
        node.put("type", type);
        node.put("type_version", "vp.logic.threshold".equals(type) ? "1.1.0" : "1.0.0");
        node.set("parameters", parameters);
        return node;
    }

    private static ObjectNode param(ObjectMapper mapper, String k1, String v1, String k2,
            String v2) {
        ObjectNode p = mapper.createObjectNode();
        p.put(k1, v1);
        p.put(k2, v2);
        return p;
    }

    private static ObjectNode edge(ObjectMapper mapper, String id, String fromNode, String fromPort,
            String toNode, String toPort) {
        ObjectNode edge = mapper.createObjectNode();
        edge.put("id", id);
        ObjectNode from = edge.putObject("from");
        from.put("node", fromNode);
        from.put("port", fromPort);
        ObjectNode to = edge.putObject("to");
        to.put("node", toNode);
        to.put("port", toPort);
        return edge;
    }
}
