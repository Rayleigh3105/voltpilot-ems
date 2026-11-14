package com.voltpilot.api.grundlast;

import com.voltpilot.api.history.HistoryRange;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;

/**
 * Die Rechenregel der <b>Grundlast</b> – „Was läuft bei mir immer?“ (Bedienkonzept Privatkunde §5.4,
 * Entscheid BK-2 = A: niedrigste Viertelstunde der Nacht; BK-3 = A: kWh am Tag und Anteil, keine
 * Jahreszahl). Rein und ohne Datenbank; {@link GrundlastService} liest die Viertelstunden und ruft
 * nur diese Funktionen.
 *
 * <ul>
 *   <li><b>Nacht</b> eines Datums = 0–5 Uhr Ortszeit (Europe/Berlin) dieses Datums. Bei der
 *       Zeitumstellung hat sie 16 (März) oder 24 (Oktober) Viertelstunden statt 20.</li>
 *   <li><b>Nachtwert</b> = die niedrigste gemessene Viertelstunde der Nacht, in Watt
 *       ({@code kWh × 4000}). Eine Nacht zählt („gewertet“), wenn höchstens
 *       {@value #HOECHSTENS_FEHLEND} ihrer Viertelstunden ohne Messwert sind (18 von 20).</li>
 *   <li><b>Typische Nacht</b> = Median der gewerteten Nächte des Zeitraums, ab
 *       {@value #MIN_NAECHTE} gewerteten Nächten; sonst gibt es keine Zahl.</li>
 *   <li><b>Jahr</b>: ein Wert je Monat (Median seiner Nächte, ab {@value #MIN_NAECHTE_MONAT}).</li>
 *   <li><b>kWh am Tag</b> = Watt × 24 ÷ 1000. <b>Anteil</b> = Grundlast über die gemessene Dauer ÷
 *       Verbrauch derselben Dauer (die Wort-Stufen bildet das Portal).</li>
 *   <li><b>Aufteilung</b>: je Teil (Unterzähler) seine Leistung in genau den Viertelstunden, die die
 *       Nachtwerte gestellt haben, Median über die Nächte; der Rest = typische Nacht minus Summe.</li>
 * </ul>
 *
 * <p>Fehlend ist keine Null: eine Nacht ohne genug Messwerte ist „nicht gewertet“, nie 0 W; ein Teil
 * ohne Wert macht den Rest unbestimmbar statt ihn zu schätzen. Die Schwellen ({@value #MIN_NAECHTE}
 * Nächte, 18 von 20, die Stufe) sind Startwerte des Baus, nicht vom Captain entschieden (Bericht §8).
 */
public final class GrundlastRegel {

    /** Die Zone aller Nachtgrenzen – dieselbe wie die der Verlauf-Zeiträume. */
    public static final ZoneId ZONE = HistoryRange.ZONE;

    /** Ende des Nachtfensters (Beginn ist Mitternacht). */
    public static final LocalTime NACHT_ENDE = LocalTime.of(5, 0);

    /** So viele Viertelstunden einer Nacht dürfen fehlen, damit sie noch zählt (18 von 20). */
    public static final int HOECHSTENS_FEHLEND = 2;

    /** Ab so vielen gewerteten Nächten gibt es eine typische Nacht. */
    public static final int MIN_NAECHTE = 3;

    /** Ab so vielen gewerteten Nächten bekommt ein Monat der Jahresansicht einen Wert. */
    public static final int MIN_NAECHTE_MONAT = 7;

    /**
     * So lange nach dem Nachtende gilt eine Nacht noch als „offen“: die 15-Minuten-Rollups werden
     * alle 15 Minuten nachgezogen ({@code telemetry_rollups_job}); vorher fehlten ihr Viertelstunden,
     * die nur noch nicht gerechnet sind.
     */
    public static final Duration NACHZUG = Duration.ofMinutes(30);

    /** Eine Stufe braucht auf jeder Seite so viele gewertete Nächte. */
    public static final int STUFE_MIN_NAECHTE = 5;

