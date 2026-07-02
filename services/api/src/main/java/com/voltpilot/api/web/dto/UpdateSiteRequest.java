package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import java.math.BigDecimal;

/**
 * Request to update a site (Standort): name, bidding zone and coordinates -
 * the same fields and validation as {@link CreateSiteRequest}. The tenant is
 * never part of the body; the row is addressed through RLS, so a customer can
 * only ever update their own sites (admins reach any tenant's sites via the
 * tenant switcher, i.e. the same RLS-scoped path with an overridden context).
 */
public record UpdateSiteRequest(
        @NotBlank String name,
        @Pattern(regexp = "DE-LU|AT|CH", message = "biddingZone must be one of DE-LU, AT, CH")
                String biddingZone,
        @DecimalMin(value = "-90", message = "latitude must be between -90 and 90")
        @DecimalMax(value = "90", message = "latitude must be between -90 and 90")
                BigDecimal latitude,
        @DecimalMin(value = "-180", message = "longitude must be between -180 and 180")
        @DecimalMax(value = "180", message = "longitude must be between -180 and 180")
                BigDecimal longitude) {

    public String biddingZoneOrDefault() {
        return biddingZone == null || biddingZone.isBlank() ? "DE-LU" : biddingZone;
    }
}
