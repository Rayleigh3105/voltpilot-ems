package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import java.math.BigDecimal;

/**
 * Request to create a site (Standort). Used both by the customer endpoint
 * ({@code POST /api/v1/sites}, tenant taken from the caller's context) and the
 * platform-admin endpoint ({@code POST /api/v1/admin/tenants/{tenantId}/sites},
 * tenant taken from the path) - in NEITHER case does the client choose the
 * tenant, so a customer can never create a site for another tenant.
 *
 * <p>{@code biddingZone} defaults to {@code DE-LU} (the only zone implemented end
 * to end today; {@code AT}/{@code CH} are recognised for forward-compatibility -
 * see services/market-data/zones.py). {@code latitude}/{@code longitude} are
 * optional WGS84 coordinates that tie the site to its weather forecast; when
 * omitted the weather widget simply stays empty until they are set.
 */
public record CreateSiteRequest(
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
