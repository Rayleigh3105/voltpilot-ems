package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.List;

/**
 * Die Verbund-Bilanz als REINE Regel (UEMS AP-15 IP-12, Konzept §3.3, B3, B5, Matrixzeile A17): erklärt sich der
 * Netzpunkt aus den Boxen? Je Viertelstunde ist das UNGEREGELTE = Netzpunkt − Summe der Box-Beiträge (kW, Bezug
 * positiv, Einspeisung negativ). Ungeregelt ist nur, was keine Box steuert — Last, die der Vorbehalt deckt; ein
 * Erzeuger ist darin nicht vorgesehen. Liegt das Ungeregelte unter {@code −Toleranz}, speist am Netzpunkt mehr ein, als
 * die Boxen zusammen erklären: ein Erzeuger, den niemand eingetragen hat, oder ein verdrehtes Vorzeichen. Das ist
 * {@code unplausibel}. Vektoren: {@code docs/contracts/v2/verbund-bilanz-vectors.json}.
 *
 * <p><b>Unbekannt ist keine Null (B5).</b> Fehlt ein Term einer Viertelstunde oder ist er nicht vollständig, ist die
 * Viertelstunde {@code unbekannt} — nie {@code plausibel}. Der Tag ist {@code unplausibel}, sobald
 * {@link #MINDESTENS_UNPLAUSIBEL} Viertelstunden es belegt sind (eine belegte Abweichung bleibt belegt, auch neben
 * Lücken); sonst {@code unbekannt}, sobald eine Viertelstunde unbekannt ist; sonst {@code plausibel}.
 *
 * <p><b>Was die Regel NICHT prüft.</b> Die Obergrenze — Ungeregeltes über dem Vorbehalt — ist Befund A20 und gehört
 * IP-13 (selbsttätige Verengung, Alarm {@code GemeinsameSteuerungVorbehaltZuKlein}); sie ist keine falsch erklärte
 * Struktur. Und ein versteckter Erzeuger zeigt sich erst, wenn er mehr einspeist, als das Ungeregelte in derselben
 * Viertelstunde verbraucht — darum „innerhalb eines Tages mit Sonne“ (A17), nicht sofort.
 */
public final class VerbundBilanzRegel {

    /** Fassung der Regel; steht in der Grundlage jedes gespeicherten Ergebnisses. */
    public static final String FASSUNG = "1";

    public static final String PLAUSIBEL = "plausibel";
    public static final String UNPLAUSIBEL = "unplausibel";
    public static final String UNBEKANNT = "unbekannt";

    /** Die Zustände in der Reihenfolge der Metrik ({@code voltpilot_uems_verbund_bilanz_zustand}). */
    public static final List<String> ZUSTAENDE = List.of(PLAUSIBEL, UNPLAUSIBEL, UNBEKANNT);

    /**
     * Untergrenze der Toleranz in kW: dieselbe absolute Schwelle wie die Sprungprobe (R19 „max(10 %, 2 kW)“) — dort
     * zeigen dieselben Zähler einen Sprung, hier dieselben Zähler eine Summe.
     */
    public static final BigDecimal TOLERANZ_MIN_KW = new BigDecimal("2");

    /**
     * Anteil am Umsatz der Viertelstunde (|Netzpunkt| + Σ |Box-Beitrag|): 5 %. Das Konzept nennt für die Bilanz keine
     * Zahl; hergeleitet ist sie aus zwei Fehlern, die sich addieren können: (1) Messfehler zweier Zähler samt Wandler,
     * je Klasse 1 (MID B) ± 1 % plus Wandler 0,5–1 % → zusammen bis ≈ 3 % des Umsatzes; (2) Zeitversatz der
     * Viertelstunden zweier Boxen (Uhren, Sendetakt 10–60 s) — bei einer Rampe über die volle Leistung in der
     * Viertelstunde sind 30 s Versatz ≈ 3 % der Leistung, im Mittel über die Viertelstunde weniger. 5 % ist die
     * Hälfte der relativen Schwelle der Sprungprobe, weil hier Mittel über 15 min verglichen werden statt eines
     * 60-s-Sprungs.
     */
    public static final BigDecimal TOLERANZ_ANTEIL = new BigDecimal("0.05");

    /**
     * So viele unplausible Viertelstunden braucht ein Tag für {@code unplausibel}: zwei. Eine einzelne kann ein
     * Zählerfehler sein, den AP-08 nicht als solchen kennzeichnet (etwa ein einmaliger Sprung eines Zählerstands);
     * zwei am selben Tag sind ein Muster. Ein versteckter Erzeuger speist an einem Tag mit Sonne Stunden lang ein.
     */
    public static final int MINDESTENS_UNPLAUSIBEL = 2;

    /** Warum ein Tag {@code unbekannt} ist — in der Reihenfolge, in der ein Grund den anderen schlägt. */
    public enum Grund {
        /** Die Mitglieder haben sich im Lauf des Tages geändert — der Tag hat keine eine erklärte Struktur. */
        STRUKTUR_GEAENDERT("struktur_geaendert"),
        /** Die führende Box hat keinen Messpunkt mit Messstelle — ohne Netzpunkt gibt es keine Bilanz. */
        NETZPUNKT_OHNE_MESSSTELLE("netzpunkt_ohne_messstelle"),
        /** Ein Box-Beitrag hat keine Messstelle: Messpunkt ohne Messstelle oder ein Gerät der führenden Box ohne. */
        BOX_OHNE_MESSSTELLE("box_ohne_messstelle"),
        /** Eine Messstelle misst in beide Richtungen („Laden / Entladen“) oder richtungslos — kein Vorzeichen. */
        RICHTUNG_NICHT_EINDEUTIG("richtung_nicht_eindeutig"),
        /** Eine Viertelstunde eines Terms fehlt, ist unvollständig oder trägt einen Ersatzwert (B5). */
        LUECKE("luecke"),
        /** Genau eine Viertelstunde weicht ab, sonst ist alles belegt — das ist kein Muster und kein „plausibel“. */
        EINZELNE_ABWEICHUNG("einzelne_abweichung");

