package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.EarningsDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsDailyDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsSiteDto;
import com.voltpilot.api.web.dto.EarningsDto.EarningsTotalsDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
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

    private final SiteRepository sites;
    private final EarningsRepository earnings;

    public EarningsController(SiteRepository sites, EarningsRepository earnings) {
        this.sites = sites;
        this.earnings = earnings;
    }

    @GetMapping
    public EarningsDto earnings(
            @RequestParam(defaultValue = "month") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at) {
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
        Map<UUID, List<EarningsRepository.DailySaved>> daily = earnings.dailySavedPerSite(
                HistoryRange.DAY.window(today.minusDays(DAILY_SAVED_DAYS - 1)).from(),
                HistoryRange.DAY.window(today).to());

        BigDecimal totalBaseline = null;
        BigDecimal totalActual = null;
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

            if (baseline != null) {
                totalBaseline = totalBaseline == null ? baseline : totalBaseline.add(baseline);
                totalActual = totalActual == null ? actual : totalActual.add(actual);
                totalCovered += covered;
                if (firstCovered == null || (siteFirst != null && siteFirst.isBefore(firstCovered))) {
                    firstCovered = siteFirst;
                }
            }

            List<EarningsDailyDto> dailySaved = daily
                    .getOrDefault(site.id(), List.of()).stream()
                    .map(d -> new EarningsDailyDto(d.day(), d.savedEur()))
                    .toList();

            fleet.add(new EarningsSiteDto(
                    site.id(),
                    site.name(),
                    site.plantKind(),
                    site.marktpraemieCtKwh(),
                    baseline,
                    actual,
                    saved,
                    covered,
                    siteFirst,
                    covered > 0 ? null : reason(agg),
                    dailySaved));
        }

        // "Gesamt" honestly starts at the first covered slot, not at the epoch.
        Instant reportedFrom = all
                ? (firstCovered != null
                        ? firstCovered.atStartOfDay(HistoryRange.ZONE).toInstant()
                        : HistoryRange.DAY.window(today).from())
                : from;

        return new EarningsDto(
                normalized,
                reportedFrom,
                to,
                fleet,
                new EarningsTotalsDto(
                        totalBaseline,
                        totalActual,
                        totalBaseline != null ? totalBaseline.subtract(totalActual) : null,
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
    private static String reason(EarningsRepository.SiteAggregate agg) {
        if (agg == null || agg.bucketCount() == 0) {
            return "no_data";
        }
        return agg.channelBuckets() == 0 ? "missing_channels" : "no_prices";
    }
}
