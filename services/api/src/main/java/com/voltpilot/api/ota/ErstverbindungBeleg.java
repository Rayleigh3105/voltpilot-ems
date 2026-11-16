package com.voltpilot.api.ota;

import java.time.Instant;

/**
 * Die Zeile „Beim ersten Verbinden" / „Beim Kunden" der Werkstatt-Seite (Erstverbindung S3, E7 = A): der Beleg
 * der Automatik, abgeleitet aus Journal und Box-Meldung - die Abnahme bleibt unverändert, sie belegt den Stand beim
 * Versand. Rein, ohne DB.
 *
 * <ul>
 *   <li>{@link #VORHER} - noch nicht verbunden: die Box holt sich beim ersten Verbinden die neueste Fassung selbst
 *       ({@code heute} = welche das heute wäre).</li>
 *   <li>{@link #PRUEFT}, {@link #LAEUFT} - verbunden, die Automatik entscheidet oder das Update läuft.</li>
 *   <li>{@link #FERTIG} - bestätigt, mit Fassung und Zeit.</li>
 *   <li>{@link #AKTUELL} - lief schon die neueste Fassung.</li>
 *   <li>{@link #NICHT} - nichts zugewiesen oder zurückgenommen, mit Grund (Stufe 1, Schalter aus, Fenster
 *       verstrichen, Grund der Box).</li>
 *   <li>{@code null} - verbunden, aber nicht von der Automatik (Bestandsbox oder Update von Hand).</li>
 * </ul>
 */
public final class ErstverbindungBeleg {

    public static final String VORHER = "vorher";
    public static final String PRUEFT = "prueft";
    public static final String LAEUFT = "laeuft";
    public static final String FERTIG = "fertig";
    public static final String AKTUELL = "aktuell";
    public static final String NICHT = "nicht";

    private ErstverbindungBeleg() {
    }

    /**
     * @param stand   eines der Wörter oben
     * @param release die Fassung (bei „vorher" die heutige neueste der Linie)
     * @param am      bestätigt am (fertig) bzw. zugewiesen am (läuft)
     * @param grund   bei „nicht" der Grund für den Betrieb
     */
    public record Beleg(String stand, String release, Instant am, String grund) {
    }

    /**
     * @param sicht           die Sicht der Box ({@link BoxUpdateSicht}); {@code null} = noch nicht verbunden
     * @param automatik       das letzte Ereignis der Automatik ohne die Zuweisung, {@code null} = keines
     * @param automatikDetail sein Detail (Fassung bei „aktuell", sonst der Grund)
     * @param boxGrund        der Grund, den die Box zu ihrem Update meldet
     * @param heute           die neueste Fassung der Linie heute ({@link NeuesteFassung}), {@code null} = keine
     */
    public static Beleg of(BoxUpdateSicht.Sicht sicht, String automatik, String automatikDetail, String boxGrund,
            String heute) {
        if (sicht == null) {
            return new Beleg(VORHER, heute, null, null);
        }
        return switch (sicht.phase()) {
            case BoxUpdateSicht.PRUEFT -> new Beleg(PRUEFT, null, sicht.seit(), null);
            case BoxUpdateSicht.LAEDT, BoxUpdateSicht.STARTET_NEU, BoxUpdateSicht.PRUEFT_BOX ->
                    new Beleg(LAEUFT, sicht.release(), sicht.seit(), null);
            case BoxUpdateSicht.FERTIG -> new Beleg(FERTIG, sicht.release(), sicht.fertigAm(), null);
            case BoxUpdateSicht.SPAETER -> new Beleg(NICHT, sicht.release(),
                    sicht.release() == null ? null : sicht.seit(),
                    Erstverbindung.EREIGNIS_AUFGEGEBEN.equals(automatik) ? automatikDetail : boxGrund);
            default -> {
                if (Erstverbindung.EREIGNIS_AKTUELL.equals(automatik)) {
                    yield new Beleg(AKTUELL, automatikDetail, null, null);
                }
                if (Erstverbindung.EREIGNIS_GESPERRT.equals(automatik) || Erstverbindung.EREIGNIS_AUS.equals(automatik)) {
                    yield new Beleg(NICHT, null, null, automatikDetail);
                }
                yield null;
            }
        };
    }
}
