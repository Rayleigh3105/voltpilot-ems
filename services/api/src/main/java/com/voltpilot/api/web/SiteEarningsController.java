package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.PeakShavingRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.SiteEarningsDto;
import com.voltpilot.api.web.dto.SiteEarningsDto.SiteEarningsBucketDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Anlagen-scharfen Erlöse: {@code GET /api/v1/sites/{siteId}/earnings}
 * (Historie concept {@code vp-historie-konzept-t4} §4.2 Welt B, feature F1 +
 * performance measure P3).
 *
 * <p><b>Why this exists next to {@code /api/v1/earnings}.</b> The tenant-wide
 * endpoint answers a portfolio question - every Anlage, every series, the
 * 12-month strip and the forward market value - and pays for it (3-7,5 s
 * measured). The Erlöse world of ONE Anlage asks a smaller question, so it gets
 * a smaller answer: three site-scoped aggregates over the SAME SQL, the same
 * price truth ({@link EarningsRepository}), no second money model anywhere. The
 * fleet endpoint stays untouched for Cockpit, Übersicht and Portfolio.
 *
 * <p><b>Ranges</b> are the Historie vocabulary, so the Erlöse world's time bar
 * (Tag · Woche · Monat · Jahr) works unchanged: {@code day|week|month|year} are
 * Europe/Berlin calendar periods containing {@code at} (default today), and
 * {@code all} spans everything up to the end of today - its {@code from} then
 * reports the site's FIRST covered day, never the epoch. Unlike the fleet
 * endpoint, {@code week} is offered here (the Historie has always had it).
 *
 * <p><b>Tenancy</b> is the usual one: the site is resolved through the
 * RLS-scoped repository, so a foreign site is a 404 and never a 403; admins
 * reach a customer's Anlage through the {@code X-Tenant-Id} switcher exactly
 * like every other site route.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/earnings")
public class SiteEarningsController {

    private final SiteRepository sites;
    private final EarningsRepository earnings;
    private final PeakShavingRepository peaks;
    private final String activePvModel;

    public SiteEarningsController(SiteRepository sites, EarningsRepository earnings,
            PeakShavingRepository peaks,
            @org.springframework.beans.factory.annotation.Value(
                    "${voltpilot.forecast.active-pv-model}") String activePvModel) {
        this.sites = sites;
        this.earnings = earnings;
        this.peaks = peaks;
        this.activePvModel = activePvModel;
    }

