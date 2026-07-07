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
 * {@code netzladenErlaubt} (migration V20260707000000) is the per-site
 * grid-charging switch: {@code false} (the default) = "Nur Solarladen (EEG)",
 * the optimizer charges the battery only from PV surplus; {@code true} =
 * "Netzladen aktiv", grid arbitrage allowed. Editable by the site owner and
 * by Portal-Admins (captain revision 2026-07-07 of decision 3); the portal
 * form carries the Ausschließlichkeitsprinzip warning.
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
        boolean netzladenErlaubt) {
}
