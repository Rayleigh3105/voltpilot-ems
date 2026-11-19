package com.voltpilot.api.ota;

import java.time.Duration;
import java.time.Instant;

/**
 * Die Regel „neueste Software beim ersten Verbinden" (Konzept
 * vp-erstverbindung-update, Entscheid des Captains 16.11.2026: E1 = A, E2 = B,
 * E3 = A) - rein, ohne DB, ohne Broker, ohne Uhr aus der Umgebung (das
 * {@link RolloutStates}-Muster).
 *
 * <p><b>Die Regel:</b> Bei der ersten Meldung einer neu verbundenen,
 * update-fähigen Box ({@link BoxArt#sperrgrund} ohne Grund) weist die Plattform
 * ihr die neueste zuweisbare Fassung ihrer Linie zu - welche das ist, sagt die
 * gemeinsame Regel {@link RolloutService#neuesteFassung} (signiert, höchste
 * {@code release_seq}, bei Edge Light alle Programme geprüft im Portal; ob schon
 * eine andere Box sie bestätigt hat, spielt keine Rolle, E2 = B), dieselbe, nach
 * der die Werkstatt aufspielt. Die Regel hier bekommt ihr Ergebnis als
 * {@link Neueste} und bleibt rein.
 *
 * <ul>
 *   <li><b>Neu verbunden</b> heißt: Die erste Meldung dieser Gerätezeile ist
 *       jünger als {@link #FENSTER}, und die Box hatte nie eine Zuweisung. So
 *       greift die Regel nur bei neuen Verbindungen, nie rückwirkend für die
 *       Flotte.</li>
 *   <li>Ist die neueste Fassung noch nicht zuweisbar (die Programme laden noch
 *       hoch), nimmt die Regel nicht die vorige, sondern wartet auf den nächsten
 *       Takt, bis {@link #FENSTER} nach der ersten Meldung; danach gibt sie mit
 *       Grund auf.</li>
 *   <li>Läuft die Box schon diese oder eine neuere Fassung, ist nichts fällig.</li>
 *   <li>Stufe 1, eine Box anderer Art, ein beendeter Kundenbereich: nichts, mit
 *       Grund.</li>
 *   <li>Der Schalter des Betriebs ({@link Schalter}) hält die Automatik je Linie
 *       oder ganz an.</li>
 *   <li>Läuft für die Referenz der Box gerade ein Fernlauf durch den
 *       Wartungstunnel ({@code vp-update-vor-zuordnung}, S3 §4.6), wartet die
 *       Regel, bis er ein Ergebnis hat - kein Wettlauf zwischen Tunnel- und
 *       Cloud-Update; danach entscheidet sie wie sonst.</li>
 * </ul>
 *
 * <p>Was danach geschieht, ist der vorhandene Update-Weg, unverändert: die
 * Zuweisung geht über {@link RolloutService#createRollout} mit dem Urheber
 * {@link #URHEBER}, die Box prüft Signatur, lädt, probt mit Selbsttest und nimmt
 * bei einem Fehler zurück. Jede Entscheidung außer „warten" steht einmal im
 * Journal ({@code rollout_event}, Akteur {@link #URHEBER}); danach ist die Box
 * für die Regel erledigt.
 */
public final class Erstverbindung {

    /** Der Akteur im Journal; das Portal zeigt „Automatik · erstes Verbinden". */
    public static final String URHEBER = "erstverbindung";

    /** Wie lange nach der ersten Meldung die Regel noch zuweist. */
    public static final Duration FENSTER = Duration.ofHours(1);

    /**
     * Bis wann der Wächter eine Box noch ansieht: lang genug, dass eine Box, die
     * im Fenster nicht entschieden wurde (Takt ausgefallen), ihren Grund noch ins
     * Journal bekommt.
     */
    public static final Duration NACHLAUF = FENSTER.multipliedBy(2);

    /** Journal-Ereignis: die Box läuft schon die neueste Fassung ihrer Linie. */
    public static final String EREIGNIS_AKTUELL = "erstverbindung_aktuell";
    /** Journal-Ereignis: die Box bekommt nichts (Stufe 1, andere Art, …), mit Grund. */
    public static final String EREIGNIS_GESPERRT = "erstverbindung_gesperrt";
    /** Journal-Ereignis: der Schalter des Betriebs steht auf aus. */
    public static final String EREIGNIS_AUS = "erstverbindung_aus";
    /** Journal-Ereignis: im Fenster ging nichts zuzuweisen, mit Grund. */
    public static final String EREIGNIS_AUFGEGEBEN = "erstverbindung_aufgegeben";
    /** Journal-Ereignis: jemand hat den Schalter umgelegt (Akteur = Mensch). */
    public static final String EREIGNIS_SCHALTER = "erstverbindung_schalter";

    public static final String GRUND_KEINE_FASSUNG =
            "Für diese Linie liegt keine signierte Fassung im Register.";
    public static final String GRUND_ART_UNBEKANNT =
            "Die Box hat noch nicht gemeldet, ob sie eine Docker-Box oder Edge Light ist.";
    public static final String GRUND_FENSTER =
            "Die erste Stunde nach der ersten Meldung ist verstrichen, bevor zugewiesen werden konnte.";
    public static final String GRUND_FERNLAUF =
            "Für diese Box läuft gerade ein Fernlauf durch den Wartungstunnel.";

    private Erstverbindung() {
    }

