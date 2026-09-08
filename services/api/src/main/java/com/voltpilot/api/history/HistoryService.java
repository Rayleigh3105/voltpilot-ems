package com.voltpilot.api.history;

import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.SlotEconomics;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.web.dto.HistoryBucketDto;
import com.voltpilot.api.web.dto.HistoryCoverageDto;
import com.voltpilot.api.web.dto.HistoryDto;
import com.voltpilot.api.web.dto.HistoryEventDto;
import com.voltpilot.api.web.dto.HistoryPlanPointDto;
import com.voltpilot.api.web.dto.HistoryTotalsDto;
import com.voltpilot.api.web.dto.ProtocolEventDto;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.stereotype.Service;

/**
 * Assembles a site's Historie response for one period: the bucketed series
 * (day = live 15-min from raw telemetry; week/month/year = the precomputed
 * rollups), the period totals (formulas documented on
 * {@link HistoryTotalsDto}), and for the day range the Tagesprotokoll plus
 * the plan-vs-actual overlay. Tenant scoping is entirely RLS (the repository
 * reads as the app role), so this service never sees foreign data.
 */
@Service
public class HistoryService {

    private final HistoryRepository repo;

    /**
     * Nur zum LESEN der Anlagen-Ökonomie ({@link SlotEconomics}) für den
     * Erlös-Satz des Abendverkaufs - dieselbe Rekomposition, die auch die
     * Fahrplan-Seite liest ({@code SchedulePricingService}). Die Erlös-Rechnung
     * selbst bleibt unangetastet.
     */
    private final OptimizerDiagnosticsService diagnostics;

    public HistoryService(HistoryRepository repo, OptimizerDiagnosticsService diagnostics) {
        this.repo = repo;
        this.diagnostics = diagnostics;
    }

    public HistoryDto history(UUID siteId, String biddingZone, HistoryRange range, LocalDate at) {
        HistoryRange.Window window = range.window(at);

        // MIG v1->v2 history bridge: an un-migrated site (cutover null) reads
        // pure v1, byte-identical to before. A migrated site splices at the
        // cutover instant - v1 owns buckets that START before it, v2 owns those
        // at/after it - so the series is gap-free AND overlap-free (every bucket
        // start is either < or >= the instant). Totals/protocol/plan are then
        // computed over the merged bucket list unchanged (era-agnostic).
        Instant cutover = repo.v2HistoryCutover(siteId);
        List<HistoryBucketDto> buckets = buckets(siteId, biddingZone, range, window, cutover);

        HistoryTotalsDto totals = totals(buckets,
                repo.plannedSavings(siteId, window.from(), window.to()),
                repo.tariffContext(siteId));

        List<ProtocolEventDto> protocol = range == HistoryRange.DAY
                ? Tagesprotokoll.build(buckets)
                : List.of();
        List<HistoryPlanPointDto> plan = range == HistoryRange.DAY
                ? repo.planForWindow(siteId, window.from(), window.to())
                : List.of();

        // Die Abdeckungs-Rohzahlen werden EINMAL geholt und zweimal gelesen: die
        // Zeit-Leiste zählt daraus die Fehlstellen, die Ereignis-Spur setzt ihre
        // Rand-Marker auf dieselben Grenzen - sonst stünde „6 Lücken" über vier
        // Markern.
        HistoryRepository.CoverageRow coverageRow =
                repo.coverage(siteId, window.from(), window.to());
        HistoryCoverageDto coverage = coverage(coverageRow, window, Instant.now());

        return new HistoryDto(range.name().toLowerCase(java.util.Locale.ROOT),
                window.from(), window.to(), range.bucketMinutes(), buckets, totals, protocol, plan,
                coverage, events(siteId, biddingZone, range, window, coverageRow, coverage,
                        at, cutover));
    }

