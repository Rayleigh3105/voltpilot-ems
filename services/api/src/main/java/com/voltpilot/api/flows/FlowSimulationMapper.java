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
 *
 * <p>An AUTOMATION (U3) - no battery strategy, but an action driven by Wenn/Dann
 * conditions: a device control ({@code vp.entity.control}: a Wallbox/Heizstab
 * rule, a price rule, a compound AND rule), a notification ({@code
 * vp.notify.push}), or a MAPPED Modbus read ({@code vp.modbus.read} with an
 * entity/channel mapping - recording IS its action, MB-M1) - does not change
 * the battery dispatch economics in the MVP simulation model. Its dry-run is
 * therefore SCOPED to what the flow actually touches: {@code yearSimulation()}
 * is false and NO simulation job runs at all (audit E-8). Until this fix every
 * such flow - including a pure time-window rule - ran a 365-day battery-dispatch
 * MILP taking ~2,5 minutes and requiring a full previous calendar year of
 * day-ahead prices plus a live weather-archive call: two external dependencies
 * and a two-minute wait for "schalte mittags die Wallbox ein", and the ONE
 * reason a rollout failed outright on a plant whose price history was not
 * backfilled. A flow with neither a strategy nor an action (e.g. a bare read +
 * threshold with no sink) has no dry-run at all and is refused.
 */
public final class FlowSimulationMapper {

    /**
     * The mapping outcome: supported + scenario key, or a German refusal.
     *
     * @param yearSimulation whether this flow's dry-run needs the full-year
     *     Ersparnis-Simulation (a battery strategy changes the dispatch
     *     economics) or is SCOPED to the flow itself (an automation does not) -
     *     see the class doc, audit E-8. Always false when {@code supported} is
     *     false. When false, {@code scenario} is null: no scenario runs.
     */
    public record Mapping(boolean supported, String reason, String scenario,
            String speicherschonung, String strategyNodeId, boolean yearSimulation) {

        static Mapping unsupported(String reason) {
            return new Mapping(false, reason, null, null, null, false);
        }

        /** A dry-run scoped to the flow itself - no year simulation is run. */
        static Mapping scoped() {
            return new Mapping(true, null, null, null, null, false);
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
            // A Wenn/Dann automation (controlling a consumer, recording a
            // measurement, notifying) has no battery strategy; it does not change
            // the dispatch economics, so there is nothing a year-long battery
            // simulation could tell anyone about it. Its dry-run is SCOPED to the
            // flow (validation + the plant model), runs instantly and needs
            // neither a year of prices nor the weather archive (E-8).
            if (hasAutomationAction(doc)) {
                return Mapping.scoped();
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
                schonung, strategy.path("id").asText(), true);
    }

    private static boolean hasAutomationAction(JsonNode doc) {
        for (JsonNode node : doc.path("nodes")) {
            String type = node.path("type").asText();
            if ("vp.entity.control".equals(type) || "vp.notify.push".equals(type)) {
                return true;
            }
            // MB-M1: a MAPPED Modbus read RECORDS a value into an entity
            // channel - that recording IS its action, so a record-only flow
            // (no control/notify sink) still reaches 'simuliert' and can
            // activate. An unmapped bare read stays refused (no sink at all).
            if ("vp.modbus.read".equals(type)
                    && !node.path("parameters").path("entity_id").asText("").isEmpty()
                    && !node.path("parameters").path("channel").asText("").isEmpty()) {
                return true;
            }
        }
        return false;
    }
}
