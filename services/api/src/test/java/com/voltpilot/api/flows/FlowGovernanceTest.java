package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * AE7 node governance (pure): the catalog's gated classification and the
 * gated-not-enabled rule the activation gate + editor consult. Always runs.
 */
class FlowGovernanceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final FlowCatalog CATALOG = new FlowCatalog(MAPPER);

    @Test
    void catalogClassifiesStrategyNodes() {
        assertThat(CATALOG.isGated("vp.strategy.market")).isTrue();
        assertThat(CATALOG.isGated("vp.strategy.peakshaving")).isTrue();
        assertThat(CATALOG.isGated("vp.strategy.atypical-grid")).isTrue();
        assertThat(CATALOG.isGated("vp.entity.control")).isFalse();
        assertThat(CATALOG.isGated("vp.price.dayahead")).isFalse();
        // Gating is NOT a strategy-only concept: vp.price.current is a DATA node
        // gated because the price down-channel to the device (E4) does not exist
        // yet - a price automation would otherwise deploy and do nothing (#519,
        // audit H3-c). It is unlocked per site once VoltPilot sets it up.
        assertThat(CATALOG.isGated("vp.price.current")).isTrue();
        assertThat(CATALOG.gatedTypes()).containsExactlyInAnyOrder("vp.strategy.market",
                "vp.strategy.peakshaving", "vp.strategy.atypical-grid", "vp.price.current");
    }

    @Test
    void gatedNodeTypesAndNotEnabled() {
        ObjectNode doc = MAPPER.createObjectNode();
        ArrayNode nodes = doc.putArray("nodes");
        nodes.addObject().put("id", "s1").put("type", "vp.strategy.market");
        nodes.addObject().put("id", "e1").put("type", "vp.entity.read");
        nodes.addObject().put("id", "c1").put("type", "vp.entity.control");

        assertThat(FlowGovernance.gatedNodeTypes(doc, CATALOG))
                .containsExactly("vp.strategy.market");
        // No enablement -> the market node is not enabled.
        assertThat(FlowGovernance.notEnabledNodeTypes(doc, CATALOG, Set.of()))
                .containsExactly("vp.strategy.market");
        // Enabled -> nothing blocks.
        assertThat(FlowGovernance.notEnabledNodeTypes(doc, CATALOG, Set.of("vp.strategy.market")))
                .isEmpty();
    }

    @Test
    void freeOnlyFlowIsNeverGated() {
        ObjectNode doc = MAPPER.createObjectNode();
        ArrayNode nodes = doc.putArray("nodes");
        nodes.addObject().put("id", "e1").put("type", "vp.entity.read");
        nodes.addObject().put("id", "c1").put("type", "vp.entity.control");
        assertThat(FlowGovernance.gatedNodeTypes(doc, CATALOG)).isEmpty();
        assertThat(FlowGovernance.notEnabledNodeTypes(doc, CATALOG, Set.of())).isEmpty();
    }
}
