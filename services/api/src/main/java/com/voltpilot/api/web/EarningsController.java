package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.PeakShavingRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.EarningsDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsDailyDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsMonthDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsSeriesPointDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsSiteDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsTotalsDto;
import com.voltpilot.api.web.dto.EarningsDto.PeakPeriodDto;
import com.voltpilot.api.web.dto.EarningsDto.PeakShavingDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Realized earnings ({@code GET /api/v1/earnings}): the measured "Erlös mit
 * VoltPilot vs. ungeregelte Anlage" numbers behind the portal hero - Phase 2 of
 * the fleet overview. The math lives in {@link EarningsRepository}; this
 * controller only resolves the window and derives the honest per-site
 * degradation reason.
 *
 * <p>Ranges: {@code day|month|year} are Europe/Berlin calendar periods
 * containing {@code at} (default today, {@link HistoryRange} semantics -
 * {@code week} is deliberately not offered here); {@code all} starts at the
 * fleet's first covered slot, and the response's {@code from} says so.
 * Default range is {@code month} (captain decision).
 *
 * <p>Everything reads through the RLS-scoped app datasource with NO tenant
 * predicate - RLS is the fence, admins use the {@code X-Tenant-Id} switcher
 * like every customer endpoint. Rollups refresh every 15 min, so the numbers
 * trail live by up to a quarter hour and count only closed slots - fine (and
 * honest) for a money figure.
 */
@RestController
@RequestMapping("/api/v1/earnings")
public class EarningsController {

    /** Days of the realized daily-savings series (spark bars, incl. today). */
    private static final int DAILY_SAVED_DAYS = 14;

    /** Months of the tappable Meine-Anlage strip (incl. the current month). */
    private static final int MONTH_STRIP_LENGTH = 12;

    private final SiteRepository sites;
    private final EarningsRepository earnings;
    private final PeakShavingRepository peaks;
    private final String activePvModel;

    public EarningsController(SiteRepository sites, EarningsRepository earnings,
            PeakShavingRepository peaks,
            @org.springframework.beans.factory.annotation.Value(
                    "${voltpilot.forecast.active-pv-model}") String activePvModel) {
        this.sites = sites;
        this.earnings = earnings;
        this.peaks = peaks;
        this.activePvModel = activePvModel;
    }

    @GetMapping
    public EarningsDto earnings(
            @RequestParam(defaultValue = "month") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at,
            @RequestParam(name = "strip", defaultValue = "false") boolean stripRequested) {
        String normalized = range == null ? "" : range.trim().toLowerCase(Locale.ROOT);
        boolean all = "all".equals(normalized);
        HistoryRange parsed = all ? null : HistoryRange.parse(normalized);
        if (!all && (parsed == null || parsed == HistoryRange.WEEK)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "range must be one of day|month|year|all");
        }

        LocalDate today = LocalDate.now(HistoryRange.ZONE);
        LocalDate effectiveAt = at != null ? at : today;
        // "all" spans everything up to the end of today's Berlin day; rollup
        // chunks bound the scan to the data that actually exists.
        Instant from = all ? Instant.EPOCH : parsed.window(effectiveAt).from();
        Instant to = all
                ? HistoryRange.DAY.window(today).to()
                : parsed.window(effectiveAt).to();

        Map<UUID, EarningsRepository.SiteAggregate> aggregates = earnings.aggregate(from, to);
        Map<UUID, EarningsRepository.ArbitrageSplit> splits = earnings.arbitrageSplit(from, to);
        // Whether each site's import valuation engages a tariff/Preisblatt
        // beyond bare spot - the provenance copy's honesty switch.
        Map<UUID, Boolean> tarifPriced = earnings.tarifPriced();
        // The forward expected Marktwert Solar is independent of the selected
        // range (always the coming horizon), so it is computed once against the
        // wall clock, keyed on the ACTIVE PV model.
        Map<UUID, EarningsRepository.ExpectedMarketValue> expected =
                earnings.expectedMarketValue(activePvModel, Instant.now());
        Map<UUID, List<EarningsRepository.DailySaved>> daily = earnings.dailySavedPerSite(
                HistoryRange.DAY.window(today.minusDays(DAILY_SAVED_DAYS - 1)).from(),
                HistoryRange.DAY.window(today).to());
        // The peak-shaving proof (PS-4) is range-independent like the forward
        // market value: always the RUNNING billing period, anchored on today.
        Map<UUID, List<PeakShavingRepository.PeriodPeak>> peakPeriods =
                peaks.peaksByPeriod(today);

