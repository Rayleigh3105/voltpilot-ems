package com.voltpilot.api.erzeuger;

import com.voltpilot.api.erzeuger.VorgabenAbleitung.Getragen;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Lesung;
import com.voltpilot.api.erzeuger.VorgabenAbleitung.Nachschau;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * UEMS EZ-7: aus den gespeicherten Proben einer Anlagensteuerung ({@code device_measurement_sample}) die
 * {@link Lesung}en der {@link VorgabenAbleitung}. Rein, ohne Datenbank.
 *
 * <p>Die Box liest alle 5 s, sendet aber nur, was sich ändert (spätestens alle 60 s, EZ-5
 * {@code erzeuger-meldung.js}): Zustände und Bitfelder bei jeder Änderung, „seit“ und Zähler im 60-s-Takt. Darum
 * wird jeder Wert <b>getragen</b>, bis eine neue Probe kommt — höchstens {@value VorgabenAbleitung#GILT_S} s lang,
 * denn ein Wert, der ungültig wird, kommt nie wieder (die Box sendet für ihn nichts). Alle Proben einer Lesezeit sind
 * eine Lesung.
 *
 * <p>Qualität: {@code good}/{@code uncertain} sind Werte; {@code invalid}/{@code device_error} machen den Wert
 * unbekannt; {@code stale} (Herzschlag steht, EZ-1 §8) ist keine Beobachtung — eine Lesezeit nur mit veralteten
 * Proben ist keine Lesung, die Zeit dazwischen wird zur Lücke.
 */
public final class VorgabenVerlauf {

    /** Eine gespeicherte Probe: Lesezeit, Punkt, Wert ({@code coalesce(decoded, raw)}), Qualität. */
    public record Probe(Instant zeit, String punkt, BigDecimal wert, String qualitaet) {}

    private VorgabenVerlauf() {}

    /**
     * Die Lesungen in {@code (ab, bis]}. {@code proben} sind nach Zeit geordnet und dürfen bis
     * {@code bis + NACHSCHAU_S} reichen (für „seit“ und Zähler nach einem Wechsel). {@code getragen} ist der Stand
     * vor {@code ab} und wird fortgeschrieben. {@code luecken} sind Zeitpunkte gemeldeter Datenlücken
     * ({@code data_gap}), {@code neustarts} die der Steuerung ({@code device_restart}): sie gelten für die erste
     * Lesung danach.
     */
    public static List<Lesung> lesungen(Map<String, Getragen> getragen, List<Probe> proben, Instant ab, Instant bis,
            List<Instant> luecken, List<Instant> neustarts) {
        Map<String, List<Probe>> nachschau = new HashMap<>();
        for (Probe p : proben) {
            if (VorgabenAbleitung.NACHSCHAU.contains(p.punkt()) && gut(p.qualitaet()) && p.wert() != null) {
                nachschau.computeIfAbsent(p.punkt(), k -> new ArrayList<>()).add(p);
            }
        }
        TreeMap<Instant, List<Probe>> je = new TreeMap<>();
        for (Probe p : proben) {
            if (p.zeit().isAfter(ab) && !p.zeit().isAfter(bis)) {
                je.computeIfAbsent(p.zeit(), k -> new ArrayList<>()).add(p);
            }
        }
        List<Instant> offeneLuecken = new ArrayList<>(luecken);
        List<Instant> offeneNeustarts = new ArrayList<>(neustarts);
        Collections.sort(offeneLuecken);
        Collections.sort(offeneNeustarts);
        List<Lesung> out = new ArrayList<>();
        for (Map.Entry<Instant, List<Probe>> e : je.entrySet()) {
            Instant t = e.getKey();
            boolean beobachtet = false;
            Set<String> frisch = new HashSet<>();
            for (Probe p : e.getValue()) {
                if ("stale".equals(p.qualitaet())) {
                    continue;
                }
                beobachtet = true;
                if (gut(p.qualitaet()) && p.wert() != null) {
                    getragen.put(p.punkt(), new Getragen(p.wert(), t));
                    frisch.add(p.punkt());
                } else {
                    getragen.remove(p.punkt());
                }
            }
            if (!beobachtet) {
                continue;
            }
            Map<String, BigDecimal> werte = new LinkedHashMap<>();
            Instant frist = t.minusSeconds(VorgabenAbleitung.GILT_S);
            getragen.forEach((punkt, g) -> {
                if (!g.zeit.isBefore(frist)) {
                    werte.put(punkt, g.wert);
                }
            });
            Map<String, Nachschau> danach = new HashMap<>();
            for (String punkt : VorgabenAbleitung.NACHSCHAU) {
                Probe n = erste(nachschau.get(punkt), t);
                if (n != null) {
                    danach.put(punkt, new Nachschau(n.zeit(), n.wert()));
                }
            }
            out.add(new Lesung(t, Map.copyOf(werte), Set.copyOf(frisch), vorBis(offeneLuecken, t),
                    vorBis(offeneNeustarts, t), Map.copyOf(danach)));
        }
        return out;
    }

    private static boolean gut(String qualitaet) {
        return "good".equals(qualitaet) || "uncertain".equals(qualitaet);
    }

    /** Die erste Probe in {@code [t, t + NACHSCHAU_S]}. */
    private static Probe erste(List<Probe> liste, Instant t) {
        if (liste == null) {
            return null;
        }
        Instant bis = t.plusSeconds(VorgabenAbleitung.NACHSCHAU_S);
        for (Probe p : liste) {
            if (!p.zeit().isBefore(t)) {
                return p.zeit().isAfter(bis) ? null : p;
            }
        }
        return null;
    }

    /** Liegt ein Zeitpunkt der Liste bis {@code t}? Verbraucht ihn: er gilt nur für die erste Lesung danach. */
    private static boolean vorBis(List<Instant> zeiten, Instant t) {
        boolean gefunden = false;
        while (!zeiten.isEmpty() && !zeiten.get(0).isAfter(t)) {
            zeiten.remove(0);
            gefunden = true;
        }
        return gefunden;
    }
}
