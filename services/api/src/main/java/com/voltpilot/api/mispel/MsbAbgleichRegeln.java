package com.voltpilot.api.mispel;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Die Abweichungsampel Gerät gegen Messstellenbetreiber je Zähler, Richtung und Monat (MiSpeL MP-15, Bedienkonzept
 * BK-15 Variante A). Rein: ohne Spring, Datenbank, Uhr.
 *
 * <p>Abweichung = (Gerät − Messstellenbetreiber) ÷ Messstellenbetreiber; bis {@code gruenBis} grün, bis
 * {@code gelbBis} gelb, darüber rot. Grau „nicht vergleichbar“ bei fehlenden Werten, Lücke oder Zählerwechsel — nie
 * „passt“. Die Festlegung nennt keine Schwellen; 2 % und 5 % sind ein Vorschlag, den der Pilot (MP-47) bestätigt.
 * Die Ampel erklärt, sie ersetzt nichts: maßgeblich bleiben die Werte des Messstellenbetreibers (Tenor S. 28).
 */
public final class MsbAbgleichRegeln {

    public static final String GRUEN = "gruen";
    public static final String GELB = "gelb";
    public static final String ROT = "rot";
    public static final String GRAU = "grau";

    public static final String KEINE_MSB_WERTE = "keine_msb_werte";
    public static final String KEINE_GERAETEWERTE = "keine_geraetewerte";
    public static final String LUECKE = "luecke";
    public static final String ZAEHLERWECHSEL = "zaehlerwechsel";

    private static final BigDecimal HUNDERT = new BigDecimal("100");

    private MsbAbgleichRegeln() {}

    /** Die Schwellen in Prozent (Beträge der Abweichung, einschließlich). */
    public record Schwellen(BigDecimal gruenBisProzent, BigDecimal gelbBisProzent) {
        public Schwellen {
            if (gruenBisProzent == null || gelbBisProzent == null || gruenBisProzent.signum() < 0
                    || gelbBisProzent.compareTo(gruenBisProzent) < 0) {
                throw new IllegalArgumentException("Schwellen: 0 ≤ grün ≤ gelb verlangt.");
            }
        }
    }

    /** Was verglichen wurde: Summen über die Viertelstunden und wie viele es je Seite sind. */
    public record Eingang(int erwartet, int geraetViertelstunden, BigDecimal geraetKwh, int msbViertelstunden,
            BigDecimal msbKwh, boolean zaehlerwechsel) {}

    /**
     * Das Ergebnis: Summen, Unterschied in kWh und Prozent (eine Stelle, kaufmännisch), Ampel und bei Grau der Grund.
     * {@code null} = nicht bestimmbar, nie 0.
     */
    public record Ergebnis(BigDecimal geraetKwh, BigDecimal msbKwh, BigDecimal unterschiedKwh,
            BigDecimal abweichungProzent, String ampel, String grund) {}

    public static Ergebnis vergleichen(Eingang e, Schwellen s) {
        BigDecimal g = e.geraetViertelstunden() == 0 ? null : e.geraetKwh();
        BigDecimal m = e.msbViertelstunden() == 0 ? null : e.msbKwh();
        if (m == null) {
            return new Ergebnis(g, null, null, null, GRAU, KEINE_MSB_WERTE);
        }
        if (g == null) {
            return new Ergebnis(null, m, null, null, GRAU, KEINE_GERAETEWERTE);
        }
        if (e.zaehlerwechsel()) {
            return new Ergebnis(g, m, null, null, GRAU, ZAEHLERWECHSEL);
        }
        if (e.msbViertelstunden() < e.erwartet() || e.geraetViertelstunden() < e.erwartet()) {
            return new Ergebnis(g, m, null, null, GRAU, LUECKE);
        }
        BigDecimal u = g.subtract(m);
        if (m.signum() == 0) {
            return u.signum() == 0 ? new Ergebnis(g, m, u, BigDecimal.ZERO.setScale(1), GRUEN, null)
                    : new Ergebnis(g, m, u, null, ROT, null);
        }
        BigDecimal p = u.multiply(HUNDERT).divide(m, 12, RoundingMode.HALF_UP);
        BigDecimal betrag = p.abs();
        String ampel = betrag.compareTo(s.gruenBisProzent()) <= 0 ? GRUEN
                : betrag.compareTo(s.gelbBisProzent()) <= 0 ? GELB : ROT;
        return new Ergebnis(g, m, u, p.setScale(1, RoundingMode.HALF_UP), ampel, null);
    }
}
