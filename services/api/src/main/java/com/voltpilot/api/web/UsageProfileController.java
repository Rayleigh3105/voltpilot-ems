package com.voltpilot.api.web;

import com.voltpilot.api.profile.UsageProfileDeriver;
import com.voltpilot.api.profile.UsageProfileService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.UsageProfileDto;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The AE7 Nutzungsprofil surface (contract docs/contracts/v2/usage-profile.md):
 * the derived usage profile + emphasis map that steer the adaptive portal/edge,
 * and the explicit override. Tenant-scoped like every site route (foreign site
 * => 404; admins reach any tenant's site via the X-Tenant-Id switcher, the same
 * RLS-scoped path). Read-only derivation + one override write; the derived
 * profile is never stored (ONE truth - it follows the flow/entities/master data).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/profile")
public class UsageProfileController {

    private final UsageProfileService profiles;
    private final SiteRepository sites;

    public UsageProfileController(UsageProfileService profiles, SiteRepository sites) {
        this.profiles = profiles;
        this.sites = sites;
    }

    /** The effective profile, derived default, override, emphasis and signals. */
    @GetMapping
    public UsageProfileDto get(@PathVariable UUID siteId) {
        UsageProfileDto dto = profiles.profile(siteId);
        if (dto == null) {
            throw notFound();
        }
        return dto;
    }

    /** Body of the override write ({@code null}/blank clears to auto-derive). */
    public record OverrideRequest(String override) {}

    /**
     * Set (or clear with null/blank) the site's usage-profile override. Customer
     * or admin (RLS-scoped); returns the recomputed read-model.
     */
    @PutMapping
    @Transactional
    public UsageProfileDto set(@PathVariable UUID siteId, @RequestBody OverrideRequest request) {
        String override = request == null ? null : request.override();
        if (override != null && override.isBlank()) {
            override = null;
        }
        if (override != null && !UsageProfileDeriver.isProfile(override)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "usageProfileOverride muss arbitrage oder peak sein (oder leer).");
        }
        if (!sites.setUsageProfileOverride(siteId, override)) {
            throw notFound();
        }
        return profiles.profile(siteId);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
    }
}
