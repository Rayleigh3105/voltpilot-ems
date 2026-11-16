package com.voltpilot.api.ota;

import java.time.Duration;
import java.time.Instant;

/**
 * Was Kunde und Installateur über das Update ihrer Box sehen (Erstverbindung S2,
 * E4 = B: der Verbinden-Weg wartet, bis das Update fertig ist) - rein, ohne DB
 * (das {@link RolloutStates}-Muster).
 *
 * <p>Die Station „Software" im Verbinden-Weg kennt sieben Phasen:
 * <ul>
 *   <li>{@link #KEINS} - kein Update fällig: Bestandsbox, schon aktuell, Stufe 1,
 *       Schalter aus. Die Station ist sofort erledigt.</li>
 *   <li>{@link #PRUEFT} - die Box hat sich gerade zum ersten Mal gemeldet, die
 *       Automatik hat noch nicht entschieden.</li>
 *   <li>{@link #LAEDT}, {@link #STARTET_NEU}, {@link #PRUEFT_BOX} - das Update der
 *       Automatik läuft.</li>
 *   <li>{@link #FERTIG} - die Box hat die neue Fassung bestätigt.</li>
 *   <li>{@link #SPAETER} - zurückgenommen, fehlgeschlagen, zurückgestellt oder
 *       nicht zugewiesen: die Box läuft auf ihrem Stand weiter, VoltPilot
 *       kümmert sich („Braucht dich").</li>
 * </ul>
 *
 * <p>Getrennt davon {@link Sicht#updateLaeuft()}: läuft auf der Box irgendein
 * Update (auch eines von Hand), das sie gleich neu starten lässt? Dann wartet
 * die Gerätesuche, sonst ginge ihr Auftrag im Neustart verloren.
 *
 * <p>Der Kunde sieht nie einen technischen Grund; den hat der Betrieb.
 */
public final class BoxUpdateSicht {

    public static final String KEINS = "keins";
    public static final String PRUEFT = "prueft";
    public static final String LAEDT = "laedt";
    public static final String STARTET_NEU = "startet_neu";
    public static final String PRUEFT_BOX = "prueft_box";
    public static final String FERTIG = "fertig";
    public static final String SPAETER = "spaeter";

    /**
     * Wie lange eine Zuweisung, auf die die Box noch nicht reagiert hat, als
     * „läuft gleich" gilt: Probezeit 10 Minuten plus Rand, dieselbe Obergrenze
     * wie im Verbinden-Weg.
     */
    public static final Duration OBERGRENZE = Duration.ofMinutes(12);

    private BoxUpdateSicht() {
    }

    /** Die aktuelle Zuweisung der Box ({@code device_update_target}). */
    public record Ziel(String release, String von, Instant am) {
    }

    /**
     * Die Sicht.
     *
     * @param phase        eine der Phasen oben
     * @param release      die Fassung des Updates der Automatik (auch bei „fertig"),
     *                     bei „keins" die laufende, wenn die Automatik sie als aktuell befand
     * @param seit         seit wann die Phase läuft: erste Meldung (prüft) oder Zuweisung
     * @param fertigAm     wann die Box die neue Fassung bestätigt hat
     * @param updateLaeuft irgendein Update startet die Box gleich neu
     */
    public record Sicht(String phase, String release, Instant seit, Instant fertigAm,
            boolean updateLaeuft) {
    }

    /**
     * @param ziel         die Zuweisung der Box, {@code null} = keine
     * @param automatik    das Journal-Ereignis der Automatik zu dieser Box
     *                     ({@link Erstverbindung#EREIGNIS_AKTUELL} …), {@code null} = keines
     * @param automatikRelease die Fassung zum Ereignis (bei „aktuell")
     * @param ersteMeldung die erste Meldung dieser Gerätezeile, {@code null} = vor der Regel
     * @param gemeldet     was die Box meldet, {@code null} = noch nichts
     * @param laeuftSeit   seit wann der laufende Stand läuft ({@code current_since})
     */
    public static Sicht of(Ziel ziel, String automatik, String automatikRelease, Instant ersteMeldung,
            RolloutStates.Reported gemeldet, Instant laeuftSeit, Instant now) {
        RolloutStates.Verdict v = ziel == null ? null : RolloutStates.derive(ziel.release(), gemeldet, now);
        boolean updateLaeuft = v != null && laeuft(v.state(), ziel.am(), now);
        if (ziel != null && Erstverbindung.URHEBER.equals(ziel.von())) {
            String phase = switch (v.state()) {
                case RolloutStates.BESTAETIGT, RolloutStates.AKTUELL -> FERTIG;
                case RolloutStates.FEHLGESCHLAGEN, RolloutStates.ZURUECKGEROLLT,
                        RolloutStates.ZURUECKGESTELLT, RolloutStates.BLOCKIERT -> SPAETER;
                case RolloutStates.WENDET_AN, RolloutStates.IM_UPDATE_VERSTUMMT -> STARTET_NEU;
                case RolloutStates.SELBSTTEST -> PRUEFT_BOX;
                default -> LAEDT;
            };
            Instant fertigAm = FERTIG.equals(phase) ? laeuftSeit : null;
            return new Sicht(phase, ziel.release(), ziel.am(), fertigAm, updateLaeuft);
        }
        if (Erstverbindung.EREIGNIS_AUFGEGEBEN.equals(automatik)) {
            return new Sicht(SPAETER, null, ersteMeldung, null, updateLaeuft);
        }
        if (automatik != null || ziel != null || ersteMeldung == null
                || now.isAfter(ersteMeldung.plus(Erstverbindung.NACHLAUF))) {
            String release = Erstverbindung.EREIGNIS_AKTUELL.equals(automatik) ? automatikRelease : null;
            return new Sicht(KEINS, release, null, null, updateLaeuft);
        }
        return new Sicht(PRUEFT, null, ersteMeldung, null, false);
    }

    /**
     * Läuft ein Update, das die Box gleich neu starten lässt? Gemeldet lädt sie,
     * wendet an oder prüft sich; oder die Zuweisung ist jünger als
     * {@link #OBERGRENZE} und die Box hat noch nicht reagiert. Eine stehende
     * Sperre, ein Endzustand oder eine erreichte Fassung zählen nicht.
     */
    static boolean laeuft(String state, Instant zugewiesenAm, Instant now) {
        return switch (state) {
            case RolloutStates.LAEDT, RolloutStates.WENDET_AN, RolloutStates.SELBSTTEST -> true;
            case RolloutStates.AUSSTEHEND, RolloutStates.OFFLINE_HOLT_NACH ->
                    zugewiesenAm != null && !now.isAfter(zugewiesenAm.plus(OBERGRENZE));
            default -> false;
        };
    }
}
