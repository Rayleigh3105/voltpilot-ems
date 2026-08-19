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
 * @param registerNote der Betreiber-Hinweis des Register-Wissens, oder
 *                  {@code null} - etwa „gehört zur laufenden Steuerung".
 * @param scaleUnit die Einheit des skalierten Werts, oder {@code null}: ein
 *                  Register ohne bekannte Skala bekommt NIE eine erfundene.
 * @param writesToday wie oft dieses Register auf diesem Gerät HEUTE schon
 *                  angefordert wurde (Berliner Tag) - EEPROM-Ehrlichkeit statt
 *                  einer Sperre.
 * @param lane      welches Ziel dieser Schritt gemeint hat.
 */
public record RegisterWriteOutcomeDto(String requestId, String mode, boolean ok, String outcome,
        Integer beforeRaw, Integer afterRaw, Double beforeScaled, Double afterScaled,
        Boolean adopted, String errorCode, String message, String targetLabel, int address,
        String addressHex, String registerLabel, String registerClass, String scaleNote,
        String registerNote, String scaleUnit, boolean noteRequired, String confirm,
        int writesToday, String lane, Instant at) {
}
