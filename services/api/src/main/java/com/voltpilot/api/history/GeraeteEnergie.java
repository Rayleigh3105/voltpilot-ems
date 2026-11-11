package com.voltpilot.api.history;

import com.voltpilot.api.repo.EntityHistoryRepository.Bucket;
import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Die Energie EINES Geräts je Eimer eines Zeitraums (Tag, Woche, Monat, Jahr) - Unterverteilungen,
 * Konzept vp-unterzaehler-anzeige C2. Rein und rahmenfrei; die Reihen liest
 * {@code EntityHistoryRepository#energySeries}.
 *
 * <p><b>Die Zählerregel</b> (Hausregel aus {@code ConsumerRequirementStateRepository.energyOverPeriod}
 * und {@code verbrauchHeute.ts}): trägt das Gerät einen Zählerstand {@code energy_kwh}, ist die Energie
 * eines Zeitraums sein ZUWACHS - je feinem Eimer der Stand am Ende minus der Stand am Ende des
 * vorigen Eimers (über die Eimergrenze hinweg), am Anfang und nach einer Lücke {@code max − min}
 * im Eimer selbst. Was in einer Lücke verbraucht wurde, ordnet die Regel keinem Eimer zu: die
 * Summe bleibt die der gezeichneten Säulen. <b>Eine Reihe, die irgendwo FÄLLT</b> (Tausch, Reset,
 * Überlauf), gibt für diesen Eimer keine Zahl und für den Zeitraum gar keine
 * ({@link Ergebnis#zaehlerFaellt()}) - ein Zähler, der von 950 auf 5 springt, lieferte sonst 945 kWh.
 *
 * <p><b>Ohne Zähler</b> die Leistung {@code power_kw}: Mittelwert × Eimerdauer, wie die Heute-kWh.
 * Ohne beides gibt es keine Zahl, nie eine 0.
 *
 * <p>Die feinen Eimer sind die Viertelstunden (Tag) bzw. Stunden (sonst); die Eimer der Antwort
 * sind die des Zeitraums ({@link HistoryRange#bucketMinutes()}, Monat und Jahr je Berliner Tag) -
 * dieselben wie in {@code /history}, damit „Haus minus Teile“ je Eimer aufgeht.
 */
public final class GeraeteEnergie {

    /** Der Zählerstand Bezug. */
    public static final String ZAEHLER = "energy_kwh";
    /** Die Leistung. */
    public static final String LEISTUNG = "power_kw";

    public static final String QUELLE_ZAEHLER = "zaehler";
    public static final String QUELLE_LEISTUNG = "leistung";

    /** Unter einem halben Wattstunde ist ein Rückgang Rundung, kein Fallen. */
    static final double TOLERANZ_KWH = 0.0005;

    private GeraeteEnergie() {
    }

    /** Ein Eimer des Zeitraums: Beginn und Energie, {@code null} = nicht belegbar. */
    public record Eimer(Instant start, Double kwh) {}

    /**
     * @param quelle {@link #QUELLE_ZAEHLER}, {@link #QUELLE_LEISTUNG} oder {@code null} (keine Reihe)
     * @param summeKwh die Energie des Zeitraums; {@code null} ohne Reihe oder wenn der Zähler fällt
     */
    public record Ergebnis(String quelle, List<Eimer> eimer, Double summeKwh, boolean zaehlerFaellt) {}

    /**
     * @param reihen die feinen Eimer je Kanal (mindestens {@link #ZAEHLER} und/oder {@link #LEISTUNG})
     * @param feinBreite die Breite eines feinen Eimers (15 min bzw. 1 h)
     */
    public static Ergebnis berechne(Map<String, List<Bucket>> reihen, Duration feinBreite, HistoryRange range) {
        List<Bucket> zaehler = nichtLeer(reihen.get(ZAEHLER));
        List<Bucket> leistung = nichtLeer(reihen.get(LEISTUNG));
        if (!zaehler.isEmpty()) {
            return ausZaehler(zaehler, feinBreite, range);
        }
        if (!leistung.isEmpty()) {
            return ausLeistung(leistung, feinBreite, range);
        }
        return new Ergebnis(null, List.of(), null, false);
    }

    private static Ergebnis ausZaehler(List<Bucket> reihe, Duration feinBreite, HistoryRange range) {
        TreeMap<Instant, Double> grob = new TreeMap<>();
        TreeMap<Instant, Boolean> grobGefallen = new TreeMap<>();
        boolean faellt = false;
        Bucket vorher = null;
        for (Bucket b : reihe) {
            if (b.max() == null) {
                continue;
            }
            double min = b.min() != null ? b.min() : b.max();
            double max = b.max();
            double ende = b.last() != null ? b.last() : max;
            boolean gefallen = ende < max - TOLERANZ_KWH;
            double kwh;
            if (vorher != null && b.start().equals(vorher.start().plus(feinBreite))) {
                double stand = vorher.last() != null ? vorher.last() : vorher.max();
                gefallen |= min < stand - TOLERANZ_KWH;
                kwh = max - stand;
            } else {
                kwh = max - min;
            }
            Instant key = grobBeginn(b.start(), range);
            if (gefallen) {
                faellt = true;
                grobGefallen.put(key, true);
                grob.putIfAbsent(key, 0.0);
            } else {
                grob.merge(key, Math.max(kwh, 0.0), Double::sum);
            }
            vorher = b;
        }
        return ergebnis(QUELLE_ZAEHLER, grob, grobGefallen, faellt);
    }

    private static Ergebnis ausLeistung(List<Bucket> reihe, Duration feinBreite, HistoryRange range) {
        double stunden = feinBreite.toSeconds() / 3600.0;
        TreeMap<Instant, Double> grob = new TreeMap<>();
        for (Bucket b : reihe) {
            if (b.avg() == null) {
                continue;
            }
            grob.merge(grobBeginn(b.start(), range), b.avg() * stunden, Double::sum);
        }
        return ergebnis(QUELLE_LEISTUNG, grob, new TreeMap<>(), false);
    }

    private static Ergebnis ergebnis(String quelle, TreeMap<Instant, Double> grob,
            TreeMap<Instant, Boolean> gefallen, boolean faellt) {
        List<Eimer> eimer = new ArrayList<>(grob.size());
        double summe = 0;
        for (Map.Entry<Instant, Double> e : grob.entrySet()) {
            boolean ohneZahl = gefallen.containsKey(e.getKey());
            eimer.add(new Eimer(e.getKey(), ohneZahl ? null : e.getValue()));
            if (!ohneZahl) {
                summe += e.getValue();
            }
        }
        Double summeKwh = eimer.isEmpty() || faellt ? null : summe;
        return new Ergebnis(quelle, List.copyOf(eimer), summeKwh, faellt);
    }

    /** Der Beginn des Zeitraum-Eimers, in den ein feiner Eimer fällt. */
    static Instant grobBeginn(Instant start, HistoryRange range) {
        if (range.dailyBuckets()) {
            ZonedDateTime z = start.atZone(HistoryRange.ZONE).truncatedTo(ChronoUnit.DAYS);
            return z.toInstant();
        }
        long breite = range.bucketMinutes() * 60L;
        long s = start.getEpochSecond();
        return Instant.ofEpochSecond(s - Math.floorMod(s, breite));
    }

    private static List<Bucket> nichtLeer(List<Bucket> reihe) {
        if (reihe == null) {
            return List.of();
        }
        List<Bucket> out = new ArrayList<>();
        for (Bucket b : reihe) {
            if (b.max() != null || b.avg() != null) {
                out.add(b);
            }
        }
        out.sort(java.util.Comparator.comparing(Bucket::start));
        return out;
    }
}
