package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Der Zustellstand einer Meldung (Kunden-Alarmierung P4, Konzept §6.1 Nr. 7 und §6.2): was mit ihr an DIE PERSON ging,
 * die fragt - aus dem Versand-Protokoll {@code benachrichtigung} gelesen, nie geschätzt. Das Portal macht daraus
 * „Gemeldet: E-Mail 12:34 · Push 12:34“ oder ehrlich „Nicht gesendet: Ruhezeit / kein Weg / beruhigt“.
 *
 * <p>{@code still} nennt einen Grund, aus dem die Meldung GAR NICHT hinausging (für niemanden): {@code probelauf},
 * {@code abhaengig} (sie steht unter der Meldung ihrer Box, {@code stillDurch} ist deren Kennzeichen) oder
 * {@code heute_schon} (ein Hinweis, der heute schon einmal gemeldet wurde, KA-4 B). Sonst {@code null}.
 *
 * <p>{@code wege} sind die Zeilen des Protokolls für diese Person: je Weg ({@code email}, {@code webpush},
 * {@code webhook}, {@code telegram}) und Anlass ({@code ausgeloest}, {@code wieder_normal}, {@code erinnerung}) der
 * Zustand ({@code wartet}, {@code gesendet}, {@code fehlgeschlagen}, {@code unterdrueckt}), der Grund
 * ({@code kein_weg}, {@code stumm}, {@code keine_sicht}, {@code vor_dem_weg}, {@code beruhigt}) und die Zeit
 * ({@code am}: gesendet um, wartet bis, sonst eingereiht um) und die Zahl der Versuche ({@code versuche > 0} bei
 * {@code wartet} heißt: ein Versuch scheiterte, der nächste folgt). Keine Zeile heißt: an diese Person ging nichts.
 */
public record ZustellstandDto(String meldungId, String still, String stillDurch, List<Weg> wege) {

    public record Weg(String weg, String anlass, String zustand, String grund, Instant am, int versuche) {}

    public record Liste(List<ZustellstandDto> zustellungen) {}
}
