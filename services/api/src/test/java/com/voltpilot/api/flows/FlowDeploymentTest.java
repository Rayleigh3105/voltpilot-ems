package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The D-11 deployment-set builder against the HAND-BUILT contract fixtures
 * (docs/contracts/v2/examples/flow-artifact.valid.*.json) - the compiler is
 * E2's, but the retained payload we publish must be shape-perfect.
 */
class FlowDeploymentTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");

    private static JsonNode fixture(String name) throws IOException {
        return MAPPER.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "v2", "examples", name)));
    }

    @Test
    void buildsTheCompleteDesiredStateFromTheFixtureArtifact() throws IOException {
        JsonNode artifact = fixture("flow-artifact.valid.artifact.json");
        Instant at = Instant.parse("2026-07-18T12:00:00Z");
        ObjectNode deployment = FlowDeployment.deploymentSet(MAPPER, TENANT, SITE, DEVICE, at,
                List.of(artifact));
        assertThat(deployment.path("schema_version").asText()).isEqualTo("1.0");
        assertThat(deployment.path("kind").asText()).isEqualTo("deployment");
        assertThat(deployment.path("tenant_id").asText()).isEqualTo(TENANT.toString());
        assertThat(deployment.path("site_id").asText()).isEqualTo(SITE.toString());
        assertThat(deployment.path("device_id").asText()).isEqualTo(DEVICE.toString());
        assertThat(deployment.path("deployed_at").asText()).isEqualTo("2026-07-18T12:00:00Z");
        assertThat(deployment.path("artifacts").size()).isEqualTo(1);
        assertThat(deployment.path("artifacts").get(0)).isEqualTo(artifact);
    }

    @Test
    void emptyArtifactListIsALegalClearingDeployment() {
        ObjectNode deployment = FlowDeployment.deploymentSet(MAPPER, TENANT, SITE, DEVICE,
                Instant.parse("2026-07-18T12:00:00Z"), List.of());
        assertThat(deployment.path("artifacts").size()).isZero();
    }

    @Test
    void fixtureDeploymentMatchesTheBuilderShape() throws IOException {
        // The contract's own deployment fixture uses exactly the fields the
        // builder emits (nothing extra, nothing missing).
        JsonNode fixture = fixture("flow-artifact.valid.deployment.json");
        ObjectNode built = FlowDeployment.deploymentSet(MAPPER,
                UUID.fromString(fixture.path("tenant_id").asText()),
                UUID.fromString(fixture.path("site_id").asText()),
                UUID.fromString(fixture.path("device_id").asText()),
                Instant.parse(fixture.path("deployed_at").asText()),
                List.of(fixture.path("artifacts").get(0)));
        List<String> builtKeys = new java.util.ArrayList<>();
        built.fieldNames().forEachRemaining(builtKeys::add);
        List<String> fixtureKeys = new java.util.ArrayList<>();
        fixture.fieldNames().forEachRemaining(fixtureKeys::add);
        assertThat(builtKeys).containsExactlyInAnyOrderElementsOf(fixtureKeys);
    }

    @Test
    void malformedArtifactsNeverReachTheRetainedTopic() throws IOException {
        ObjectNode broken = ((ObjectNode) fixture("flow-artifact.valid.artifact.json"));
        broken.remove("content_hash");
        assertThatThrownBy(() -> FlowDeployment.deploymentSet(MAPPER, TENANT, SITE, DEVICE,
                Instant.now(), List.of(broken)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("content_hash");

        JsonNode badHash = fixture("flow-artifact.invalid.bad-hash.json");
        assertThatThrownBy(() -> FlowDeployment.requireArtifactShape(badHash))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sizeBudgetIsEnforcedCloudSide() throws IOException {
        ObjectNode artifact = ((ObjectNode) fixture("flow-artifact.valid.artifact.json"));
        artifact.put("signature", "x".repeat(FlowDeployment.ARTIFACT_LIMIT_BYTES));
        assertThatThrownBy(() -> FlowDeployment.deploymentSet(MAPPER, TENANT, SITE, DEVICE,
                Instant.now(), List.of(artifact)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("256 KiB");
    }

    @Test
    void topicFollowsTheContract() {
        assertThat(FlowDeploymentPublisher.flowsTopic(TENANT, SITE, DEVICE))
                .isEqualTo("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/flows");
    }
}