    @GetMapping
    public SiteEarningsDto earnings(
            @PathVariable UUID siteId,
            @RequestParam(defaultValue = "month") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
                    LocalDate at) {
        String normalized = range == null ? "" : range.trim().toLowerCase(Locale.ROOT);
        boolean all = "all".equals(normalized);
        HistoryRange parsed = all ? null : HistoryRange.parse(normalized);
        if (!all && parsed == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "range must be one of day|week|month|year|all");
        }
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }

        LocalDate today = LocalDate.now(HistoryRange.ZONE);
        LocalDate effectiveAt = at != null ? at : today;
        Instant from = all ? Instant.EPOCH : parsed.window(effectiveAt).from();
        Instant to = all ? HistoryRange.DAY.window(today).to() : parsed.window(effectiveAt).to();

        EarningsRepository.SiteAggregate agg = earnings.aggregateForSite(siteId, from, to);
        long covered = agg == null ? 0 : agg.coveredSlots();
        boolean computable = covered > 0;

        BigDecimal baseline = computable ? agg.baselineEur() : null;
        BigDecimal actual = computable ? agg.actualEur() : null;
        BigDecimal saved = baseline != null && actual != null ? baseline.subtract(actual) : null;

        // The grid-charging attribution (netzladen sites with grid-charged
        // energy in the window). pvShift stays the exact remainder, so
        // arbitrage + pvShift == saved reconciles here like in the fleet view.
        EarningsRepository.ArbitrageSplit split = computable
                ? earnings.arbitrageSplitForSite(siteId, from, to)
                : null;
        BigDecimal arbitrage = split != null && saved != null ? split.arbitrageEur() : null;
        BigDecimal pvShift = arbitrage != null ? saved.subtract(arbitrage) : null;

        BigDecimal einspeise = computable ? agg.einspeiseErloesEur() : null;
        BigDecimal eigenverbrauchsWert = computable ? agg.eigenverbrauchsWertEur() : null;
        BigDecimal stromkosten = computable ? agg.stromkostenEur() : null;
        BigDecimal netto = netto(einspeise, eigenverbrauchsWert, stromkosten);
        // Money-centric Gesamtertrag = Einspeise-Erlös + Eigenverbrauchs-Wert
        // (the fleet twin's field, so the cockpit hero reads ONE number). A NULL
        // Eigenverbrauchs-Wert ('ohne' tariff) leaves the feed-in revenue alone;
        // both null => not computable (B2 parity).
        BigDecimal gesamtertrag = einspeise == null ? null
                : eigenverbrauchsWert == null ? einspeise : einspeise.add(eigenverbrauchsWert);
        // Forward expected Marktwert Solar (range-INDEPENDENT, always the coming
        // horizon): the SAME RLS-fenced query the fleet twin runs, keyed on the
        // ACTIVE PV model; absent when there is no forward PV/price coverage.
        EarningsRepository.ExpectedMarketValue expected =
                earnings.expectedMarketValue(activePvModel, Instant.now()).get(siteId);

        // The scale of the money chart follows the period (P6): a year shows
        // twelve month bars, not 365 day bars.
        EarningsRepository.Bucket bucket = all
                ? EarningsRepository.Bucket.MONTH
                : switch (parsed) {
                    case DAY -> EarningsRepository.Bucket.HOUR;
                    case WEEK, MONTH -> EarningsRepository.Bucket.DAY;
                    default -> EarningsRepository.Bucket.MONTH;
                };
        List<SiteEarningsBucketDto> series = computable
                ? earnings.bucketedForSite(siteId, from, to, bucket).stream()
                        .map(p -> new SiteEarningsBucketDto(
                                p.start(),
                                p.einspeiseErloesEur(),
                                p.eigenverbrauchsWertEur(),
                                p.stromkostenEur(),
                                netto(p.einspeiseErloesEur(), p.eigenverbrauchsWertEur(),
                                        p.stromkostenEur())))
                        .toList()
                : List.of();

        LocalDate firstCovered = computable && agg.firstCovered() != null
                ? agg.firstCovered().atZone(HistoryRange.ZONE).toLocalDate()
                : null;
        // "Gesamt" names the day it really starts at instead of 1970.
        Instant reportedFrom = all
                ? (firstCovered != null
                        ? firstCovered.atStartOfDay(HistoryRange.ZONE).toInstant()
                        : HistoryRange.DAY.window(today).from())
                : from;

        // The peak-shaving proof is range-INDEPENDENT (always the running
        // billing period) and only exists for a module-active site, so the
        // query only runs when the module flag is set.
        var peakRows = site.leistungspreisEurKw() == null
                ? null
                : peaks.peaksByPeriod(today).get(siteId);

        return new SiteEarningsDto(
                site.id(),
                site.name(),
                normalized,
                reportedFrom,
                to,
                site.plantKind(),
                site.tarifArt(),
                site.tarifParamCtKwh(),
                earnings.tarifPricedForSite(siteId),
                site.anzulegenderWertCtKwh(),
                covered,
                firstCovered,
                computable ? null : EarningsController.reason(agg),
                einspeise,
                eigenverbrauchsWert,
                stromkosten,
                netto,
                saved,
                arbitrage,
                pvShift,
                baseline,
                actual,
                computable ? agg.marktpraemieEur() : null,
                bezugspreisCtKwh(stromkosten, computable ? agg.bezogenKwh() : null),
                computable ? agg.realizedExportCtKwh() : null,
                computable ? agg.marketValueSolarCtKwh() : null,
                computable ? agg.marketValueProvisional() : null,
                computable ? agg.bezogenKwh() : null,
                computable ? agg.eingespeistKwh() : null,
                computable ? agg.selbstverbrauchKwh() : null,
                computable ? agg.batterieBewegtKwh() : null,
                gesamtertrag,
                expected == null ? null : expected.ctKwh(),
                expected == null ? null : expected.from(),
                expected == null ? null : expected.to(),
                expected == null ? null : expected.slots(),
                series,
                EarningsController.peakShaving(site, today, peakRows));
    }

    /**
     * The result of a period resp. bucket: Ertrag minus Stromkosten. A NULL
     * Eigenverbrauchs-Wert (an {@code ohne} tariff, no euro value for
     * self-consumed energy) leaves the two metered terms alone rather than
     * counting a fabricated zero; without a feed-in term there is nothing
     * computable at all.
     */
    private static BigDecimal netto(BigDecimal einspeise, BigDecimal eigenverbrauchsWert,
            BigDecimal stromkosten) {
        if (einspeise == null && stromkosten == null) {
            return null;
        }
        BigDecimal sum = einspeise == null ? BigDecimal.ZERO : einspeise;
        if (eigenverbrauchsWert != null) {
            sum = sum.add(eigenverbrauchsWert);
        }
        return stromkosten == null ? sum : sum.subtract(stromkosten);
    }

    /**
     * The period's Ø Bezugspreis in ct/kWh - the two sums the card already
     * shows, divided. Null without imported energy (never a 0 ct/kWh claim);
     * six decimals keep the division lossless enough for a one-decimal display.
     */
    private static BigDecimal bezugspreisCtKwh(BigDecimal stromkostenEur, BigDecimal bezogenKwh) {
        if (stromkostenEur == null || bezogenKwh == null
                || bezogenKwh.compareTo(BigDecimal.ZERO) <= 0) {
            return null;
        }
        return stromkostenEur.multiply(BigDecimal.valueOf(100))
                .divide(bezogenKwh, 6, RoundingMode.HALF_UP);
    }
}
