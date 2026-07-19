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
        assertThat(FlowTemplates.strategyNodeType("private"))
                .isEqualTo("vp.strategy.selfconsumption");
        assertThat(FlowTemplates.strategyNodeType("grey"))
                .isEqualTo("vp.strategy.selfconsumption");
    }

    @Test
    void arbitraryStarterCarriesTheMarketNodeAndPriceFeed() {
        ObjectNode doc = FlowTemplates.starterFlow(MAPPER, "arbitrage", BATTERY);
        assertThat(nodeTypes(doc)).contains("vp.strategy.market", "vp.price.dayahead",
                "vp.forecast.pv", "vp.entity.read", "vp.entity.control");
    }

    @Test
    void selfconsumptionStarterHasNoPriceFeed() {
        ObjectNode doc = FlowTemplates.starterFlow(MAPPER, "private", BATTERY);
        assertThat(nodeTypes(doc)).contains("vp.strategy.selfconsumption")
                .doesNotContain("vp.price.dayahead");
    }

    @Test
    void peakStarterCarriesThePeakNode() {
        ObjectNode doc = FlowTemplates.starterFlow(MAPPER, "peak", BATTERY);
        assertThat(nodeTypes(doc)).contains("vp.strategy.peakshaving")
                .doesNotContain("vp.price.dayahead");
    }

    @Test
    void everyProfileStarterValidatesAfterClaimStamping() {
        // A battery-hybrid entity measures soc_pct and actuates setpoint_kw.
        Map<String, EntityCapabilities> view = Map.of(BATTERY,
                new EntityCapabilities(Set.of("soc_pct", "battery_power_kw", "pv_power_kw"),
                        Set.of("setpoint_kw")));
        for (String profile : List.of("arbitrage", "peak", "private")) {
            ObjectNode doc = FlowTemplates.starterFlow(MAPPER, profile, BATTERY);
            doc.put("site_id", "22222222-2222-2222-2222-222222222222");
            FlowTemplates.applyDerivedClaims(doc, CATALOG);
            List<FlowValidationFinding> findings = VALIDATOR.validate(doc, view, List.of());
            assertThat(FlowGraphValidator.valid(findings))
                    .as(profile + " starter validates: " + findings).isTrue();
        }
    }

    private static Set<String> nodeTypes(ObjectNode doc) {
        java.util.LinkedHashSet<String> types = new java.util.LinkedHashSet<>();
        doc.path("nodes").forEach(n -> types.add(n.path("type").asText()));
        return types;
    }
}
