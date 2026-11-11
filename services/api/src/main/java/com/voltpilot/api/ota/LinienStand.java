package com.voltpilot.api.ota;

import java.util.List;
import java.util.Set;

/**
 * Wo eine Box in ihrer Software-Linie steht - EIN Wort je Box, aus dem die
 * Linien-Karte ihren Flottenbalken und die Box-Liste ihr Urteil bildet
 * (Geräte &amp; Updates G1). Jede Box steht in genau einer Gruppe.
 *
 * <p>Die Reihenfolge der Prüfung ist die Aussage:
 * <ol>
 *   <li><b>hand</b> - Edge Light mit Stufe 1: nimmt keine Updates aus dem
 *       Portal an. Das ist kein Fehler und überdeckt alles andere, denn der
 *       nächste Schritt ist immer das Nachrüsten.</li>
 *   <li><b>fehler</b> - fehlgeschlagen, zurückgenommen oder im Update
 *       verstummt. Ein gemeldeter Endzustand gilt auch, wenn die Box danach
 *       still wurde.</li>
 *   <li><b>offline</b> - kein Lebenszeichen im Online-Fenster (die EINE Uhr,
 *       {@link RolloutStates#offline}). Was eine stumme Box zuletzt gemeldet
 *       hat, ist nicht aktuell - auch nicht „neuestes".</li>
 *   <li><b>laeuft</b> - eine Anfrage ist unterwegs (ausstehend, lädt, wendet
 *       an, Selbsttest).</li>
 *   <li><b>gehalten</b> - die Box hält die Anfrage selbst zurück (Sperre,
 *       zurückgestellt); der Grund kommt von ihr.</li>
 *   <li><b>aktuell</b> / <b>aelter</b> - auf dem neuesten Release der Linie
 *       oder auf einem älteren ({@link EdgeStandVerdict}).</li>
 *   <li><b>unbekannt</b> - kein Stand, der in der Linie bewertbar ist (nichts
 *       gemeldet, oder ein Stand, den das Register nicht führt). Nie „älter".</li>
 * </ol>
 */
public final class LinienStand {

    public static final String HAND = "hand";
    public static final String FEHLER = "fehler";
    public static final String OFFLINE = "offline";
    public static final String LAEUFT = "laeuft";
    public static final String GEHALTEN = "gehalten";
    public static final String AKTUELL = "aktuell";
    public static final String AELTER = "aelter";
    public static final String UNBEKANNT = "unbekannt";

    /** Die feste Reihenfolge des Flottenbalkens (jede Gruppe genau einmal). */
    public static final List<String> REIHENFOLGE =
            List.of(AKTUELL, LAEUFT, GEHALTEN, AELTER, FEHLER, OFFLINE, HAND, UNBEKANNT);

    private static final Set<String> FEHLER_ZUSTAENDE = Set.of(RolloutStates.FEHLGESCHLAGEN,
            RolloutStates.ZURUECKGEROLLT, RolloutStates.IM_UPDATE_VERSTUMMT);
    private static final Set<String> LAUF_ZUSTAENDE = Set.of(RolloutStates.AUSSTEHEND,
            RolloutStates.LAEDT, RolloutStates.WENDET_AN, RolloutStates.SELBSTTEST);
    private static final Set<String> HALTE_ZUSTAENDE = Set.of(RolloutStates.BLOCKIERT,
            RolloutStates.ZURUECKGESTELLT);

    private LinienStand() {
    }

    /**
     * @param linie    die Linie der Box ({@link BoxArt#DOCKER}/{@link BoxArt#LIGHT}, {@code null} = unbekannt)
     * @param stufe1   Edge Light ohne gekreuztes Vertrauen ({@link BoxArt#vertrauenGekreuzt})
     * @param zustand  der abgeleitete Zustand ({@link RolloutStates#derive})
     * @param offline  kein Lebenszeichen im Online-Fenster
     * @param upToDate das Urteil an der Linie ({@link EdgeStandVerdict.Verdict#upToDate})
     */
    public static String of(String linie, boolean stufe1, String zustand, boolean offline,
            Boolean upToDate) {
        if (BoxArt.LIGHT.equals(linie) && stufe1) {
            return HAND;
        }
        if (zustand != null && FEHLER_ZUSTAENDE.contains(zustand)) {
            return FEHLER;
        }
        if (offline) {
            return OFFLINE;
        }
        if (zustand != null && LAUF_ZUSTAENDE.contains(zustand)) {
            return LAEUFT;
        }
        if (zustand != null && HALTE_ZUSTAENDE.contains(zustand)) {
            return GEHALTEN;
        }
        if (Boolean.TRUE.equals(upToDate)) {
            return AKTUELL;
        }
        if (Boolean.FALSE.equals(upToDate)) {
            return AELTER;
        }
        return UNBEKANNT;
    }
}
