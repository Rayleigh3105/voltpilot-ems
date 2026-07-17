package com.voltpilot.api.web;

import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.optimizer.OptimizerProperties;
import com.voltpilot.api.repo.OptimizerConfigRepository;
import com.voltpilot.api.repo.OptimizerDiagnosticsRepository.SiteContext;
import com.voltpilot.api.web.dto.OptimizerConfigDto;
import com.voltpilot.api.web.dto.OptimizerDiagnosticsDto;
import com.voltpilot.api.web.dto.UpdateOptimizerConfigRequest;
import jakarta.validation.Valid;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Portal-Admin optimizer surface (design vp-admin-optimizer-ui-design):
 * understand what the optimizer did for a site and WHY
 * ({@code optimizer-diagnostics}, §4.2) and tune its per-site / per-asset
 * knobs ({@code optimizer-config}, §2.7). The what-if re-optimize (§4.3) is a
 * DEFERRED separate increment - config writes here change what the NEXT
 * scheduled run uses, they never trigger a solve.
 *
 * <p>Auth + tenancy mirror the established admin pattern exactly: every route
 * is {@code platform-admin}-gated, and the data access is READ/WRITE OVER THE
 * TENANT'S OWN SITE through the RLS-scoped app datasource - the admin selects
 * the tenant via the {@code X-Tenant-Id} switcher
 * ({@link com.voltpilot.api.tenant.TenantFilter}), so without a selected
 * tenant (or with the wrong one) the site is simply invisible (404). No
 * BYPASSRLS anywhere on this surface.
 *
 * <p>The site levers that predate this panel ({@code netzladen_erlaubt},
 * {@code plant_kind}, tariff, anzulegender Wert) stay editable via the
 * existing {@code PUT /api/v1/sites/{id}} (admins: with the switcher header);
 * this controller only echoes them read-only.
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}")
@PreAuthorize("hasRole('platform-admin')")
public class AdminOptimizerController {

    private final OptimizerDiagnosticsService diagnostics;
    private final OptimizerConfigRepository config;
    private final OptimizerProperties properties;

    public AdminOptimizerController(OptimizerDiagnosticsService diagnostics,
            OptimizerConfigRepository config, OptimizerProperties properties) {
        this.diagnostics = diagnostics;
        this.config = config;
        this.properties = properties;
    }

