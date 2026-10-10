package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;

/** Packaged verbatim from docs/contracts/v2; never accepts a client supplied cost/bench. */
final class MeasurementBudgetContract {
    private static final JsonNode TABLE = load();

    private MeasurementBudgetContract() {}

    private static JsonNode load() {
        try (var in = MeasurementBudgetContract.class.getResourceAsStream(
                "/uems/measurement-budget-vectors.json")) {
            if (in == null) throw new IllegalStateException("Missing measurement budget contract");
            JsonNode table = new ObjectMapper().readTree(in);
            if (!"1.0".equals(table.path("schema_version").asText())) {
                throw new IllegalStateException("Unsupported measurement budget contract");
            }
            return table;
        } catch (IOException e) {
            throw new IllegalStateException("Unreadable measurement budget contract", e);
        }
    }

    static int limit(String name) {
        return TABLE.required("limits").required(name).asInt();
    }

    private static JsonNode family(String family, String sourceKind) {
        JsonNode override = family == null ? null : TABLE.required("family_overrides").get(family);
        JsonNode alias = sourceKind == null ? null : TABLE.required("aliases").get(sourceKind);
        String key = override != null ? override.asText() : alias != null ? alias.asText()
                : sourceKind != null && sourceKind.startsWith("modbus") ? "modbus"
                : TABLE.required("default_family").asText();
        return TABLE.required("families").required(key);
    }

    static int cost(String family, String sourceKind) {
        return family(family, sourceKind).required("request_cost_ms").asInt();
    }

    static int requests(String family, String sourceKind, int units) {
        if (units < 0) throw new IllegalArgumentException("Negative block size");
        JsonNode row = family(family, sourceKind);
        if (row.path("inbound").asBoolean()) return 0;
        int size = row.required("units_per_request").asInt();
        return units / size + (units % size == 0 ? 0 : 1);
    }
}
