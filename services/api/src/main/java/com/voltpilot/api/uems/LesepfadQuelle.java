package com.voltpilot.api.uems;

import java.time.Duration;
import java.time.Instant;

/**
 * Die QUELLENWAHL des Lesepfads (UEMS AP-07 IP-14, Report §4.3 „Speicherklassen und
 * Aufbewahrung", Abnahmefälle A2 und A7) — eine REINE Funktion, damit die Regel prüfbar ist,
 * ohne eine Datenbank zu fragen.
 *
 * <p><b>Der Mangel, den sie behebt.</b> Bis hierher antwortete der Verlauf für einen Zeitraum
 * jenseits der Rohdaten-Aufbewahrung mit einem Fehler („Für diesen Zeitraum sind keine echten
 * Rohdaten vorhanden.", HTTP 400) oder mit einer leeren Kurve — obwohl die Viertelstunden- und
 * Tageswerte der Speicherklassen (IP-12, IP-13) die Frage beantworten können. Ein Fehler auf
 * eine Frage, die wir beantworten können, ist der Mangel; {@code rawAvailable=false} plus
 * Werte ist die Antwort.
 *
 * <p><b>Die Regel in einem Satz:</b> die Speicherklassen sind ein RÜCKFALL, kein Ersatz. Der
 * bestehende Weg antwortet zuerst; erst wenn er für einen Zeitraum, der über die
 * Rohdaten-Frist hinausreicht, NICHTS hergibt, tritt die Speicherklasse an seine Stelle — und
 * die Antwort nennt IMMER, woraus sie gebildet ist.
 *
 * <p><b>Warum kein Zusammennähen.</b> Ein Zeitraum, der die Frist überschreitet, wird aus GENAU
 * EINER Quelle beantwortet. Zwei Quellen in einer Kurve hätten zwei Bedeutungen von „Wert" und
 * „Lücke" in derselben Linie; der Leser müsste raten, welchen Teil er gerade sieht. Statt zu
 * nähen nennt die Antwort die Frist ({@code rohGrenze}) und ihre Quelle.
 *
 * <p><b>Warum der Rückfall NICHT innerhalb der Frist greift.</b> Innerhalb der Frist ist die
 * Rohdaten-Antwort die Wahrheit: gibt es dort keinen Rohwert, gibt es auch keinen
 * Viertelstundenwert — er wird aus Rohwerten gebildet. Der bestehende Fehler sagt dort etwas
 * Wahres („Sie haben Rohwerte angefragt, Rohwerte werden noch aufbewahrt, es sind keine da")
 * und bleibt deshalb Zeichen für Zeichen stehen (Bestandsschutz der Kundenfläche).
 */
public final class LesepfadQuelle {

    private LesepfadQuelle() {
    }

    /** Woraus eine Antwort gebildet ist — das geschlossene Vokabular des Feldes {@code quelle}. */
    public enum Quelle {
        /** Rohwerte (die Original-Kadenz der Reihe) aus {@code device_measurement_sample}. */
        ROH("roh"),
        /** Die bestehende 5-Minuten-Verdichtung der Box. */
        ROLLUP_5M("rollup_5m"),
        /** Die bestehende 15-Minuten-Verdichtung der Box. */
        ROLLUP_15M("rollup_15m"),
        /** Die Speicherklasse Viertelstundenwerte, {@code messreihe_viertelstunde} (IP-12). */
        VIERTELSTUNDE("viertelstunde"),
        /** Die Speicherklasse Tageswerte, {@code messreihe_tag} (IP-13). */
        TAG("tag");

        private final String wort;

        Quelle(String wort) {
            this.wort = wort;
        }

        /** Das Wort, das in der Antwort und im Export steht. */
        public String wort() {
            return wort;
        }
    }

    /**
     * Die Grenze der Rohdaten-Aufbewahrung: {@code jetzt − 90 Tage} (Plan §1, in Code
     * {@code MeasurementRetention.RAW_DAYS}). Alles davor ist per Retention weg — nicht
     * „fehlt", sondern „wurde planmäßig gelöscht".
     */
    public static Instant rohGrenze(Instant jetzt, int rohTage) {
        return jetzt.minus(Duration.ofDays(rohTage));
    }

    /**
     * Reicht der angefragte Zeitraum über die Rohdaten-Frist hinaus? NUR dann darf der Rückfall
     * greifen und NUR dann verschwindet der 400er.
     */
    public static boolean jenseitsDerFrist(Instant von, Instant rohGrenze) {
        return von.isBefore(rohGrenze);
    }

    /**
     * Welche Speicherklasse trägt einen Zeitraum? Viertelstundenwerte bis einschließlich 90
     * Tage, darüber Tageswerte — dieselbe Grenze wie die Rohdaten-Frist, damit der Leser nur
     * EINE Zahl im Kopf behalten muss.
     *
     * <p>Sie ist auch eine Zeilen-Bremse: 90 Tage sind 8 640 Viertelstunden, ein Jahr wären
     * 35 040 — die Tagesklasse hält dieselbe Frage bei 366 Zeilen.
     */
    public static Quelle speicherklasse(Duration dauer, int rohTage) {
        return dauer.compareTo(Duration.ofDays(rohTage)) <= 0 ? Quelle.VIERTELSTUNDE : Quelle.TAG;
    }

    /**
     * Das Raster, in dem Viertelstundenwerte gezeichnet werden: nie feiner als die
     * Viertelstunde selbst (ein 5-Minuten-Raster über 15-Minuten-Werten wäre zu zwei Dritteln
     * leer und sähe aus wie eine Lücke) und nie so fein, dass die Antwort an der Zeilenbremse
     * abgeschnitten würde.
     *
     * @param dauer     die Länge des angefragten Zeitraums
     * @param mindestS  das feinste erlaubte Raster in Sekunden (900 für Viertelstundenwerte)
     * @param hoechstenZeilen die Zeilenbremse der Antwort
     */
    public static int raster(Duration dauer, int mindestS, int hoechstenZeilen) {
        long noetig = (dauer.getSeconds() + hoechstenZeilen - 1) / Math.max(1, hoechstenZeilen);
        long vielfache = (noetig + mindestS - 1) / mindestS;
        return (int) Math.max(1L, vielfache) * mindestS;
    }

    /**
     * Der Satz, der die Quelle benennt — Kundensprache, ohne internen Tabellennamen. Er steht
     * in der Antwort, damit keine Fläche ihn erfinden muss (Erklärbarkeit Stufe 0: eine Fläche,
     * die eine Ursache behauptet, braucht einen exportierten Fakt, der genau sie trägt).
     */
    public static String erklaerung(Quelle quelle, Instant rohGrenze) {
        return switch (quelle) {
            case ROH -> "Rohwerte in der Original-Häufigkeit der Messung.";
            case ROLLUP_5M -> "Verdichtete Werte je 5 Minuten.";
            case ROLLUP_15M -> "Verdichtete Werte je 15 Minuten.";
            case VIERTELSTUNDE -> "Viertelstundenwerte: Rohwerte werden 90 Tage aufbewahrt, für "
                    + "diesen Zeitraum sind sie nicht mehr verfügbar.";
            case TAG -> "Tageswerte: Rohwerte werden 90 Tage aufbewahrt, für diesen Zeitraum sind "
                    + "sie nicht mehr verfügbar.";
        };
    }
}
