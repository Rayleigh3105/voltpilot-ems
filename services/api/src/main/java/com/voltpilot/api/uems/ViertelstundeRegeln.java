package com.voltpilot.api.uems;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Die REINEN Regeln der Speicherklasse Viertelstundenwerte (UEMS AP-07 IP-12, Captain-Entscheide
 * E5/E6/E7 vom 10.09.2026).
 *
 * <p><b>Rein.</b> Kein Spring, keine Datenbank, keine Uhr — was gilt, entscheidet sich hier; wer es
 * liest und schreibt, steht in {@link ViertelstundeVerdichter}.
 *
 * <p><b>Was hier NICHT steht: die fachlichen Rechenregeln.</b> Menge aus Zählerständen, Rücksprung,
 * Ersatzwerte und Zeitumstellung sind AP-08 und liegen seit dem Verbrauchsvertrag als
 * {@link VerbrauchRegeln} vor. Der Verdichter RUFT sie auf. AP-07 legt fest, WAS gespeichert wird
 * und WANN es endgültig ist — das ist alles, was diese Klasse beantwortet.
 */
public final class ViertelstundeRegeln {

    private ViertelstundeRegeln() {}

    /** Die Länge eines Intervalls: 15 Minuten im UTC-Raster (§4.5 Nr. 1). */
    public static final Duration LAENGE = Duration.ofMinutes(15);

    /** E5: vorläufig bis 7 Tage nach INTERVALLENDE, danach endgültig. */
    public static final Duration FRIST = Duration.ofDays(7);

    public static final String VORLAEUFIG = "vorlaeufig";
    public static final String ENDGUELTIG = "endgueltig";

    /** Die Zustellarten des Intervalls (§4.4 „Nachlieferung"). */
    public static final String DIREKT = "direkt";
    public static final String NACHGELIEFERT = "nachgeliefert";
    public static final String GEMISCHT = "gemischt";

    /** Die fünf Ereignisarten, die §4.4 je Intervall zählt. */
    public static final List<String> GEZAEHLTE_EREIGNISSE = List.of(
            "data_gap", "counter_reset", "device_boundary", "handover", "duplicate_conflict");

    // ------------------------------------------------------------------ Raster

    /** Der Beginn des Intervalls, in dem {@code t} liegt — abgerundet auf das UTC-Raster. */
    public static Instant beginn(Instant t) {
        long s = Math.floorDiv(t.getEpochSecond(), LAENGE.toSeconds()) * LAENGE.toSeconds();
        return Instant.ofEpochSecond(s);
    }

    /** Das Ende des Intervalls, das bei {@code beginn} anfängt — zugleich der Beginn des nächsten. */
    public static Instant ende(Instant beginn) {
        return beginn.plus(LAENGE);
    }

    /** E5, wörtlich: 7 Tage nach dem Intervallende. */
    public static Instant endgueltigAb(Instant beginn) {
        return ende(beginn).plus(FRIST);
    }

    // ----------------------------------------------------------------- Wertart

    /**
     * Die Regel-Wortwahl von AP-08 zur Wertart von AP-07 (E12). Es gibt genau diese Brücke, und
     * sie steht an EINER Stelle:
     *
     * <ul>
     *   <li>{@code counter} → {@code zaehlerstand} (Z1–Z9): Stand am Anfang und am Ende;
     *   <li>{@code gauge} → {@code momentanwert} (M1–M6): Mittel, Minimum, Maximum;
     *   <li>{@code state}, {@code bitfield}, {@code text} → <b>keine</b> Regel: eine Zustandsreihe
     *       hat keine Menge und kein Mittel; gespeichert werden erster und letzter Wert, die
     *       Qualitätszähler und die Abdeckung.
     * </ul>
     *
     * <p><b>⚠ Befund:</b> AP-08 kennt eine dritte Wertart, {@code intervallmenge} (I1–I5) — das
     * AP-07-Vokabular der Rohwerte ({@code device_measurement_sample.value_kind}, IP-6) hat dafür
     * KEIN Wort. Heute entsteht also keine Reihe, die so verdichtet würde; die Spalte {@code summe}
     * steht bereit und der Weg dorthin ({@link VerbrauchRegeln#mengeIntervall}) ist verdrahtet,
     * sobald das Vokabular das Wort bekommt. Nichts wird geraten: eine Zählerreihe wird nie als
     * Intervallmenge gelesen.
     */
    public static String regelWort(String wertart) {
        if (wertart == null) {
            return null;
        }
        return switch (wertart) {
            case "counter" -> "zaehlerstand";
            case "gauge" -> "momentanwert";
            case "intervallmenge" -> "intervallmenge";
            default -> null;
        };
    }

    /** Trägt die Reihe Zahlen (und damit eine Regel von AP-08)? */
    public static boolean rechenbar(String wertart) {
        return regelWort(wertart) != null;
    }

    // ------------------------------------------------------------------- Anker

    /**
     * Ein Anker über die guten Werte eines Intervalls (§4.4 „Herkunfts-Anker"): der erste, der
     * zweite — und die ZAHL der weiteren.
     *
     * <p>Zwei Anker zu nennen und einen dritten zu verschweigen wäre eine Lüge durch Auslassen;
     * darum zählt {@code weitere}, was über die zwei hinaus vorkam. Zwei sind der Normalfall
     * (A5: Zählerwechsel im Intervall; A6: Box-Übergabe im Intervall), drei sind kein physischer
     * Fall — aber wenn doch, steht es da.
     *
     * @param erster der erste Anker in Messzeit-Reihenfolge, {@code null} wenn keiner
     * @param zweiter der zweite VERSCHIEDENE Anker, {@code null} wenn es keinen gibt
     * @param weitere wie viele verschiedene Anker es darüber hinaus gab
     */
    public record Anker<T>(T erster, T zweiter, int weitere) {

        public static <T> Anker<T> keiner() {
            return new Anker<>(null, null, 0);
        }
    }

    /**
     * Die verschiedenen Anker einer nach Messzeit geordneten Folge, Reihenfolge erhalten,
     * {@code null}-Einträge übersprungen (ein Wert ohne Einbau ist kein Einbau-Wechsel).
     */
    public static <T> Anker<T> anker(List<T> folge) {
        List<T> verschieden = new ArrayList<>();
        for (T x : folge) {
            if (x != null && verschieden.stream().noneMatch(y -> Objects.equals(y, x))) {
                verschieden.add(x);
            }
        }
        return switch (verschieden.size()) {
            case 0 -> Anker.keiner();
            case 1 -> new Anker<>(verschieden.get(0), null, 0);
            default -> new Anker<>(verschieden.get(0), verschieden.get(1), verschieden.size() - 2);
        };
    }

    // -------------------------------------------------------------- Zustellart

    /**
     * Die Zustellart des Intervalls aus den Zustellarten seiner Rohwerte: alle direkt → direkt,
     * alle nachgeliefert → nachgeliefert, beides → gemischt. {@code null}, wenn KEIN Wert eine
     * Zustellart trägt — das ist der Bestand vor IP-7, und {@code null} heißt dort „nicht
     * nachgeschlagen", nie „direkt".
     */
    public static String zustellart(List<String> arten) {
        boolean direkt = arten.contains(DIREKT);
        boolean nach = arten.contains(NACHGELIEFERT);
        if (direkt && nach) {
            return GEMISCHT;
        }
        if (direkt) {
            return DIREKT;
        }
        return nach ? NACHGELIEFERT : null;
    }
}
