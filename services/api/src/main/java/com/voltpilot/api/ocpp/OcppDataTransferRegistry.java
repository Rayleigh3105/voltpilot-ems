package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/** Closed registry for the deliberately tiny, vendor-bound DataTransfer surface. */
@Component
public final class OcppDataTransferRegistry {
    private record Schema(String vendorId, String messageId, String dataType,
            Set<String> required, Map<String, String> properties, boolean additional) {}

    private final ObjectMapper mapper;
    private final Map<String, Schema> schemas = new HashMap<>();

    public OcppDataTransferRegistry(ObjectMapper mapper) { this.mapper = mapper; }

    @PostConstruct
    void load() throws Exception {
        try (InputStream in = getClass().getResourceAsStream("/ocpp/data-transfer-registry.json")) {
            if (in == null) throw new IllegalStateException("OCPP DataTransfer registry fehlt");
            JsonNode root = mapper.readTree(in);
            if (!"1.0".equals(root.path("schema_version").asText()))
                throw new IllegalStateException("OCPP DataTransfer registry version ungültig");
            for (JsonNode n : root.path("schemas")) {
                String id = requiredText(n, "schema_id");
                Map<String, String> properties = new HashMap<>();
                n.path("properties").fields().forEachRemaining(e -> properties.put(e.getKey(), e.getValue().asText()));
                Set<String> required = new HashSet<>();
                n.path("required").forEach(v -> required.add(v.asText()));
                Schema schema = new Schema(requiredText(n, "vendor_id"), requiredText(n, "message_id"),
                        requiredText(n, "data_type"), Set.copyOf(required), Map.copyOf(properties),
                        n.path("additional_properties").asBoolean(false));
                if (schemas.putIfAbsent(id, schema) != null) throw new IllegalStateException("Doppeltes DataTransfer-Schema " + id);
            }
        }
    }

    /** Validates and removes the registry-only schemaId before OCPP serialization. */
    public JsonNode validateAndProject(JsonNode request) {
        if (request == null || !request.isObject()) throw new IllegalArgumentException("DataTransfer-Payload fehlt.");
        String id = request.path("schemaId").asText("");
        Schema schema = schemas.get(id);
        if (schema == null) throw new IllegalArgumentException("DataTransfer-Schema ist nicht registriert.");
        if (!schema.vendorId().equals(request.path("vendorId").asText())
                || !schema.messageId().equals(request.path("messageId").asText()))
            throw new IllegalArgumentException("DataTransfer Vendor/Message passt nicht zum registrierten Schema.");
        JsonNode data = request.get("data");
        if (!matchesType(data, schema.dataType())) throw new IllegalArgumentException("DataTransfer-Daten haben den falschen Typ.");
        for (String field : schema.required()) if (data == null || !data.has(field))
            throw new IllegalArgumentException("DataTransfer-Pflichtfeld fehlt: " + field);
        if (data != null && data.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = data.fields();
            while (fields.hasNext()) {
                var field = fields.next();
                String type = schema.properties().get(field.getKey());
                if (type == null && !schema.additional()) throw new IllegalArgumentException("DataTransfer-Feld ist nicht registriert: " + field.getKey());
                if (type != null && !matchesType(field.getValue(), type)) throw new IllegalArgumentException("DataTransfer-Feld hat den falschen Typ: " + field.getKey());
            }
        }
        var projected = mapper.createObjectNode();
        projected.put("vendorId", schema.vendorId());
        projected.put("messageId", schema.messageId());
        projected.set("data", data);
        return projected;
    }

    private static boolean matchesType(JsonNode n, String type) {
        if (n == null || n.isNull()) return false;
        return switch (type) {
            case "object" -> n.isObject(); case "array" -> n.isArray(); case "string" -> n.isTextual();
            case "integer" -> n.isIntegralNumber(); case "number" -> n.isNumber(); case "boolean" -> n.isBoolean();
            default -> false;
        };
    }
    private static String requiredText(JsonNode n, String field) {
        String value = n.path(field).asText("");
        if (value.isBlank()) throw new IllegalStateException("DataTransfer registry field fehlt: " + field);
        return value;
    }
}
