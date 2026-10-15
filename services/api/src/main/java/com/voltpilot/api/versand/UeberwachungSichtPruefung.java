package com.voltpilot.api.versand;

import java.time.Instant;
import java.util.UUID;

/**
 * Die Sicht-Prüfung je Empfänger beim Versand (Alerting Scheibe 1, Konzept vp-alerting-konzept-m1
 * §6.6): "Der Läufer hat keinen Zugriffs-Kontext... Darum prüft der Zusteller je Empfänger, Bezug
 * und Zeitpunkt mit der reinen Funktion {@code RechteAbleitung.darf}". {@link Zusteller} ruft dies
 * nur für {@code quelle = "alarm"} auf - Scheibe 0 (Unterstützungs-Hinweise) kennt keine Sicht-Prüfung.
 *
 * <p>Liegt in {@code versand}, nicht in {@code ueberwachung}: der Zusteller (Scheibe 0) soll die
 * Überwachung (Scheibe 1) nicht als Compile-Abhängigkeit tragen - Spring verdrahtet die echte
 * Implementierung ({@code ueberwachung.UeberwachungSichtPruefungImpl}) automatisch.
 * {@link #IMMER_SICHTBAR} ist der No-Op für Dienste ohne Spring-Kontext (Unit-Tests bestehender
 * Konstruktoren) - dasselbe Muster wie {@link BenachrichtigungAusgang#STUMM}.
 */
public interface UeberwachungSichtPruefung {

    /** Darf {@code empfaengerSub} den Wert dieses Alarms zum Zeitpunkt {@code jetzt} sehen? */
    boolean sichtbar(UUID alarmId, String empfaengerSub, Instant jetzt);

    UeberwachungSichtPruefung IMMER_SICHTBAR = (alarmId, sub, jetzt) -> true;
}
