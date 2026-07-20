package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * Platform-admin request to update a tenant's master data (name/segment/
 * betriebsart). Mirrors {@link CreateTenantRequest}'s validation.
 *
 * <p>{@code betriebsart} is the U0 shell-frame override, full-representation:
 * 'endkunde' / 'betreiber' set it, null (or blank) clears it back to the
 * automatic segment-derived default - so the admin select's three states
 * (Endkunde / Betreiber / Automatisch) map 1:1 onto the request.
 */
public record UpdateTenantRequest(
        @NotBlank String name,
        @Pattern(regexp = "CI|B2C", message = "segment must be 'CI' or 'B2C'") String segment,
        @Pattern(regexp = "(endkunde|betreiber)?",
                message = "betriebsart must be 'endkunde' or 'betreiber'") String betriebsart) {

    public String segmentOrDefault() {
        return segment == null || segment.isBlank() ? "CI" : segment;
    }

    /** The override to store: null (= automatic) when absent or blank. */
    public String betriebsartOrNull() {
        return betriebsart == null || betriebsart.isBlank() ? null : betriebsart;
    }
}
