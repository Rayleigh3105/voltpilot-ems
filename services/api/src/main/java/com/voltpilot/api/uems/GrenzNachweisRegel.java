package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Der Grenz-Nachweis am Netzanschluss (UEMS AP-15 IP-31, NW-8, M-1, B5, W10): aus der Mess-Welt je Richtung das
 * höchste Viertelstunden-Mittel gegen die an seinem Tag wirksame Grenze, die Viertelstunden darüber und die
 * zusammenhängenden Überschreitungen („Unterbrechungen“) mit Dauer und Höchstwert.
 *
 * <p><b>Eine Lücke ist kein sauberer Wert (B5):</b> nur eine VOLLSTÄNDIGE Viertelstunde belegt etwas. Eine
 * unvollständige, eine mit Ersatzwert oder eine fehlende macht den Zeitraum „nicht belegt“ — nie „eingehalten“. Eine
 * belegte Überschreitung bleibt „überschritten“, auch wenn daneben Viertelstunden fehlen. Gleich der Grenze ist
 * eingehalten. Eine Unterbrechung endet an jeder Viertelstunde, die nicht belegt darüber liegt — über eine Lücke
 * hinweg wird nichts verbunden.
 *
 * <p>Rein: ohne Spring, ohne DB, ohne Uhr. Vektoren: {@code docs/contracts/v2/netzanschluss-grenznachweis-vectors.json}
 * ({@code GrenzNachweisVectorsTest}). Gerechnet, nie gespeichert — keine Migration.
 */
public final class GrenzNachweisRegel {

    public static final String EINGEHALTEN = "eingehalten";
    public static final String UEBERSCHRITTEN = "ueberschritten";
    public static final String NICHT_BELEGT = "nicht_belegt";

    /** Warum nicht geprüft wird: an keinem Tag des Zeitraums eine Grenze in dieser Richtung. */
    public static final String KEINE_GRENZE = "keine_grenze";
    /** Eine Grenze gilt, aber an keinem ihrer Tage misst genau ein Hauptzähler dieser Richtung. */
    public static final String KEIN_HAUPTZAEHLER = "kein_hauptzaehler";
    /** Der Zeitraum hat noch keinen abgeschlossenen Tag (der laufende Monat am 1., ein künftiger Monat). */
    public static final String KEIN_ABGESCHLOSSENER_TAG = "kein_abgeschlossener_tag";

    /** M-2: die Mess-Welt hält je Viertelstunde Mittel, Min und Max, aber keine Dauer über einer Schwelle. */
    public static final String AUGENBLICK_NICHT_GEMESSEN = "nicht_gemessen";

    private GrenzNachweisRegel() {}

    /**
     * Eine Viertelstunde des Zeitraums: die an ihrem Tag wirksame Grenze ({@code null} = keine), ob genau ein
     * Hauptzähler dieser Richtung misst, der Zustand ihres Werts (Wort des Ergebnis-Zustands-Vertrags, {@code null},
     * wenn kein Wert gebildet ist) und ihr Mittel in kW ({@code null} = unbekannt, nie 0).
     */
    public record Viertelstunde(Instant von, Instant bis, BigDecimal grenzeKw, boolean hauptzaehler, String zustand,
            BigDecimal mittelKw) {

        boolean belegt() {
            return hauptzaehler && ErgebnisZustand.VOLLSTAENDIG.equals(zustand) && mittelKw != null;
        }

        boolean unvollstaendig() {
            return hauptzaehler && (ErgebnisZustand.UNVOLLSTAENDIG.equals(zustand)
                    || ErgebnisZustand.MIT_ERSATZWERT.equals(zustand));
        }

        boolean darueber() {
            return belegt() && mittelKw.compareTo(grenzeKw) > 0;
        }
    }

    /** Die Viertelstunde mit dem höchsten Mittel gegen ihre Grenze (größtes Mittel − Grenze; gleich: die frühere). */
    public record Hoechstes(Instant von, Instant bis, BigDecimal mittelKw, BigDecimal grenzeKw, BigDecimal abstandKw) {}

    /** Zusammenhängende belegte Viertelstunden über der Grenze. */
    public record Unterbrechung(Instant von, Instant bis, long minuten, BigDecimal hoechstwertKw, BigDecimal grenzeKw) {}

    /**
     * Das Urteil einer Richtung. {@code urteil} und die Zahlen stehen nur, wenn {@code grenzeGeprueft}; sonst sagt
     * {@code grund}, warum nicht. {@code belegtProzent} wird abgerundet — 100 nur, wenn nichts fehlt.
     */
    public record Urteil(boolean grenzeGeprueft, String grund, String urteil, int erwartet, int belegt,
            int unvollstaendig, int fehlend, Integer belegtProzent, Hoechstes hoechstes, int viertelstundenDarueber,
            long minutenDarueber, List<Unterbrechung> unterbrechungen) {}

