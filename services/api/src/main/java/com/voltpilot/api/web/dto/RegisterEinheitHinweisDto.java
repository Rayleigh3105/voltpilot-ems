package com.voltpilot.api.web.dto;

import java.math.BigDecimal;

/**
 * S5 (vp-mastr-mehrere-einheiten-konzept §4.4/§8): die „fehlt eine Einheit?"-
 * Plausibilität - die gemessene PV-Spitze gegen die Summe der bestätigten PV-
 * Einheiten. {@code moeglicherweiseFehlendeEinheit} ist nur bei genug
 * Messwerten UND einer gepflegten Summe wahr (nie geraten); ohne beides sind
 * {@code gemessenePeakKw}/{@code summeKwp} trotzdem gesetzt, wo bekannt - das
 * Portal zeigt den Hinweis nur, wenn das Flag wahr ist.
 */
public record RegisterEinheitHinweisDto(
        boolean moeglicherweiseFehlendeEinheit,
        BigDecimal gemessenePeakKw,
        BigDecimal summeKwp,
        long messwerteViertelstunden) {
}
