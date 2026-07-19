package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.net.URI;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The {@link FlowCompiler} bridge onto the {@code flowc-serve} Node sidecar
 * (E2's compiler; edge-app/nodered/flowc/serve.js): the JVM api has no Node
 * runtime and MUST NOT reimplement the RFC-8785 JCS content hash, so it POSTs
 * the flow-graph document to {@code {base}/compile} and gets the compiled
 * flow-artifact back (with flowc's own {@code content_hash}). Same shape as
 * {@code SimulationClient}: the api owns auth/tenancy, the sidecar owns the
 * compile; a transport failure or a compiler rejection becomes a
 * {@link FlowCompilerException} the activation path relays as an honest
 * German {@code activated=false}.
 */
public class FlowCompilerClient implements FlowCompiler {

    private static final Logger log = LoggerFactory.getLogger(FlowCompilerClient.class);

    private final FlowCompilerHttp http;
    private final URI baseUri;
    private final ObjectMapper json;

    public FlowCompilerClient(FlowCompilerHttp http, URI baseUri, ObjectMapper json) {
        this.http = http;
        this.baseUri = baseUri;
        this.json = json;
    }

    @Override
    public JsonNode compile(JsonNode flowDocument) {
        ObjectNode request = json.createObjectNode();
        request.set("document", flowDocument);
        FlowCompilerHttp.Response response;
        try {
            response = http.post(resolve("/compile"), json.writeValueAsString(request));
        } catch (IOException e) {
            log.warn("flowc.compile_unreachable: {}", e.toString());
            throw FlowCompilerException.unavailable();
        }
        if (response.status() == 200) {
            JsonNode artifact = parse(response.body());
            if (artifact == null || !"artifact".equals(artifact.path("kind").asText())) {
                log.warn("flowc.compile_unexpected_body");
                throw FlowCompilerException.rejected(
                        "Der Flow-Compiler lieferte eine unerwartete Antwort.");
            }
            return artifact;
        }
        if (response.status() == 422) {
            log.warn("flowc.compile_rejected: {}", response.body());
            throw FlowCompilerException.rejected(upstreamMessage(response));
        }
        log.warn("flowc.compile_unexpected_status: {}", response.status());
        throw FlowCompilerException.unavailable();
    }

    private URI resolve(String path) {
        String base = baseUri.toString();
        return URI.create(base.endsWith("/") ? base.substring(0, base.length() - 1) + path
                : base + path);
    }

    private JsonNode parse(String body) {
        try {
            return body == null || body.isBlank() ? null : json.readTree(body);
        } catch (IOException e) {
            return null;
        }
    }

    /** The sidecar's German {@code {"message": ...}}, or null if absent. */
    private String upstreamMessage(FlowCompilerHttp.Response response) {
        JsonNode body = parse(response.body());
        if (body != null && body.path("message").isTextual()) {
            String message = body.path("message").asText();
            if (!message.isBlank()) {
                return message;
            }
        }
        return null;
    }
}