    /** Eine Stufe ist mindestens so groß (Watt) … */
    public static final double STUFE_MIN_W = 50;

    /** … und mindestens dieser Bruchteil des Werts davor. */
    public static final double STUFE_MIN_ANTEIL = 0.2;

    /**
     * Ab dieser Leistung (Watt) über der typischen Nacht widersprechen sich Haus und Teile – dieselbe
     * Schwelle wie der Rest in „Verbrauch nach Bereichen“ ({@code verbrauchBereiche.ts}, 0,2 kW).
     */
    public static final double KONFLIKT_W = 200;

    /** Wie eine Nacht in die Zahl eingeht. */
    public enum Status {
        /** Genug Messwerte: der Nachtwert zählt. */
        GEWERTET,
        /** Nach Messbeginn, aber zu viele Viertelstunden ohne Messwert: nicht gewertet. */
        LUECKE,
        /** Vor der ersten Messung der Anlage: nichts zu werten, keine Lücke. */
        VORHER,
        /** Die Nacht ist noch nicht vorbei (oder noch nicht nachgerechnet). */
        OFFEN
    }

    /**
     * Eine Nacht.
     *
     * @param tiefste die Viertelstunde, die den Nachtwert gestellt hat (nur bei {@code GEWERTET})
     * @param gemessen Viertelstunden mit Messwert
     * @param erwartet Viertelstunden der Nacht (16, 20 oder 24)
     */
    public record Nacht(LocalDate datum, Status status, Double w, Instant tiefste, int gemessen, int erwartet) {}

    /** Ein Monat der Jahresansicht: Median seiner gewerteten Nächte, oder {@code null} darunter. */
    public record Monat(YearMonth monat, Double w, int gewertet) {}

    /** Eine Stufe im Zeitraum: ab {@code seit} liegt die Grundlast deutlich anders als davor. */
    public record Stufe(LocalDate seit, double vorherW, double nachherW) {}

    /**
     * Ein gemessener Teil des Hauses mit seiner Leistung (kW) je Viertelstunde.
     *
     * @param kwJeViertelstunde Mittelwert der Leistung je Viertelstundenbeginn; fehlt ein Eintrag, ist
     *     der Wert unbekannt
     */
    public record TeilEingabe(String entityId, String label, String typLabel, boolean unterzaehler,
            Map<Instant, Double> kwJeViertelstunde) {}

    /** Ein Teil der Aufteilung; {@code w == null} = in keiner gewerteten Nacht gemessen. */
    public record Teil(String entityId, String label, String typLabel, boolean unterzaehler, Double w) {}

    /** Der Rest („übriger Haushalt“): Watt, oder der Grund, warum es keine Zahl gibt. */
    public record Rest(Double w, RestGrund grund) {}

    /** Warum der Rest keine Zahl hat. */
    public enum RestGrund {
        /** Ein Teil hat in keiner gewerteten Nacht einen Wert. */
        TEIL_OHNE_WERT,
        /** Die Teile messen mehr als das Haus (über {@link #KONFLIKT_W}). */
        TEILE_MEHR_ALS_HAUS
    }

    private GrundlastRegel() {}

    /** Beginn der Nacht eines Datums (Mitternacht Ortszeit). */
    public static Instant nachtBeginn(LocalDate datum) {
        return datum.atStartOfDay(ZONE).toInstant();
    }

    /** Ende der Nacht eines Datums (5 Uhr Ortszeit; die Umstellung liegt davor, 5 Uhr gibt es immer). */
    public static Instant nachtEnde(LocalDate datum) {
        return datum.atTime(NACHT_ENDE).atZone(ZONE).toInstant();
    }

    /** Viertelstunden der Nacht: 20, bei der Zeitumstellung 16 oder 24. */
    public static int erwarteteViertelstunden(LocalDate datum) {
        return (int) (Duration.between(nachtBeginn(datum), nachtEnde(datum)).toMinutes() / 15);
    }