    /** Was die Regel mit einer Box tut. */
    public enum Art {
        /** Nicht neu verbunden, hatte schon eine Zuweisung, oder schon entschieden. */
        NICHTS,
        /** Zuweisen: {@link Urteil#releaseSeq()}. */
        ZUWEISEN,
        /** Nichts fällig: läuft schon die neueste Fassung. */
        AKTUELL,
        /** Bekommt nichts, mit Grund. */
        GESPERRT,
        /** Schalter aus. */
        AUS,
        /** Im nächsten Takt erneut versuchen, kein Journal. */
        WARTEN,
        /** Fenster verstrichen, mit Grund. */
        AUFGEBEN
    }

    /**
     * Das Urteil: {@code releaseSeq}/{@code release} beim Zuweisen (bei
     * {@link Art#AKTUELL} die laufende Fassung, soweit bekannt), {@code grund}
     * bei Sperre, Warten, Aufgeben und Aus.
     */
    public record Urteil(Art art, Long releaseSeq, String release, String grund) {

        static Urteil nur(Art art) {
            return new Urteil(art, null, null, null);
        }

        static Urteil mitGrund(Art art, String grund) {
            return new Urteil(art, null, null, grund);
        }
    }

    /**
     * Eine Box, wie der Wächter sie sieht.
     *
     * @param boxArt            {@link BoxArt#ofDevice} ({@code null} = unbekannt)
     * @param vertrauenGekreuzt Wurzel und geprüftes Vertrauens-Set gemeldet
     * @param loader            gemeldeter Loader-Stand ({@code null} = keine Angabe)
     * @param istSeq            das Register-Release ihrer Linie, das sie fährt ({@code null} = keines bekannt)
     * @param istRelease        sein Name
     * @param ersteMeldung      erste Meldung dieser Gerätezeile ({@code null} = vor der Regel)
     * @param hatteZuweisung    die Box hat oder hatte je eine Zuweisung
     * @param entschieden       die Regel hat für diese Box schon entschieden (Journal)
     * @param beendet           ihr Kundenbereich ist beendet
     * @param fernlaufOffen     für ihre Referenz läuft gerade ein Fernlauf durch den Wartungstunnel (S3 §4.6)
     */
    public record Box(String boxArt, boolean vertrauenGekreuzt, String loader, Long istSeq, String istRelease,
            Instant ersteMeldung, boolean hatteZuweisung, boolean entschieden, boolean beendet,
            boolean fernlaufOffen) {
    }

    /**
     * Die neueste signierte Fassung der Linie der Box ({@link RolloutService#neuesteFassung}).
     *
     * @param nichtZuweisbar warum sie heute noch nicht zuweisbar ist, sonst {@code null}
     */
    public record Neueste(long releaseSeq, String version, String nichtZuweisbar) {
    }

    /** Der Schalter des Betriebs; ohne Eintrag an. */
    public record Schalter(boolean alle, boolean docker, boolean light) {

        public static final Schalter AN = new Schalter(true, true, true);

        /** Ist die Automatik für diese Linie an? {@code null} = Linie unbekannt, nur der globale. */
        public boolean an(String linie) {
            if (!alle) {
                return false;
            }
            if (BoxArt.DOCKER.equals(linie)) {
                return docker;
            }
            if (BoxArt.LIGHT.equals(linie)) {
                return light;
            }
            return true;
        }
    }

    /**
     * @param neueste die neueste signierte Fassung der Linie der Box, {@code null} = keine (oder Linie unbekannt)
     */
    public static Urteil of(Box box, Neueste neueste, Schalter schalter, Instant now) {
        if (box.ersteMeldung() == null || box.hatteZuweisung() || box.entschieden()
                || now.isAfter(box.ersteMeldung().plus(NACHLAUF))) {
            return Urteil.nur(Art.NICHTS);
        }
        boolean imFenster = !now.isAfter(box.ersteMeldung().plus(FENSTER));
        if (box.fernlaufOffen()) {
            return warten(imFenster, GRUND_FERNLAUF);
        }
        String linie = box.boxArt();
        if (!schalter.an(linie)) {
            return Urteil.mitGrund(Art.AUS, schalter.alle()
                    ? "Die Automatik ist für " + linieName(linie) + " abgeschaltet."
                    : "Die Automatik ist abgeschaltet.");
        }
        if (box.beendet()) {
            return Urteil.mitGrund(Art.GESPERRT, UpdateEignung.GRUND_BEENDET);
        }
        if (linie == null) {
            return warten(imFenster, GRUND_ART_UNBEKANNT);
        }
        String sperre = BoxArt.sperrgrund(linie, linie, box.vertrauenGekreuzt(), box.loader());
        if (sperre != null) {
            return Urteil.mitGrund(Art.GESPERRT, sperre);
        }
        if (neueste == null) {
            return Urteil.mitGrund(Art.GESPERRT, GRUND_KEINE_FASSUNG);
        }
        if (box.istSeq() != null && box.istSeq() >= neueste.releaseSeq()) {
            return new Urteil(Art.AKTUELL, box.istSeq(), box.istRelease(), null);
        }
        if (neueste.nichtZuweisbar() != null) {
            return warten(imFenster, neueste.nichtZuweisbar());
        }
        if (!imFenster) {
            return Urteil.mitGrund(Art.AUFGEBEN, GRUND_FENSTER);
        }
        return new Urteil(Art.ZUWEISEN, neueste.releaseSeq(), neueste.version(), null);
    }

    private static Urteil warten(boolean imFenster, String grund) {
        return Urteil.mitGrund(imFenster ? Art.WARTEN : Art.AUFGEBEN, grund);
    }

    /** Die Linie in Worten, wie die Seite sie nennt. */
    public static String linieName(String linie) {
        if (BoxArt.DOCKER.equals(linie)) {
            return "Docker-Boxen";
        }
        if (BoxArt.LIGHT.equals(linie)) {
            return "Edge Light";
        }
        return "Boxen unbekannter Art";
    }
}
