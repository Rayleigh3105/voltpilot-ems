package com.voltpilot.api.history;

import com.voltpilot.api.repo.HistoryRepository.CoverageRow;
import com.voltpilot.api.repo.HistoryRepository.GapRun;
import com.voltpilot.api.repo.HistoryRepository.ValueSlot;
import com.voltpilot.api.web.dto.HistoryCoverageDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

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
     * Wie viele Fenster je Art höchstens ausgeliefert werden - die LÄNGSTEN
     * zuerst. Eine unauffällige Anlage bleibt weit darunter; eine sehr flatterige
     * würde die Antwort sonst mit hunderten Ein-Slot-Fenstern fluten. Die Zahl
     * der Fehlstellen sagt unabhängig davon die Datenlage der Zeit-Leiste
     * ({@link HistoryCoverageDto#gaps}), es geht also keine Information verloren.
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
     * Die Spur eines Zeitraums, chronologisch.
     *
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
            List<ValueSlot> negativePrices,
            List<ValueSlot> curtailments,
            List<ValueSlot> gridLimits,
            List<ValueSlot> gridCharges,
            List<GapRun> innerGaps,
            CoverageRow row,
            HistoryCoverageDto coverage) {

        List<HistoryEventDto> events = new ArrayList<>();
        events.addAll(fromRuns(negativePrices, "negativpreis", Ereignisse::negativpreisText));
        events.addAll(fromRuns(curtailments, "abregelung", Ereignisse::abregelungText));
        events.addAll(fromRuns(gridLimits, "netzgrenze", Ereignisse::netzgrenzeText));
        events.addAll(fromRuns(gridCharges, "netzladen", Ereignisse::netzladenText));
        events.addAll(gapEvents(innerGaps, row, coverage));
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

    /** Fenster -> Ereignisse, die {@value #MAX_PER_TYPE} längsten je Art. */
    private static List<HistoryEventDto> fromRuns(List<ValueSlot> slots, String type,
            java.util.function.Function<Run, String> text) {
        List<Run> all = runs(slots);
        all.sort(Comparator.comparing((Run r) -> r.dauer()).reversed()
                .thenComparing(Run::from));
        return all.stream()
                .limit(MAX_PER_TYPE)
                .map(r -> new HistoryEventDto(type, r.from(), r.to(), text.apply(r)))
                .toList();
    }

    // ---- die Texte (deutsch, ohne Zeitangabe - die trägt die Oberfläche) -----

    private static String negativpreisText(Run r) {
        String dauer = dauer(r.dauer());
        if (r.min() == null) {
            return "Negative Börsenpreise: " + dauer;
        }
        return String.format(Locale.GERMANY, "Negative Börsenpreise: %s, bis %.1f ct/kWh",
                dauer, ctPerKwh(r.min()));
    }

    private static String abregelungText(Run r) {
        // Aus den gespeicherten Fahrplänen - eine Vorher-Rechnung, keine Messung.
        BigDecimal kwh = r.sum().multiply(new BigDecimal("0.25"));
        return String.format(Locale.GERMANY,
                "PV-Abregelung eingeplant: %s (%.1f kWh)", dauer(r.dauer()), kwh);
    }

    private static String netzgrenzeText(Run r) {
        if (r.min() == null) {
            return "Netzgrenze gemeldet (§ 14a): " + dauer(r.dauer());
        }
        return String.format(Locale.GERMANY,
                "Netzgrenze gemeldet (§ 14a): %s, höchstens %.1f kW", dauer(r.dauer()), r.min());
    }

    private static String netzladenText(Run r) {
        return String.format(Locale.GERMANY,
                "Speicher aus dem Netz geladen: %s (ca. %.1f kWh)", dauer(r.dauer()), r.sum());
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

        StringBuilder text = new StringBuilder();
        text.append(String.format(Locale.GERMANY, "Abendverkauf %s bis %s · %.1f kWh",
                uhr(start, zone), uhr(end, zone), kwh));
        if (minCt != null) {
            text.append(minCt.compareTo(maxCt) == 0
                    ? String.format(Locale.GERMANY, " zu %.1f ct", minCt)
                    : String.format(Locale.GERMANY, " zu %.1f bis %.1f ct", minCt, maxCt));
            if (erloesEur != null) {
                text.append(String.format(Locale.GERMANY, " (%.2f €)", erloesEur));
            }
        }
        text.append('.');

        if (prognoseKwh != null && gemessenKwh != null) {
            text.append(String.format(Locale.GERMANY,
                    " Prognose für die Nacht %.0f kWh, gemessen %.0f kWh",
                    prognoseKwh, gemessenKwh));
            if (prognoseKwh.signum() > 0) {
                BigDecimal abweichung = gemessenKwh
                        .divide(prognoseKwh, java.math.MathContext.DECIMAL64)
                        .subtract(BigDecimal.ONE)
                        .multiply(BigDecimal.valueOf(100));
                text.append(String.format(Locale.GERMANY, " (%+.0f %%)", abweichung));
            }
            text.append('.');
        }

        List<String> nacht = new ArrayList<>();
        if (bodenAt != null) {
            nacht.add("Speicher leer um " + uhr(bodenAt, zone));
        }
        if (bezugKwh != null && bezugKwh.compareTo(new BigDecimal("0.05")) > 0) {
            StringBuilder b = new StringBuilder(String.format(Locale.GERMANY,
                    "Netzbezug bis %s %.1f kWh", uhr(nachtEnde, zone), bezugKwh));
            if (bezugEur != null) {
                b.append(String.format(Locale.GERMANY, " (%.2f €)", bezugEur));
            }
            nacht.add(b.toString());
        }
        if (!nacht.isEmpty()) {
            text.append(' ').append(String.join("; ", nacht)).append('.');
        }
        return new HistoryEventDto("abendverkauf", start, end, text.toString());
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
     */
    private static List<HistoryEventDto> gapEvents(List<GapRun> innerGaps,
            CoverageRow row,
            HistoryCoverageDto coverage) {
        if (coverage == null || row == null) {
            return List.of();
        }
        List<HistoryEventDto> out = new ArrayList<>();
        if (row.firstInWindow() == null) {
            // Kein einziger Messwert im Zeitraum: EINE Lücke, der ganze Zeitraum.
            if (coverage.expectedTo().isAfter(coverage.expectedFrom())) {
                out.add(luecke(coverage.expectedFrom(), coverage.expectedTo(), row, coverage));
            }
            return out;
        }
        if (row.firstInWindow().isAfter(coverage.expectedFrom())) {
            out.add(luecke(coverage.expectedFrom(), row.firstInWindow(), row, coverage));
        }
        List<GapRun> inner = new ArrayList<>(innerGaps == null ? List.of() : innerGaps);
        inner.removeIf(g -> g == null || g.from() == null || g.to() == null
                || !g.to().isAfter(g.from()));
        inner.sort(Comparator.comparing((GapRun g) -> Duration.between(g.from(), g.to())).reversed()
                .thenComparing(GapRun::from));
        inner.stream().limit(MAX_PER_TYPE)
                .forEach(g -> out.add(luecke(g.from(), g.to(), row, coverage)));
        Instant nachLetzter = row.lastInWindow().plus(SLOT);
        if (nachLetzter.isBefore(coverage.expectedTo())) {
            out.add(luecke(nachLetzter, coverage.expectedTo(), row, coverage));
        }
        return out;
    }

    private static HistoryEventDto luecke(Instant from, Instant to,
            CoverageRow row,
            HistoryCoverageDto coverage) {
        boolean stilleAmEnde = to.equals(coverage.expectedTo())
                && row.lastInWindow() != null
                && row.lastInWindow().equals(row.siteLast());
        if (stilleAmEnde) {
            return new HistoryEventDto("geraet-still", from, to,
                    "Keine Messwerte mehr - das Gerät meldet sich nicht");
        }
        return new HistoryEventDto("datenluecke", from, to,
                "Datenlücke: " + dauer(Duration.between(from, to)) + " ohne Messwerte");
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