        // The Ertrag chart series over the SELECTED range: hourly for a day,
        // daily for a month, monthly for a year / "Gesamt".
        EarningsRepository.Bucket seriesBucket = all
                ? EarningsRepository.Bucket.MONTH
                : switch (parsed) {
                    case DAY -> EarningsRepository.Bucket.HOUR;
                    case MONTH -> EarningsRepository.Bucket.DAY;
                    default -> EarningsRepository.Bucket.MONTH;
                };
        Map<UUID, List<EarningsRepository.BucketPoint>> series =
                earnings.bucketed(from, to, seriesBucket);

        // The tappable 12-month strip is a stable navigator anchored on today,
        // independent of the selected range/at (the last 12 Berlin months).
        //
        // OPT-IN (audit vp-portal-perf-a4, finding B5). Computing it is a fixed
        // ~173 ms 12-month scan over telemetry_rollup_15m x the price CTE, and
        // it used to run on EVERY /earnings call - including range=day in the
        // 30 s cockpit poll and the fleet Übersicht poll. No portal surface
        // renders the fleet strip's VALUES today (the MonthStrip is a
        // date-derived jump navigator with showValues={false}; the pin lives in
        // frontend/portal/src/monthStripStrip.test.ts). So it is computed ONLY
        // when a caller explicitly asks (?strip=true) and is [] otherwise -
        // chosen over a shared server-side TTL cache, which would have to be
        // keyed by tenant and carries the RLS-leak risk the audit flagged.
        Map<UUID, List<EarningsRepository.BucketPoint>> strip = Map.of();
        if (stripRequested) {
            YearMonth currentMonth = YearMonth.from(today);
            Instant stripFrom = currentMonth.minusMonths(MONTH_STRIP_LENGTH - 1)
                    .atDay(1).atStartOfDay(HistoryRange.ZONE).toInstant();
            Instant stripTo = currentMonth.plusMonths(1).atDay(1)
                    .atStartOfDay(HistoryRange.ZONE).toInstant();
            strip = earnings.bucketed(stripFrom, stripTo, EarningsRepository.Bucket.MONTH);
        }

        BigDecimal totalBaseline = null;
        BigDecimal totalActual = null;
        BigDecimal totalArbitrage = null;
        long totalCovered = 0;
        LocalDate firstCovered = null;

