package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * A site as returned by the portal API (see docs/contracts/openapi.yaml).
 * {@code latitude}/{@code longitude} are nullable (WGS84) and tie the site to its
 * weather forecast; they are null for sites that have no coordinates set yet.
 * {@code plantKind} ({@code direktvermarktung} | {@code eigenverbrauch}, migration
 * V20260706010000) steers the portal's money wording per site ("mehr verdient"
 * vs. "gespart").
 */
public record SiteDto(
        UUID id,
        String name,
        String biddingZone,
        BigDecimal latitude,
        BigDecimal longitude,
        String plantKind) {
}
