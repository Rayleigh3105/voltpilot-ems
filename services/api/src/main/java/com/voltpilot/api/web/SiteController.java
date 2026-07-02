package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.history.HistoryService;
import com.voltpilot.api.repo.ForecastQualityRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.repo.ScheduleRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.TelemetryRepository;
import com.voltpilot.api.repo.WeatherRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.CreateSiteRequest;
import com.voltpilot.api.web.dto.ForecastQualityDto;
import com.voltpilot.api.web.dto.HistoryDto;
import com.voltpilot.api.web.dto.PricePointDto;
import com.voltpilot.api.web.dto.PriceSeriesDto;
import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.TelemetryPointDto;
import com.voltpilot.api.web.dto.WeatherForecastDto;
import jakarta.validation.Valid;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Sites and their telemetry for the caller's tenant. Results are transparently
 * scoped by Postgres Row-Level-Security via the {@code tenant_id} JWT claim, so
 * one tenant can never read another's sites or telemetry.
 */
@RestController
@RequestMapping("/api/v1/sites")
public class SiteController {

    private static final int MAX_POINTS = 5000;
    private static final int MAX_PRICE_POINTS = 1000;

    private final SiteRepository sites;
    private final TelemetryRepository telemetry;
    private final PriceRepository prices;
    private final WeatherRepository weather;
    private final ScheduleRepository schedules;
    private final HistoryService history;
    private final ForecastQualityRepository forecastQuality;
    private final String activeLoadModel;
    private final String activePvModel;

    public SiteController(
            SiteRepository sites,
            TelemetryRepository telemetry,
            PriceRepository prices,
            WeatherRepository weather,
            ScheduleRepository schedules,
            HistoryService history,
            ForecastQualityRepository forecastQuality,
            @Value("${voltpilot.forecast.active-load-model}") String activeLoadModel,
            @Value("${voltpilot.forecast.active-pv-model}") String activePvModel) {
        this.sites = sites;
        this.telemetry = telemetry;
        this.prices = prices;
        this.weather = weather;
        this.schedules = schedules;
        this.history = history;
        this.forecastQuality = forecastQuality;
        this.activeLoadModel = activeLoadModel;
        this.activePvModel = activePvModel;
    }

    @GetMapping
    public List<SiteDto> listSites() {
        return sites.findAll();
    }

