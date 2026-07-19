package com.voltpilot.api.flows;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * The api → flowc bridge's failure mapping (pure unit, no network - the fake
 * {@link FlowCompilerHttp} seam): a 200 returns flowc's artifact verbatim (the
 * JCS content_hash is NEVER recomputed here), a 422 becomes a rejection
 * carrying the sidecar's German message, and a transport error / unexpected
 * status / unexpected body becomes an honest "unavailable".
 */
class FlowCompilerClientTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final URI BASE = URI.create("http://flowc:8099");

    private static String fixtureArtifact() throws IOException {
        return Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "examples",
                "flow-artifact.valid.artifact.json"));
    }

    /** A one-shot fake returning a fixed response (or throwing on transport). */
    private static FlowCompilerHttp respondWith(int status, String body) {
        return (uri, jsonBody) -> new FlowCompilerHttp.Response(status, body);
    }

    private FlowCompilerClient client(FlowCompilerHttp http) {
        return new FlowCompilerClient(http, BASE, MAPPER);
    }

    @Test
    void twoHundredReturnsTheArtifactWithFlowcsOwnContentHash() throws IOException {
        String artifactJson = fixtureArtifact();
        JsonNode result = client(respondWith(200, artifactJson))
                .compile(MAPPER.createObjectNode());
        assertThat(result.path("kind").asText()).isEqualTo("artifact");
        assertThat(result.path("content_hash").asText())
                .isEqualTo(MAPPER.readTree(artifactJson).path("content_hash").asText());
        // The bridge posts to /compile with the graph wrapped as {document}.
        FlowCompilerHttp capturing = (uri, jsonBody) -> {
            assertThat(uri.toString()).isEqualTo("http://flowc:8099/compile");
            assertThat(MAPPER.readTree(jsonBody).has("document")).isTrue();
            return new FlowCompilerHttp.Response(200, artifactJson);
        };
        client(capturing).compile(MAPPER.createObjectNode());
    }

    @Test
    void fourTwentyTwoBecomesARejectionCarryingTheSidecarMessage() {
        String body = "{\"message\":\"Der Flow konnte nicht kompiliert werden: V-4 …\","
                + "\"findings\":[{\"rule\":\"V-4\"}]}";
        assertThatThrownBy(() -> client(respondWith(422, body)).compile(MAPPER.createObjectNode()))
                .isInstanceOfSatisfying(FlowCompilerException.class, e -> {
                    assertThat(e.reason()).isEqualTo("compiler_rejected");
                    assertThat(e.getMessage()).contains("V-4");
                });
    }

    @Test
    void anUnexpectedStatusBecomesUnavailable() {
        assertThatThrownBy(() -> client(respondWith(503, "{}")).compile(MAPPER.createObjectNode()))
                .isInstanceOfSatisfying(FlowCompilerException.class, e -> {
                    assertThat(e.reason()).isEqualTo("compiler_unavailable");
                    assertThat(e.getMessage()).contains("nicht erreichbar");
                });
    }

    @Test
    void aTransportFailureBecomesUnavailable() {
        FlowCompilerHttp broken = (uri, jsonBody) -> {
            throw new IOException("connection refused");
        };
        assertThatThrownBy(() -> client(broken).compile(MAPPER.createObjectNode()))
                .isInstanceOfSatisfying(FlowCompilerException.class,
                        e -> assertThat(e.reason()).isEqualTo("compiler_unavailable"));
    }

    @Test
    void aTwoHundredWithANonArtifactBodyIsRejected() {
        assertThatThrownBy(() -> client(respondWith(200, "{\"kind\":\"deployment\"}"))
                .compile(MAPPER.createObjectNode()))
                .isInstanceOfSatisfying(FlowCompilerException.class,
                        e -> assertThat(e.reason()).isEqualTo("compiler_rejected"));
    }
}