    public static Urteil nachweis(List<Viertelstunde> viertelstunden) {
        List<Viertelstunde> mitGrenze = viertelstunden.stream().filter(v -> v.grenzeKw() != null).toList();
        if (mitGrenze.isEmpty()) {
            return nicht(KEINE_GRENZE);
        }
        if (mitGrenze.stream().noneMatch(Viertelstunde::hauptzaehler)) {
            return nicht(KEIN_HAUPTZAEHLER);
        }
        int belegt = 0;
        int unvollstaendig = 0;
        int fehlend = 0;
        int darueber = 0;
        long sekundenDarueber = 0;
        Hoechstes hoechstes = null;
        List<Unterbrechung> unterbrechungen = new ArrayList<>();
        Viertelstunde laufendVon = null;
        Viertelstunde laufendBis = null;
        Viertelstunde laufendSpitze = null;
        for (Viertelstunde v : mitGrenze) {
            if (v.belegt()) {
                belegt++;
                BigDecimal abstand = v.mittelKw().subtract(v.grenzeKw());
                if (hoechstes == null || abstand.compareTo(hoechstes.abstandKw()) > 0) {
                    hoechstes = new Hoechstes(v.von(), v.bis(), v.mittelKw(), v.grenzeKw(), abstand);
                }
            } else if (v.unvollstaendig()) {
                unvollstaendig++;
            } else {
                fehlend++;
            }
            if (v.darueber()) {
                darueber++;
                sekundenDarueber += Duration.between(v.von(), v.bis()).toSeconds();
                if (laufendBis != null && laufendBis.bis().equals(v.von())) {
                    laufendBis = v;
                    if (v.mittelKw().compareTo(laufendSpitze.mittelKw()) > 0) {
                        laufendSpitze = v;
                    }
                } else {
                    abschliessen(unterbrechungen, laufendVon, laufendBis, laufendSpitze);
                    laufendVon = v;
                    laufendBis = v;
                    laufendSpitze = v;
                }
            } else {
                abschliessen(unterbrechungen, laufendVon, laufendBis, laufendSpitze);
                laufendVon = null;
                laufendBis = null;
                laufendSpitze = null;
            }
        }
        abschliessen(unterbrechungen, laufendVon, laufendBis, laufendSpitze);
        int erwartet = mitGrenze.size();
        String urteil = darueber > 0 ? UEBERSCHRITTEN : belegt < erwartet ? NICHT_BELEGT : EINGEHALTEN;
        return new Urteil(true, null, urteil, erwartet, belegt, unvollstaendig, fehlend, belegt * 100 / erwartet,
                hoechstes, darueber, sekundenDarueber / 60, List.copyOf(unterbrechungen));
    }

    /** Ohne abgeschlossenen Tag gibt es nichts zu prüfen — auch wenn Grenze und Hauptzähler vorliegen. */
    public static Urteil ohneAbgeschlossenenTag() {
        return nicht(KEIN_ABGESCHLOSSENER_TAG);
    }

    private static Urteil nicht(String grund) {
        return new Urteil(false, grund, null, 0, 0, 0, 0, null, null, 0, 0, List.of());
    }

    private static void abschliessen(List<Unterbrechung> out, Viertelstunde von, Viertelstunde bis,
            Viertelstunde spitze) {
        if (von == null) {
            return;
        }
        long minuten = Duration.between(von.von(), bis.bis()).toSeconds() / 60;
        out.add(new Unterbrechung(von.von(), bis.bis(), minuten, spitze.mittelKw(), spitze.grenzeKw()));
    }

    /** Das Viertelstunden-Mittel in kW aus einer Menge in kWh über die Dauer der Viertelstunde (kWh ≠ kW). */
    public static BigDecimal mittelAusMenge(BigDecimal mengeKwh, Instant von, Instant bis) {
        if (mengeKwh == null) {
            return null;
        }
        long sekunden = Duration.between(von, bis).toSeconds();
        if (sekunden <= 0) {
            return null;
        }
        return kurz(mengeKwh.multiply(BigDecimal.valueOf(3600)).divide(BigDecimal.valueOf(sekunden),
                Math.max(mengeKwh.scale(), 0) + 4, RoundingMode.HALF_EVEN));
    }

    /** {@code 100.0000} wird {@code 100} (nie {@code 1E+2}) — die Zahl, die gemeint ist. */
    public static BigDecimal kurz(BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        BigDecimal k = wert.stripTrailingZeros();
        return k.scale() < 0 ? k.setScale(0) : k;
    }
}
