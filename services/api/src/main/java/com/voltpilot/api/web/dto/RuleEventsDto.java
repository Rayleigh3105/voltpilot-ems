package com.voltpilot.api.web.dto;

import java.time.Instant;
import java.util.List;

/**
 * Das REGEL-PROTOKOLL einer Anlage (Einheitsmodell Stufe 5b, Teil 5b.6) - EINE
 * Antwort für die drei Flächen, die es zeigen: die Zähler-Zeile an der Karte,
 * der Ausschnitt im Detail-Einschub und das kompakte Gesamt-Protokoll.
 *
 * <p><b>{@code recordingSince} ist der Grund, warum eine 0 nicht gelogen ist.</b>
 * Ohne ihn wüsste keine Fläche, ob „heute 0× geschaltet" heißt „nichts
 * passiert" oder „wir haben erst vor zehn Minuten angefangen hinzusehen". Ist
 * er jünger als der heutige Berliner Tagesbeginn, sagt die Fläche „seit HH:MM
 * aufgezeichnet" STATT eines Zählers; {@code null} heißt, dass für diese
 * Anlage noch gar nicht aufgezeichnet wurde.
 *
 * <p><b>{@code countsToday} beantwortet dieselbe Frage für eine Regel OHNE
 * jedes Ereignis.</b> Sie taucht in {@code rules} gar nicht auf (es gibt nichts
 * zu gruppieren), und ohne dieses Flag könnte die Fläche „noch nie geschaltet"
 * nicht von „wir haben noch nicht hingesehen" unterscheiden - sie müsste den
 * Berliner Tagesbeginn selbst nachrechnen und hätte damit einen ZWILLING der
 * Server-Regel. Es gibt sie genau einmal, hier.
 *
 * <p><b>Die Genauigkeit steht AN der Fläche, nicht im Kleingedruckten:</b> die
 * Ereignisse werden aus WECHSELN im 15-Sekunden-Herzschlag abgeleitet, sind
 * also auf etwa diesen Takt genau und blind für ein Wechsel-und-zurück
 * dazwischen ({@code accuracySeconds}). Der Präzisions-Uplink der
 * Arbitrierungs-Ereignisse (Stufe 5b-2) hebt das später additiv, ohne die
 * Fläche zu ändern.
 */
public record RuleEventsDto(Instant recordingSince, int accuracySeconds, boolean countsToday,
        List<RuleActivityDto> rules, List<RuleEventDto> events) {

    /**
     * Die Zähler EINER Regel. {@code ruleKind}/{@code ruleRef} sind der
     * Schnappschuss der Zuordnung ({@code rezept} = die Komponenten-Id,
     * {@code flow} = die Flow-Id) - die Fläche bildet daraus ihren Kartenschlüssel.
     *
     * <p>{@code switchedToday} zählt STARTS („3× geschaltet" heißt: es lief
     * dreimal), {@code lastSwitchedAt} ist der jüngste Schaltvorgang in BEIDE
     * Richtungen (Start oder Stopp) - das ist die Frage „wann hat sich zuletzt
     * etwas bewegt".
     *
     * <p><b>{@code switchedToday} ist NULLABLE, und das ist die ganze
     * Ehrlichkeit dieser Stufe:</b> {@code null} heißt „der Speicher hat den
     * heutigen Tag nicht vollständig gesehen" (er zeichnet erst seit heute
     * auf), und die Fläche sagt dann „seit HH:MM aufgezeichnet" statt einer 0.
     * Die Entscheidung fällt EINSEITIG hier im Backend - das Portal konsumiert
     * sie und kann den Zähler damit gar nicht erfinden (das
     * {@code RolloutStates}-Muster).
     */
    public record RuleActivityDto(String ruleKind, String ruleRef, Integer switchedToday,
            Instant lastSwitchedAt) {
    }

    /**
     * Ein einzelner Wechsel. {@code state}/{@code previousState}/{@code reasonCode}
     * sind unverändert die GEMELDETEN Wörter (der Ingest hat unbekannte längst
     * verworfen); {@code actualKw} ist {@code null}, wenn im Moment des
     * Wechsels nichts gemessen wurde - nie eine erfundene 0.
     */
    public record RuleEventDto(long id, String ruleKind, String ruleRef, String entityId,
            String kind, String state, String previousState, String reasonCode, Double actualKw,
            String detail, Instant occurredAt) {
    }
}
