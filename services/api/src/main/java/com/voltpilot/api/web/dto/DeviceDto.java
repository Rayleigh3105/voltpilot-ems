package com.voltpilot.api.web.dto;

import java.util.UUID;

/** A device as returned by the portal API (see docs/contracts/openapi.yaml). */
public record DeviceDto(UUID id, UUID siteId, String externalRef, String kind, String status) {
}
