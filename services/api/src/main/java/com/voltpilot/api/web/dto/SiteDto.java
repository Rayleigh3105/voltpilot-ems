package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * A site as returned by the portal API (see docs/contracts/openapi.yaml).
 * {@code latitude}/{@code longitude} are nullable (WGS84) and tie the site to its
 * weather forecast; they are null for sites that have no coordinates set yet.
 */
public record SiteDto(
        UUID id,
        String name,
        String biddingZone,
        BigDecimal latitude,
        BigDecimal longitude) {
}
