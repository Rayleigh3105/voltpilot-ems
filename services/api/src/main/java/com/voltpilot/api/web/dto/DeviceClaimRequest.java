package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.UUID;

/**
 * Request body for claiming an edge device into one of the caller's sites.
 * "Onboarding = one insert" (architecture §14.1).
 *
 * <p>{@code externalRef} is capped at the provisioning contract's 64-char ref
 * limit (plus room for surrounding whitespace, which the controller trims); the
 * charset itself is validated post-canonicalization against
 * {@code ProvisioningTopics.isValidRef} in the controller.
 */
public record DeviceClaimRequest(
        @NotNull UUID siteId,
        @NotBlank @Size(max = 80) String externalRef,
        String kind) {
}