    /**
     * Die Ereignis-Spur (F6) eines Zeitraums. Jede Abfrage liefert nur die
     * auffälligen Viertelstunden; Fenster, Texte und Obergrenzen entstehen in der
     * reinen {@link Ereignisse}.
     *
     * <p>Die §-14a-Netzgrenze steht ausschließlich in der ROHEN {@code telemetry}
     * (die Rollup-Kaskade führt die Spalte nicht), deshalb wird sie nur für
     * begrenzte Fenster gelesen - {@link Ereignisse#evaluatesGridLimit}. Die
     * Oberfläche spricht das aus, statt das Fehlen eines Markers als „keine
     * Netzgrenze" lesen zu lassen.
     */
    private List<HistoryEventDto> events(UUID siteId, String biddingZone, HistoryRange range,
            HistoryRange.Window window, HistoryRepository.CoverageRow coverageRow,
            HistoryCoverageDto coverage, LocalDate at, Instant cutover) {
        List<HistoryEventDto> events = new java.util.ArrayList<>(Ereignisse.build(
                repo.negativePriceSlots(biddingZone, window.from(), window.to()),
                repo.curtailSlots(siteId, window.from(), window.to()),
                Ereignisse.evaluatesGridLimit(range)
                        ? repo.gridLimitSlots(siteId, window.from(), window.to())
                        : List.of(),
                repo.gridChargeSlots(siteId, window.from(), window.to()),
                repo.dataGaps(siteId, window.from(), window.to()),
                coverageRow, coverage));
        if (range == HistoryRange.DAY) {
            HistoryEventDto abendverkauf = abendverkauf(siteId, biddingZone, at, cutover);
            if (abendverkauf != null) {
                events.add(abendverkauf);
                events.sort(java.util.Comparator.comparing(HistoryEventDto::start));
            }
        }
        return events;
    }

    // ---- Abendverkauf (P2 des Nachtreserve-Konzepts) --------------------------

    /**
     * Das Ereignis „Abendverkauf" des angezeigten Tages, oder {@code null}.
     *
     * <p><b>Nur im Tages-Zeitraum</b>: die Erklärung besteht aus Viertelstunden
     * eines Abends und der darauf folgenden Nacht - in einem Monatsfenster wären
     * das dreißig Nächte und dreißig Abfragen. Genau wie das Tagesprotokoll und
     * die Plan-Überlagerung bleibt sie deshalb dem Tag vorbehalten.
     *
     * <p><b>Die Nacht reicht über den Zeitraum hinaus</b> (18:00 bis 07:00 des
     * Folgetags): sie wird mit demselben Bucket-Weg gelesen wie die
     * Tagesreihe - inklusive v1/v2-Naht -, damit dieselbe Zahl herauskommt, die
     * der Kunde am nächsten Tag im Diagramm sieht.
     */
    private HistoryEventDto abendverkauf(UUID siteId, String biddingZone, LocalDate at,
            Instant cutover) {
        ZoneId zone = HistoryRange.ZONE;
        List<HistoryRepository.VerkaufSlot> geplant = repo.verkaufSlots(siteId,
                at.atTime(VERKAUF_VON, 0).atZone(zone).toInstant(),
                at.atTime(VERKAUF_BIS, 0).atZone(zone).toInstant());
        if (geplant.isEmpty()) {
            return null;
        }
        // Der Erlös je kWh entsteht aus DERSELBEN Rechnung wie auf der
        // Fahrplan-Seite (SlotEconomics wird hier nur GELESEN). Fehlt die
        // Anlagen-Ökonomie (RLS), bleibt der reine Börsenpreis - und fehlt auch
        // der, nennt der Text keinen Preis.
        SlotEconomics economics = diagnostics.economicsFor(siteId,
                geplant.get(0).slot(), geplant.get(geplant.size() - 1).slot());
        List<Ereignisse.VerkaufSlotWert> werte = new java.util.ArrayList<>(geplant.size());
        for (HistoryRepository.VerkaufSlot s : geplant) {
            BigDecimal kwh = s.gridKw().negate().multiply(new BigDecimal("0.25"));
            Double spot = s.priceEurMwh() == null ? null : s.priceEurMwh().doubleValue();
            Double ct = economics == null ? null : economics.exportValueCtKwh(spot, s.slot());
            if (ct == null && spot != null) {
                ct = spot / 10.0;
            }
            werte.add(new Ereignisse.VerkaufSlotWert(s.slot(), kwh,
                    ct == null ? null : BigDecimal.valueOf(ct)));
        }

        Instant nachtVon = at.atTime(NACHT_VON, 0).atZone(zone).toInstant();
        Instant nachtBis = at.plusDays(1).atTime(NACHT_BIS, 0).atZone(zone).toInstant();
        BigDecimal prognose = repo.nachtPrognoseKwh(siteId, nachtVon, nachtBis,
                at.atTime(PROGNOSE_LAUF_VOR, 0).atZone(zone).toInstant());

        List<HistoryBucketDto> nacht = buckets(siteId, biddingZone, HistoryRange.DAY,
                new HistoryRange.Window(nachtVon, nachtBis), cutover);
        Instant bodenAb = at.atTime(BODEN_AB, 0).atZone(zone).toInstant();
        Instant boden = null;
        for (HistoryBucketDto b : nacht) {
            if (!b.start().isBefore(bodenAb) && b.socLastPct() != null
                    && b.socLastPct().compareTo(Ereignisse.BODEN_SOC_PCT) <= 0) {
                boden = b.start();
                break;
            }
        }
        Instant bezugAb = at.atTime(BEZUG_AB, 0).atZone(zone).toInstant();
        List<HistoryBucketDto> spaet = nacht.stream()
                .filter(b -> !b.start().isBefore(bezugAb)).toList();

        return Ereignisse.abendverkauf(werte, prognose,
                sum(nacht, HistoryBucketDto::loadKwh), boden,
                sum(spaet, HistoryBucketDto::gridImportKwh),
                sum(spaet, HistoryBucketDto::costEur),
                nachtBis, zone);
    }

