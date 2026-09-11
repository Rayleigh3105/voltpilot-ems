package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A small runner over the subset of JSON Schema draft 2020-12 the v2 event contracts use
 * ({@code mqtt-events-2.1.schema.json}, {@code events-raw.event.schema.json}): {@code type},
 * {@code required}, {@code properties}, {@code additionalProperties}, {@code items},
 * {@code enum}, {@code const}, {@code pattern}, {@code minItems}, {@code maxItems},
 * {@code minLength}, {@code maxLength}, {@code minimum}, {@code maximum}, {@code anyOf} and
 * {@code $ref} to {@code #/$defs/…}. The service has no schema library (see {@code pom.xml});
 * this runner is TEST-ONLY and pins the contract files to exactly the rules they write down,
 * naming the path of every violation. {@code format} is an annotation here - every date-time
 * and uuid in these contracts also carries a {@code pattern}.
 *
 * <p>Its twin is {@code services/api .../uems/UemsSchemaLaeufer} (same subset, used by the
 * vocabulary vector test). The RUNTIME check of {@code …/v2/events} is {@link BoxEventsValidator}
 * (UEMS AP-07 IP-5), driven by the same fixtures and vector cases; this runner stays the test-side
 * proof that every record Ingest publishes on {@code events.raw} is schema-valid.
 */
final class ContractSchemaRunner {
    private final JsonNode root;
    private final List<String> errors;
    private final Map<String, Pattern> patterns = new HashMap<>();

    private ContractSchemaRunner(JsonNode root, List<String> errors) {
        this.root = root;
        this.errors = errors;
    }

    /** Every violation of {@code data} against {@code schema}, each with its path; empty = valid. */
    static List<String> violations(JsonNode data, JsonNode schema) {
        List<String> errors = new ArrayList<>();
        new ContractSchemaRunner(schema, errors).check(data, schema, "$");
        return errors;
    }

    private void check(JsonNode value, JsonNode schema, String path) {
        if (schema.has("$ref")) {
            JsonNode target = root.at(schema.get("$ref").asText().substring(1));
            if (target.isMissingNode()) {
                errors.add(path + ": unknown $ref " + schema.get("$ref").asText());
                return;
            }
            check(value, target, path);
            return;
        }
        if (schema.has("anyOf")) {
            boolean any = false;
            for (JsonNode branch : schema.get("anyOf")) {
                List<String> probe = new ArrayList<>();
                new ContractSchemaRunner(root, probe).check(value, branch, path);
                any |= probe.isEmpty();
            }
            if (!any) {
                errors.add(path + ": matches no anyOf branch");
            }
        }
        if (schema.has("type") && !typeMatches(value, schema.get("type"))) {
            errors.add(path + ": type does not match " + schema.get("type"));
            return;
        }
        if (schema.has("const") && !value.equals(schema.get("const"))) {
            errors.add(path + ": " + value + " is not " + schema.get("const"));
        }
        if (schema.has("enum") && !value.isNull()) {
            boolean in = false;
            for (JsonNode e : schema.get("enum")) {
                in |= e.equals(value);
            }
            if (!in) {
                errors.add(path + ": " + value + " not in " + schema.get("enum"));
            }
        }
        if (value.isTextual()) {
            String s = value.asText();
            if (schema.has("pattern") && !patterns.computeIfAbsent(schema.get("pattern").asText(),
                    Pattern::compile).matcher(s).find()) {
                errors.add(path + ": \"" + s + "\" does not match " + schema.get("pattern").asText());
            }
            if (schema.has("minLength") && s.length() < schema.get("minLength").asInt()) {
                errors.add(path + ": too short");
            }
            if (schema.has("maxLength") && s.length() > schema.get("maxLength").asInt()) {
                errors.add(path + ": too long");
            }
        }
        if (value.isNumber()) {
            if (schema.has("minimum") && value.asDouble() < schema.get("minimum").asDouble()) {
                errors.add(path + ": below minimum");
            }
            if (schema.has("maximum") && value.asDouble() > schema.get("maximum").asDouble()) {
                errors.add(path + ": above maximum");
            }
        }
        if (value.isArray()) {
            if (schema.has("minItems") && value.size() < schema.get("minItems").asInt()) {
                errors.add(path + ": too few items");
            }
            if (schema.has("maxItems") && value.size() > schema.get("maxItems").asInt()) {
                errors.add(path + ": too many items");
            }
            if (schema.has("items")) {
                for (int i = 0; i < value.size(); i++) {
                    check(value.get(i), schema.get("items"), path + "[" + i + "]");
                }
            }
        }
        if (value.isObject()) {
            for (JsonNode r : schema.path("required")) {
                if (!value.has(r.asText())) {
                    errors.add(path + ": required " + r.asText() + " missing");
                }
            }
            JsonNode props = schema.path("properties");
            JsonNode extra = schema.path("additionalProperties");
            Set<String> known = new HashSet<>();
            props.fieldNames().forEachRemaining(known::add);
            value.fields().forEachRemaining(e -> {
                if (known.contains(e.getKey())) {
                    check(e.getValue(), props.get(e.getKey()), path + "." + e.getKey());
                } else if (extra.isObject()) {
                    check(e.getValue(), extra, path + "." + e.getKey());
                } else if (extra.isBoolean() && !extra.asBoolean()) {
                    errors.add(path + ": unknown field " + e.getKey());
                }
            });
        }
    }

    private static boolean typeMatches(JsonNode value, JsonNode type) {
        if (type.isArray()) {
            for (JsonNode t : type) {
                if (oneTypeMatches(value, t.asText())) {
                    return true;
                }
            }
            return false;
        }
        return oneTypeMatches(value, type.asText());
    }

    private static boolean oneTypeMatches(JsonNode value, String type) {
        return switch (type) {
            case "object" -> value.isObject();
            case "array" -> value.isArray();
            case "string" -> value.isTextual();
            case "integer" -> value.isIntegralNumber();
            case "number" -> value.isNumber();
            case "boolean" -> value.isBoolean();
            case "null" -> value.isNull();
            default -> false;
        };
    }
}