        private final String code;

        Grund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /**
     * Ein Term einer Viertelstunde: der Mittelwert in kW mit Vorzeichen (Bezug positiv), {@code null} = unbekannt.
     */
    public record Viertelstunde(Instant von, BigDecimal netzpunktKw, List<BigDecimal> boxKw) {}

    /** Das Urteil einer Viertelstunde; {@code ungeregeltKw}/{@code toleranzKw} nur, wenn sie belegt ist. */
    public record UrteilViertelstunde(Instant von, String zustand, BigDecimal ungeregeltKw, BigDecimal toleranzKw) {}

    /**
     * Das Urteil eines Tages. {@code grund} nur bei {@code unbekannt}; {@code geringstes} ist die belegte Viertelstunde
     * mit dem kleinsten Abstand Ungeregeltes + Toleranz — die, die {@code unplausibel} am deutlichsten zeigt.
     */
    public record Urteil(String zustand, String grund, int erwartet, int plausibel, int unplausibel, int unbekannt,
            UrteilViertelstunde geringstes) {}

    private VerbundBilanzRegel() {}

    /** Das Urteil einer Viertelstunde. */
    public static UrteilViertelstunde viertelstunde(Viertelstunde v) {
        if (v.netzpunktKw() == null || v.boxKw() == null || v.boxKw().stream().anyMatch(x -> x == null)) {
            return new UrteilViertelstunde(v.von(), UNBEKANNT, null, null);
        }
        BigDecimal summe = BigDecimal.ZERO;
        BigDecimal umsatz = v.netzpunktKw().abs();
        for (BigDecimal b : v.boxKw()) {
            summe = summe.add(b);
            umsatz = umsatz.add(b.abs());
        }
        BigDecimal ungeregelt = v.netzpunktKw().subtract(summe);
        BigDecimal toleranz = TOLERANZ_MIN_KW.max(umsatz.multiply(TOLERANZ_ANTEIL));
        String zustand = ungeregelt.compareTo(toleranz.negate()) < 0 ? UNPLAUSIBEL : PLAUSIBEL;
        return new UrteilViertelstunde(v.von(), zustand, kurz(ungeregelt), kurz(toleranz));
    }

    /**
     * Das Urteil eines Tages über {@code erwartet} Viertelstunden. Fehlt eine in {@code viertelstunden}, zählt sie als
     * unbekannt. {@code grundFest} ist ein Grund, der schon vor den Werten feststeht (etwa kein Netzpunkt) — dann ist
     * jede Viertelstunde unbekannt.
     */
    public static Urteil tag(int erwartet, List<Viertelstunde> viertelstunden, Grund grundFest) {
        if (erwartet <= 0) {
            throw new IllegalArgumentException("erwartet > 0");
        }
        if (grundFest != null) {
            return new Urteil(UNBEKANNT, grundFest.code(), erwartet, 0, 0, erwartet, null);
        }
        int plausibel = 0;
        int unplausibel = 0;
        UrteilViertelstunde geringstes = null;
        for (Viertelstunde v : viertelstunden) {
            UrteilViertelstunde u = viertelstunde(v);
            if (UNBEKANNT.equals(u.zustand())) {
                continue;
            }
            if (UNPLAUSIBEL.equals(u.zustand())) {
                unplausibel++;
            } else {
                plausibel++;
            }
            if (geringstes == null || abstand(u).compareTo(abstand(geringstes)) < 0) {
                geringstes = u;
            }
        }
        int unbekannt = erwartet - plausibel - unplausibel;
        if (unbekannt < 0) {
            throw new IllegalArgumentException("mehr Viertelstunden als erwartet");
        }
        if (unplausibel >= MINDESTENS_UNPLAUSIBEL) {
            return new Urteil(UNPLAUSIBEL, null, erwartet, plausibel, unplausibel, unbekannt, geringstes);
        }
        if (unbekannt > 0) {
            return new Urteil(UNBEKANNT, Grund.LUECKE.code(), erwartet, plausibel, unplausibel, unbekannt, geringstes);
        }
        if (unplausibel > 0) {
            // Eine einzelne Abweichung belegt nichts — und belegt auch nicht „plausibel“.
            return new Urteil(UNBEKANNT, Grund.EINZELNE_ABWEICHUNG.code(), erwartet, plausibel, unplausibel, 0,
                    geringstes);
        }
        return new Urteil(PLAUSIBEL, null, erwartet, plausibel, 0, 0, geringstes);
    }

    private static BigDecimal abstand(UrteilViertelstunde u) {
        return u.ungeregeltKw().add(u.toleranzKw());
    }

    /** Drei Nachkommastellen, wie die Viertelstunden-Mittel des Grenz-Nachweises. */
    static BigDecimal kurz(BigDecimal kw) {
        return kw.setScale(3, RoundingMode.HALF_UP).stripTrailingZeros();
    }
}
