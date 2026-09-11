package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import java.math.BigDecimal;
import java.util.UUID;

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
 * market revenue ("mehr verdient"). {@code anzulegenderWertCtKwh} is the plant's
 * optional fixed EEG reference rate (anzulegender Wert, ct/kWh - from the EEG
 * award / Direktvermarktungsvertrag); null = not configured; only meaningful
 * for {@code direktvermarktung} sites. The dynamic monthly Marktprämie derives
 * from it (see EarningsRepository) - the deprecated fixed
 * {@code marktpraemieCtKwh} is NOT accepted here anymore (unknown JSON fields
 * are ignored, so an old client sending it simply no-ops).
 * {@code tarifArt}/{@code tarifParamCtKwh} are the customer's electricity tariff
 * (they REPLACE the old fixed strompreisCtKwh): {@code tarifArt} is
 * {@code dynamisch} | {@code fest} | {@code ohne} (default {@code ohne}), and
 * {@code tarifParamCtKwh} (ct/kWh, >= 0, optional) is its parameter - the fixed
 * retail price for {@code fest}, the optional spot-price Aufschlag for
 * {@code dynamisch}, unused for {@code ohne}. When the tariff is set the realized
 * earnings value self-consumed energy in euros (dynamisch: per 15-min slot at
 * spot + Aufschlag; fest: at the fixed price); {@code ohne} shows kWh only, never
 * a fabricated euro number.
 *
 * <p>{@code netzladenErlaubt} (the per-site grid-charging switch): the SITE
 * OWNER may set it too (captain revision 2026-07-07 of decision 3 - not only
 * the Portal-Admin), since RLS already scopes which sites a customer reaches;
 * the portal form carries the Ausschließlichkeitsprinzip warning so nobody
 * flips it uninformed. An omitted field leaves the DB default FALSE
 * ("Nur Solarladen (EEG)").
 *
 * <p>{@code maxFeedInKw} (FK1) is the optional static feed-in cap at the grid
 * connection point (Einspeisegrenze am Netzanschlusspunkt, kW, strictly
 * positive); omit/null = no connection-point limit. The optimizer enforces it
 * export-only.
 *
 * <p>{@code standortId} (additiv, Bestandsübernahme der Standorte AP-02 IP-9): der
 * Standort, zu dem die neue Anlage gehört — sie wird ihm ab dem Tag ihres Anlegens
 * zugeordnet. Weggelassen: bei genau einem Standort des Kundenbereichs ist er vorbelegt,
 * ohne Standort bleibt die Anlage wie bisher „noch nicht zugeordnet", bei mehreren ist
 * die Wahl Pflicht (422 {@code standort_waehlen}). Nur {@code POST /api/v1/sites} liest
 * das Feld; die Plattform-Route {@code POST /api/v1/admin/tenants/{tenantId}/sites}
 * überliest es (sie legt wie bisher ohne Zuordnung an).
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
        @DecimalMin(value = "0", message = "anzulegenderWertCtKwh must not be negative")
        @Digits(integer = 5, fraction = 3,
                message = "anzulegenderWertCtKwh must have at most 3 decimal places")
                BigDecimal anzulegenderWertCtKwh,
        @Pattern(regexp = "dynamisch|fest|ohne",
                message = "tarifArt must be one of dynamisch, fest, ohne")
                String tarifArt,
        @DecimalMin(value = "0", message = "tarifParamCtKwh must not be negative")
        @Digits(integer = 5, fraction = 3,
                message = "tarifParamCtKwh must have at most 3 decimal places")
                BigDecimal tarifParamCtKwh,
        Boolean netzladenErlaubt,
        @DecimalMin(value = "0", inclusive = false,
                message = "maxFeedInKw must be positive")
        @Digits(integer = 6, fraction = 2,
                message = "maxFeedInKw must have at most 2 decimal places")
                BigDecimal maxFeedInKw,
        UUID standortId) {

    public String biddingZoneOrDefault() {
        return biddingZone == null || biddingZone.isBlank() ? "DE-LU" : biddingZone;
    }

    public String plantKindOrDefault() {
        return plantKind == null || plantKind.isBlank() ? "eigenverbrauch" : plantKind;
    }

    public String tarifArtOrDefault() {
        return tarifArt == null || tarifArt.isBlank() ? "ohne" : tarifArt;
    }

    /**
     * The tariff parameter to persist: null for {@code ohne} (no euro value),
     * otherwise the given value - so a stray parameter can never linger on an
     * {@code ohne} site.
     */
    public BigDecimal tarifParamOrNull() {
        return "ohne".equals(tarifArtOrDefault()) ? null : tarifParamCtKwh;
    }
}
