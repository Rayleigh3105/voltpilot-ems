package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The compiler-module boundary (E2's deliverable, contract
 * docs/contracts/v2/flow-artifact.md): turns a validated flow-graph document
 * into ONE flow-artifact manifest+bundle JSON ($defs/artifact) - deterministic
 * tab/node ids per (flow_id, flow_version), content_hash = sha256 over the RFC
 * 8785 canonical bundle, version gates, required_entities.
 *
 * <p>NO implementation ships with E3a: the parallel E2 epic owns the
 * flow-graph→Node-RED compiler. {@link FlowActivationService} consumes this
 * seam via ObjectProvider - absent bean = activation answers honestly
 * "Compiler folgt" and publishes nothing. Tests exercise the activation +
 * deployment-set publisher against a hand-built artifact fixture from
 * docs/contracts/v2/examples/.
 */
public interface FlowCompiler {

    /** Compile one flow document into its flow-artifact JSON ($defs/artifact). */
    JsonNode compile(JsonNode flowDocument);
}
