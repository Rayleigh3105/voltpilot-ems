package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A device as returned by the portal API (see docs/contracts/openapi.yaml).
 * {@code name} is the optional customer-facing label (Bezeichnung; the
 * immutable {@code externalRef} stays the identity). {@code lastSeenAt} is the
 * newest telemetry timestamp for the device (null until the first sample
 * arrives) - the portal derives the onboarding status "wartet auf erste Daten"
 * vs. "online" from it.
 */
public record DeviceDto(UUID id, UUID siteId, String externalRef, String kind, String name,
        String status, Instant lastSeenAt) {
}