    /**
     * Create a site for the CALLER's own tenant (self-service onboarding, "Variante
     * C"). The tenant is taken from the request's {@link TenantContext} (the JWT
     * {@code tenant_id} claim) - never from the request body - and RLS' WITH CHECK
     * guarantees the row lands in that tenant, so a customer can only ever create a
     * site for themselves. This unblocks the device-claim flow: a fresh customer
     * makes a site here, then claims devices into it.
     */
    @PostMapping
    public ResponseEntity<SiteDto> createSite(@Valid @RequestBody CreateSiteRequest request) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No tenant in token");
        }
        SiteDto created = sites.create(tenantId, request.name().trim(),
                request.biddingZoneOrDefault(), request.latitude(), request.longitude());
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping("/{siteId}/telemetry")
    public List<TelemetryPointDto> telemetry(
            @PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        // RLS makes an out-of-tenant site invisible; treat that as 404.
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND, "Site not found");
        }
        Instant effectiveTo = to != null ? to : Instant.now();
        Instant effectiveFrom = from != null ? from : effectiveTo.minus(24, ChronoUnit.HOURS);
        return telemetry.findForSite(siteId, effectiveFrom, effectiveTo, MAX_POINTS);
    }

    /**
     * Day-ahead spot prices for a site's bidding zone (15-min slots). Prices are
     * market-wide per zone, but the endpoint is site-scoped so the portal reads
     * "the price for this site": we resolve the site (RLS => 404 if not the
     * caller's) and return its zone's series. Defaults span roughly today+tomorrow.
     */
    @GetMapping("/{siteId}/prices")
    public PriceSeriesDto prices(
            @PathVariable UUID siteId,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to) {
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND, "Site not found");
        }
        Instant now = Instant.now();
        Instant effectiveFrom = from != null ? from : now.minus(24, ChronoUnit.HOURS);
        Instant effectiveTo = to != null ? to : now.plus(48, ChronoUnit.HOURS);
        String zone = site.biddingZone();
        List<PricePointDto> points = prices.findForZone(zone, effectiveFrom, effectiveTo, MAX_PRICE_POINTS);
        String resolution = prices.latestResolution(zone);
        return new PriceSeriesDto(zone, resolution, prices.currencyFor(zone), points);
    }

    /**
     * Latest weather forecast for a site (hourly, coming days). The
     * {@code weather_forecast} table is RLS-scoped by tenant, and the site lookup
     * itself is RLS-gated, so a foreign site is a 404 (never another tenant's data).
     */
    @GetMapping("/{siteId}/weather")
    public WeatherForecastDto weather(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND, "Site not found");
        }
        WeatherForecastDto forecast = weather.latestForSite(siteId);
        // No run stored yet: return an empty (but well-formed) forecast, not 404.
        return forecast != null ? forecast : new WeatherForecastDto(null, List.of());
    }

    /**
     * Current optimizer plan for a site: the latest run from the {@code schedule}
     * hypertable (written by services/optimization), including per-slot battery
     * power / SoC / projected costs and the headline savings vs. the no-battery
     * baseline. RLS-scoped by tenant like telemetry/weather; a foreign site is a
     * 404, no plan yet is an empty (but well-formed) plan.
     */
    /**
     * A site's history for one period ("Historie"): bucketed pv/load/grid/SoC
     * series with per-bucket import cost, period totals (grid cost, battery
     * savings, Autarkiegrad, Eigenverbrauchsquote - formulas on
     * {@code HistoryTotalsDto}), and for {@code range=day} the Tagesprotokoll
     * plus the persisted plan for the plan-vs-actual overlay. Period
     * boundaries are Europe/Berlin; {@code at} picks the period containing
     * that date (default today). RLS-scoped like telemetry - a foreign site
     * is a 404.
     */
    @GetMapping("/{siteId}/history")
    public HistoryDto history(
            @PathVariable UUID siteId,
            @RequestParam(defaultValue = "day") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate at) {
        HistoryRange parsed = HistoryRange.parse(range);
        if (parsed == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "range must be one of day|week|month|year");
        }
        SiteDto site = sites.findById(siteId);
        if (site == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        LocalDate effectiveAt = at != null ? at : LocalDate.now(HistoryRange.ZONE);
        return history.history(siteId, site.biddingZone(), parsed, effectiveAt);
    }

    /**
     * "Prognosequalität" for a site: which forecast model is live per kind
     * (from the api's config - the same env the optimizer reads), every
     * model's lifecycle incl. challengers still collecting training data, the
     * daily error/skill series computed by the evaluation job, and the daily
     * plan-vs-actual economics. All from RLS-scoped tables - a foreign site
     * is a 404; a fresh site yields empty (but well-formed) lists.
     */
    @GetMapping("/{siteId}/forecast-quality")
    public ForecastQualityDto forecastQuality(
            @PathVariable UUID siteId,
            @RequestParam(defaultValue = "30") int days) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        int window = Math.min(Math.max(days, 1), 90);
        LocalDate since = LocalDate.now(HistoryRange.ZONE).minusDays(window);
        Set<String> active = Set.of(activeLoadModel, activePvModel);
        return new ForecastQualityDto(
                activeLoadModel,
                activePvModel,
                forecastQuality.modelStates(siteId, active),
                forecastQuality.accuracySeries(siteId, since),
                forecastQuality.planAccuracySeries(siteId, since));
    }

    @GetMapping("/{siteId}/schedule")
    public SchedulePlanDto schedule(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND, "Site not found");
        }
        SchedulePlanDto plan = schedules.latestForSite(siteId);
        return plan != null ? plan : SchedulePlanDto.empty();
    }
}
