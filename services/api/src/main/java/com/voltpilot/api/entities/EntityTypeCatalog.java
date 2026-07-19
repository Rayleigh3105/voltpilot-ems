package com.voltpilot.api.entities;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The data-driven entity-type catalog (E1b): loads
 * {@code entitytypes/catalog.json} once at startup and is the ONE truth the
 * api validates entity creation/edit against (the flowcatalog precedent). The
 * WIRE vocabulary (edge-entity.schema.json) is an open kebab-case pattern;
 * this catalog is the platform's knowledge about the types it offers - adding
 * a type is catalog data + an optional edge driver (E6), never a schema
 * release and never a DB migration (the pilot-enum CHECK fell with
 * V20260719010000).
 */
@Component
public class EntityTypeCatalog {

    /** The contract's open kebab-case entity_type pattern. */
    public static final Pattern TYPE_PATTERN = Pattern.compile("^[a-z][a-z0-9-]{0,62}$");

    /** One catalog entry. Capability nodes are the raw catalog JSON. */
    public record EntityType(String type, String label, String category, boolean controllable,
            boolean composed, String defaultFailsafe, JsonNode defaultMeasure,
            JsonNode defaultActuate) {}

    private final JsonNode raw;
    private final Map<String, EntityType> types = new LinkedHashMap<>();

    public EntityTypeCatalog(ObjectMapper mapper) {
        try (InputStream in = getClass().getResourceAsStream("/entitytypes/catalog.json")) {
            if (in == null) {
                throw new IllegalStateException("entitytypes/catalog.json missing from classpath");
            }
            this.raw = mapper.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException("entitytypes/catalog.json unreadable", e);
        }
        for (JsonNode t : raw.path("types")) {
            EntityType type = new EntityType(
                    t.path("type").asText(),
                    t.path("label").asText(),
                    t.path("category").asText(),
                    t.path("controllable").asBoolean(false),
                    t.path("composed").asBoolean(false),
                    t.path("default_failsafe").asText("off"),
                    t.path("default_measure"),
                    t.path("default_actuate"));
            if (!TYPE_PATTERN.matcher(type.type()).matches()) {
                throw new IllegalStateException("catalog type not kebab-case: " + type.type());
            }
            types.put(type.type(), type);
        }
        if (types.isEmpty()) {
            throw new IllegalStateException("entitytypes/catalog.json declares no types");
        }
    }

    /** The raw catalog document (served to the portal admin editor verbatim). */
    public JsonNode document() {
        return raw;
    }

    /** The known type, or null. */
    public EntityType find(String type) {
        return type == null ? null : types.get(type);
    }

    /** German display label for a type ("" for unknown types, never null). */
    public String labelFor(String type) {
        EntityType t = find(type);
        return t == null ? "" : t.label();
    }

    /** All catalog types in declaration order. */
    public List<EntityType> all() {
        return new ArrayList<>(types.values());
    }
}
