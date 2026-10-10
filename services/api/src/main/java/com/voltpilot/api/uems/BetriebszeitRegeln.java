package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/** AP-16 E9: ein Gauge gilt höchstens eine Messkadenz; fehlende Zeit ist niemals Stillstand. */
public final class BetriebszeitRegeln {
    private BetriebszeitRegeln() {}
    public record Leistung(Instant zeit, BigDecimal kw, boolean gut) {}
    public record Schwelle(Instant von, Instant bis, BigDecimal kw) {}
    public record Ergebnis(BigDecimal betrag, String zustand, BigDecimal abdeckungProzent, List<String> kennzeichen,
            BigDecimal betriebsSekunden, BigDecimal gemesseneSekunden) {}

    public static String kennzeichen(BigDecimal kw) {
        return "aus Leistung über " + kw.stripTrailingZeros().toPlainString().replace('.', ',') + " kW (Annahme)";
    }

    public static Ergebnis rechnen(Instant von, Instant bis, int kadenzS, List<Leistung> werte,
            List<Schwelle> fassungen, List<BezugsdatenRegeln.Luecke> luecken) {
        if (!bis.isAfter(von) || kadenzS < 1) throw new IllegalArgumentException("Zeitraum oder Kadenz ungültig");
        var roh = werte.stream().sorted(Comparator.comparing(Leistung::zeit)).toList();
        var schwellen = fassungen.stream().sorted(Comparator.comparing(Schwelle::von)).toList();
        TreeSet<Instant> grenzen = new TreeSet<>(List.of(von, bis));
        for (var r : roh) { grenzen.add(r.zeit()); grenzen.add(r.zeit().plusSeconds(kadenzS)); }
        List<String> kennzeichen = new ArrayList<>();
        for (var s : schwellen) {
            if (s.kw() == null || s.kw().signum() < 0) throw new IllegalArgumentException("Schwelle ungültig");
            grenzen.add(s.von());
            if (s.bis() != null) grenzen.add(s.bis());
            if (s.von().isBefore(bis) && (s.bis() == null || s.bis().isAfter(von))) kennzeichen.add(kennzeichen(s.kw()));
        }
        TreeMap<Instant, Integer> lueckenDelta = new TreeMap<>();
        for (var l : luecken) {
            grenzen.add(l.von()); grenzen.add(l.bis());
            lueckenDelta.merge(l.von(), 1, Integer::sum); lueckenDelta.merge(l.bis(), -1, Integer::sum);
        }
        int ri = -1, si = -1, offen = 0;
        BigDecimal gemessen = BigDecimal.ZERO, betrieb = BigDecimal.ZERO;
        Instant vorher = null;
        for (Instant ende : grenzen) {
            if (vorher != null && !vorher.isBefore(von) && !ende.isAfter(bis) && offen == 0 && ri >= 0 && si >= 0) {
                var r = roh.get(ri); var s = schwellen.get(si);
                if (r.gut() && r.kw() != null && vorher.isBefore(r.zeit().plusSeconds(kadenzS))
                        && (s.bis() == null || vorher.isBefore(s.bis()))) {
                    BigDecimal dauer = BigDecimal.valueOf(Duration.between(vorher, ende).toNanos(), 9);
                    gemessen = gemessen.add(dauer);
                    if (r.kw().compareTo(s.kw()) > 0) betrieb = betrieb.add(dauer);
                }
            }
            while (ri + 1 < roh.size() && !roh.get(ri + 1).zeit().isAfter(ende)) ri++;
            while (si + 1 < schwellen.size() && !schwellen.get(si + 1).von().isAfter(ende)) si++;
            offen += lueckenDelta.getOrDefault(ende, 0);
            vorher = ende;
        }
        BigDecimal dauer = BigDecimal.valueOf(Duration.between(von, bis).toNanos(), 9);
        boolean voll = gemessen.compareTo(dauer) == 0;
        return new Ergebnis(gemessen.signum() == 0 ? null : betrieb.divide(BigDecimal.valueOf(3600), 6, RoundingMode.HALF_UP),
                gemessen.signum() == 0 ? VerbrauchRegeln.KEINE_WERTE : voll ? VerbrauchRegeln.VOLLSTAENDIG : VerbrauchRegeln.UNVOLLSTAENDIG,
                gemessen.multiply(BigDecimal.valueOf(100)).divide(dauer, 1, RoundingMode.HALF_UP),
                kennzeichen.stream().distinct().toList(), betrieb, gemessen);
    }
}
