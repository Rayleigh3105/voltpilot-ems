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

    @Test
    void defaultRoleMapping() {
        assertThat(TopologyDeriver.defaultRole("storage", "pv_power_kw")).isEqualTo("pv");
        assertThat(TopologyDeriver.defaultRole("producer", "pv_power_kw")).isEqualTo("pv");
        assertThat(TopologyDeriver.defaultRole("storage", "battery_power_kw")).isEqualTo("storage");
        assertThat(TopologyDeriver.defaultRole("storage", "soc_pct")).isEqualTo("storage");
        assertThat(TopologyDeriver.defaultRole("storage", "power_kw")).isEqualTo("storage");
        assertThat(TopologyDeriver.defaultRole("producer", "power_kw")).isEqualTo("pv");
        assertThat(TopologyDeriver.defaultRole("consumer", "power_kw")).isEqualTo("consumer");
        assertThat(TopologyDeriver.defaultRole("meter", "power_kw")).isEqualTo("grid");
        assertThat(TopologyDeriver.defaultRole("measure-only", "power_kw")).isEqualTo("grid");
        assertThat(TopologyDeriver.defaultRole("consumer", "energy_kwh")).isEmpty();
        assertThat(TopologyDeriver.defaultRole("meter", "frequency_hz")).isEmpty();
    }
}
