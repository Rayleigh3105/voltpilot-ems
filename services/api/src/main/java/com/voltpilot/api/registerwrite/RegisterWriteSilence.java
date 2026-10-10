package com.voltpilot.api.registerwrite;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/**
 * WARUM nichts zurückkam - die drei unterscheidbaren Fälle des Schweigens
 * (Produktionsvorfall 20.08.2026, Auftrag 3).
 *
 * <p>Vorher trug jeder Ausgang denselben Satz („Die Anlage hat den Ist-Wert
 * nicht rechtzeitig gemeldet"), und der war in zwei von drei Fällen falsch: er
 * beschuldigte die ANLAGE, obwohl entweder die Cloud den Auftrag gar nicht
 * hinausbekam oder das Gerät sehr wohl geantwortet hatte, nur zu spät. Ein
 * pauschaler Satz über drei verschiedene Ursachen ist keine Auskunft, sondern
 * eine Vermutung - und er hat eine ganze Untersuchungsrunde gekostet.
 *
 * <p><b>Die drei Fälle und woran sie hängen:</b>
 * <ul>
 *   <li><b>(a) Die Cloud konnte nicht senden</b> - {@link #NOT_PUBLISHED}.
 *       Belegt durch die geworfene Ausnahme des Publishers; der Auftrag hat das
 *       Haus nie verlassen, also ist es AUSDRÜCKLICH nicht die Anlage.</li>
 *   <li><b>(b) Das Gerät hat nicht geantwortet</b> - und hier trennt die
 *       LEBENDIGKEIT noch einmal: ein Gerät, das sich seit Minuten gar nicht
 *       meldet, hat den Auftrag mit hoher Wahrscheinlichkeit nie gesehen; ein
 *       verbundenes Gerät schweigt aus einem anderen Grund (meist ist der Bus
 *       mit dem laufenden Auslesen belegt).</li>
 *   <li><b>(c) Die Antwort kam zu spät</b> - belegt durch eine VERSPÄTET
 *       zugestellte Quittung desselben Geräts
 *       ({@link RegisterWriteRegistry#lastLateAnswer}). Das ist der Fall, der
 *       den Vorfall ausgelöst hat, und der einzige, in dem „erneut versuchen"
 *       wirklich hilft.</li>
 * </ul>
 *
 * <p>Rein und ohne Uhr (jede zeitabhängige Funktion nimmt ihr {@code now}) -
 * das {@code Tagesprotokoll}/{@code FleetPflege}-Muster: jede Regel, die einem
 * Kunden einen Grund nennt, ist ohne einen einzigen Container prüfbar.
 */
public final class RegisterWriteSilence {

    private RegisterWriteSilence() {
    }

    /**
     * Das Fenster, ab dem ein Gerät als „meldet sich nicht" gilt - dieselben
     * fünf Minuten, mit denen das Portal überall Lebendigkeit beurteilt
     * (`deviceLiveStatus`), gemessen an {@code lastSeenAt}: Ankunft des
     * Status-Herzschlags, mit Telemetrie-Ankunft nur als Migrations-Fallback.
     */
    public static final Duration LIVE_WINDOW = Duration.ofMinutes(5);

    /** (a) Der Auftrag hat das Haus nie verlassen - ausdrücklich nicht die Anlage. */
    public static final String NOT_PUBLISHED =
            "Der Auftrag konnte nicht an die Anlage übergeben werden - das liegt an VoltPilot, "
                    + "nicht an Ihrer Anlage. Es wurde nichts gelesen und nichts geschrieben. "
                    + "Bitte in einem Moment erneut versuchen.";

    /**
     * Der Satz zum Schweigen NACH einem hinausgegangenen Auftrag.
     *
     * @param write      ob es der echte Schreibvorgang war - dann bleibt der
     *                   Zustand UNBEKANNT und der Satz sagt das (die
     *                   PR-280-Lehre: Schweigen ist nie „nicht geschrieben").
     * @param lastSeenAt wann sich das Gerät zuletzt bei VoltPilot gemeldet hat;
     *                   {@code null} = noch nie.
     * @param late       eine verspätet eingetroffene Quittung desselben Geräts,
     *                   falls es eine gab.
     */
    public static String message(boolean write, Instant lastSeenAt, Instant now,
            Duration budget, Optional<RegisterWriteRegistry.LateAnswer> late) {
        String tail = write
                ? " Der Zustand ist unbekannt - bitte den Ist-Wert erneut lesen, bevor Sie noch "
                        + "einmal schreiben."
                : "";
        // ⚠ DIE REIHENFOLGE IST EINE AUSSAGE, KEIN STIL: eine verspätet
        // eingetroffene Antwort ist der STÄRKERE Lebensbeweis als die
        // Herzschlag-Frische - sie kommt aus GENAU diesem Pfad, während
        // `lastSeenAt` eine andere Kette misst. Ein Gerät, das nachweislich
        // geantwortet hat, darf nie „meldet sich nicht" heißen; und nur hier
        // hilft „erneut versuchen" wirklich.
        if (late.isPresent()) {
            return "Die Anlage antwortet zurzeit langsamer, als das Zeitfenster von "
                    + seconds(budget) + " erlaubt - die vorige Anfrage traf "
                    + seconds(late.get().lateBy()) + " zu spät ein. Meist ist der "
                    + "Wechselrichter-Bus gerade mit dem laufenden Auslesen belegt. Bitte in "
                    + "einem Moment erneut versuchen." + tail;
        }
        if (lastSeenAt == null) {
            return "Dieses Gerät hat sich noch nie bei VoltPilot gemeldet. Der Auftrag ging "
                    + "hinaus, konnte dort aber niemanden erreichen." + tail;
        }
        Duration silent = Duration.between(lastSeenAt, now);
        if (silent.compareTo(LIVE_WINDOW) > 0) {
            return "Dieses Gerät meldet sich seit " + ago(silent) + " nicht mehr bei VoltPilot. "
                    + "Der Auftrag ging hinaus, wurde dort aber sehr wahrscheinlich nicht "
                    + "empfangen." + tail;
        }
        return "Das Gerät ist verbunden, hat aber innerhalb von " + seconds(budget)
                + " nicht geantwortet. Meist ist der Wechselrichter-Bus gerade mit dem "
                + "laufenden Auslesen belegt. Bitte erneut versuchen." + tail;
    }

    /**
     * „12 Sekunden" / „3 Minuten" / „2 Stunden" - nie eine Nachkommastelle.
     *
     * <p>⚠ Unter einer Sekunde wird nicht auf „0 Sekunden" gerundet: das ist ein
     * ERREICHBARER Fall (eine Quittung, die Sekundenbruchteile nach dem Aufgeben
     * eintrifft), und „traf 0 Sekunden zu spät ein" sagt genau nichts.
     */
    static String seconds(Duration d) {
        long s = Math.max(0, d.toSeconds());
        if (s == 0 && d.toMillis() > 0) {
            return "weniger als eine Sekunde";
        }
        if (s < 90) {
            return s + (s == 1 ? " Sekunde" : " Sekunden");
        }
        long m = Math.round(s / 60.0);
        if (m < 90) {
            return m + (m == 1 ? " Minute" : " Minuten");
        }
        long h = Math.round(m / 60.0);
        return h + (h == 1 ? " Stunde" : " Stunden");
    }

    private static String ago(Duration d) {
        return seconds(d);
    }
}