    /**
     * The per-slot "why" view of one persisted run: plan slots + the real
     * €-decomposition (import price per tariff, export value incl.
     * Marktprämie/feste Vergütung, persisted wear, approximate stored-energy
     * value, decision label, German rationale). {@code generatedAt} selects a
     * historical run; {@code date} (a Europe/Berlin day) scopes the
     * {@code availableRuns} navigation list to that day and, without an
     * explicit {@code generatedAt}, shows the day's newest run; neither =
     * the latest run + its day's list. A site with no plan yet (and a picked
     * day without runs) returns an empty well-formed body; an unknown run is
     * 404.
     */
    @GetMapping("/optimizer-diagnostics")
    public OptimizerDiagnosticsDto optimizerDiagnostics(
            @PathVariable UUID siteId,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant generatedAt,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        SiteContext site = requireSite(siteId);
        OptimizerDiagnosticsDto dto = diagnostics.diagnose(site, generatedAt, date);
        if (dto == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "No optimizer run at " + generatedAt + " for this site");
        }
        return dto;
    }

    /** The site's optimizer knobs: platform defaults, overrides, effective values. */
    @GetMapping("/optimizer-config")
    public OptimizerConfigDto optimizerConfig(@PathVariable UUID siteId) {
        return toConfigDto(requireSite(siteId));
    }

    /**
     * Write the per-site / per-asset overrides (full-representation: null
     * clears an override back to the platform default). Battery fields need a
     * battery asset (409 otherwise); the effective SoC band must stay a real
     * window (400). Changes take effect on the optimizer's NEXT cycle - it
     * re-reads master data every run.
     */
    @PutMapping("/optimizer-config")
    @Transactional
    public OptimizerConfigDto updateOptimizerConfig(@PathVariable UUID siteId,
            @Valid @RequestBody UpdateOptimizerConfigRequest request) {
        SiteContext site = requireSite(siteId);
        if (request.touchesBattery() && !site.hasBattery()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Anlage hat keinen Batteriespeicher - Verschleißkosten und "
                            + "SoC-Band können erst nach dem Anlegen des Speichers gesetzt werden.");
        }
        requireValidSocBand(request.socMinPct(), request.socMaxPct());
        if (site.hasBattery()) {
            config.updateBatteryOverrides(siteId, request.wearCostCtPerKwh(),
                    request.socMinPct(), request.socMaxPct());
        }
        config.updateBackupReserve(siteId, request.backupReserveSocPct());
        // Peak shaving (PS-1/PS-2): admin-only by construction - these fields
        // exist ONLY on this endpoint, never on the customer site requests.
        config.updatePeakShaving(siteId, request.leistungspreisEurKw(),
                request.abrechnungLeistung(), request.peakReserveSocPct());
        return toConfigDto(requireSite(siteId));
    }

    /**
     * The effective band (override ?? platform default per side) must stay a
     * real window - a one-sided override crossing the other side's default
     * would otherwise make the solver fall back with a warning on every run.
     */
    private static void requireValidSocBand(BigDecimal socMinPct, BigDecimal socMaxPct) {
        double effMin = socMinPct != null
                ? socMinPct.doubleValue() : OptimizerProperties.DEFAULT_SOC_MIN_PCT;
        double effMax = socMaxPct != null
                ? socMaxPct.doubleValue() : OptimizerProperties.DEFAULT_SOC_MAX_PCT;
        if (effMin >= effMax) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Das SoC-Band ist ungültig: die Untergrenze (" + effMin
                            + " %) muss unter der Obergrenze (" + effMax + " %) liegen.");
        }
    }

    private SiteContext requireSite(UUID siteId) {
        SiteContext site = diagnostics.siteContext(siteId);
        if (site == null) {
            // RLS hides sites outside the switched tenant (or no tenant selected).
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return site;
    }

    private OptimizerConfigDto toConfigDto(SiteContext site) {
        double defaultWear = properties.defaultWearCostCtPerKwh();
        Double effWear = site.hasBattery()
                ? (site.wearCostCtPerKwh() != null
                        ? site.wearCostCtPerKwh().doubleValue() : defaultWear)
                : null;
        Double effMin = site.hasBattery()
                ? (site.socMinPct() != null
                        ? site.socMinPct().doubleValue() : OptimizerProperties.DEFAULT_SOC_MIN_PCT)
                : null;
        Double effMax = site.hasBattery()
                ? (site.socMaxPct() != null
                        ? site.socMaxPct().doubleValue() : OptimizerProperties.DEFAULT_SOC_MAX_PCT)
                : null;
        return new OptimizerConfigDto(
                site.siteId(),
                site.hasBattery(),
                new OptimizerConfigDto.PlatformDefaults(
                        defaultWear,
                        OptimizerProperties.DEFAULT_SOC_MIN_PCT,
                        OptimizerProperties.DEFAULT_SOC_MAX_PCT,
                        properties.terminalValueQuantile(),
                        properties.terminalValueOverrideCtPerKwh()),
                new OptimizerConfigDto.Overrides(
                        site.wearCostCtPerKwh(),
                        site.socMinPct(),
                        site.socMaxPct(),
                        site.backupReserveSocPct()),
                new OptimizerConfigDto.Effective(
                        effWear, effMin, effMax, site.backupReserveSocPct()),
                new OptimizerConfigDto.PeakShaving(
                        site.leistungspreisEurKw(),
                        site.abrechnungLeistung(),
                        site.peakReserveSocPct()),
                new OptimizerConfigDto.SiteLevers(
                        site.netzladenErlaubt(),
                        site.plantKind(),
                        site.tarifArt(),
                        site.tarifParamCtKwh(),
                        site.anzulegenderWertCtKwh()));
    }
}