    /**
     * Die Nacht eines Datums aus den gemessenen Viertelstunden.
     *
     * @param kwhJeViertelstunde Hausverbrauch (kWh) je gemessener Viertelstunde; fehlt ein Eintrag,
     *     hat die Viertelstunde keinen Messwert
     * @param ersteMessung die erste je gemessene Viertelstunde der Anlage, oder {@code null}
     * @param jetzt die Uhr
     */
    public static Nacht nacht(LocalDate datum, NavigableMap<Instant, Double> kwhJeViertelstunde,
            Instant ersteMessung, Instant jetzt) {
        Instant beginn = nachtBeginn(datum);
        Instant ende = nachtEnde(datum);
        int erwartet = erwarteteViertelstunden(datum);
        if (jetzt.isBefore(ende.plus(NACHZUG))) {
            return new Nacht(datum, Status.OFFEN, null, null, 0, erwartet);
        }
        int gemessen = 0;
        Double tiefsteKwh = null;
        Instant tiefste = null;
        for (Map.Entry<Instant, Double> e : kwhJeViertelstunde.subMap(beginn, true, ende, false).entrySet()) {
            if (e.getValue() == null) {
                continue;
            }
            gemessen++;
            if (tiefsteKwh == null || e.getValue() < tiefsteKwh) {
                tiefsteKwh = e.getValue();
                tiefste = e.getKey();
            }
        }
        if (gemessen >= erwartet - HOECHSTENS_FEHLEND) {
            return new Nacht(datum, Status.GEWERTET, Math.max(0, tiefsteKwh) * 4000.0, tiefste, gemessen, erwartet);
        }
        boolean vorher = ersteMessung == null || !ersteMessung.isBefore(ende);
        return new Nacht(datum, vorher ? Status.VORHER : Status.LUECKE, null, null, gemessen, erwartet);
    }

    /** Alle Nächte der Daten {@code [von, bis)}. */
    public static List<Nacht> naechte(LocalDate von, LocalDate bis, NavigableMap<Instant, Double> kwhJeViertelstunde,
            Instant ersteMessung, Instant jetzt) {
        List<Nacht> out = new ArrayList<>();
        for (LocalDate d = von; d.isBefore(bis); d = d.plusDays(1)) {
            out.add(nacht(d, kwhJeViertelstunde, ersteMessung, jetzt));
        }
        return out;
    }

    /** Die gewerteten Nächte. */
    public static List<Nacht> gewertet(Collection<Nacht> naechte) {
        return naechte.stream().filter(n -> n.status() == Status.GEWERTET).toList();
    }

    /** Median, oder {@code null} für eine leere Liste. */
    public static Double median(List<Double> werte) {
        if (werte.isEmpty()) {
            return null;
        }
        List<Double> s = werte.stream().sorted().toList();
        int n = s.size();
        return n % 2 == 1 ? s.get(n / 2) : (s.get(n / 2 - 1) + s.get(n / 2)) / 2.0;
    }

    /** Die typische Nacht: Median der gewerteten, ab {@code mindestens} Nächten, sonst {@code null}. */
    public static Double typisch(Collection<Nacht> naechte, int mindestens) {
        List<Double> w = gewertet(naechte).stream().map(Nacht::w).toList();
        return w.size() >= mindestens ? median(w) : null;
    }

    /** Die Monate der Jahresansicht in Kalenderreihenfolge (jeder Monat, der eine Nacht hat). */
    public static List<Monat> monate(List<Nacht> naechte) {
        Map<YearMonth, List<Nacht>> jeMonat = new LinkedHashMap<>();
        for (Nacht n : naechte) {
            jeMonat.computeIfAbsent(YearMonth.from(n.datum()), k -> new ArrayList<>()).add(n);
        }
        List<Monat> out = new ArrayList<>();
        jeMonat.forEach((m, ns) -> out.add(new Monat(m, typisch(ns, MIN_NAECHTE_MONAT), gewertet(ns).size())));
        return out;
    }

    /** kWh am Tag zu einer Leistung in Watt. */
    public static Double kwhAmTag(Double w) {
        return w == null ? null : w * 24 / 1000.0;
    }

