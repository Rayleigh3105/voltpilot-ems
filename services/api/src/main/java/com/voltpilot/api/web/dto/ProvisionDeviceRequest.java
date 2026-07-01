package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * Platform-admin request to register a manufactured sticker Geräte-ID. The
 * controller canonicalizes {@code externalRef} exactly like the claim path
 * (trim + uppercase) and requires the {@code VP-} sticker prefix - only
 * sticker-format IDs are gated by the registry, so anything else in it would
 * be dead data.
 */
public record ProvisionDeviceRequest(
        @NotBlank String externalRef,
        String kind,
        String note) {

    public String kindOrDefault() {
        return kind == null || kind.isBlank() ? "inverter" : kind.trim();
    }
}