        List<SiteDto> siteRows = sites.findAll();
        List<EarningsSiteDto> fleet = new ArrayList<>(siteRows.size());
        for (SiteDto site : siteRows) {
            EarningsRepository.SiteAggregate agg = aggregates.get(site.id());
            long covered = agg == null ? 0 : agg.coveredSlots();
            BigDecimal baseline = covered > 0 ? agg.baselineEur() : null;
            BigDecimal actual = covered > 0 ? agg.actualEur() : null;
            BigDecimal saved = baseline != null && actual != null
                    ? baseline.subtract(actual)
                    : null;
            LocalDate siteFirst = covered > 0 && agg.firstCovered() != null
                    ? agg.firstCovered().atZone(HistoryRange.ZONE).toLocalDate()
                    : null;
            // The "davon Arbitrage-Gewinn" split (see EarningsRepository
            // .arbitrageSplit): present only for netzladen sites whose window
            // holds grid-charged energy; pvShift is the exact remainder, so
            // arbitrage + pvShift == saved always reconciles.
            EarningsRepository.ArbitrageSplit split = splits.get(site.id());
            BigDecimal arbitrage = split != null && saved != null ? split.arbitrageEur() : null;
            BigDecimal pvShift = arbitrage != null ? saved.subtract(arbitrage) : null;
            // Forward expected Marktwert Solar (range-independent); absent when
            // the site has no forward PV forecast or price coverage.
            EarningsRepository.ExpectedMarketValue exp = expected.get(site.id());

            if (baseline != null) {
                totalBaseline = totalBaseline == null ? baseline : totalBaseline.add(baseline);
                totalActual = totalActual == null ? actual : totalActual.add(actual);
                totalCovered += covered;
                if (firstCovered == null || (siteFirst != null && siteFirst.isBefore(firstCovered))) {
                    firstCovered = siteFirst;
                }
            }
            if (arbitrage != null) {
                totalArbitrage = totalArbitrage == null ? arbitrage : totalArbitrage.add(arbitrage);
            }

            List<EarningsDailyDto> dailySaved = daily
                    .getOrDefault(site.id(), List.of()).stream()
                    .map(d -> new EarningsDailyDto(d.day(), d.savedEur()))
                    .toList();

            // The money-centric Gesamtertrag = Einspeise-Erlös + the
            // Eigenverbrauchs-Wert. The latter is computed slot-by-slot in the
            // repository per the site's tariff (dynamisch: at each slot's spot
            // price + Aufschlag; fest: at the fixed price; ohne: NULL), so an
            // 'ohne' tariff keeps the self-consumption in kWh only and never
            // fabricates a euro - gesamtertrag then falls back to the feed-in
            // revenue alone.
            BigDecimal einspeise = covered > 0 ? agg.einspeiseErloesEur() : null;
            BigDecimal selbstverbrauchKwh = covered > 0 ? agg.selbstverbrauchKwh() : null;
            BigDecimal eigenverbrauchsWert = covered > 0 ? agg.eigenverbrauchsWertEur() : null;
            BigDecimal gesamtertrag = einspeise == null ? null
                    : eigenverbrauchsWert == null ? einspeise : einspeise.add(eigenverbrauchsWert);

            List<EarningsSeriesPointDto> siteSeries = series
                    .getOrDefault(site.id(), List.of()).stream()
                    .map(p -> new EarningsSeriesPointDto(p.start(), gesamtertragOf(p)))
                    .toList();
            List<EarningsMonthDto> siteStrip = strip
                    .getOrDefault(site.id(), List.of()).stream()
                    .map(p -> new EarningsMonthDto(
                            p.start().atZone(HistoryRange.ZONE).toLocalDate(),
                            gesamtertragOf(p)))
                    .toList();

            fleet.add(new EarningsSiteDto(
                    site.id(),
                    site.name(),
                    site.plantKind(),
                    site.anzulegenderWertCtKwh(),
                    agg == null ? null : agg.realizedExportCtKwh(),
                    agg == null ? null : agg.marketValueSolarCtKwh(),
                    agg == null ? null : agg.marketValueProvisional(),
                    baseline,
                    actual,
                    saved,
                    arbitrage,
                    pvShift,
                    covered,
                    siteFirst,
                    covered > 0 ? null : reason(agg),
                    dailySaved,
                    site.tarifArt(),
                    site.tarifParamCtKwh(),
                    tarifPriced.getOrDefault(site.id(), false),
                    einspeise,
                    eigenverbrauchsWert,
                    gesamtertrag,
                    selbstverbrauchKwh,
                    covered > 0 ? agg.eingespeistKwh() : null,
                    covered > 0 ? agg.batterieBewegtKwh() : null,
                    exp == null ? null : exp.ctKwh(),
                    exp == null ? null : exp.from(),
                    exp == null ? null : exp.to(),
                    exp == null ? null : exp.slots(),
                    siteSeries,
                    siteStrip,
                    peakShaving(site, today, peakPeriods.get(site.id()))));
        }

        // "Gesamt" honestly starts at the first covered slot, not at the epoch.
        Instant reportedFrom = all
                ? (firstCovered != null
                        ? firstCovered.atStartOfDay(HistoryRange.ZONE).toInstant()
                        : HistoryRange.DAY.window(today).from())
                : from;

