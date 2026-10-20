package com.voltpilot.api.history;

import com.voltpilot.api.repo.HistoryRepository.CoverageRow;
import com.voltpilot.api.repo.HistoryRepository.GapRun;
import com.voltpilot.api.repo.HistoryRepository.ValueSlot;
import com.voltpilot.api.web.dto.HistoryCoverageDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * <b>Die Ereignis-Spur des Verlaufs</b> (Feature F6 des Historie-Konzepts
 * {@code data/vp-historie-konzept-t4}) - reine Funktionen, kein I/O, wie
 * {@link Tagesprotokoll}.
 *
 * <p><b>Der behobene Befund:</b> das Tagesprotokoll erklärt die Ausreißer eines
 * Tages schon heute - aber nur am TAG, nur als LISTE und ohne Verbindung zum
 * Diagramm. Wer im Monat einen eingebrochenen Balken sieht, erfährt nirgends,
 * dass an dem Tag vier Stunden abgeregelt wurde oder zwei Stunden Messwerte
 * fehlen. Diese Spur beantwortet genau diese Frage - in JEDEM Zeitraum.
 *
 * <p><b>Die Arbeitsteilung zum Tagesprotokoll ist bewusst:</b> das Protokoll
 * bleibt unverändert die Liste der GEWÖHNLICHEN Ereignisse eines Tages (Laden,
 * Entladen, PV-Spitze, Preisextreme); diese Spur trägt ausschließlich das
 * AUFFÄLLIGE, das eine Erklärung braucht. Beide leben nebeneinander, keines
 * ersetzt das andere.
 *
 * <p><b>Drei Ehrlichkeitsregeln sind hier Gesetz:</b>
 * <ol>
 *   <li><b>Was nicht bewiesen ist, wird nicht behauptet.</b> „Netzladen"
 *       entsteht nur, wenn die Viertelstunde PV UND Ladung UND Netzbezug
 *       gemessen hat - ohne bekannte PV wird kein Netzladen unterstellt.</li>
 *   <li><b>Geplantes heißt geplant.</b> Die Abregelung stammt aus den
 *       gespeicherten Fahrplänen ({@code schedule.curtail_kw}), nicht aus einer
 *       Messung - der Text sagt „eingeplant".</li>
 *   <li><b>Die Lücken stimmen mit der Zeit-Leiste überein.</b> Rand- und
 *       Innenlücken werden aus denselben Zahlen abgeleitet, aus denen
 *       {@link HistoryService#coverage} den Abdeckungs-Satz baut - sonst stünde
 *       „6 Lücken" über vier Markern.</li>
 * </ol>
 */
public final class Ereignisse {

    /** Ein Slot der Messreihe/Preisreihe (die Viertelstunde). */
    static final Duration SLOT = Duration.ofMinutes(15);

    /**
     * Wie viele Fenster je Art der TAG höchstens ausliefert - die LÄNGSTEN
     * zuerst. Eine unauffällige Anlage bleibt weit darunter; eine sehr flatterige
     * würde die Antwort sonst mit hunderten Ein-Slot-Fenstern fluten. Die Zahl
     * der Fehlstellen sagt unabhängig davon die Datenlage der Zeit-Leiste
     * ({@link HistoryCoverageDto#gaps}), es geht also keine Information verloren.
     * Ab der Woche wird gebündelt statt gekappt ({@link #buendeln}).
     */
    static final int MAX_PER_TYPE = 20;

    private Ereignisse() {
    }

    /**
     * Für welche Zeiträume die §-14a-Netzgrenze ausgewertet wird.
     *
     * <p><b>Warum nicht immer:</b> {@code grid_limit_kw} steht nur in der ROHEN
     * {@code telemetry} - die Rollup-Kaskade führt die Spalte nicht. Ein
     * Jahresfenster wäre damit ein Scan über Millionen Rohzeilen (die
     * Rollup-Tabellen gibt es genau deshalb), und die Historie wäre wieder so
     * langsam wie vor der Preis-Materialisierung. Tag und Woche sind bewusst
     * begrenzte Scans - und genau die Zeiträume, in denen die Frage „was war da
     * los?" gestellt wird.
     *
     * <p><b>Die Oberfläche muss das AUSSPRECHEN</b> (sonst liest sich das Fehlen
     * eines Markers als „keine Netzgrenze"); der Zwilling dieser Regel ist
     * {@code frontend/portal/src/historieEreignisse.ts} {@code spurHinweis} -
     * beide zusammen ändern.
     */
    public static boolean evaluatesGridLimit(HistoryRange range) {
        return range == HistoryRange.DAY || range == HistoryRange.WEEK;
    }

    /**
     * Ab dieser Energie je Fenster ist Netzladen ein Ereignis (Entscheid im
     * Konzept {@code data/vp-verlauf-ereignisse-k1}, 20.10.2026) - wie
     * {@link #ABENDVERKAUF_MIN_KWH}: eine Zehntel-Kilowattstunde erklärt keinen
     * Balken und ist oft nur der Unterschied zweier Zähler. Die Schwelle je
     * Viertelstunde (Rauschen) sitzt davor in der Abfrage.
     */
    static final BigDecimal NETZLADEN_MIN_LAUF_KWH = new BigDecimal("0.5");

    private static final BigDecimal VIERTELSTUNDE_H = new BigDecimal("0.25");

    /**
     * Die Spur eines Zeitraums, chronologisch.
     *
     * <p><b>Im Tag ist jedes Fenster ein Ereignis</b>, die {@value #MAX_PER_TYPE}
     * längsten je Art. <b>Ab der Woche bündelt ein Ereignis die Fenster eines
     * Tages</b> (Woche, Monat) <b>bzw. eines Monats</b> (Jahr) je Art: das ist von
     * selbst begrenzt (höchstens 31 bzw. 12 je Art) und darum vollständig - die
     * Kappung der längsten Fenster ließ im Sommer Tage mit negativen Preisen weg.
     *
     * @param range          der Zeitraum - er entscheidet, ob gebündelt wird
     * @param negativePrices Preis-Slots unter null (Wert = EUR/MWh)
     * @param curtailments   geplante Abregelung je Slot (Wert = kW)
     * @param gridLimits     gemeldete Netzgrenze je Slot (Wert = kW); leer, wenn
     *                       der Zeitraum sie nicht auswertet
     * @param gridCharges    Netzladen je Slot (Wert = kWh über der PV-Erzeugung)
     * @param innerGaps      Fehlstellen ZWISCHEN zwei gemessenen Viertelstunden
     * @param row            die Rohzahlen der Abdeckungs-Abfrage (Rand-Lücken)
     * @param coverage       der daraus gerechnete Abdeckungs-Block - null, wenn
     *                       die Anlage noch nie gemessen hat (dann gibt es keine
     *                       Lücken-Marker, nur Markt-/Plan-Ereignisse)
     */
    public static List<HistoryEventDto> build(
            HistoryRange range,
            List<ValueSlot> negativePrices,
            List<ValueSlot> curtailments,
            List<ValueSlot> gridLimits,
            List<ValueSlot> gridCharges,
            List<GapRun> innerGaps,
            CoverageRow row,
            HistoryCoverageDto coverage) {

        List<HistoryEventDto> events = new ArrayList<>();
        events.addAll(ereignisse(range, "negativpreis", runs(negativePrices)));
        events.addAll(ereignisse(range, "abregelung", runs(curtailments)));
        events.addAll(ereignisse(range, "netzgrenze", runs(gridLimits)));
        events.addAll(ereignisse(range, "netzladen", runs(gridCharges).stream()
                .filter(r -> r.sum().compareTo(NETZLADEN_MIN_LAUF_KWH) >= 0)
                .toList()));
        events.addAll(gapEvents(range, innerGaps, row, coverage));
        events.sort(Comparator.comparing(HistoryEventDto::start));
        return events;
    }

    // ---- Fenster aus Slots ---------------------------------------------------

    /** Ein zusammenhängendes Fenster gleichartiger Slots. */
    record Run(Instant from, Instant to, BigDecimal min, BigDecimal max, BigDecimal sum,
            int slots) {

        Duration dauer() {
            return Duration.between(from, to);
        }
    }

    /**
     * Verschmilzt aufeinanderfolgende Slots zu Fenstern. Zusammenhängend heißt
     * <b>genau eine Viertelstunde Abstand</b> - fehlt dazwischen ein Slot (weil
     * der Preis positiv war, die Messung fehlt, …), sind es zwei Fenster. Der
     * Eingang muss aufsteigend sortiert sein (das liefert jede Abfrage).
     */
    static List<Run> runs(List<ValueSlot> slots) {
        List<Run> out = new ArrayList<>();
        Instant from = null;
        Instant last = null;
        BigDecimal min = null;
        BigDecimal max = null;
        BigDecimal sum = BigDecimal.ZERO;
        int count = 0;
        for (ValueSlot s : slots) {
            if (s == null || s.slot() == null) {
                continue;
            }
            if (from != null && !s.slot().equals(last.plus(SLOT))) {
                out.add(new Run(from, last.plus(SLOT), min, max, sum, count));
                from = null;
            }
            if (from == null) {
                from = s.slot();
                min = null;
                max = null;
                sum = BigDecimal.ZERO;
                count = 0;
            }
            last = s.slot();
            count++;
            if (s.value() != null) {
                min = min == null ? s.value() : min.min(s.value());
                max = max == null ? s.value() : max.max(s.value());
                sum = sum.add(s.value());
            }
        }
        if (from != null) {
            out.add(new Run(from, last.plus(SLOT), min, max, sum, count));
        }
        return out;
    }

    // ---- Bündel: ein Fenster (Tag) oder alle Fenster eines Tages/Monats ---------

    /**
     * Was EIN Ereignis zusammenfasst. Im Tag genau ein Fenster; ab der Woche alle
     * Fenster einer Art an einem Tag (Woche, Monat) bzw. in einem Monat (Jahr).
     * {@code dauer} ist die Summe der Fenster, nicht der Abstand von {@code from}
     * bis {@code to}.
     */
    record Buendel(Instant from, Instant to, BigDecimal min, BigDecimal sum, Duration dauer,
            int anzahl, int tage) {

        static Buendel von(Run r) {
            return new Buendel(r.from(), r.to(), r.min(), r.sum(), r.dauer(), 1, 1);
        }
    }

    /** Fenster -> Ereignisse einer Art, zeitraumgerecht gebündelt. */
    private static List<HistoryEventDto> ereignisse(HistoryRange range, String type,
            List<Run> runs) {
        return buendeln(range, runs).stream().map(b -> ereignis(range, type, b)).toList();
    }

    /**
     * Im Tag die {@value #MAX_PER_TYPE} längsten Fenster je einzeln; ab der Woche
     * je Tag bzw. Monat (Berliner Zeit, gezählt am Beginn des Fensters) ein
     * Bündel - ohne Kappung, die Zahl der Bündel ist durch den Kalender begrenzt.
     */
    static List<Buendel> buendeln(HistoryRange range, List<Run> runs) {
        if (range == HistoryRange.DAY) {
            return runs.stream()
                    .sorted(Comparator.comparing(Run::dauer).reversed().thenComparing(Run::from))
                    .limit(MAX_PER_TYPE)
                    .map(Buendel::von)
                    .toList();
        }
        Map<Object, List<Run>> gruppen = new LinkedHashMap<>();
        runs.stream().sorted(Comparator.comparing(Run::from)).forEach(r -> gruppen
                .computeIfAbsent(kalenderSchluessel(range, r.from()), k -> new ArrayList<>())
                .add(r));
        List<Buendel> out = new ArrayList<>(gruppen.size());
        for (List<Run> gruppe : gruppen.values()) {
            BigDecimal min = null;
            BigDecimal sum = BigDecimal.ZERO;
            Duration dauer = Duration.ZERO;
            Instant bis = gruppe.get(0).to();
            Set<LocalDate> tage = new HashSet<>();
            for (Run r : gruppe) {
                if (r.min() != null) {
                    min = min == null ? r.min() : min.min(r.min());
                }
                if (r.sum() != null) {
                    sum = sum.add(r.sum());
                }
                dauer = dauer.plus(r.dauer());
                if (r.to().isAfter(bis)) {
                    bis = r.to();
                }
                tage.add(r.from().atZone(HistoryRange.ZONE).toLocalDate());
            }
            out.add(new Buendel(gruppe.get(0).from(), bis, min, sum, dauer, gruppe.size(),
                    tage.size()));
        }
        return out;
    }

    private static Object kalenderSchluessel(HistoryRange range, Instant at) {
        LocalDate tag = at.atZone(HistoryRange.ZONE).toLocalDate();
        return range == HistoryRange.YEAR ? YearMonth.from(tag) : tag;
    }

    // ---- die Ereignisse (deutsch, ohne Zeitangabe - die trägt die Oberfläche) --

    /**
     * Ein Bündel als Ereignis: der Satz für ältere Oberflächen und die EINE Zahl
     * als Feld ({@code value}/{@code unit}), aus denselben Werten.
     */
    private static HistoryEventDto ereignis(HistoryRange range, String type, Buendel b) {
        String dauer = dauerText(range, b);
        BigDecimal value;
        String unit;
        boolean planned = false;
        String text;
        switch (type) {
            case "negativpreis" -> {
                value = b.min() == null ? null : ctPerKwh(b.min());
                unit = value == null ? null : "ct/kWh";
                text = value == null
                        ? "Negative Börsenpreise: " + dauer
                        : String.format(Locale.GERMANY, "Negative Börsenpreise: %s, bis %.1f ct/kWh",
                                dauer, value);
            }
            case "abregelung" -> {
                // Aus den gespeicherten Fahrplänen - eine Vorher-Rechnung, keine Messung.
                value = b.sum().multiply(VIERTELSTUNDE_H);
                unit = "kWh";
                planned = true;
                text = String.format(Locale.GERMANY, "PV-Abregelung eingeplant: %s (%.1f kWh)",
                        dauer, value);
            }
            case "netzgrenze" -> {
                value = b.min();
                unit = value == null ? null : "kW";
                text = value == null
                        ? "Netzgrenze gemeldet (§ 14a): " + dauer
                        : String.format(Locale.GERMANY,
                                "Netzgrenze gemeldet (§ 14a): %s, höchstens %.1f kW", dauer, value);
            }
            case "netzladen" -> {
                value = b.sum();
                unit = "kWh";
                text = String.format(Locale.GERMANY,
                        "Speicher aus dem Netz geladen: %s (ca. %.1f kWh)", dauer, value);
            }
            case "datenluecke" -> {
                value = null;
                unit = null;
                text = "Datenlücke: " + dauer + " ohne Messwerte";
            }
            default -> throw new IllegalArgumentException("Unbekannte Ereignis-Art: " + type);
        }
        return new HistoryEventDto(type, b.from(), b.to(), text, value, unit, planned,
                b.dauer().toMinutes(), b.anzahl(), b.tage(), List.of());
    }

    /**
     * „4 Std" für ein Fenster, „3×, zusammen 4 Std" für einen Tag, „an 9 Tagen,
     * zusammen 23 Std" für einen Monat mit Fenstern an mehreren Tagen.
     */
    static String dauerText(HistoryRange range, Buendel b) {
        if (b.anzahl() == 1) {
            return dauer(b.dauer());
        }
        if (range == HistoryRange.YEAR && b.tage() > 1) {
            return "an " + b.tage() + " Tagen, zusammen " + dauer(b.dauer());
        }
        return b.anzahl() + "×, zusammen " + dauer(b.dauer());
    }

    // ---- Abendverkauf (P2 des Nachtreserve-Konzepts vp-nachtreserve-konzept-k2)

    /** Unter dieser verkauften Energie ist ein Abendverkauf kein Ereignis. */
    static final BigDecimal ABENDVERKAUF_MIN_KWH = new BigDecimal("1.0");

    /** Ab diesem Ladestand gilt der Speicher als LEER (der „Boden" der Nacht). */
    static final BigDecimal BODEN_SOC_PCT = new BigDecimal("5.5");

    /**
     * Eine geplante Verkaufs-Viertelstunde mit ihrer Energie und ihrem Wert.
     *
     * @param slot   Beginn der Viertelstunde
     * @param kwh    die eingespeiste Energie (positiv)
     * @param ctKwh  der Erlös je kWh in ct - {@code null}, wenn der Slot keinen
     *               Preis trägt (dann nennt der Text keinen)
     */
    public record VerkaufSlotWert(Instant slot, BigDecimal kwh, BigDecimal ctKwh) {
    }

    /**
     * <b>Das Ereignis „Abendverkauf"</b> - die Antwort auf die Kundenfrage
     * „warum wurde abends verkauft, wenn ich nachts Strom kaufen musste?"
     * (Konzept {@code data/vp-nachtreserve-konzept-k2} §P2).
     *
     * <p><b>Jeder Satz ist ein persistierter Fakt</b> (Erklärbarkeits-Stufe 0):
     * der Verkauf steht im gespeicherten Fahrplan, die Prognose im Lauf des
     * Abends, die Nachtlast/der Boden/der Nachtbezug in der Messreihe. Ein Fakt,
     * den es nicht gibt, LÄSST SEINEN SATZ WEG - er wird nie geschätzt: ohne
     * Preis kein Erlös, ohne gemessenen Boden kein „Speicher leer", ohne
     * Nachtbezug kein Bezugs-Satz. Der Satz „ohne den Verkauf hätte der Speicher
     * bis … gereicht" fehlt bewusst: er wäre eine RECHNUNG, keine Messung.
     *
     * <p>{@code null}, wenn nichts verkauft wurde oder die verkaufte Menge unter
     * {@link #ABENDVERKAUF_MIN_KWH} bleibt - ein halbes Kilowatt erklärt keine
     * Nacht.
     *
     * @param verkauf       die geplanten Verkaufs-Viertelstunden des Abends
     * @param prognoseKwh   die Lastprognose der Nacht (Lauf vor 19:00), oder null
     * @param gemessenKwh   die gemessene Nachtlast, oder null
     * @param bodenAt       die erste Viertelstunde mit leerem Speicher, oder null
     * @param bezugKwh      der gemessene Netzbezug der Nacht, oder null
     * @param bezugEur      dessen Kosten, oder null
     * @param nachtEnde     das Ende des Nachtfensters (für „bis 07:00")
     * @param zone          die Zeitzone der Anlage (Europe/Berlin)
     */
    public static HistoryEventDto abendverkauf(
            List<VerkaufSlotWert> verkauf,
            BigDecimal prognoseKwh,
            BigDecimal gemessenKwh,
            Instant bodenAt,
            BigDecimal bezugKwh,
            BigDecimal bezugEur,
            Instant nachtEnde,
            ZoneId zone) {

        List<VerkaufSlotWert> slots = new ArrayList<>(verkauf == null ? List.of() : verkauf);
        slots.removeIf(s -> s == null || s.slot() == null || s.kwh() == null);
        if (slots.isEmpty()) {
            return null;
        }
        slots.sort(Comparator.comparing(VerkaufSlotWert::slot));

        BigDecimal kwh = BigDecimal.ZERO;
        BigDecimal erloesEur = null;
        BigDecimal minCt = null;
        BigDecimal maxCt = null;
        for (VerkaufSlotWert s : slots) {
            kwh = kwh.add(s.kwh());
            if (s.ctKwh() != null) {
                minCt = minCt == null ? s.ctKwh() : minCt.min(s.ctKwh());
                maxCt = maxCt == null ? s.ctKwh() : maxCt.max(s.ctKwh());
                BigDecimal anteil = s.kwh().multiply(s.ctKwh())
                        .divide(BigDecimal.valueOf(100), java.math.MathContext.DECIMAL64);
                erloesEur = erloesEur == null ? anteil : erloesEur.add(anteil);
            }
        }
        if (kwh.compareTo(ABENDVERKAUF_MIN_KWH) < 0) {
            return null;
        }
        Instant start = slots.get(0).slot();
        Instant end = slots.get(slots.size() - 1).slot().plus(SLOT);

        // Derselbe Fakt steht zweimal: im Satz (ältere Oberflächen) und als
        // Zeile der Fakten-Liste. Beide entstehen hier aus denselben Werten, und
        // ein fehlender Fakt fehlt in beiden.
        List<HistoryEventDto.Fact> fakten = new ArrayList<>();
        StringBuilder text = new StringBuilder();
        text.append(String.format(Locale.GERMANY, "Abendverkauf %s bis %s · %.1f kWh",
                uhr(start, zone), uhr(end, zone), kwh));
        if (minCt != null) {
            text.append(minCt.compareTo(maxCt) == 0
                    ? String.format(Locale.GERMANY, " zu %.1f ct", minCt)
                    : String.format(Locale.GERMANY, " zu %.1f bis %.1f ct", minCt, maxCt));
            fakten.add(new HistoryEventDto.Fact("Preis", minCt.compareTo(maxCt) == 0
                    ? String.format(Locale.GERMANY, "%.1f ct/kWh", minCt)
                    : String.format(Locale.GERMANY, "%.1f bis %.1f ct/kWh", minCt, maxCt)));
            if (erloesEur != null) {
                text.append(String.format(Locale.GERMANY, " (%.2f €)", erloesEur));
                fakten.add(new HistoryEventDto.Fact("Erlös",
                        String.format(Locale.GERMANY, "%.2f €", erloesEur)));
            }
        }
        text.append('.');

        if (prognoseKwh != null && gemessenKwh != null) {
            text.append(String.format(Locale.GERMANY,
                    " Prognose für die Nacht %.0f kWh, gemessen %.0f kWh",
                    prognoseKwh, gemessenKwh));
            fakten.add(new HistoryEventDto.Fact("Nachtlast Prognose",
                    String.format(Locale.GERMANY, "%.0f kWh", prognoseKwh)));
            String gemessen = String.format(Locale.GERMANY, "%.0f kWh", gemessenKwh);
            if (prognoseKwh.signum() > 0) {
                BigDecimal abweichung = gemessenKwh
                        .divide(prognoseKwh, java.math.MathContext.DECIMAL64)
                        .subtract(BigDecimal.ONE)
                        .multiply(BigDecimal.valueOf(100));
                text.append(String.format(Locale.GERMANY, " (%+.0f %%)", abweichung));
                gemessen += String.format(Locale.GERMANY, " (%+.0f %%)", abweichung);
            }
            fakten.add(new HistoryEventDto.Fact("Nachtlast gemessen", gemessen));
            text.append('.');
        }

        List<String> nacht = new ArrayList<>();
        if (bodenAt != null) {
            nacht.add("Speicher leer um " + uhr(bodenAt, zone));
            fakten.add(new HistoryEventDto.Fact("Speicher leer", uhr(bodenAt, zone)));
        }
        if (bezugKwh != null && bezugKwh.compareTo(new BigDecimal("0.05")) > 0) {
            String menge = String.format(Locale.GERMANY, "%.1f kWh", bezugKwh);
            if (bezugEur != null) {
                menge += String.format(Locale.GERMANY, " (%.2f €)", bezugEur);
            }
            nacht.add("Netzbezug bis " + uhr(nachtEnde, zone) + " " + menge);
            fakten.add(new HistoryEventDto.Fact("Netzbezug bis " + uhr(nachtEnde, zone), menge));
        }
        if (!nacht.isEmpty()) {
            text.append(' ').append(String.join("; ", nacht)).append('.');
        }
        return new HistoryEventDto("abendverkauf", start, end, text.toString(), kwh, "kWh", true,
                Duration.between(start, end).toMinutes(), 1, 1, List.copyOf(fakten));
    }

    /** „19:45" in der Zeitzone der Anlage. */
    private static String uhr(Instant at, ZoneId zone) {
        return UHR.format(at.atZone(zone == null ? ZoneId.of("Europe/Berlin") : zone));
    }

    private static final DateTimeFormatter UHR = DateTimeFormatter.ofPattern("HH:mm");

    // ---- Fehlstellen ----------------------------------------------------------

    /**
     * Die Lücken - Innenlücken aus der Messreihe plus die beiden Ränder, exakt
     * nach den Regeln, mit denen {@link HistoryService#coverage} zählt. Der
     * Schluss-Rand ist {@code geraet-still}, wenn die Anlage auch NACH diesem
     * Zeitraum nichts mehr gemessen hat - das ist der Unterschied zwischen
     * „damals fehlte etwas" und „es kommt gerade nichts".
     *
     * <p>Im Tag werden die Innenlücken wie jede Art auf die
     * {@value #MAX_PER_TYPE} längsten gekappt (die Ränder stehen immer da); ab
     * der Woche werden ALLE Lücken je Tag bzw. Monat gebündelt. Das stille Gerät
     * bleibt ein eigenes Ereignis - es gibt höchstens eines.
     */
    private static List<HistoryEventDto> gapEvents(HistoryRange range, List<GapRun> innerGaps,
            CoverageRow row,
            HistoryCoverageDto coverage) {
        if (coverage == null || row == null) {
            return List.of();
        }
        List<Run> luecken = new ArrayList<>();
        List<HistoryEventDto> out = new ArrayList<>();
        if (row.firstInWindow() == null) {
            // Kein einziger Messwert im Zeitraum: EINE Lücke, der ganze Zeitraum.
            if (coverage.expectedTo().isAfter(coverage.expectedFrom())) {
                luecken.add(luecke(coverage.expectedFrom(), coverage.expectedTo()));
            }
        } else {
            if (row.firstInWindow().isAfter(coverage.expectedFrom())) {
                luecken.add(luecke(coverage.expectedFrom(), row.firstInWindow()));
            }
            List<GapRun> inner = new ArrayList<>(innerGaps == null ? List.of() : innerGaps);
            inner.removeIf(g -> g == null || g.from() == null || g.to() == null
                    || !g.to().isAfter(g.from()));
            inner.sort(Comparator.comparing((GapRun g) -> Duration.between(g.from(), g.to()))
                    .reversed().thenComparing(GapRun::from));
            inner.stream().limit(range == HistoryRange.DAY ? MAX_PER_TYPE : Long.MAX_VALUE)
                    .forEach(g -> luecken.add(luecke(g.from(), g.to())));
            Instant nachLetzter = row.lastInWindow().plus(SLOT);
            if (nachLetzter.isBefore(coverage.expectedTo())) {
                boolean stilleAmEnde = row.lastInWindow().equals(row.siteLast());
                if (stilleAmEnde) {
                    out.add(new HistoryEventDto("geraet-still", nachLetzter, coverage.expectedTo(),
                            "Keine Messwerte mehr - das Gerät meldet sich nicht"));
                } else {
                    luecken.add(luecke(nachLetzter, coverage.expectedTo()));
                }
            }
        }
        if (range == HistoryRange.DAY) {
            luecken.forEach(r -> out.add(ereignis(range, "datenluecke", Buendel.von(r))));
        } else {
            out.addAll(ereignisse(range, "datenluecke", luecken));
        }
        return out;
    }

    /** Eine Lücke als Fenster ohne Werte. */
    private static Run luecke(Instant from, Instant to) {
        return new Run(from, to, null, null, null,
                (int) (Duration.between(from, to).toMinutes() / SLOT.toMinutes()));
    }

    // ---- Helfer ---------------------------------------------------------------

    /** „4 Std 15 Min" / „45 Min" / „2 Std" - nie „0 Std 45 Min". */
    static String dauer(Duration d) {
        long minutes = Math.max(0, d.toMinutes());
        long h = minutes / 60;
        long m = minutes % 60;
        if (h == 0) {
            return m + " Min";
        }
        return m == 0 ? h + " Std" : h + " Std " + m + " Min";
    }

    private static BigDecimal ctPerKwh(BigDecimal eurPerMwh) {
        return eurPerMwh.divide(BigDecimal.TEN, java.math.MathContext.DECIMAL64);
    }
}
