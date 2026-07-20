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
 * <p>Mapping: {@code vp.strategy.market} and {@code vp.strategy.peakshaving} →
 * the "voltpilot" scenario (the co-optimized dispatch, which folds in the
 * site's active modules incl. the PS-1 Leistungspreis epigraph),
 * {@code vp.strategy.selfconsumption} → the "standardSpeicher" scenario (greedy
 * self-consumption). Exactly ONE battery strategy is simulierbar; several
 * conflict under V-5 anyway. {@code vp.strategy.atypical-grid} is deliberately
 * NOT simulable - its economics (E5b) are not built, so a flow carrying it
 * cannot reach a dry-run (and thus never activates).
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
        boolean atypicalGrid = false;
        for (JsonNode node : doc.path("nodes")) {
            String type = node.path("type").asText();
            if ("vp.strategy.market".equals(type) || "vp.strategy.selfconsumption".equals(type)
                    || "vp.strategy.peakshaving".equals(type)) {
                strategies.add(node);
            } else if ("vp.strategy.atypical-grid".equals(type)) {
                atypicalGrid = true;
            }
        }
        if (strategies.isEmpty()) {
            // atypical-grid IS a strategy, but its economics (E5b) are not built,
            // so it is deliberately not simulable - an honest, specific refusal
            // (naming it) rather than the generic "no strategy" message. Since a
            // flow can never reach a dry-run, it also never activates.
            if (atypicalGrid) {
                return Mapping.unsupported(
                        "Die atypische Netznutzung (§ 19 StromNEV) ist noch in Vorbereitung und "
                                + "kann derzeit nicht simuliert oder aktiviert werden.");
            }
            return Mapping.unsupported(
                    "Dieser Flow enthält keinen simulierbaren Strategie-Baustein. Für den "
                            + "Dry-Run braucht es eine Marktoptimierung, eine Lastspitzenkappung "
                            + "oder einen Eigenverbrauchs-Baustein mit Speicher.");
        }
        if (strategies.size() > 1) {
            return Mapping.unsupported(
                    "Dieser Flow enthält mehrere Strategie-Bausteine - bitte zuerst auf einen "
                            + "reduzieren (pro Speicher darf nur eine Strategie steuern).");
        }
        JsonNode strategy = strategies.get(0);
        String type = strategy.path("type").asText();
        // Market AND peak-shaving dry-run as the co-optimized "voltpilot"
        // dispatch (the co-solver folds in the site's Leistungspreis epigraph);
        // self-consumption is the greedy "standardSpeicher".
        boolean coOptimized = "vp.strategy.market".equals(type)
                || "vp.strategy.peakshaving".equals(type);
        String schonung = strategy.path("parameters").path("speicherschonung").asText(null);
        return new Mapping(true, null, coOptimized ? "voltpilot" : "standardSpeicher",
                schonung, strategy.path("id").asText());
    }
}
