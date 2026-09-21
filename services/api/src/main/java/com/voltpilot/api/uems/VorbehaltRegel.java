package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * Der Vorbehalt der Bezugsseite aus Messwerten (UEMS AP-15 IP-13, Regel B4, Kasten W10, Matrixzeile A20, Fall R23) —
 * rein, Vektoren {@code docs/contracts/v2/vorbehalt-vectors.json}.
 *
 * <p>Eingang je Tag der Anlage ist der höchste BELEGTE Viertelstundenwert des Ungeregelten, den die Verbund-Bilanz
 * (IP-12) schon rechnet ({@link VerbundBilanzRegel.Urteil#hoechstes}) — eine unvollständige Viertelstunde zählt nicht,
 * ein Tag ohne belegte Viertelstunde ist kein Messtag. Gemessen = Höchstwert der letzten ≤ 12 Monate × 1,1,
 * AUFgerundet auf 0,1 kW (die sichere Seite, Rundungs-Lesart aus IP-2), nie unter 0.
 *
 * <p><b>Richtung.</b> Verlangt die Messung MEHR als den geltenden Vorbehalt, wird erhöht — das verengt nur und
 * geschieht selbsttätig, auch vor dem 30. Messtag (B4 „sobald die Messung sie verlangt“; ein kurzer Zeitraum
 * unterschätzt den Höchstwert, nie überschätzt er ihn). Verlangt sie WENIGER, bleibt es ein Vorschlag — und erst ab
 * 30 Messtagen; davor gilt der erklärte Wert weiter. Ohne geltenden Wert (unbekannt ist keine Null) gibt es nichts
 * zu erhöhen: ab 30 Messtagen ein Vorschlag.
 */
public final class VorbehaltRegel {

    /** Fassung der Regel; steht in jeder Zeile von {@code steuerungsverbund_vorbehalt}. */
    public static final String FASSUNG = "1";

    /** Zuschlag auf den Höchstwert (B4, A20). */
    public static final BigDecimal ZUSCHLAG = new BigDecimal("1.1");

    /** Ab so vielen Messtagen ersetzt die Messung den erklärten Wert (B4). */
    public static final int MINDEST_MESSTAGE = 30;

    /** Höchstens so viele Monate zurück (B4). */
    public static final int MONATE = 12;

    /** Was der Lauf tut. */
    public enum Aktion {
        ERHOEHEN("erhoehen"),
        VORSCHLAGEN("vorschlagen"),
        KEINE("keine");

        private final String code;

        Aktion(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Warum nichts geschieht — nur bei {@link Aktion#KEINE}. */
    public enum Grund {
        KEINE_MESSUNG("keine_messung"),
        ZU_WENIG_MESSUNG("zu_wenig_messung"),
        UNVERAENDERT("unveraendert");

        private final String code;

        Grund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Ein Tag der Anlage: höchster belegter Viertelstundenwert des Ungeregelten, {@code null} = kein Messtag. */
    public record Tag(LocalDate tag, BigDecimal hoechstesKw, Instant hoechstesVon) {}

    /**
     * Das Urteil. {@code neuKw} = gemessen (Höchstwert × 1,1 aufgerundet), leer ohne Messtag; {@code altKw} = der
     * geltende Wert, leer = unbekannt. Der Zeitraum sind Tage der Anlage, beide eingeschlossen.
     */
    public record Urteil(Aktion aktion, Grund grund, BigDecimal altKw, BigDecimal neuKw, BigDecimal hoechstwertKw,
            Instant hoechstwertVon, LocalDate zeitraumVon, LocalDate zeitraumBis, int messtage) {}

    private VorbehaltRegel() {}

    /** Der erste Tag des Zeitraums: heute vor zwölf Monaten; der letzte ist gestern. */
    public static LocalDate zeitraumVon(LocalDate heute) {
        return heute.minusMonths(MONATE);
    }

    /** Höchstwert × 1,1, aufgerundet auf 0,1 kW, nie unter 0. */
    public static BigDecimal gemessen(BigDecimal hoechstwertKw) {
        BigDecimal v = hoechstwertKw.multiply(ZUSCHLAG).setScale(1, RoundingMode.CEILING);
        return v.signum() < 0 ? BigDecimal.ZERO.setScale(1) : v;
    }

    /** Das Urteil über die Tage {@code tage} am Tag {@code heute} gegen den geltenden Vorbehalt {@code altKw}. */
    public static Urteil pruefen(BigDecimal altKw, List<Tag> tage, LocalDate heute) {
        LocalDate von = zeitraumVon(heute);
        LocalDate bis = heute.minusDays(1);
        int messtage = 0;
        Tag hoechster = null;
        for (Tag t : tage) {
            if (t.tag().isBefore(von) || t.tag().isAfter(bis) || t.hoechstesKw() == null) {
                continue;
            }
            messtage++;
            if (hoechster == null || t.hoechstesKw().compareTo(hoechster.hoechstesKw()) > 0
                    || (t.hoechstesKw().compareTo(hoechster.hoechstesKw()) == 0 && t.tag().isBefore(hoechster.tag()))) {
                hoechster = t;
            }
        }
        if (hoechster == null) {
            return new Urteil(Aktion.KEINE, Grund.KEINE_MESSUNG, altKw, null, null, null, von, bis, 0);
        }
        BigDecimal neu = gemessen(hoechster.hoechstesKw());
        Aktion aktion;
        Grund grund = null;
        if (altKw != null && neu.compareTo(altKw) > 0) {
            aktion = Aktion.ERHOEHEN;
        } else if (messtage < MINDEST_MESSTAGE) {
            aktion = Aktion.KEINE;
            grund = Grund.ZU_WENIG_MESSUNG;
        } else if (altKw == null || neu.compareTo(altKw) < 0) {
            aktion = Aktion.VORSCHLAGEN;
        } else {
            aktion = Aktion.KEINE;
            grund = Grund.UNVERAENDERT;
        }
        return new Urteil(aktion, grund, altKw, neu, hoechster.hoechstesKw(), hoechster.hoechstesVon(), von, bis,
                messtage);
    }
}
