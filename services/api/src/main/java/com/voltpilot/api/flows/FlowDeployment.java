package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Builds the RETAINED deployment-set payload (flow-artifact contract §3,
 * decision D-11): the COMPLETE desired state of active flow artifacts for one
 * device, published on {@code ems/{t}/{s}/{d}/v2/flows}. Never a diff - an
 * empty artifact list clears every artifact tab on the edge. Pure and
 * unit-tested against the contract example fixtures.
 */
public final class FlowDeployment {

    /** Schema x-limits: one artifact <= 256 KiB, one deployment <= 512 KiB. */
    static final int ARTIFACT_LIMIT_BYTES = 262144;
    static final int DEPLOYMENT_LIMIT_BYTES = 524288;

    private FlowDeployment() {
    }

    /** The deployment JSON ($defs/deployment). Throws on a busted size budget. */
    public static ObjectNode deploymentSet(ObjectMapper mapper, UUID tenantId, UUID siteId,
            UUID deviceId, Instant deployedAt, List<JsonNode> artifacts) {
        ObjectNode deployment = mapper.createObjectNode();
        deployment.put("schema_version", "1.0");
        deployment.put("kind", "deployment");
        deployment.put("tenant_id", tenantId.toString());
        deployment.put("site_id", siteId.toString());
        deployment.put("device_id", deviceId.toString());
        deployment.put("deployed_at", deployedAt.toString());
        ArrayNode array = deployment.putArray("artifacts");
        for (JsonNode artifact : artifacts) {
            requireArtifactShape(artifact);
            if (serializedSize(artifact) > ARTIFACT_LIMIT_BYTES) {
                throw new IllegalArgumentException(
                        "Das kompilierte Flow-Artefakt überschreitet das Größenbudget von 256 KiB.");
            }
            array.add(artifact);
        }
        if (serializedSize(deployment) > DEPLOYMENT_LIMIT_BYTES) {
            throw new IllegalArgumentException(
                    "Der Flow-Rollout überschreitet das Größenbudget von 512 KiB je Gerät.");
        }
        return deployment;
    }

    /**
     * Structural manifest check (schema $defs/artifact required fields) - the
     * compiler is E2's, but nothing malformed may reach the retained topic.
     */
    public static void requireArtifactShape(JsonNode artifact) {
        String[] required = {"schema_version", "kind", "artifact_id", "flow_id", "flow_version",
                "runtime", "content_hash", "compiled_at", "compiler_version",
                "min_palette_version", "min_core_version", "required_entities", "bundle"};
        for (String field : required) {
            if (artifact == null || !artifact.has(field)) {
                throw new IllegalArgumentException(
                        "Flow-Artefakt unvollständig: Feld \"" + field + "\" fehlt.");
            }
        }
        if (!"artifact".equals(artifact.path("kind").asText())) {
            throw new IllegalArgumentException("Flow-Artefakt: kind muss \"artifact\" sein.");
        }
        if (!artifact.path("content_hash").asText().matches("^sha256:[0-9a-f]{64}$")) {
            throw new IllegalArgumentException("Flow-Artefakt: content_hash ist kein sha256.");
        }
        JsonNode bundle = artifact.path("bundle");
        if (!"nodered-tabs".equals(bundle.path("format").asText())
                || !bundle.path("tab_ids").isArray() || bundle.path("tab_ids").isEmpty()
                || !bundle.path("nodered_flows").isArray()
                || bundle.path("nodered_flows").isEmpty()) {
            throw new IllegalArgumentException("Flow-Artefakt: bundle ist unvollständig.");
        }
    }

    private static int serializedSize(JsonNode node) {
        return node.toString().getBytes(StandardCharsets.UTF_8).length;
    }
}
