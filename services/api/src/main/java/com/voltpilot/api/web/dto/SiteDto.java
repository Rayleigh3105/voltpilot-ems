package com.voltpilot.api.web.dto;

import java.util.UUID;

/** A site as returned by the portal API (see docs/contracts/openapi.yaml). */
public record SiteDto(UUID id, String name, String biddingZone) {
}
