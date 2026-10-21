package com.voltpilot.api.history;

import com.voltpilot.api.erzeuger.ErzeugerRegisterbild;
import com.voltpilot.api.erzeuger.VorgabenAbleitung;
import com.voltpilot.api.erzeuger.VorgabenRepository.LueckeZeile;
import com.voltpilot.api.erzeuger.VorgabenRepository.Zeile;
import com.voltpilot.api.erzeuger.VorgabenZaehlung;
import com.voltpilot.api.repo.HistoryRepository.CoverageRow;
import com.voltpilot.api.repo.HistoryRepository.GapRun;
import com.voltpilot.api.repo.HistoryRepository.ValueSlot;
import com.voltpilot.api.web.dto.HistoryCoverageDto;
import com.voltpilot.api.web.dto.ErzeugerVorgabenDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import com.voltpilot.api.web.dto.HistoryVorgabenDto;
import java.math.BigDecimal;
import java.math.MathContext;
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
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;

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

    // ---- Vorgaben einer Erzeugeranlage (UEMS EZ-9, Konzept vp-erzeuger-wago-konzept §4.5, EW-12 A)

    /**
     * Die Arten der Vorgaben in Spur, Chronik und „Nach Art“ - in dieser Reihenfolge. Der Zwilling ist
     * {@code frontend/portal/src/historieEreignisse.ts} ({@code VORGABEN_ARTEN}); beide zusammen ändern.
     */
    public static final List<String> VORGABEN_ARTEN =
            List.of("netzbetreiber", "direktvermarkter", "nicht-bereit");

    /**
     * Die Art einer Vorgabe im Verlauf, oder {@code null}: Netzbetreiber und Direktvermarkter für die ganze Anlage
     * (je Einheit stehen ihre Vorgaben nur in der Zählung, sonst stünde ein Abruf dreimal in der Chronik),
     * „nicht bereit“ je Einheit. Was die Anlage selbst, die Hand, ein Ersatzwert oder der Schutz begrenzt, nennt
     * die Chronik der Vorgaben samt CSV; §4.5 bringt in den Verlauf die drei Arten von außen.
     */
    static String vorgabenArt(Zeile z) {
        if ("nicht_bereit".equals(z.art())) {
            return "nicht-bereit";
        }
        if (z.teNr() != null) {
            return null;
        }
        return switch (z.urheber()) {
            case "netzbetreiber" -> "netzbetreiber";
            case "direktvermarkter" -> "direktvermarkter";
            default -> null;
        };
    }

    /** Die Art einer Lücke mit weiteren Wechseln: der Urheber, dessen Zähler sprang. */
    private static String lueckenArt(LueckeZeile l) {
        return "netzbetreiber".equals(l.urheber()) || "direktvermarkter".equals(l.urheber()) ? l.urheber() : null;
    }

    /**
     * <b>Die Vorgaben als Ereignisse</b> - Quelle sind die abgeleiteten Vorgaben aus EZ-7, keine neue Messung.
     *
     * <p><b>Im Tag</b> ist jede Vorgabe ein Ereignis (ohne Kappung: eine Vorgabe ist ein Wechsel an der Steuerung,
     * kein Rauschen, und das Protokoll soll vollständig sein), dazu jede Datenlücke, in der der Zähler eines Urhebers
     * weitere Wechsel zählt ({@code count} 0 - sie ist keine Vorgabe). <b>Ab der Woche</b> bündelt ein Ereignis je Art
     * die Vorgaben eines Tages (im Jahr eines Monats); Anzahl, Dauer und Energie zählt dafür {@link VorgabenZaehlung}
     * - dieselben Zahlen wie die Route „Nach Art“ und die Kachel „Wer hat heute geregelt?“.
     *
     * <p>{@code start}/{@code end} sind auf den Zeitraum bzw. den Tag geschnitten (eine Grenze, die seit Jahren
     * gilt, liegt sonst vor dem Diagramm); eine laufende Vorgabe endet bei der letzten Lesung, in der sie galt - nie
     * in der Zukunft. Die Energie ist ihr Anteil im Abschnitt ({@code energie_je_tag}), {@code null} ohne Grundlage.
     */
    public static List<HistoryEventDto> vorgaben(HistoryRange range, HistoryRange.Window window,
            List<Zeile> zeilen, List<LueckeZeile> luecken) {
        List<HistoryEventDto> out = new ArrayList<>();
        if (range == HistoryRange.DAY) {
            LocalDate tag = window.from().atZone(HistoryRange.ZONE).toLocalDate();
            for (Zeile z : zeilen) {
                String art = vorgabenArt(z);
                if (art == null || !VorgabenZaehlung.beruehrt(z, window.from(), window.to())) {
                    continue;
                }
                out.add(vorgabe(art, z, window.from(), window.to(), tag));
            }
            for (LueckeZeile l : luecken) {
                String art = lueckenArt(l);
                if (art != null && l.beginn().isBefore(window.to()) && !l.ende().isBefore(window.from())) {
                    out.add(luecke(art, l, window.from(), window.to()));
                }
            }
        } else {
            for (LocalDate[] p : abschnitte(range, window)) {
                Instant b = max(p[0].atStartOfDay(HistoryRange.ZONE).toInstant(), window.from());
                Instant e = min(p[1].plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant(), window.to());
                for (String art : VORGABEN_ARTEN) {
                    HistoryEventDto ereignis = buendel(range, art, zeilen, luecken, b, e, p[0], p[1]);
                    if (ereignis != null) {
                        out.add(ereignis);
                    }
                }
            }
        }
        out.sort(Comparator.comparing(HistoryEventDto::start));
        return out;
    }

    /** Die Tage (Woche, Monat) bzw. Monate (Jahr) eines Zeitraums als erster/letzter Tag. */
    private static List<LocalDate[]> abschnitte(HistoryRange range, HistoryRange.Window window) {
        LocalDate erster = window.from().atZone(HistoryRange.ZONE).toLocalDate();
        LocalDate letzter = window.to().minusNanos(1).atZone(HistoryRange.ZONE).toLocalDate();
        List<LocalDate[]> out = new ArrayList<>();
        if (range == HistoryRange.YEAR) {
            for (YearMonth m = YearMonth.from(erster); !m.isAfter(YearMonth.from(letzter)); m = m.plusMonths(1)) {
                out.add(new LocalDate[] {m.atDay(1), m.atEndOfMonth()});
            }
        } else {
            for (LocalDate t = erster; !t.isAfter(letzter); t = t.plusDays(1)) {
                out.add(new LocalDate[] {t, t});
            }
        }
        return out;
    }

    /** Eine Vorgabe im Tag: ihr Anteil am Tag, wie ihn die Zählung rechnet. */
    private static HistoryEventDto vorgabe(String art, Zeile z, Instant von, Instant bis, LocalDate tag) {
        ErzeugerVorgabenDto.Gruppe anteil = VorgabenZaehlung.gruppen(List.of(z), von, bis, tag, tag).get(0);
        Instant start = max(z.beginn(), von);
        Instant end = max(start, min(z.belegtBis(), bis));
        BigDecimal energie = anteil.energieKwh();
        return new HistoryEventDto(art, start, end, vorgabeSatz(art, z, energie), energie,
                energie == null ? null : "kWh", false, anteil.dauerS() / 60, 1, 1, List.of(),
                new HistoryEventDto.Vorgabe(z.id(), z.urheber(), z.art(), z.teNr(), z.einheitName(), z.beginn(),
                        z.beginnGenau(), z.ende(), z.ende() == null, z.vorgabeProzent(), z.vorgabeW(), z.bindung(),
                        anteil.wertEur(), z.unvollstaendig() ? 1 : 0, 0, null, gruende(z.gruende())));
    }

    /** Eine Datenlücke, in der der Zähler eines Urhebers weitere Wechsel zählt - ohne erfundene Zeiten. */
    private static HistoryEventDto luecke(String art, LueckeZeile l, Instant von, Instant bis) {
        Instant start = max(l.beginn(), von);
        Instant end = max(start, min(l.ende(), bis));
        return new HistoryEventDto(art, start, end, urheberWort(art) + ": " + weitereText(l.weitereWechsel()), null,
                null, false, Duration.between(start, end).toMinutes(), 0, 1, List.of(),
                new HistoryEventDto.Vorgabe(null, l.urheber(), null, null, null, l.beginn(), false, l.ende(), false,
                        null, null, null, null, 0, 1, l.weitereWechsel(), List.of()));
    }

    /** Die Vorgaben einer Art an einem Tag (Woche, Monat) bzw. in einem Monat (Jahr) - oder null. */
    private static HistoryEventDto buendel(HistoryRange range, String art, List<Zeile> zeilen,
            List<LueckeZeile> luecken, Instant b, Instant e, LocalDate ersterTag, LocalDate letzterTag) {
        List<Zeile> eigene = zeilen.stream()
                .filter(z -> art.equals(vorgabenArt(z)) && VorgabenZaehlung.beruehrt(z, b, e)).toList();
        List<LueckeZeile> eigeneLuecken = luecken.stream()
                .filter(l -> art.equals(lueckenArt(l)) && !l.beginn().isBefore(b) && l.beginn().isBefore(e))
                .toList();
        if (eigene.isEmpty() && eigeneLuecken.isEmpty()) {
            return null;
        }
        Summe s = summe(art, eigene, b, e, ersterTag, letzterTag);
        Instant start = null;
        Instant end = null;
        Set<LocalDate> tage = new HashSet<>();
        boolean laeuft = false;
        for (Zeile z : eigene) {
            Instant von = max(z.beginn(), b);
            Instant bis = max(von, min(z.belegtBis(), e));
            start = start == null ? von : min(start, von);
            end = end == null ? bis : max(end, bis);
            tage.addAll(tageIn(von, bis));
            // „läuft“ trägt nur das Bündel, in dem sie zuletzt gesehen wurde - nicht jeder Tag seit ihrem Beginn.
            laeuft |= z.ende() == null && !z.belegtBis().isBefore(b) && !z.belegtBis().isAfter(e);
        }
        for (LueckeZeile l : eigeneLuecken) {
            Instant von = max(l.beginn(), b);
            Instant bis = max(von, min(l.ende(), e));
            start = start == null ? von : min(start, von);
            end = end == null ? bis : max(end, bis);
        }
        Integer weitere = weitere(eigeneLuecken);
        List<String> teile = new ArrayList<>();
        if (s.anzahl > 0) {
            teile.add(s.anzahl == 1 ? dauer(Duration.ofSeconds(s.dauerS))
                    : s.anzahl + "×, zusammen " + dauer(Duration.ofSeconds(s.dauerS)));
        }
        if (s.energie != null && s.energie.signum() > 0) {
            teile.add(String.format(Locale.GERMANY, "geschätzt %.1f kWh nicht erzeugt", s.energie));
        }
        if (!eigeneLuecken.isEmpty()) {
            teile.add(eigeneLuecken.size() == 1 ? weitereText(weitere)
                    : weitere == null ? "weitere Wechsel während Datenlücken (Zahl unbekannt)"
                    : weitere + (weitere == 1 ? " weiterer Wechsel" : " weitere Wechsel") + " während Datenlücken");
        }
        String text = urheberWort(art) + ": " + String.join("; ", teile);
        return new HistoryEventDto(art, start, end, text, s.energie, s.energie == null ? null : "kWh",
                false, s.dauerS / 60, s.anzahl, range == HistoryRange.YEAR ? Math.max(1, tage.size()) : 1, List.of(),
                new HistoryEventDto.Vorgabe(null, urheber(art), null, null, null, null, false, null, laeuft, null,
                        null, null, s.wert, s.unvollstaendig, eigeneLuecken.size(), weitere, List.of()));
    }

    /**
     * <b>„Nach Art“</b>: je Art der ganze Zeitraum samt seinen Einheiten, im Jahr dazu je Monat - gezählt von
     * {@link VorgabenZaehlung} über EINEN Abschnitt, damit eine Vorgabe über Mitternacht einmal zählt.
     */
    public static HistoryVorgabenDto vorgabenZaehlung(HistoryRange range, HistoryRange.Window window,
            List<Zeile> zeilen, List<LueckeZeile> luecken, Instant verarbeitetBis) {
        List<HistoryVorgabenDto.Zaehlung> out = new ArrayList<>(zaehlung(null, window.from(), window.to(),
                zeilen, luecken, true));
        if (range == HistoryRange.YEAR) {
            for (LocalDate[] m : abschnitte(range, window)) {
                Instant b = max(m[0].atStartOfDay(HistoryRange.ZONE).toInstant(), window.from());
                Instant e = min(m[1].plusDays(1).atStartOfDay(HistoryRange.ZONE).toInstant(), window.to());
                out.addAll(zaehlung(YearMonth.from(m[0]).toString(), b, e, zeilen, luecken, false));
            }
        }
        return new HistoryVorgabenDto(verarbeitetBis, List.copyOf(out));
    }

    private static List<HistoryVorgabenDto.Zaehlung> zaehlung(String periode, Instant b, Instant e,
            List<Zeile> zeilen, List<LueckeZeile> luecken, boolean jeEinheit) {
        LocalDate erster = b.atZone(HistoryRange.ZONE).toLocalDate();
        LocalDate letzter = e.minusNanos(1).atZone(HistoryRange.ZONE).toLocalDate();
        List<HistoryVorgabenDto.Zaehlung> out = new ArrayList<>();
        for (String art : VORGABEN_ARTEN) {
            List<Zeile> eigene = zeilen.stream()
                    .filter(z -> art.equals(vorgabenArt(z)) && VorgabenZaehlung.beruehrt(z, b, e)).toList();
            List<LueckeZeile> eigeneLuecken = luecken.stream()
                    .filter(l -> art.equals(lueckenArt(l)) && !l.beginn().isBefore(b) && l.beginn().isBefore(e))
                    .toList();
            if (!eigene.isEmpty() || !eigeneLuecken.isEmpty()) {
                out.add(zeile(periode, art, null, null, summe(art, eigene, b, e, erster, letzter),
                        eigeneLuecken));
            }
            if (!jeEinheit) {
                continue;
            }
            // Je Einheit: beim Direktvermarkter seine Abrufe je Motor/WR, bei „nicht bereit“ jede Einheit.
            List<Zeile> jeTe = zeilen.stream()
                    .filter(z -> z.teNr() != null && VorgabenZaehlung.beruehrt(z, b, e)
                            && ("nicht-bereit".equals(art) ? "nicht_bereit".equals(z.art())
                                    : urheber(art).equals(z.urheber()) && !"nicht_bereit".equals(z.art())))
                    .toList();
            Map<Integer, List<Zeile>> nachTe = new TreeMap<>();
            jeTe.forEach(z -> nachTe.computeIfAbsent(z.teNr(), k -> new ArrayList<>()).add(z));
            nachTe.forEach((te, liste) -> out.add(zeile(periode, art, te,
                    liste.stream().map(Zeile::einheitName).filter(Objects::nonNull).findFirst().orElse(null),
                    summeGruppen(VorgabenZaehlung.gruppen(liste, b, e, erster, letzter)), List.of())));
        }
        return out;
    }

    private static HistoryVorgabenDto.Zaehlung zeile(String periode, String art, Integer teNr, String name,
            Summe s, List<LueckeZeile> luecken) {
        return new HistoryVorgabenDto.Zaehlung(periode, art, teNr, name, s.anzahl, s.dauerS / 60, s.energie, s.wert,
                s.ohneSchaetzung, s.unvollstaendig, Map.copyOf(s.arten), luecken.size(), weitere(luecken));
    }

    /** Die Zahlen einer Art: je Urheber vereinigt (ganze Anlage), „nicht bereit“ über die Einheiten summiert. */
    private static Summe summe(String art, List<Zeile> eigene, Instant b, Instant e, LocalDate ersterTag,
            LocalDate letzterTag) {
        List<ErzeugerVorgabenDto.Gruppe> gruppen = VorgabenZaehlung.gruppen(eigene, b, e, ersterTag, letzterTag);
        Summe s = summeGruppen(gruppen);
        if (!"nicht-bereit".equals(art)) {
            VorgabenZaehlung.jeUrheber(eigene, b, e, ersterTag, letzterTag).stream()
                    .filter(j -> j.urheber().equals(urheber(art))).findFirst().ifPresent(j -> {
                        s.anzahl = j.anzahl();
                        s.dauerS = j.dauerS();
                        s.energie = j.energieKwh();
                        s.wert = j.wertEur();
                    });
        }
        return s;
    }

    private static Summe summeGruppen(List<ErzeugerVorgabenDto.Gruppe> gruppen) {
        Summe s = new Summe();
        for (ErzeugerVorgabenDto.Gruppe g : gruppen) {
            s.anzahl += g.anzahl();
            s.dauerS += g.dauerS();
            s.energie = plus(s.energie, g.energieKwh());
            s.wert = plus(s.wert, g.wertEur());
            s.ohneSchaetzung += g.ohneSchaetzung();
            s.unvollstaendig += g.unvollstaendig();
            s.arten.merge(g.art(), g.anzahl(), Integer::sum);
        }
        return s;
    }

    /** Die Summen einer Art in einem Abschnitt. */
    private static final class Summe {
        int anzahl;
        long dauerS;
        BigDecimal energie;
        BigDecimal wert;
        int ohneSchaetzung;
        int unvollstaendig;
        final Map<String, Integer> arten = new TreeMap<>();
    }

    private static BigDecimal plus(BigDecimal a, BigDecimal b) {
        return a == null ? b : b == null ? a : a.add(b);
    }

    /** Die weiteren Wechsel mehrerer Lücken zusammen; {@code null}, wenn keine oder eine Zahl unbekannt ist. */
    private static Integer weitere(List<LueckeZeile> luecken) {
        if (luecken.isEmpty() || luecken.stream().anyMatch(l -> l.weitereWechsel() == null)) {
            return null;
        }
        return luecken.stream().mapToInt(LueckeZeile::weitereWechsel).sum();
    }

    private static String weitereText(Integer n) {
        if (n == null) {
            return "weitere Wechsel während einer Datenlücke (Zahl unbekannt, die Steuerung startete neu)";
        }
        return n + (n == 1 ? " weiterer Wechsel" : " weitere Wechsel") + " während einer Datenlücke";
    }

    /** Die Tage (Berliner Zeit), die {@code [von, bis)} berührt; ein Zeitpunkt ohne Dauer seinen Tag. */
    private static Set<LocalDate> tageIn(Instant von, Instant bis) {
        Set<LocalDate> out = new HashSet<>();
        LocalDate erster = von.atZone(HistoryRange.ZONE).toLocalDate();
        LocalDate letzter = bis.isAfter(von) ? bis.minusNanos(1).atZone(HistoryRange.ZONE).toLocalDate() : erster;
        for (LocalDate t = erster; !t.isAfter(letzter); t = t.plusDays(1)) {
            out.add(t);
        }
        return out;
    }

    /** Der Urheber einer Art; „nicht bereit“ meldet die Einheit selbst (Urheber {@code anlage} in EZ-7). */
    private static String urheber(String art) {
        return "nicht-bereit".equals(art) ? "anlage" : art;
    }

    private static String urheberWort(String art) {
        return switch (art) {
            case "netzbetreiber" -> "Netzbetreiber";
            case "direktvermarkter" -> "Direktvermarkter";
            default -> "Nicht bereit";
        };
    }

    /**
     * Der Satz einer Vorgabe - „Vorgabe“, beim Direktvermarkter „Abruf“, nie „Eingriff“ (§4.1: das Wort meint im
     * Portal den Handeingriff).
     */
    static String vorgabeSatz(String art, Zeile z, BigDecimal energie) {
        StringBuilder s = new StringBuilder();
        switch (art) {
            case "netzbetreiber" -> {
                switch (z.art()) {
                    case "abschaltung" -> s.append("Netzbetreiber schaltet die Anlage ab");
                    case "q_vorgabe" -> s.append("Netzbetreiber gibt den cos φ vor");
                    default -> s.append(z.vorgabeProzent() != null
                            ? String.format(Locale.GERMANY, "Netzbetreiber begrenzt auf %.0f %%", z.vorgabeProzent())
                            : z.vorgabeW() != null ? String.format(Locale.GERMANY, "Netzbetreiber begrenzt auf %.1f kW",
                                    kw(z.vorgabeW()))
                            : "Netzbetreiber begrenzt die Anlage");
                }
            }
            case "direktvermarkter" -> s.append("dv_stopp".equals(z.art()) ? "Direktvermarkter stoppt die Anlage"
                    : z.vorgabeW() != null ? String.format(Locale.GERMANY, "Direktvermarkter ruft %.1f kW ab",
                            kw(z.vorgabeW()))
                    : "Direktvermarkter ruft ab");
            default -> {
                s.append(z.einheitName() != null ? z.einheitName() : "Einheit " + z.teNr())
                        .append(" nicht bereit für den Direktvermarkter");
                List<String> gruende = gruende(z.gruende());
                if (!gruende.isEmpty()) {
                    s.append(": ").append(String.join(", ", gruende));
                }
            }
        }
        if ("nicht_bindend".equals(z.bindung())) {
            s.append(" (nicht bindend)");
        }
        if (energie != null && energie.signum() > 0) {
            s.append(String.format(Locale.GERMANY, ", geschätzt %.1f kWh nicht erzeugt", energie));
        }
        if (z.unvollstaendig()) {
            s.append(" - unvollständig");
        }
        return s.toString();
    }

    /** Die Gründe für „nicht bereit“ in den Worten des Bilds ({@code t_bits} Bit 4-9); ein fremdes Wort bleibt roh. */
    static List<String> gruende(List<String> woerter) {
        if (woerter == null || woerter.isEmpty()) {
            return List.of();
        }
        List<ErzeugerRegisterbild.Bit> bits = ErzeugerRegisterbild.feld(VorgabenAbleitung.einheit(1, "t_bits"))
                .map(ErzeugerRegisterbild.Feld::bits).orElse(List.of());
        return woerter.stream().map(w -> bits.stream().filter(b -> b.wort().equals(w))
                .map(ErzeugerRegisterbild.Bit::text).findFirst().orElse(w)).toList();
    }

    private static BigDecimal kw(BigDecimal w) {
        return w.divide(BigDecimal.valueOf(1000), MathContext.DECIMAL64);
    }

    private static Instant max(Instant a, Instant b) {
        return a.isAfter(b) ? a : b;
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

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
