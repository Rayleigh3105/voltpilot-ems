package com.voltpilot.api.history;

import com.voltpilot.api.web.dto.HistoryBucketDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Ein freier Zeitraum in GANZEN Tagen, beide Tage eingeschlossen (Bedienkonzept
 * vp-privatkunde-bedienkonzept §7.4, Paket R1; Regel des Repos: tagesgenaue Zuordnungen schließen den
 * letzten Tag ein). Grenzen sind Berliner Tage wie bei {@link HistoryRange}.
 *
 * <p><b>Eimer:</b> bis {@value #TAGE_JE_TAG} Tage einer je Tag, darüber einer je Kalendermonat - aus
 * denselben Tageseimern summiert, die {@code range=month|year} liefert. Die Summen des Zeitraums
 * hängen deshalb nicht an der Eimer-Wahl.
 *
 * <p>Rein und rahmenfrei; die Prüfung der Grenzen ({@link #pruefe}) liefert einen Satz statt zu werfen,
 * damit Controller und Tests dieselbe Regel lesen.
 */
public record Zeitraum(LocalDate von, LocalDate bis) {

    /** Bis zu so vielen Tagen bekommt jeder Tag einen Eimer, darüber jeder Monat. */
    public static final int TAGE_JE_TAG = 92;

    /** Längster Zeitraum: drei Jahre (eine Abrechnung umfasst eines, mit Luft für Rumpfjahre). */
    public static final int MAX_TAGE = 3 * 366;

    /** Anzahl der Tage, beide Grenzen eingeschlossen. */
    public long tage() {
        return ChronoUnit.DAYS.between(von, bis) + 1;
    }

    /** Ab {@value #TAGE_JE_TAG} + 1 Tagen ein Eimer je Monat. */
    public boolean jeMonat() {
        return tage() > TAGE_JE_TAG;
    }

    /** Das halboffene Fenster: Beginn von {@code von} bis Beginn des Tages nach {@code bis} (Berlin). */
    public HistoryRange.Window window() {
        return new HistoryRange.Window(
                von.atStartOfDay(HistoryRange.ZONE).toInstant(),
                bis.plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant());
    }

    /**
     * Der feste Zeitraum, dessen Ereignis-Bündelung dieser Zeitraum übernimmt: je Tag wie der Monat,
     * je Monat wie das Jahr. Die Netzgrenze liest keiner von beiden ({@link Ereignisse#evaluatesGridLimit}).
     */
    public HistoryRange ereignisRaster() {
        return jeMonat() ? HistoryRange.YEAR : HistoryRange.MONTH;
    }

    /**
     * Prüft die Grenzen gegen {@code heute}: {@code null} = gültig, sonst der Grund für die 400.
     * {@code bis} darf heute sein (der laufende Tag ist dann ein Zwischenstand), nie später.
     */
    public static String pruefe(LocalDate von, LocalDate bis, LocalDate heute) {
        if (von == null || bis == null) {
            return "from und to gehören zusammen (ganze Tage, JJJJ-MM-TT)";
        }
        if (bis.isBefore(von)) {
            return "to liegt vor from";
        }
        if (bis.isAfter(heute)) {
            return "to liegt in der Zukunft";
        }
        if (ChronoUnit.DAYS.between(von, bis) + 1 > MAX_TAGE) {
            return "Zeitraum länger als " + MAX_TAGE + " Tage";
        }
        return null;
    }

    /**
     * Tageseimer zu Monatseimern: Energien und Kosten summiert (null, wenn kein Tag des Monats den
     * Kanal trug - nie eine erfundene 0), Ladestand min/max über den Monat, „zuletzt" vom letzten Tag
     * mit Wert; der Preis bleibt leer (ein Mittel über Tagesmittel wäre keine Börsenzahl). Der Eimer
     * beginnt am Monatsersten, im ersten Monat am Beginn des Zeitraums.
     */
    public List<HistoryBucketDto> monatsEimer(List<HistoryBucketDto> tagesEimer) {
        Instant beginn = window().from();
        Map<YearMonth, List<HistoryBucketDto>> gruppen = new LinkedHashMap<>();
        for (HistoryBucketDto b : tagesEimer) {
            YearMonth m = YearMonth.from(b.start().atZone(HistoryRange.ZONE));
            gruppen.computeIfAbsent(m, k -> new ArrayList<>()).add(b);
        }
        List<HistoryBucketDto> out = new ArrayList<>();
        for (Map.Entry<YearMonth, List<HistoryBucketDto>> e : gruppen.entrySet()) {
            List<HistoryBucketDto> g = e.getValue();
            Instant start = e.getKey().atDay(1).atStartOfDay(HistoryRange.ZONE).toInstant();
            if (start.isBefore(beginn)) {
                start = beginn;
            }
            BigDecimal socLast = null;
            for (HistoryBucketDto b : g) {
                if (b.socLastPct() != null) {
                    socLast = b.socLastPct();
                }
            }
            out.add(new HistoryBucketDto(start,
                    summe(g, HistoryBucketDto::pvKwh),
                    summe(g, HistoryBucketDto::loadKwh),
                    summe(g, HistoryBucketDto::gridImportKwh),
                    summe(g, HistoryBucketDto::gridExportKwh),
                    summe(g, HistoryBucketDto::batteryChargeKwh),
                    summe(g, HistoryBucketDto::batteryDischargeKwh),
                    extrem(g, HistoryBucketDto::socMinPct, true),
                    extrem(g, HistoryBucketDto::socMaxPct, false),
                    socLast,
                    null,
                    summe(g, HistoryBucketDto::costEur)));
        }
        return out;
    }

    private static BigDecimal summe(List<HistoryBucketDto> g, Function<HistoryBucketDto, BigDecimal> f) {
        BigDecimal s = null;
        for (HistoryBucketDto b : g) {
            BigDecimal v = f.apply(b);
            if (v != null) {
                s = s == null ? v : s.add(v);
            }
        }
        return s;
    }

    private static BigDecimal extrem(List<HistoryBucketDto> g, Function<HistoryBucketDto, BigDecimal> f,
            boolean min) {
        BigDecimal e = null;
        for (HistoryBucketDto b : g) {
            BigDecimal v = f.apply(b);
            if (v != null && (e == null || (min ? v.compareTo(e) < 0 : v.compareTo(e) > 0))) {
                e = v;
            }
        }
        return e;
    }
}
