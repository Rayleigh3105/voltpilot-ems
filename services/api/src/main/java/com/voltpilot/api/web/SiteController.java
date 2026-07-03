package com.voltpilot.api.web;

import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.history.HistoryService;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.ForecastQualityRepository;
import com.voltpilot.api.repo.PriceRepository;
import com.voltpilot.api.repo.ScheduleRepository;
import com.voltpilot.api.repo.SeriesRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.TelemetryRepository;
import com.voltpilot.api.repo.WeatherRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.CreateSiteRequest;
import com.voltpilot.api.web.dto.ForecastQualityDto;
import com.voltpilot.api.web.dto.HistoryDto;
import com.voltpilot.api.web.dto.PriceHistoryDto;
import com.voltpilot.api.web.dto.PricePointDto;
import com.voltpilot.api.web.dto.PriceSeriesDto;
import com.voltpilot.api.web.dto.SchedulePlanDto;
import com.voltpilot.api.web.dto.SiteDeletionPreviewDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.TelemetryPointDto;
import com.voltpilot.api.web.dto.UpdateSiteRequest;
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
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
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
    private final DeviceRepository devices;
    private final SeriesRepository series;
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
            DeviceRepository devices,
            SeriesRepository series,
            TelemetryRepository telemetry,
            PriceRepository prices,
            WeatherRepository weather,
            ScheduleRepository schedules,
            HistoryService history,
            ForecastQualityRepository forecastQuality,
            @Value("${voltpilot.forecast.active-load-model}") String activeLoadModel,
            @Value("${voltpilot.forecast.active-pv-model}") String activePvModel) {
        this.sites = sites;
        this.devices = devices;
        this.series = series;
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

    /**
     * Update a site's editable fields (name/bidding zone/coordinates) -
     * validation mirrors create. RLS makes a foreign site invisible (404) and
     * pins the row to its tenant, so neither a customer nor an admin using the
     * tenant switcher can ever move a site across tenants.
     */
    @PutMapping("/{siteId}")
    public SiteDto updateSite(@PathVariable UUID siteId,
            @Valid @RequestBody UpdateSiteRequest request) {
        SiteDto updated = sites.update(siteId, request.name().trim(),
                request.biddingZoneOrDefault(), request.latitude(), request.longitude());
        if (updated == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return updated;
    }

    /**
     * What deleting this site would remove - feeds the portal's confirm dialog
     * so the consequences (device count, recorded data ranges) are explicit
     * before the customer confirms.
     */
    @GetMapping("/{siteId}/deletion-preview")
    public SiteDeletionPreviewDto deletionPreview(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return series.previewForSite(siteId, devices.countForSite(siteId));
    }

    /**
     * Delete a site. GUARDED: refused (409) while devices exist - devices must
     * be removed first, so nobody deletes a live plant by accident. The site's
     * assets cascade by FK; its series data (telemetry/rollups/forecast/
     * schedule/weather/quality rows) is removed in the same transaction. All
     * through the RLS-scoped datasource: a foreign site is a 404 and the
     * cascade can never touch another tenant's rows.
     */
    @DeleteMapping("/{siteId}")
    @Transactional
    public ResponseEntity<Void> deleteSite(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        int deviceCount = devices.countForSite(siteId);
        if (deviceCount > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Der Standort hat noch " + deviceCount + " Gerät(e). "
                            + "Bitte entfernen Sie zuerst alle Geräte dieses Standorts.");
        }
        series.deleteForSite(siteId);
        if (!sites.delete(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return ResponseEntity.noContent().build();
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
     * Day-ahead prices aggregated over one historical range (Tag/Woche/Monat/
     * Jahr), mirroring the Historie period pattern: {@code at} picks the period
     * containing that date, boundaries are Europe/Berlin. The day range on today
     * extends into tomorrow so the forward-looking day-ahead curve stays visible;
     * past days show that single day. Aggregation runs in SQL (time_bucket:
     * 15-min for the day, hourly for the week, daily for month/year) so a year is
     * ~365 rows, not ~35k slots. Prices are market-wide per zone; the endpoint is
     * site-scoped (RLS => 404 for a foreign site) and reads the site's zone.
     */
    @GetMapping("/{siteId}/price-history")
    public PriceHistoryDto priceHistory(
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
        LocalDate today = LocalDate.now(HistoryRange.ZONE);
        LocalDate effectiveAt = at != null ? at : today;
        HistoryRange.Window window = parsed.window(effectiveAt);
        Instant from = window.from();
        Instant to = window.to();
        // Day view on "today": extend into tomorrow so the published day-ahead
        // prices (the page's forward-looking core value) stay on the chart.
        if (parsed == HistoryRange.DAY && effectiveAt.equals(today)) {
            to = effectiveAt.plusDays(2).atStartOfDay(HistoryRange.ZONE).toInstant();
        }
        String bucketInterval = switch (parsed) {
            case DAY -> "15 minutes";
            case WEEK -> "1 hour";
            case MONTH, YEAR -> "1 day";
        };
        String bucketLabel = switch (parsed) {
            case DAY -> "PT15M";
            case WEEK -> "PT1H";
            case MONTH, YEAR -> "P1D";
        };
        String zone = site.biddingZone();
        return new PriceHistoryDto(
                zone,
                prices.currencyFor(zone),
                bucketLabel,
                from,
                to,
                prices.aggregate(zone, from, to, bucketInterval, parsed.dailyBuckets()),
                prices.summarize(zone, from, to));
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
