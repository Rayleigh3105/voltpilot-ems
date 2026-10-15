package com.voltpilot.api.web.dto;

import java.time.Instant;

/**
 * "Was diese Regel in den letzten {@code fensterTage} Tagen gemeldet hätte" (Alerting Scheibe 2,
 * Konzept §6.4, §6.8 Entwurf 1) - die Vorschau im Blatt, bevor eine Person "Überwachung starten"
 * tippt. {@code zuletzt} ist {@code null}, wenn die Regel in diesem Fenster nie ausgelöst hätte.
 */
public record ProbelaufDto(long fensterTage, int ausgeloest, Instant zuletzt, long gesamtdauerS) {
}
