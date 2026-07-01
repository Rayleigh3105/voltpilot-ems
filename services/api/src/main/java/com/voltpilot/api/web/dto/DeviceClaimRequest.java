package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.UUID;

/**
 * Request body for claiming an edge device into one of the caller's sites.
 * "Onboarding = one insert" (architecture §14.1).
 */
public record DeviceClaimRequest(
        @NotNull UUID siteId,
        @NotBlank String externalRef,
        String kind) {
}
