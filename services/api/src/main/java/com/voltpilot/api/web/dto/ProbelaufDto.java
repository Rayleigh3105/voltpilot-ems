package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * "Was diese Regel in den letzten {@code fensterTage} Tagen gemeldet hätte" (Alerting Scheibe 2,
 * Konzept §6.4, §6.8 Entwurf 1) - die Vorschau im Blatt, bevor eine Person "Überwachung starten"
 * tippt. {@code zuletzt} ist {@code null}, wenn die Regel in diesem Fenster nie ausgelöst hätte.
 *
 * <p>{@code moeglich} (Kunden-Alarmierung P0): {@code false}, wenn die Rückschau für diesen Wert keinen einzigen
 * bekannten Messpunkt hat - für Börsenpreis und Ladepunkte gibt es keine Reihe, und eine Anlage ohne Daten hat keine.
 * Dann sind {@code ausgeloest = 0} und {@code zuletzt = null} KEINE Aussage („hätte nicht ausgelöst“), sondern
 * „keine Vorschau möglich“; unbekannt ist keine Null.
 */
public record ProbelaufDto(long fensterTage, int ausgeloest, Instant zuletzt, long gesamtdauerS, boolean moeglich) {
}
