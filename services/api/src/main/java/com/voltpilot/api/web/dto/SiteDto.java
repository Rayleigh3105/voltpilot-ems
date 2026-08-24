package com.voltpilot.api.web.dto;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * A site as returned by the portal API (see docs/contracts/openapi.yaml).
 * {@code latitude}/{@code longitude} are nullable (WGS84) and tie the site to its
 * weather forecast; they are null for sites that have no coordinates set yet.
 * {@code plantKind} ({@code direktvermarktung} | {@code eigenverbrauch}, migration
 * V20260706010000) steers the portal's money wording per site ("mehr verdient"
 * vs. "gespart"). {@code anzulegenderWertCtKwh} (migration V20260707020000) is
 * the plant's fixed EEG reference rate (anzulegender Wert, from the EEG award /
 * Direktvermarktungsvertrag); null = not configured, only relevant for
 * {@code plantKind = direktvermarktung} - when set, the realized earnings
 * include the DYNAMIC monthly premium {@code max(0, anzulegender Wert -
 * Monatsmarktwert Solar)}, suspended in negative-price slots.
 * {@code marktpraemieCtKwh} is the DEPRECATED predecessor (a fixed premium -
 * wrong semantics, captain fix 2026-07-07): echoed read-only for one release,
 * no longer accepted on create/update and no longer used anywhere.
 * {@code tarifArt}/{@code tarifParamCtKwh} (migration V20260708010000, REPLACES
 * the fixed strompreis_ct_kwh) are the customer's electricity tariff:
 * {@code tarifArt} is {@code dynamisch} | {@code fest} | {@code ohne}, and
 * {@code tarifParamCtKwh} (ct/kWh, null = none) is its parameter - the fixed
 * retail price for {@code fest}, the optional spot-price Aufschlag (grid fees,
 * levies, margin) for {@code dynamisch}, unused for {@code ohne}. It steers how
 * the realized earnings value self-consumed energy: for {@code dynamisch} each
 * self-consumed kWh is priced at its 15-min Börsenpreis + the Aufschlag, for
 * {@code fest} at the fixed price, for {@code ohne} not in euros (kWh only,
 * never a fabricated value).
 * {@code netzladenErlaubt} (migration V20260707000000) is the per-site
 * grid-charging switch: {@code false} (the default) = "Nur Solarladen (EEG)",
 * the optimizer charges the battery only from PV surplus; {@code true} =
 * "Netzladen aktiv", grid arbitrage allowed. Editable by the site owner and
 * by Portal-Admins (captain revision 2026-07-07 of decision 3); the portal
 * form carries the Ausschließlichkeitsprinzip warning.
 * {@code maxFeedInKw} (migration V20260716000000, FK1) is the site's static
 * feed-in cap at the grid connection point (Einspeisegrenze am
 * Netzanschlusspunkt, kW &gt; 0); null = no connection-point limit. The
 * optimizer enforces it as a hard cap on grid EXPORT ONLY - unlike the
 * telemetry-driven §14a limit, which is symmetric.
 * {@code leistungspreisEurKw}/{@code abrechnungLeistung}/{@code peakReserveSocPct}
 * (migration V20260716020000, PS-1/PS-2 peak shaving) are echoed READ-ONLY
 * here: the peak-shaving module is configured by Portal-Admins via the
 * optimizer-config endpoint, never through the customer site forms (captain
 * decision: VoltPilot richtet vertragsnahe Module ein). A non-null
 * {@code leistungspreisEurKw} (EUR per kW per billing period) IS the
 * module-active flag; {@code abrechnungLeistung} is {@code jahr} |
 * {@code monat}; {@code peakReserveSocPct} is the hard SoC floor reserved
 * for out-of-horizon peaks (null = none).
 * {@code profil} (migration V20260838000000, Anwendungs-Programm Stufe 2) is the
 * site's application PRESET ({@code privat} | {@code gewerbe}; null = none
 * chosen, the state of every pre-Stufe-2 site). It is preset + tonality +
 * reset base ONLY - never a signal of the activation derivation - and is
 * written exclusively by {@code PUT /api/v1/sites/{id}/anwendungs-preset}.
 */
public record SiteDto(
        UUID id,
        String name,
        String biddingZone,
        BigDecimal latitude,
        BigDecimal longitude,
        String plantKind,
        BigDecimal anzulegenderWertCtKwh,
        BigDecimal marktpraemieCtKwh,
        String tarifArt,
        BigDecimal tarifParamCtKwh,
        boolean netzladenErlaubt,
        BigDecimal maxFeedInKw,
        BigDecimal leistungspreisEurKw,
        String abrechnungLeistung,
        BigDecimal peakReserveSocPct,
        // AE7 Nutzungsprofil (migration V20260719050000): the explicit usage-
        // profile override (arbitrage|peak|private) or null to auto-derive. Set
        // via PUT /api/v1/sites/{id}/profile; the effective+derived profile and
        // emphasis are served by GET /api/v1/sites/{id}/profile.
        String usageProfileOverride,
        // Anwendungs-Preset (migration V20260838000000): privat | gewerbe, or
        // null when none was chosen. Written by PUT .../anwendungs-preset.
        String profil) {
}