    /** Das Verkaufsfenster des Abends (Berliner Stunden, Konzept §P2). */
    static final int VERKAUF_VON = 17;
    static final int VERKAUF_BIS = 23;
    /** Das Nachtfenster, über das Prognose und Messung verglichen werden. */
    static final int NACHT_VON = 18;
    static final int NACHT_BIS = 7;
    /** Bis wann der Lauf erzeugt sein muss, dessen Prognose den Verkauf trug. */
    static final int PROGNOSE_LAUF_VOR = 19;
    /** Ab wann ein leerer Speicher als „Boden der Nacht" zählt. */
    static final int BODEN_AB = 20;
    /** Ab wann der Netzbezug der Nacht zählt. */
    static final int BEZUG_AB = 22;

    // ---- Datenabdeckung (F4/P7) ---------------------------------------------

    /** Die gezählte Einheit: die Messreihe entsteht in Viertelstunden. */
    static final Duration COVERAGE_RESOLUTION = Duration.ofMinutes(15);

    /**
     * Wie weit das 15-Minuten-Rollup der Gegenwart hinterherlaufen darf: der
     * Auffrisch-Job läuft alle 15 Minuten (Migration V20260701030000). Eine
     * gerade erst beendete Viertelstunde ist deshalb noch keine Fehlstelle - sie
     * ist nur noch nicht verdichtet. Lieber eine Lücke zu spät melden als eine
     * erfinden.
     */
    static final Duration ROLLUP_LAG = Duration.ofMinutes(15);

    /**
     * Die reine Abdeckungs-Rechnung (F4/P7): aus den Rohzahlen der Datenbank
     * plus Fenster und „jetzt" wird der erwartete Zeitraum, die gemessene Menge
     * und die Zahl der Fehlstellen.
     *
     * <p>Drei Entscheidungen stecken darin, alle in Richtung Ehrlichkeit:
     * <ul>
     *   <li><b>Erwartet wird erst ab der ersten je gemessenen Viertelstunde.</b>
     *       Ein Kalenderjahr einer im Juni ans Netz gegangenen Anlage ist nicht
     *       zu 45 % lückenhaft - es gab die Anlage vorher nicht. Genau dafür
     *       reist {@code firstDataAt} mit: die Oberfläche sagt „Daten ab …".</li>
     *   <li><b>Die laufende (und die gerade beendete) Viertelstunde zählt
     *       nicht.</b> Sie kann nicht fehlen, und das Rollup ist noch nicht so
     *       weit ({@link #ROLLUP_LAG}).</li>
     *   <li><b>Kein Prozentsatz.</b> Hier stehen Zähler; wie daraus ein Satz
     *       wird, entscheidet die Oberfläche (die dort auch die Regel „nie auf
     *       100 % aufrunden" trägt).</li>
     * </ul>
     *
     * @return null, wenn die Anlage noch nie eine Viertelstunde gemessen hat -
     *         dann behauptet niemand eine Abdeckung.
     */
    static HistoryCoverageDto coverage(HistoryRepository.CoverageRow row,
            HistoryRange.Window window, Instant now) {
        if (row == null || row.siteFirst() == null) {
            return null;
        }
        Instant expectedFrom = max(window.from(), row.siteFirst());
        Instant expectedTo = min(window.to(), floorResolution(now.minus(ROLLUP_LAG)));
        if (!expectedTo.isAfter(expectedFrom)) {
            // Ein Zeitraum, der noch gar nicht laufen konnte (Zukunft) - die
            // Herkunftsangabe bleibt trotzdem nützlich.
            return new HistoryCoverageDto(row.siteFirst(), row.siteLast(),
                    expectedFrom, expectedFrom, 0, 0, 0, (int) COVERAGE_RESOLUTION.toMinutes());
        }
        long expected = Duration.between(expectedFrom, expectedTo).toMinutes()
                / COVERAGE_RESOLUTION.toMinutes();
        // Das Fenster kann durch die Rollup-Toleranz ein paar Viertelstunden
        // MEHR enthalten als der erwartete Zeitraum - dann ist es voll gemessen,
        // nie über 100 %.
        long measured = Math.min(row.measured(), expected);

        int gaps;
        if (measured == 0) {
            gaps = expected > 0 ? 1 : 0;
        } else {
            gaps = row.innerGaps();
            if (row.firstInWindow() != null && row.firstInWindow().isAfter(expectedFrom)) {
                gaps++;
            }
            if (row.lastInWindow() != null
                    && row.lastInWindow().plus(COVERAGE_RESOLUTION).isBefore(expectedTo)) {
                gaps++;
            }
        }
        return new HistoryCoverageDto(row.siteFirst(), row.siteLast(), expectedFrom, expectedTo,
                expected, measured, gaps, (int) COVERAGE_RESOLUTION.toMinutes());
    }

