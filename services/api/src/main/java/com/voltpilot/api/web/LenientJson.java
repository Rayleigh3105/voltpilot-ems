package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Parses an already-stored JSON column back into a tree, treating a blank or
 * malformed value as absent rather than failing the request - the value was
 * written by this same service, so a parse failure means missing data, not
 * untrusted input to reject.
 */
final class LenientJson {

    private LenientJson() {
    }

    static JsonNode parse(ObjectMapper mapper, String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }
}
