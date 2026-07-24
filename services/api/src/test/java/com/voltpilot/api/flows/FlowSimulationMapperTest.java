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
        assertThat(mapping.yearSimulation()).isTrue();
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
    void deviceAutomationDryRunsScopedWithoutAYearSimulation() {
        // E-8: a Wenn/Dann rule controlling a consumer (no battery strategy)
        // cannot change the dispatch economics, so its dry-run is SCOPED to the
        // flow: supported (it reaches 'simuliert' and activates) but with NO
        // scenario and NO year simulation - no year of prices, no weather call.
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        FlowGraphValidatorTest.addNode(doc, "t1", "vp.logic.threshold", "1.1.0",
                Map.of("threshold", -2.0, "direction", "below"));
        FlowGraphValidatorTest.addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "wallbox-1", "command", "on_off", "ttl_s", 300));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.yearSimulation()).isFalse();
        assertThat(mapping.scenario()).isNull();
        assertThat(mapping.strategyNodeId()).isNull();
    }

    @Test
    void pureTimeWindowRuleNeedsNoYearSimulationEither() {
        // The audit's exact case: "schick mir mittags eine Nachricht" ran a
        // 365-day battery MILP (~2,5 min, a year of prices + a live weather
        // archive call). A schedule-driven rule touches no battery at all.
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "z1", "vp.schedule.window", "1.0.0",
                Map.of("from", "11:00", "to", "15:00", "days", "alle"));
        FlowGraphValidatorTest.addNode(doc, "c1", "vp.entity.control", "1.0.0",
                Map.of("entity_id", "wallbox-1", "command", "on_off", "ttl_s", 300));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.yearSimulation()).isFalse();
    }

    @Test
    void batteryStrategiesStillNeedTheYearSimulation() {
        // The scoping must not weaken the strategy path: those DO change the
        // dispatch economics, so their dry-run stays the full-year run.
        ObjectNode market = FlowGraphValidatorTest.pilotFlow("batt-main");
        assertThat(FlowSimulationMapper.map(market).yearSimulation()).isTrue();

        ObjectNode self = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(self, "s1", "vp.strategy.selfconsumption", "1.0.0",
                Map.of("entity_id", "batt-main"));
        FlowGraphValidatorTest.setClaims(self, "s1", "batt-main", List.of("setpoint_kw"), true);
        assertThat(FlowSimulationMapper.map(self).yearSimulation()).isTrue();
    }

    @Test
    void notificationAutomationDryRunsScopedToo() {
        // The notification stays SIMULIERBAR (existing flows keep working) but
        // is likewise scoped - it is diagnostic-only in the UI since N-1.
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "r1", "vp.entity.read", "1.0.0",
                Map.of("entity_id", "grid-meter-1", "channel", "power_kw"));
        FlowGraphValidatorTest.addNode(doc, "g1", "vp.logic.gate", "1.0.0", Map.of());
        FlowGraphValidatorTest.addNode(doc, "n1", "vp.notify.push", "1.0.0",
                Map.of("message", "Hohe Einspeisung."));
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(doc);
        assertThat(mapping.supported()).isTrue();
        assertThat(mapping.yearSimulation()).isFalse();
    }

    @Test
    void mappedModbusReadCountsAsAutomationUnmappedBareReadStaysRefused() {
        // MB-M1: a record-only flow (a mapped Modbus read with no control/
        // notify sink) RECORDS - that is its action, so it dry-runs as the
        // flow-scoped dry-run (E-8) and can activate.
        ObjectNode doc = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(doc, "mb1", "vp.modbus.read", "1.0.0",
                Map.of("host", "192.168.40.17", "address", 100,
                        "entity_id", "modbus-meter-1", "channel", "leistung_kw"));
        FlowSimulationMapper.Mapping mapped = FlowSimulationMapper.map(doc);
        assertThat(mapped.supported()).isTrue();
        assertThat(mapped.yearSimulation()).isFalse();

        // An UNMAPPED bare read has no sink at all - honestly refused.
        ObjectNode bare = FlowGraphValidatorTest.flowShell();
        FlowGraphValidatorTest.addNode(bare, "mb1", "vp.modbus.read", "1.0.0",
                Map.of("host", "192.168.40.17", "address", 100));
        FlowSimulationMapper.Mapping refused = FlowSimulationMapper.map(bare);
        assertThat(refused.supported()).isFalse();
        assertThat(refused.reason()).contains("simulierbaren Strategie-Baustein");
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
