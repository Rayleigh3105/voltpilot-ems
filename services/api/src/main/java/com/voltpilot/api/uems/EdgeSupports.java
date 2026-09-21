package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.ArrayList;
import java.util.function.Consumer;

/** Wire vocabulary. Shared with Go and TS through edge-supports-vectors.json. */
public final class EdgeSupports {
    public static final List<String> NAMES = List.of(
            "data_sources", "assignment_effective_at", "measurement_sample_provenance", "events",
            "automation_paused_until_revoked", "plan_quittung", "steuerungsverbund_anteil");
    private EdgeSupports() {}

    public static List<String> parse(JsonNode block, Consumer<String> unknown) {
        if (block == null || block.isNull()) return null;
        if (!block.isArray() || block.size() > 128) throw new IllegalArgumentException("Invalid supports block");
        var result = new ArrayList<String>();
        for (JsonNode value : block) {
            if (!value.isTextual() || !value.asText().matches("[a-z][a-z0-9_]{0,63}"))
                throw new IllegalArgumentException("Invalid capability name");
            String name = value.asText();
            if (!NAMES.contains(name)) unknown.accept(name);
            else if (!result.contains(name)) result.add(name);
        }
        return List.copyOf(result);
    }

    public static List<String> fromJson(String raw) {
        if (raw == null) return null;
        try { return parse(new ObjectMapper().readTree(raw), ignored -> {}); }
        catch (Exception e) { throw new IllegalArgumentException("Invalid stored supports", e); }
    }
}
