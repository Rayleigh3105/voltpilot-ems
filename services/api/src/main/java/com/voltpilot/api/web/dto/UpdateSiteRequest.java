package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import java.math.BigDecimal;

/**
 * Request to update a site (Standort): name, bidding zone, coordinates and
 * plant kind - the same fields and validation as {@link CreateSiteRequest}. The
 * tenant is never part of the body; the row is addressed through RLS, so a
 * customer can only ever update their own sites (admins reach any tenant's
 * sites via the tenant switcher, i.e. the same RLS-scoped path with an
 * overridden context).
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
                BigDecimal longitude,
        @Pattern(regexp = "direktvermarktung|eigenverbrauch",
                message = "plantKind must be one of direktvermarktung, eigenverbrauch")
                String plantKind,
        @DecimalMin(value = "0", message = "marktpraemieCtKwh must not be negative")
        @Digits(integer = 5, fraction = 3,
                message = "marktpraemieCtKwh must have at most 3 decimal places")
                BigDecimal marktpraemieCtKwh) {

    public String biddingZoneOrDefault() {
        return biddingZone == null || biddingZone.isBlank() ? "DE-LU" : biddingZone;
    }

    public String plantKindOrDefault() {
        return plantKind == null || plantKind.isBlank() ? "eigenverbrauch" : plantKind;
    }
}
