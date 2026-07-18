package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;

/**
 * Compiles a flow graph to its DETERMINISTIC simulation input mapping (E3a
 * scope): which Ersparnis-Simulation scenario represents this flow's battery
 * strategy, plus the strategy parameters that feed the job payload. The
 * dry-run itself runs on the existing simulate-serve infrastructure (real
 * historical prices + weather of the reference year) - this mapper only
 * decides HOW a flow maps onto it, and refuses honestly when it cannot:
 * a flow without a battery strategy has no economic dry-run in the MVP.
 *
 * <p>Mapping: {@code vp.strategy.market} → the "voltpilot" scenario (the
 * co-optimized dispatch), {@code vp.strategy.selfconsumption} → the
 * "standardSpeicher" scenario (greedy self-consumption). Exactly ONE battery
 * strategy is simulierbar; several conflict under V-5 anyway.
 */
public final class FlowSimulationMapper {

    /** The mapping outcome: supported + scenario key, or a German refusal. */
    public record Mapping(boolean supported, String reason, String scenario,
            String speicherschonung, String strategyNodeId) {

        static Mapping unsupported(String reason) {
            return new Mapping(false, reason, null, null, null);
        }
    }

    private FlowSimulationMapper() {
    }

    public static Mapping map(JsonNode doc) {
        List<JsonNode> strategies = new ArrayList<>();
        for (JsonNode node : doc.path("nodes")) {
            String type = node.path("type").asText();
            if ("vp.strategy.market".equals(type) || "vp.strategy.selfconsumption".equals(type)) {
                strategies.add(node);
            }
        }
        if (strategies.isEmpty()) {
            return Mapping.unsupported(
                    "Dieser Flow enthält keinen simulierbaren Strategie-Baustein. Für den "
                            + "Dry-Run braucht es eine Marktoptimierung oder einen "
                            + "Eigenverbrauchs-Baustein mit Speicher.");
        }
        if (strategies.size() > 1) {
            return Mapping.unsupported(
                    "Dieser Flow enthält mehrere Strategie-Bausteine - bitte zuerst auf einen "
                            + "reduzieren (pro Speicher darf nur eine Strategie steuern).");
        }
        JsonNode strategy = strategies.get(0);
        boolean market = "vp.strategy.market".equals(strategy.path("type").asText());
        String schonung = strategy.path("parameters").path("speicherschonung").asText(null);
        return new Mapping(true, null, market ? "voltpilot" : "standardSpeicher",
                schonung, strategy.path("id").asText());
    }
}
