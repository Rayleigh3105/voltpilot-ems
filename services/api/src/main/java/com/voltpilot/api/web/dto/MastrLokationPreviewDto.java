package com.voltpilot.api.web.dto;

import java.util.List;

/**
 * S2 (Lokations-Suche, vp-mastr-mehrere-einheiten-konzept Abschnitt 5.3): every
 * unit sharing the customer's typed unit's Lokation ("eine Nummer genügt"),
 * sorted by commissioning date. Nothing persisted yet - the customer confirms
 * which of these to adopt ({@code mastr-lokation-apply}).
 */
public record MastrLokationPreviewDto(
        String lokationMastrNummer,
        List<MastrLokationEinheitDto> einheiten) {
}
