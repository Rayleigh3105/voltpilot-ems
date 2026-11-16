package com.voltpilot.api.ota;

import java.util.Comparator;
import java.util.List;

/**
 * Die EINE Regel „welche ist die neueste Fassung einer Linie, die eine Box heute
 * bekommen kann?" - rein, ohne DB (das {@link RolloutStates}-Muster). Die
 * Automatik beim ersten Verbinden ({@link Erstverbindung}) nutzt sie, und jeder
 * andere Weg, der „immer die neueste" meint (etwa die Werkstatt), soll sie
 * nutzen statt einer zweiten Fassung derselben Regel. Das Register dazu liefert
 * {@link RolloutService#register()}, das fertige Urteil je Linie
 * {@link RolloutService#neuesteZuweisbare(String)}.
 *
 * <p><b>Die Regel</b> (Konzept vp-erstverbindung-update, Abschnitt 10.1):
 * <ul>
 *   <li>Gezählt wird nur ein SIGNIERTES Release (Manifest und Signatur): ein
 *       unsigniertes kann keine Box bekommen (N4).</li>
 *   <li>Die Linie ist die Box-Art des Releases ({@link BoxArt#ofRelease}).</li>
 *   <li>Die neueste ist die mit der höchsten {@code release_seq}; ob eine Box sie
 *       schon bestätigt hat, spielt keine Rolle (E2 = B).</li>
 *   <li>Ist die neueste noch nicht zuweisbar (bei Edge Light liegen die
 *       Programme noch nicht vollständig im Portal), gilt NICHT die vorige: das
 *       Urteil nennt die neueste und den Grund, und der Aufrufer wartet.</li>
 * </ul>
 */
public final class NeuesteFassung {

    public static final String GRUND_KEINE_FASSUNG =
            "Für diese Linie liegt keine signierte Fassung im Register.";

    private NeuesteFassung() {
    }

    /**
     * Ein Release des Registers.
     *
     * @param boxArt         die Linie ({@link BoxArt#DOCKER}, {@link BoxArt#LIGHT})
     * @param nichtZuweisbar warum es gerade noch nicht zuweisbar ist (Edge Light:
     *                       Programme fehlen im Portal), sonst {@code null}
     */
    public record Release(long releaseSeq, String version, String boxArt, boolean signiert,
            String nichtZuweisbar) {
    }

    /**
     * Das Urteil für eine Linie.
     *
     * @param release die neueste signierte Fassung, {@code null} = keine
     * @param grund   warum (noch) nichts zuzuweisen ist, sonst {@code null}
     */
    public record Urteil(Release release, String grund) {

        /** Heute zuweisbar: es gibt eine neueste Fassung, und nichts spricht dagegen. */
        public boolean zuweisbar() {
            return release != null && grund == null;
        }
    }

    public static Urteil of(List<Release> register, String linie) {
        Release neueste = register.stream()
                .filter(r -> r.signiert() && r.boxArt() != null && r.boxArt().equals(linie))
                .max(Comparator.comparingLong(Release::releaseSeq)).orElse(null);
        if (neueste == null) {
            return new Urteil(null, GRUND_KEINE_FASSUNG);
        }
        return new Urteil(neueste, neueste.nichtZuweisbar());
    }
}
