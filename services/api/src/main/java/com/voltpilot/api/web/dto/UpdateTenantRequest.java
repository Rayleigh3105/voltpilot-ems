package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * Platform-admin request to update a tenant's master data (name/segment).
 * Mirrors {@link CreateTenantRequest}'s validation.
 */
public record UpdateTenantRequest(
        @NotBlank String name,
        @Pattern(regexp = "CI|B2C", message = "segment must be 'CI' or 'B2C'") String segment) {

    public String segmentOrDefault() {
        return segment == null || segment.isBlank() ? "CI" : segment;
    }
}