        // Fleet-level split: sites without one cannot grid-charge, so their
        // whole saved is PV-shift - the remainder keeps arbitrage + pvShift ==
        // saved at fleet level too. A split site is always covered, so
        // totalSaved is non-null whenever totalArbitrage is.
        BigDecimal totalSaved = totalBaseline != null ? totalBaseline.subtract(totalActual) : null;
        return new EarningsDto(
                normalized,
                reportedFrom,
                to,
                fleet,
                new EarningsTotalsDto(
                        totalBaseline,
                        totalActual,
                        totalSaved,
                        totalArbitrage,
                        totalArbitrage != null ? totalSaved.subtract(totalArbitrage) : null,
                        totalCovered,
                        firstCovered));
    }

    /**
     * Why a site has no computable slot, machine-readable for honest portal
     * copy: {@code no_data} - no measurements at all in the window (fresh site,
     * or one whose device never sent); {@code missing_channels} - measurements
     * exist but lack the load/PV/grid channels the math needs (generation-only
     * inverters); {@code no_prices} - measured slots exist but no day-ahead
     * price covers them yet.
     */
    static String reason(EarningsRepository.SiteAggregate agg) {
        if (agg == null || agg.bucketCount() == 0) {
            return "no_data";
        }
        return agg.channelBuckets() == 0 ? "missing_channels" : "no_prices";
    }

    /**
     * The peak-shaving proof block of one site (PS-4): null unless the site's
     * module is active (non-NULL Leistungspreis - the module flag, migration
     * V20260716020000). The running Europe/Berlin billing period is derived
     * from {@code abrechnung_leistung} (first of the current month resp.
     * year); its measured/counterfactual peaks come from the repository rows,
     * and stay null when the period has no measured import bucket yet. The
     * avoided-kW floor and the no-pro-rating euro semantics are documented on
     * {@link PeakShavingDto}.
     */
    static PeakShavingDto peakShaving(SiteDto site, LocalDate today,
            List<PeakShavingRepository.PeriodPeak> rows) {
        BigDecimal leistungspreis = site.leistungspreisEurKw();
        if (leistungspreis == null) {
            return null;
        }
        boolean monthly = "monat".equals(site.abrechnungLeistung());
        LocalDate periodStart = monthly ? today.withDayOfMonth(1) : today.withDayOfYear(1);

        List<PeakPeriodDto> history = (rows == null ? List.<PeakShavingRepository.PeriodPeak>of() : rows)
                .stream()
                .map(r -> {
                    BigDecimal avoidedKw = r.baselinePeakKw().subtract(r.peakKw()).max(BigDecimal.ZERO);
                    return new PeakPeriodDto(
                            r.periodStart(),
                            r.peakKw(),
                            r.baselinePeakKw(),
                            avoidedKw,
                            avoidedKw.multiply(leistungspreis));
                })
                .toList();
        PeakPeriodDto current = history.stream()
                .filter(p -> p.periodStart().equals(periodStart))
                .findFirst()
                .orElse(null);
        return new PeakShavingDto(
                leistungspreis,
                site.abrechnungLeistung(),
                periodStart,
                current == null ? null : current.peakKw(),
                current == null ? null : current.baselinePeakKw(),
                current == null ? null : current.avoidedKw(),
                current == null ? null : current.avoidedEur(),
                history);
    }

    /**
     * One bucket's Gesamtertrag: feed-in revenue + the tariff-priced
     * self-consumption value (both summed per slot in the repository, so a
     * dynamic tariff is valued at each slot's own Börsenpreis). A NULL
     * Eigenverbrauchs-Wert ({@code ohne} tariff) leaves the feed-in revenue alone.
     */
    private static BigDecimal gesamtertragOf(EarningsRepository.BucketPoint p) {
        BigDecimal einspeise = p.einspeiseErloesEur() == null ? BigDecimal.ZERO : p.einspeiseErloesEur();
        BigDecimal wert = p.eigenverbrauchsWertEur();
        return wert == null ? einspeise : einspeise.add(wert);
    }
}
