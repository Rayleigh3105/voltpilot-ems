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
    void peakShavingMapsToVoltpilotScenario() {
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "s1", "vp.strategy.peakshaving", "1.0.0",
                Map.of("entity_id", "batt-main"));
        FlowGraphValidatorTest.setClaims(doc, "s1", "batt-main", List.of("setpoint_kw"), true);
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.scenario()).isEqualTo("voltpilot");
        assertThat(mapping.strategyNodeId()).isEqualTo("s1");
    }

    @Test
    void atypicalGridIsNotSimulableSinceItsEconomicsAreNotBuilt() {
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "s1", "vp.strategy.atypical-grid", "1.0.0",
                Map.of("entity_id", "batt-main"));
        FlowGraphValidatorTest.setClaims(doc, "s1", "batt-main", List.of("setpoint_kw"), true);
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isFalse();
        assertThat(mapping.reason()).contains("atypische Netznutzung").contains("Vorbereitung");
    }

    @Test
    void flowWithoutStrategyOrControlIsRefusedInGerman() {
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isFalse();
        assertThat(mapping.reason()).contains("keinen simulierbaren Strategie-Baustein");
    }

    @Test
    void deviceAutomationMapsToStandardSpeicherBaseline() {
        // A Wenn/Dann rule controlling a consumer (no battery strategy) is
        // simulierbar as the site's standard-battery baseline (U3), so it can
        // reach 'simuliert' and activate.
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        FlowGraphValidatorTest.addNode(doc, "t1", "vp.logic.threshold", "1.1.0",
                Map.of("threshold", -2.0, "direction", "below"));
        FlowGraphValidatorTest.addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "wallbox-1", "command", "on_off", "ttl_s", 300));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.scenario()).isEqualTo("standardSpeicher");
        assertThat(mapping.strategyNodeId()).isNull();
    }

    @Test
    void notificationAutomationMapsToStandardSpeicherBaseline() {
        // A notification automation (no control, no strategy) is simulierbar as
        // the baseline too, so the guided builder's Benachrichtigung action is
        // not a dead-end (U3).
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        FlowGraphValidatorTest.addNode(doc, "g1", "vp.logic.gate", "1.0.0", Map.of());
        FlowGraphValidatorTest.addNode(doc, "n1", "vp.notify.push", "1.0.0",
                Map.of("message", "Hohe Einspeisung."));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.scenario()).isEqualTo("standardSpeicher");
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
