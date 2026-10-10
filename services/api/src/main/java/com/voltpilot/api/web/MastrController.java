package com.voltpilot.api.web;

import com.voltpilot.api.mastr.MastrService;
import com.voltpilot.api.mastr.RegistryLookupException;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MastrApplyRequest;
import com.voltpilot.api.web.dto.MastrLookupRequest;
import com.voltpilot.api.web.dto.MastrPreviewDto;
import com.voltpilot.api.web.dto.SiteAssetDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The optional "Anlage verknüpfen" step: look a MaStR unit up (preview only,
 * nothing persisted), then persist the customer-CONFIRMED values onto the
 * site's assets. Tenant-scoped exactly like the rest of the site API - the
 * site resolution runs under RLS, so a foreign site is a 404 before any
 * registry call happens, and the asset writes land in the caller's tenant via
 * RLS' WITH CHECK.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class MastrController {

    private final Geltungsbereich geltungsbereich;
    private final AssetRepository assets;
    private final MastrService mastr;

    public MastrController(Geltungsbereich geltungsbereich, AssetRepository assets, MastrService mastr) {
        this.geltungsbereich = geltungsbereich;
        this.assets = assets;
        this.mastr = mastr;
    }

    /** The site's asset master data incl. registry provenance (drawer display). */
    @GetMapping("/assets")
    public List<SiteAssetDto> assets(@PathVariable UUID siteId) {
        requireSite(siteId);
        return assets.findForSite(siteId);
    }

    /**
     * Fetch + map one unit from the registry for confirmation. NOT persisted -
     * the customer sees the preview (incl. registry PLZ/Ort for their own
     * plausibility check) and decides.
     */
    @PostMapping("/mastr-lookup")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public MastrPreviewDto lookup(@PathVariable UUID siteId,
            @Valid @RequestBody MastrLookupRequest request) throws RegistryLookupException {
        requireSite(siteId);
        return mastr.lookup(request.einheitNummer());
    }

    /**
     * Persist the confirmed values onto the site's PV/battery assets. Runs in
     * ONE transaction so pv+battery apply atomically - a failure on the second
     * rolls the first back instead of leaving a half-applied state.
     */
    @Transactional
    @PostMapping("/mastr-apply")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public List<SiteAssetDto> apply(@PathVariable UUID siteId,
            @Valid @RequestBody MastrApplyRequest request) {
        requireSite(siteId);
        if (request.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "At least one of pv/storage is required");
        }
        UUID tenantId = TenantContext.get();
        Instant fetchedAt = Instant.now();
        if (request.pv() != null) {
            assets.applyPv(tenantId, siteId, request.pv(), "mastr", fetchedAt);
        }
        if (request.storage() != null) {
            assets.applyBattery(tenantId, siteId, request.storage(), "mastr", fetchedAt);
            // A newly-created battery asset has NO control path yet; link it to
            // the site's single device so the optimizer can publish the plan
            // (the self-maintaining rule, see AssetRepository.autoLinkBatteryDevice).
            assets.autoLinkBatteryDevice(siteId);
        }
        return assets.findForSite(siteId);
    }

    /**
     * Registry-lookup outcomes the customer must understand: the German
     * message travels in the body ({@code {"message": ...}}) and the reason
     * maps to a status the portal can also branch on.
     */
    @ExceptionHandler(RegistryLookupException.class)
    public ResponseEntity<Map<String, String>> registryError(RegistryLookupException e) {
        HttpStatus status = switch (e.reason()) {
            case INVALID_NUMBER -> HttpStatus.BAD_REQUEST;
            case NOT_FOUND -> HttpStatus.NOT_FOUND;
            case UNAVAILABLE -> HttpStatus.BAD_GATEWAY;
        };
        return ResponseEntity.status(status).body(Map.of("message", e.getMessage()));
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }
}
