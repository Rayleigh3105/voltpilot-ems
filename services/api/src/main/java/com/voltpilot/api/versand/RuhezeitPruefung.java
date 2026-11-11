package com.voltpilot.api.versand;

import java.time.Instant;
import java.util.UUID;

/**
 * Ruhezeit und Stummschaltung beim Versand (Alerting Scheibe 3, Konzept §6.4): dieselbe Form wie
 * {@link UeberwachungSichtPruefung} - ein Interface in {@code versand}, damit {@link Zusteller} keine
 * Compile-Abhängigkeit auf das Paket {@code ueberwachung} trägt; Spring verdrahtet die echte
 * Implementierung automatisch über {@code @Autowired(required = false)}.
 *
 * <p>Nur für {@code quelle = "alarm"} relevant (Zusteller prüft das selbst, wie bei der Sicht-Prüfung);
 * andere Absender (Unterstützungs-Hinweise, die Bestätigungs-Mail selbst, die Tages-Zusammenfassung)
 * kennen keine Ruhezeit.
 */
public interface RuhezeitPruefung {

    /**
     * {@code jetzt}, wenn sofort gesendet werden darf; ein späterer Zeitpunkt (das Ende der Ruhezeit),
     * wenn die Zustellung erst dann nachgeholt wird (§6.4: "Warnung kommt am Ende der Ruhezeit nach,
     * falls noch aktiv"); {@link Instant#MAX}, wenn sie endgültig unterdrückt bleibt (Stummschaltung,
     * oder der Alarm ist inzwischen erledigt/gesehen und eine Erinnerung wäre sinnlos, Entscheid 3B).
     */
    Instant wannSenden(UUID alarmId, String empfaengerSub, String weg, String anlass, Instant jetzt);

    RuhezeitPruefung IMMER_SOFORT = (alarmId, sub, weg, anlass, jetzt) -> jetzt;
}
