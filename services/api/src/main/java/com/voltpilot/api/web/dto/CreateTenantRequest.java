package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/**
 * Request to create a tenant. {@code segment} is optional and defaults to
 * {@code CI} (matches the {@code tenant.segment} CHECK: 'CI' | 'B2C').
 */
public record CreateTenantRequest(
        @NotBlank String name,
        @Pattern(regexp = "CI|B2C", message = "segment must be 'CI' or 'B2C'") String segment) {

    public String segmentOrDefault() {
        return segment == null || segment.isBlank() ? "CI" : segment;
    }
}
