package com.voltpilot.api.web;

import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceClaimRequest;
import com.voltpilot.api.web.dto.DeviceDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Devices for the caller's tenant, and the claim endpoint. Claiming is a single
 * insert scoped to the tenant; RLS plus the global unique {@code external_ref}
 * index make cross-tenant claiming impossible.
 */
@RestController
@RequestMapping("/api/v1/devices")
public class DeviceController {

    private final DeviceRepository devices;
    private final SiteRepository sites;
    private final ObjectProvider<ProvisioningPublisher> provisioning;

    public DeviceController(DeviceRepository devices, SiteRepository sites,
            ObjectProvider<ProvisioningPublisher> provisioning) {
        this.devices = devices;
        this.sites = sites;
        this.provisioning = provisioning;
    }

    @GetMapping
    public List<DeviceDto> listDevices() {
        return devices.findAll();
    }

    @PostMapping("/claim")
    public ResponseEntity<DeviceDto> claim(@Valid @RequestBody DeviceClaimRequest request) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No tenant in token");
        }
        // The target site must belong to the caller's tenant (RLS-checked).
        if (!sites.existsForCurrentTenant(request.siteId())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        String externalRef = canonicalExternalRef(request.externalRef());
        // Idempotent within the tenant: re-entering a device the account already
        // connected (wizard restart, double submit) returns that device instead
        // of a conflict. RLS scopes the lookup, so a hit is always the caller's own.
        Optional<DeviceDto> existing = devices.findByExternalRef(externalRef);
        if (existing.isPresent()) {
            return ResponseEntity.ok(existing.get());
        }
        try {
            DeviceDto claimed = devices.claim(tenantId, request.siteId(), externalRef, request.kind());
            // Zero-touch onboarding: hand the waiting device its identity via the
            // retained provision/{ref}/config (best-effort; see ProvisioningPublisher).
            provisioning.ifAvailable(p ->
                    p.publishConfig(claimed.externalRef(), tenantId, claimed.siteId(), claimed.id()));
            return ResponseEntity.status(HttpStatus.CREATED).body(claimed);
        } catch (DuplicateKeyException ex) {
            // external_ref already claimed by another tenant (which RLS hides above).
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Device '" + externalRef + "' is already claimed");
        }
    }

    /**
     * Sticker Geräte-IDs are printed uppercase ({@code VP-1234-ABCD}); the typed
     * case and stray padding must not turn one physical device into two rows.
     * Non-sticker refs pass through untouched apart from trimming.
     */
    static String canonicalExternalRef(String raw) {
        String trimmed = raw.trim();
        return trimmed.regionMatches(true, 0, "VP-", 0, 3)
                ? trimmed.toUpperCase(Locale.ROOT)
                : trimmed;
    }
}
