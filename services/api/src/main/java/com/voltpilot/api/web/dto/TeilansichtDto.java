package com.voltpilot.api.web.dto;

/**
 * Das additive Feld {@code teilansicht} der Flotten-Antworten (UEMS AP-03 IP-10, Regel R-A2): über WIE VIELE
 * Standorte diese Antwort gebildet wurde und wie viele der Kundenbereich hat.
 *
 * <p><b>{@code gesamt} ist eine ANZAHL VON STANDORTEN — keine Energie- und keine Geldsumme.</b> Es ist die
 * einzige Zahl einer dieser Antworten, die über die sichtbare Menge hinausweist, und sie ist bewusst nur eine
 * Kardinalzahl: aus „3“ lässt sich kein fremder Verbrauch, kein fremder Erlös und kein fremder Name ableiten.
 * Jedes andere Feld — Liste wie Summe — entsteht ausschließlich über die {@code sichtbar} Standorte
 * (§6.2 Punkt 6: „kein Feld enthält eine Gesamtsumme, aus der sich ein fremder Standort ableiten ließe“).
 *
 * <p>Das Portal zeigt daraus „Teilansicht: {@code sichtbar} von {@code gesamt} Standorten“, sobald
 * {@code sichtbar < gesamt} — denselben Satz, den {@code GET /api/v1/me} aus dem Rechte-Vertrag bildet
 * ({@code RechteAbleitung.teilansicht}). Beide zählen Standorte OHNE archivierte, damit Kopfzeile und Antwort
 * nie Verschiedenes behaupten.
 *
 * <p>Ein Kundenbereich ohne Standorte antwortet {@code {0, 0}} — heute der Normalfall, solange keine Anlage
 * einem Standort zugeordnet ist. Ein unternehmensweiter Zugriff antwortet {@code sichtbar == gesamt}; daran
 * misst der Bestandsnachweis (W11), dass sich für einen Kundenadministrator nichts geändert hat.
 *
 * @param sichtbar die Standorte, über die diese Antwort gebildet wurde
 * @param gesamt die Standorte des Kundenbereichs
 */
public record TeilansichtDto(int sichtbar, int gesamt) {
}
