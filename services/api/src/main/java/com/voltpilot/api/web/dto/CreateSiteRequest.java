package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
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
 * {@code plantKind} defaults to {@code eigenverbrauch} (avoided cost - the safe
 * money story); {@code direktvermarktung} switches the portal wording to real
 * market revenue ("mehr verdient"). {@code marktpraemieCtKwh} is the optional
 * Marktprämie (ct/kWh) from the customer's Direktvermarktungsvertrag - null =
 * not configured; only meaningful for {@code direktvermarktung} sites.
 *
 * <p>{@code netzladenErlaubt} (the per-site grid-charging switch): the SITE
 * OWNER may set it too (captain revision 2026-07-07 of decision 3 - not only
 * the Portal-Admin), since RLS already scopes which sites a customer reaches;
 * the portal form carries the Ausschließlichkeitsprinzip warning so nobody
 * flips it uninformed. An omitted field leaves the DB default FALSE
 * ("Nur Solarladen (EEG)").
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
                BigDecimal longitude,
        @Pattern(regexp = "direktvermarktung|eigenverbrauch",
                message = "plantKind must be one of direktvermarktung, eigenverbrauch")
                String plantKind,
        @DecimalMin(value = "0", message = "marktpraemieCtKwh must not be negative")
        @Digits(integer = 5, fraction = 3,
                message = "marktpraemieCtKwh must have at most 3 decimal places")
                BigDecimal marktpraemieCtKwh,
        Boolean netzladenErlaubt) {

    public String biddingZoneOrDefault() {
        return biddingZone == null || biddingZone.isBlank() ? "DE-LU" : biddingZone;
    }

    public String plantKindOrDefault() {
        return plantKind == null || plantKind.isBlank() ? "eigenverbrauch" : plantKind;
    }
}
