package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The deterministic flow → Ersparnis-Simulation mapping: market strategy →
 * the "voltpilot" scenario (with its Speicherschonung), selfconsumption →
 * "standardSpeicher", anything else → an honest German refusal.
 */
class FlowSimulationMapperTest {

    @Test
    void marketStrategyMapsToVoltpilotScenarioWithSpeicherschonung() {
        ObjectNode doc = FlowGraphValidatorTest.pilotFlow("batt-main");
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.scenario()).isEqualTo("voltpilot");
        assertThat(mapping.speicherschonung()).isEqualTo("ausgewogen");
        assertThat(mapping.strategyNodeId()).isEqualTo("strat1");
    }

    @Test
    void selfconsumptionMapsToStandardSpeicher() {
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "s1", "vp.strategy.selfconsumption", "1.0.0",
                Map.of("entity_id", "batt-main"));
        FlowGraphValidatorTest.setClaims(doc, "s1", "batt-main", List.of("setpoint_kw"), true);
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.scenario()).isEqualTo("standardSpeicher");
        assertThat(mapping.speicherschonung()).isNull();
    }

    @Test
    void flowWithoutStrategyIsRefusedInGerman() {
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isFalse();
        assertThat(mapping.reason()).contains("keinen simulierbaren Strategie-Baustein");
    }

    @Test
    void severalStrategiesAreRefused() {
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "s1", "vp.strategy.market", "1.0.0",
                Map.of("entity_id", "batt-main"));
        FlowGraphValidatorTest.addNode(doc, "s2", "vp.strategy.selfconsumption", "1.0.0",
                Map.of("entity_id", "batt-main"));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isFalse();
        assertThat(mapping.reason()).contains("mehrere Strategie-Bausteine");
    }
}
