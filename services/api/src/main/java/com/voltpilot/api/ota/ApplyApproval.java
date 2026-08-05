package com.voltpilot.api.ota;

import java.time.Duration;
import java.time.Instant;

/**
 * Die EINE Ableitung „was ist aus der erteilten Freigabe geworden" - rein, ohne
 * DB, ohne Broker, ohne Uhr aus der Umgebung ({@code now} wird übergeben). Das
 * ist dasselbe {@code RolloutStates}/{@code BakeGate}-Muster: eine Regel, die
 * eine Behauptung über eine Kundenanlage erzeugt, gehört an EINE Stelle und
 * wird Docker-frei festgenagelt.
 *
 * <h2>Warum das NICHT in {@link RolloutStates} steht</h2>
 * Die beiden beantworten verschiedene Fragen, und genau deshalb reisen sie
 * nebeneinander statt ineinander (dieselbe Begründung, aus der
 * {@code target_verdict} NEBEN {@code state} steht): {@link RolloutStates}
 * sagt, was mit dem GERÄT los ist, diese Klasse, was mit der FREIGABE los ist.
 * Ein Gerät kann „wartet auf Anwendung" sein, während gleichzeitig eine
 * Freigabe unterwegs, abgeholt oder verfallen ist - jede Vermischung würde
 * einen der beiden Sätze verschlucken.
 *
 * <h2>Die Ehrlichkeitsregel dieser Stufe</h2>
 * <b>Eine Freigabe, die niemand abgeholt hat, muss das SAGEN.</b> Der Umschlag
 * geht NICHT-retained hinaus (retained würde ihn bei jedem Reconnect erneut
 * zustellen - eine Einmal-Freigabe, die beliebig oft wieder erscheint, wäre
 * keine). Eine Box, die im Moment der Freigabe offline war, bekommt sie also
 * bewusst NICHT nachgeliefert: eine Zustimmung von vor drei Stunden ist keine
 * Zustimmung für jetzt. Ohne {@link #VERFALLEN} sähe genau dieser Fall aus wie
 * „läuft noch" - der Betreiber wartete auf etwas, das nie kommt.
 */
public final class ApplyApproval {

    /**
     * Das Fenster, in dem eine Freigabe gilt - der GLEICHE Wert wie
     * {@code otaapply.ApplyRequestWindow} auf dem Gerät (15 min).
     *
     * <p>Er ist hier eine ANZEIGE-Wahrheit, nie eine Durchsetzung: durchgesetzt
     * wird das Fenster ausschließlich auf dem Gerät. Liefen die beiden
     * auseinander, wäre höchstens die Aussage der Oberfläche zu früh oder zu
     * spät - nie das Verhalten der Anlage.
     */
    public static final Duration WINDOW = Duration.ofMinutes(15);

    /** Erteilt und im Fenster: die Box kann sie beim nächsten Takt aufgreifen. */
    public static final String ERTEILT = "erteilt";
    /**
     * Die Box hat sichtbar zu arbeiten begonnen ({@code applying}) oder läuft
     * bereits auf dem freigegebenen Stand - die Freigabe hat gewirkt.
     */
    public static final String ABGEHOLT = "abgeholt";
    /**
     * Das Fenster ist zu und nichts ist passiert. Der häufigste Grund ist eine
     * Box, die zum Zeitpunkt der Freigabe offline war - siehe Klassen-Doku.
     */
    public static final String VERFALLEN = "verfallen";

    /** Der Zustand plus sein Grund (jede nicht-grüne Zeile trägt ihren). */
    public record Verdict(String state, String reason) {
    }

    private ApplyApproval() {
    }

    /**
     * Was ist aus der Freigabe für {@code release} geworden?
     *
     * @param release      das freigegebene Release (der Stand, den der Mensch SAH)
     * @param requestedAt  wann die Freigabe hinausging
     * @param reportedState der {@code state} des Geräts aus dem Herzschlag
     * @param running      der laufende Stand des Geräts ({@code current}), falls gemeldet
     * @param now          jetzt
     * @return {@code null}, wenn es gar keine Freigabe gibt - dann sagt die
     *         Oberfläche nichts, statt einen Zustand zu erfinden
     */
    public static Verdict derive(String release, Instant requestedAt, String reportedState,
            String running, Instant now) {
        if (release == null || release.isBlank() || requestedAt == null) {
            return null;
        }
        // ABGEHOLT wird nur BELEGT behauptet, nie geglaubt: entweder die Box
        // meldet, dass sie gerade anwendet, oder sie läuft nachweislich auf dem
        // freigegebenen Stand. Den Token selbst sieht die Cloud nie - er lebt
        // ausschließlich zwischen Gerät und Sidecar, und das ist richtig so.
        if ("applying".equals(reportedState) || "rolling_back".equals(reportedState)) {
            return new Verdict(ABGEHOLT, "Das Gerät wendet gerade an.");
        }
        if (RolloutStates.releaseIsRunning(release, running)) {
            return new Verdict(ABGEHOLT, "Das Gerät läuft auf dem freigegebenen Stand.");
        }
        if (!now.isBefore(requestedAt.plus(WINDOW))) {
            return new Verdict(VERFALLEN,
                    "Die Freigabe ist abgelaufen, ohne dass das Gerät sie abgeholt hat - "
                            + "meist war es zu diesem Zeitpunkt offline. Sie gilt bewusst nicht "
                            + "nachträglich; geben Sie erneut frei, sobald das Gerät erreichbar "
                            + "ist.");
        }
        return new Verdict(ERTEILT,
                "Freigabe erteilt - das Gerät greift sie beim nächsten Takt auf.");
    }

    /**
     * Gilt die Freigabe gerade NOCH? Ausschließlich für die Frage „darf ein
     * zweites Mal freigegeben werden" - sie ist absichtlich ein reiner
     * Fenster-Test ohne Blick auf das Gerät.
     */
    public static boolean isOpen(Instant requestedAt, Instant now) {
        return requestedAt != null && now.isBefore(requestedAt.plus(WINDOW));
    }
}
