package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * Das Ergebnis EINES Schritts der Zwei-Schritt-Strecke (Vorschau oder
 * Schreibvorgang).
 *
 * <p><b>Jedes Zahlenfeld darf fehlen, und ein fehlendes heißt „nicht gemessen",
 * nie 0</b> - eine 0 wäre bei einer Einspeisegrenze ein WERT („gar keine
 * Einspeisung erlaubt"). {@code adopted} ist dreiwertig: {@code null} = keine
 * Aussage (Vorschau, ausgebliebene Quittung), {@code false} = angenommen aber
 * nicht übernommen, {@code true} = zurückgelesen.
 *
 * @param outcome   {@code gelesen|uebernommen|nicht_uebernommen|abgelehnt|fehler|unbekannt}
 *                  - {@code unbekannt} ist die ehrliche Antwort auf Schweigen
 *                  und ausdrücklich NICHT „nicht geschrieben".
 * @param confirm   der Bestätigungs-Token, den dieser Schreibvorgang getragen
 *                  hat (nur beim Schreiben) - er steht im Beleg, damit sichtbar
 *                  ist, was genau autorisiert wurde.
 */
public record RegisterWriteOutcomeDto(String requestId, String mode, boolean ok, String outcome,
        Integer beforeRaw, Integer afterRaw, Double beforeScaled, Double afterScaled,
        Boolean adopted, String errorCode, String message, String targetLabel, int address,
        String addressHex, String registerLabel, String registerClass, String scaleNote,
        boolean noteRequired, String confirm, Instant at) {
}
