package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

/**
 * The VoltPilot node catalog (flow-graph contract §1): loaded ONCE from the
 * classpath resource {@code flowcatalog/catalog.json}, served verbatim to the
 * portal editor and consumed by the {@link FlowGraphValidator} - client and
 * server validate against the SAME data. Adding a node type is additive
 * (append to the JSON); the final catalog ownership moves to E2/E4.
 */
@Component
public class FlowCatalog {

    private final JsonNode root;
    private final Map<String, JsonNode> byType = new LinkedHashMap<>();

    public FlowCatalog(ObjectMapper mapper) {
        try (InputStream in = new ClassPathResource("flowcatalog/catalog.json").getInputStream()) {
            this.root = mapper.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException("flow catalog resource unreadable", e);
        }
        for (JsonNode type : root.path("types")) {
            byType.put(type.path("type").asText(), type);
        }
    }

    /** The whole catalog document (the GET /flow-catalog payload). */
    public JsonNode raw() {
        return root;
    }

    /** The catalog entry of a type id, or null when unknown. */
    public JsonNode type(String typeId) {
        return byType.get(typeId);
    }

    /**
     * Whether a node type is GATED (AE7 governance, spec §3): market-/grid-near
     * strategy nodes that need VoltPilot enablement/contract. Free node types
     * (Eigenverbrauch, device control, all data/logic/action nodes) omit the
     * flag and return false. An unknown type is treated as not gated (the
     * V-4 unknown-type check handles it).
     */
    public boolean isGated(String typeId) {
        JsonNode type = byType.get(typeId);
        return type != null && type.path("gated").asBoolean(false);
    }

    /** The set of gated node types (AE7 governance). */
    public Set<String> gatedTypes() {
        Set<String> gated = new LinkedHashSet<>();
        for (Map.Entry<String, JsonNode> e : byType.entrySet()) {
            if (e.getValue().path("gated").asBoolean(false)) {
                gated.add(e.getKey());
            }
        }
        return gated;
    }

    /**
     * Whether the catalog can serve a document built against {@code requested}:
     * same MAJOR and the catalog's version is >= the requested one (semver) -
     * so a 1.1.0 catalog accepts 1.0.0 documents, a 2.x never accepts 1.x.
     */
    public boolean supportsVersion(String typeId, String requested) {
        JsonNode type = byType.get(typeId);
        if (type == null) {
            return false;
        }
        int[] have = parseSemver(type.path("type_version").asText());
        int[] want = parseSemver(requested);
        if (have == null || want == null || have[0] != want[0]) {
            return false;
        }
        if (have[1] != want[1]) {
            return have[1] > want[1];
        }
        return have[2] >= want[2];
    }

    /** The declared port node (inputs/outputs list entry) or null. */
    public JsonNode port(String typeId, String direction, String portName) {
        JsonNode type = byType.get(typeId);
        if (type == null) {
            return null;
        }
        for (JsonNode port : type.path(direction)) {
            if (port.path("name").asText().equals(portName)) {
                return port;
            }
        }
        return null;
    }

    /**
     * Port type compatibility per flow-graph contract §2: equal types, plus the
     * two declared widenings price→timeseries and number→timeseries. Nothing
     * else - no implicit conversions.
     */
    public static boolean compatible(String from, String to) {
        return from.equals(to)
                || ("price".equals(from) && "timeseries".equals(to))
                || ("number".equals(from) && "timeseries".equals(to));
    }

    static int[] parseSemver(String version) {
        if (version == null) {
            return null;
        }
        String[] parts = version.split("\\.");
        if (parts.length != 3) {
            return null;
        }
        try {
            return new int[] {Integer.parseInt(parts[0]), Integer.parseInt(parts[1]),
                    Integer.parseInt(parts[2])};
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
