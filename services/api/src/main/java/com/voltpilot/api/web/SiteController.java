package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.repo.TelemetryRepository;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.TelemetryPointDto;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
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

    private final SiteRepository sites;
    private final TelemetryRepository telemetry;

    public SiteController(SiteRepository sites, TelemetryRepository telemetry) {
        this.sites = sites;
        this.telemetry = telemetry;
    }

    @GetMapping
    public List<SiteDto> listSites() {
        return sites.findAll();
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
}
