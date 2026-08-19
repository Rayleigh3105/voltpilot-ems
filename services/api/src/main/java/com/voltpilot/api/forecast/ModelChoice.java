package com.voltpilot.api.forecast;

import java.time.Instant;

/**
 * EINE gespeicherte Umstellung des aktiven Prognosemodells - der aktuelle Stand
 * einer Prognoseart, samt Papier-Spur.
 *
 * <p>Sie ist der gemeinsame Zeilen-Typ der ZWEI append-only Journale, die sich
 * die Präzedenz teilen: {@code forecast_model_choice} (die PLATTFORM-Vorgabe,
 * global, admin-only - Migration V20260825000000) und
 * {@code site_forecast_model_choice} (die Wahl EINER Anlage, mandantengebunden,
 * vom Kunden selbst - Migration V20260826000000). Ein gemeinsamer Typ, weil
 * beide dieselbe Frage beantworten und {@link ForecastModelService} sie in
 * EINER Auflösung zusammenführt; zwei identische Records wären zwei Wahrheiten
 * über dieselbe Zeilenform.
 */
public record ModelChoice(
        /** 'load' | 'pv'. */
        String kind,
        /** Die Modell-Id, die seit dieser Zeile plant. */
        String model,
        /** Das abgelöste Modell; {@code null} = die erste Umstellung. */
        String previousModel,
        /** Das JWT-Subject des Umstellers - die maschinenstabile Identität. */
        String setBy,
        /** Der Anzeige-Name; {@code null} = nicht im Token. */
        String setByName,
        Instant setAt) {
}
