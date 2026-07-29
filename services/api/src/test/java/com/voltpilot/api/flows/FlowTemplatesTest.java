package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.flows.FlowGraphValidator.EntityCapabilities;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * AE7 auto-start templates: the profile → strategy-node mapping and that each
 * profile's starter flow is a VALID flow-graph document (against the real
 * catalog + validator) once claims are stamped. Pure; always runs (no Docker).
 */
class FlowTemplatesTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final FlowCatalog CATALOG = new FlowCatalog(MAPPER);
    private static final FlowGraphValidator VALIDATOR = new FlowGraphValidator(CATALOG);
    private static final String BATTERY = "11111111-1111-1111-1111-111111111111";

    @Test
    void strategyNodeTypePerProfile() {
        assertThat(FlowTemplates.strategyNodeType("arbitrage")).isEqualTo("vp.strategy.market");
        assertThat(FlowTemplates.strategyNodeType("peak")).isEqualTo("vp.strategy.peakshaving");
        // The private household default (and any unknown profile) has NO starter -
        // self-consumption is base behaviour (report vp-nacht-bezug-e7 §3.3).
        assertThat(FlowTemplates.strategyNodeType("private")).isNull();
        assertThat(FlowTemplates.strategyNodeType("grey")).isNull();
    }

    @Test
    void arbitraryStarterCarriesTheMarketNodeAndPriceFeed() {
        ObjectNode doc = FlowTemplates.starterFlow(MAPPER, "arbitrage", BATTERY);
        assertThat(nodeTypes(doc)).contains("vp.strategy.market", "vp.price.dayahead",
                "vp.forecast.pv", "vp.entity.read", "vp.entity.control");
    }

    @Test
    void peakStarterCarriesThePeakNode() {
        ObjectNode doc = FlowTemplates.starterFlow(MAPPER, "peak", BATTERY);
        assertThat(nodeTypes(doc)).contains("vp.strategy.peakshaving")
                .doesNotContain("vp.price.dayahead");
    }

    @Test
    void everyStartingProfileValidatesAfterClaimStamping() {
        // A battery-hybrid entity measures soc_pct and actuates setpoint_kw.
        Map<String, EntityCapabilities> view = Map.of(BATTERY,
                new EntityCapabilities(Set.of("soc_pct", "battery_power_kw", "pv_power_kw"),
                        Set.of("setpoint_kw")));
        // Only arbitrage + peak have a starter; private has none (no_template).
        for (String profile : List.of("arbitrage", "peak")) {
            ObjectNode doc = FlowTemplates.starterFlow(MAPPER, profile, BATTERY);
            doc.put("site_id", "22222222-2222-2222-2222-222222222222");
            FlowTemplates.applyDerivedClaims(doc, CATALOG);
            List<FlowValidationFinding> findings = VALIDATOR.validate(doc, view, List.of());
            assertThat(FlowGraphValidator.valid(findings))
                    .as(profile + " starter validates: " + findings).isTrue();
        }
    }

    /**
     * MEDIUM-5 (#519): the starter templates wire {@code strategy.wunsch ->
     * control.plan}, which flowc could not compile (no {@code plan} port, no
     * plan-fed claim suppression) - so an auto-started flow validated, simulated
     * and then died at activation with {@code compiler_rejected}. flowc now
     * pins the SAME shape as the committed contract fixture
     * {@code flow-graph.valid.market-starter.json}; this test keeps the template
     * and that fixture in lockstep, so a template change that flowc cannot
     * compile fails HERE instead of at a customer's activation.
     */
    @Test
    void marketStarterMatchesTheCompilerPinnedContractFixture() throws Exception {
        java.nio.file.Path fixture = java.nio.file.Path.of("..", "..", "docs", "contracts", "v2",
                "examples", "flow-graph.valid.market-starter.json");
        com.fasterxml.jackson.databind.JsonNode pinned =
                MAPPER.readTree(java.nio.file.Files.readString(fixture));

        ObjectNode doc = FlowTemplates.starterFlow(MAPPER, "arbitrage",
                pinned.path("nodes").get(0).path("parameters").path("entity_id").asText());
        FlowTemplates.applyDerivedClaims(doc, CATALOG);

        assertThat(shape(doc))
                .as("the AE7 starter must keep the shape flowc is pinned against")
                .isEqualTo(shape(pinned));
    }

    /** Node types + edge (from-port -> to-port) wiring, ids aside. */
    private static List<String> shape(com.fasterxml.jackson.databind.JsonNode doc) {
        java.util.List<String> out = new java.util.ArrayList<>();
        doc.path("nodes").forEach(n -> out.add("node " + n.path("type").asText()
                + " claims=" + n.path("claims")));
        java.util.Map<String, String> typeById = new java.util.HashMap<>();
        doc.path("nodes").forEach(n -> typeById.put(n.path("id").asText(), n.path("type").asText()));
        doc.path("edges").forEach(e -> out.add("edge "
                + typeById.get(e.path("from").path("node").asText()) + "."
                + e.path("from").path("port").asText() + " -> "
                + typeById.get(e.path("to").path("node").asText()) + "."
                + e.path("to").path("port").asText()));
        java.util.Collections.sort(out);
        return out;
    }

    private static Set<String> nodeTypes(ObjectNode doc) {
        java.util.LinkedHashSet<String> types = new java.util.LinkedHashSet<>();
        doc.path("nodes").forEach(n -> types.add(n.path("type").asText()));
        return types;
    }
}