    /** Auf den Beginn der Viertelstunde abrunden (UTC-Raster, wie das Rollup). */
    private static Instant floorResolution(Instant t) {
        long step = COVERAGE_RESOLUTION.getSeconds();
        return Instant.ofEpochSecond(Math.floorDiv(t.getEpochSecond(), step) * step);
    }

    private static Instant max(Instant a, Instant b) {
        return a.isAfter(b) ? a : b;
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

    /**
     * Die Buckets eines Fensters in der Era-Sicht der Anlage: unmigriert = rein
     * v1, sonst die an {@code cutover} gespleißte Reihe. Der EINE Weg, auf dem
     * sowohl die angezeigte Reihe als auch das Nachtfenster des Abendverkaufs
     * gelesen werden - damit beide dieselbe Zahl sehen.
     */
    private List<HistoryBucketDto> buckets(UUID siteId, String biddingZone, HistoryRange range,
            HistoryRange.Window window, Instant cutover) {
        if (cutover == null) {
            return v1Buckets(siteId, biddingZone, range, window);
        }
        return splice(
                v1Buckets(siteId, biddingZone, range, window),
                v2Buckets(siteId, biddingZone, range, window),
                cutover);
    }

    /** v1-era buckets for a range (day = raw telemetry, else = rollups + cost). */
    private List<HistoryBucketDto> v1Buckets(UUID siteId, String biddingZone, HistoryRange range,
            HistoryRange.Window window) {
        if (range == HistoryRange.DAY) {
            return repo.dayBuckets(siteId, window.from(), window.to(), biddingZone);
        }
        List<HistoryBucketDto> buckets =
                repo.rollupBuckets(siteId, window.from(), window.to(), range.dailyBuckets());
        Map<Instant, BigDecimal> costs = repo.costPerBucket(
                siteId, window.from(), window.to(), biddingZone, range.dailyBuckets());
        return buckets.stream().map(b -> withCost(b, costs.get(b.start()))).toList();
    }

    /** v2-era buckets, reconstructed into the SAME shape from telemetry_v2. */
    private List<HistoryBucketDto> v2Buckets(UUID siteId, String biddingZone, HistoryRange range,
            HistoryRange.Window window) {
        if (range == HistoryRange.DAY) {
            return repo.v2DayBuckets(siteId, window.from(), window.to(), biddingZone);
        }
        List<HistoryBucketDto> buckets =
                repo.v2RollupBuckets(siteId, window.from(), window.to(), range.dailyBuckets());
        Map<Instant, BigDecimal> costs = repo.v2CostPerBucket(
                siteId, window.from(), window.to(), biddingZone, range.dailyBuckets());
        return buckets.stream().map(b -> withCost(b, costs.get(b.start()))).toList();
    }

    /**
     * Splice the two eras at the cutover: v1 buckets that START before it, then
     * v2 buckets at/after it, ordered by start. No bucket start can satisfy both
     * predicates, so the result never gaps and never overlaps.
     */
    static List<HistoryBucketDto> splice(List<HistoryBucketDto> v1, List<HistoryBucketDto> v2,
            Instant cutover) {
        java.util.List<HistoryBucketDto> merged = new java.util.ArrayList<>();
        for (HistoryBucketDto b : v1) {
            if (b.start().isBefore(cutover)) {
                merged.add(b);
            }
        }
        for (HistoryBucketDto b : v2) {
            if (!b.start().isBefore(cutover)) {
                merged.add(b);
            }
        }
        merged.sort(java.util.Comparator.comparing(HistoryBucketDto::start));
        return merged;
    }

    /** Period totals; see {@link HistoryTotalsDto} for the formulas. */
    static HistoryTotalsDto totals(List<HistoryBucketDto> buckets, BigDecimal savings) {
        return totals(buckets, new HistoryRepository.PlannedSavings(savings, null), null);
    }

    /**
     * Period totals; see {@link HistoryTotalsDto} for the formulas. Every sum
     * follows the cost fields' discipline: null (not 0) when NO bucket carried
     * the channel, so a 0-bucket day renders "—" rather than a confident zero
     * (audit V2/X1). {@code tariff} is the labeling context for
     * {@code gridCostEur} (kind + whether the import valuation engaged a real
     * tariff/Preisblatt - Stufe 3 of the structured Bezugspreis; audit H8).
     */
    /**
     * Period totals carrying BOTH planned figures: the unchanged
     * no-battery-baseline number and the Messlatte against the same battery
     * WITHOUT smart control ({@code steuerungPlannedEur}, Captain 04.09.2026).
     * The steering figure is passed through EXACTLY as the repository judged
     * it - null stays null; this layer never sums a partial window itself.
     */
    static HistoryTotalsDto totals(List<HistoryBucketDto> buckets,
            HistoryRepository.PlannedSavings planned,
            HistoryRepository.TariffContext tariff) {
        BigDecimal savings = planned.batteryEur();
        BigDecimal consumption = sum(buckets, HistoryBucketDto::loadKwh);
        BigDecimal pv = sum(buckets, HistoryBucketDto::pvKwh);
        BigDecimal gridImport = sum(buckets, HistoryBucketDto::gridImportKwh);
        BigDecimal gridExport = sum(buckets, HistoryBucketDto::gridExportKwh);

        // Cost is null (not zero) when no bucket had a matching price at all.
        BigDecimal cost = null;
        for (HistoryBucketDto b : buckets) {
            if (b.costEur() != null) {
                cost = (cost == null ? BigDecimal.ZERO : cost).add(b.costEur());
            }
        }

        // A ratio needs BOTH of its inputs; an unknown denominator/numerator is
        // undefined, never silently 0.
        BigDecimal autarkie = null;
        if (consumption != null && gridImport != null && consumption.signum() > 0) {
            autarkie = clampPct(BigDecimal.ONE
                    .subtract(gridImport.divide(consumption, MathContext.DECIMAL64))
                    .multiply(BigDecimal.valueOf(100)));
        }
        BigDecimal eigenverbrauch = null;
        if (pv != null && gridExport != null && pv.signum() > 0) {
            eigenverbrauch = clampPct(pv.subtract(gridExport)
                    .divide(pv, MathContext.DECIMAL64)
                    .multiply(BigDecimal.valueOf(100)));
        }

        return HistoryTotalsDto.of(
                round(consumption), round(pv), round(gridImport), round(gridExport),
                cost == null ? null : cost.setScale(4, RoundingMode.HALF_UP),
                tariff == null ? null : tariff.tarifArt(),
                tariff == null ? null : tariff.tarifPriced(),
                savings == null ? null : savings.setScale(4, RoundingMode.HALF_UP),
                planned.steuerungEur() == null
                        ? null : planned.steuerungEur().setScale(4, RoundingMode.HALF_UP),
                autarkie, eigenverbrauch);
    }

    private static HistoryBucketDto withCost(HistoryBucketDto b, BigDecimal cost) {
        if (cost == null) {
            return b;
        }
        return new HistoryBucketDto(b.start(), b.pvKwh(), b.loadKwh(),
                b.gridImportKwh(), b.gridExportKwh(),
                b.batteryChargeKwh(), b.batteryDischargeKwh(),
                b.socMinPct(), b.socMaxPct(), b.socLastPct(),
                b.priceEurMwh(), cost);
    }

    /**
     * Sum of a bucket field, or <b>null when not a single bucket carried it</b>
     * (a 0-bucket period, or a channel the plant does not measure at all) -
     * the same discipline the cost fields already had.
     */
    private static BigDecimal sum(List<HistoryBucketDto> buckets,
            Function<HistoryBucketDto, BigDecimal> field) {
        BigDecimal total = null;
        for (HistoryBucketDto b : buckets) {
            BigDecimal v = field.apply(b);
            if (v != null) {
                total = (total == null ? BigDecimal.ZERO : total).add(v);
            }
        }
        return total;
    }

    private static BigDecimal clampPct(BigDecimal pct) {
        BigDecimal clamped = pct.max(BigDecimal.ZERO).min(BigDecimal.valueOf(100));
        return clamped.setScale(1, RoundingMode.HALF_UP);
    }

    private static BigDecimal round(BigDecimal v) {
        return v == null ? null : v.setScale(3, RoundingMode.HALF_UP);
    }
}
