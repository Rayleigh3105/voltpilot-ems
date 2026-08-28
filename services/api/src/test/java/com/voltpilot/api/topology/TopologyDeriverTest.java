package com.voltpilot.api.topology;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The Java twin's contract: {@link TopologyDeriver#derive} matches the committed
 * expected topology for every case in the ONE shared vector file
 * (docs/contracts/v2/topology-vectors.json), the same file the Go twin
 * (edge-app/core/internal/topology/topology_test.go) and the TS twin
 * (frontend/portal/src/topology.test.ts) run - so all three produce the same
 * node set. Pure; always runs (no Docker).
 */
class TopologyDeriverTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Working dir is services/api; the repo root is two levels up.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "topology-vectors.json");

    @TestFactory
    List<DynamicTest> deriveMatchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("cases")) {
            String name = c.path("name").asText();
            TopologyDeriver.Input input =
                    MAPPER.treeToValue(c.path("input"), TopologyDeriver.Input.class);
            TopologyDeriver.Topology expected =
                    MAPPER.treeToValue(c.path("expected"), TopologyDeriver.Topology.class);
            tests.add(DynamicTest.dynamicTest(name,
                    () -> assertThat(TopologyDeriver.derive(input)).isEqualTo(expected)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * The MAPPING itself, pinned across the three twins. The derive cases cannot
     * cover it - they carry roles that are ALREADY resolved - and it is exactly
     * where the copies drift: a charge point is category "consumer", so only
     * the TYPE keeps it out of the house node (Cockpit Phase 1 / C2).
     */
    @TestFactory
    List<DynamicTest> defaultRoleMatchesSharedVectors() throws Exception {
        JsonNode root = MAPPER.readTree(Files.readString(VECTORS));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : root.path("default_role_cases")) {
            String name = c.path("name").asText();
            String type = c.path("type").asText("");
            String category = c.path("category").asText("");
            String channel = c.path("channel").asText("");
            String connection = c.path("connection").asText("");
            String expected = c.path("expected").asText("");
            tests.add(DynamicTest.dynamicTest(name, () -> assertThat(
                    TopologyDeriver.defaultRole(type, category, channel, connection))
                            .isEqualTo(expected)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * The charging roles sit at the END of the canonical order, so every case
     * authored before them emits exactly the nodes it always did.
     */
    @Test
    void chargingRolesAreAppendedSoOlderVectorsStayByteIdentical() {
        // Deliberately shuffled input: the output follows the canonical order.
        TopologyDeriver.Input in = new TopologyDeriver.Input(List.of(
                entity("C", "charging-own"), entity("G", "grid"), entity("W", "charging"),
                entity("H", "consumer"), entity("S", "storage"), entity("P", "pv")));
        assertThat(TopologyDeriver.derive(in).nodes().stream().map(TopologyDeriver.FlowNode::role))
                .containsExactly("pv", "storage", "consumer", "grid", "charging", "charging-own");
    }

    /** Laden IS consumption: both charging roles flow OUT of the hub. */
    @Test
    void bothChargingRolesFlowOutOfTheHub() {
        TopologyDeriver.Input in = new TopologyDeriver.Input(
                List.of(entity("W", "charging"), entity("C", "charging-own")));
        assertThat(TopologyDeriver.derive(in).nodes())
                .allMatch(n -> "out".equals(n.direction()) && n.flowActive());
    }

    private static TopologyDeriver.EntityInput entity(String id, String role) {
        return new TopologyDeriver.EntityInput(id, id, id, "consumer", "ok",
                List.of(new TopologyDeriver.CapabilityInput("power_kw", role, true, 1.0)));
    }
}