    /**
     * Anteil der Grundlast am Verbrauch: die Grundlast über die gemessene Dauer ÷ den Verbrauch derselben
     * Dauer. {@code null}, wenn eine der Zahlen fehlt oder kein Verbrauch gemessen ist. Nicht geklemmt –
     * über 1 heißt: die Messung widerspricht sich, das Portal sagt dann „mehr als die Hälfte“.
     */
    public static Double anteil(Double w, long gemesseneViertelstunden, Double verbrauchKwh) {
        if (w == null || verbrauchKwh == null || verbrauchKwh <= 0 || gemesseneViertelstunden <= 0) {
            return null;
        }
        return (w / 1000.0) * (gemesseneViertelstunden * 0.25) / verbrauchKwh;
    }

    /**
     * Die Stufe im Zeitraum, oder {@code null}: die Teilung der gewerteten Nächte in „davor“ und „ab“, an
     * der die Nächte am besten zu zwei festen Werten passen (kleinste Summe der Abstände zum Median je
     * Seite). Sie zählt, wenn jede Seite mindestens {@value #STUFE_MIN_NAECHTE} Nächte hat und sich die
     * Mediane um mindestens {@value #STUFE_MIN_W} W und {@code STUFE_MIN_ANTEIL} des Werts davor
     * unterscheiden. Keine Warnung, nur der Tag für den Satz.
     */
    public static Stufe stufe(List<Nacht> naechte) {
        List<Double> w = gewertet(naechte).stream().map(Nacht::w).toList();
        List<Nacht> g = gewertet(naechte);
        int besteK = -1;
        double besteAbweichung = Double.MAX_VALUE;
        for (int k = STUFE_MIN_NAECHTE; k <= w.size() - STUFE_MIN_NAECHTE; k++) {
            double abweichung = abweichung(w.subList(0, k)) + abweichung(w.subList(k, w.size()));
            if (abweichung < besteAbweichung) {
                besteAbweichung = abweichung;
                besteK = k;
            }
        }
        if (besteK < 0) {
            return null;
        }
        double vor = median(w.subList(0, besteK));
        double nach = median(w.subList(besteK, w.size()));
        double diff = Math.abs(nach - vor);
        if (diff < STUFE_MIN_W || diff < STUFE_MIN_ANTEIL * vor) {
            return null;
        }
        return new Stufe(g.get(besteK).datum(), vor, nach);
    }

    /** Summe der Abstände zum Median. */
    private static double abweichung(List<Double> werte) {
        double m = median(werte);
        double s = 0;
        for (double v : werte) {
            s += Math.abs(v - m);
        }
        return s;
    }

    /**
     * Die Aufteilung: je Teil seine Leistung (W) in der Viertelstunde, die den Nachtwert gestellt hat,
     * Median über die gewerteten Nächte, in denen der Teil dort einen Wert hat.
     */
    public static List<Teil> teile(List<Nacht> naechte, List<TeilEingabe> eingaben) {
        List<Nacht> g = gewertet(naechte);
        List<Teil> out = new ArrayList<>();
        for (TeilEingabe t : eingaben) {
            List<Double> w = new ArrayList<>();
            for (Nacht n : g) {
                Double kw = t.kwJeViertelstunde().get(n.tiefste());
                if (kw != null) {
                    w.add(Math.max(0, kw) * 1000.0);
                }
            }
            out.add(new Teil(t.entityId(), t.label(), t.typLabel(), t.unterzaehler(), median(w)));
        }
        return out;
    }

    /** Der Rest zur typischen Nacht, oder {@code null}, wenn es keine typische Nacht oder keine Teile gibt. */
    public static Rest rest(Double typischW, List<Teil> teile) {
        if (typischW == null || teile.isEmpty()) {
            return null;
        }
        double summe = 0;
        for (Teil t : teile) {
            if (t.w() == null) {
                return new Rest(null, RestGrund.TEIL_OHNE_WERT);
            }
            summe += t.w();
        }
        double rest = typischW - summe;
        if (rest < -KONFLIKT_W) {
            return new Rest(null, RestGrund.TEILE_MEHR_ALS_HAUS);
        }
        return new Rest(Math.max(0, rest), null);
    }
}
