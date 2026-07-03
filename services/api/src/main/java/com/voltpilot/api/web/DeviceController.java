package com.voltpilot.api.web;

import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.ProvisionedDeviceRepository;
import com.voltpilot.api.repo.SeriesRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceClaimRequest;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.UpdateDeviceRequest;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DuplicateKeyException;
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

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(DeviceController.class);

    /** Sticker Geräte-IDs carry this prefix; only they are registry-gated. */
    static final String STICKER_PREFIX = "VP-";

    private final DeviceRepository devices;
    private final SiteRepository sites;
    private final SeriesRepository series;
    private final ProvisionedDeviceRepository provisioned;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final ObjectProvider<EnrollmentService> enrollment;

    public DeviceController(DeviceRepository devices, SiteRepository sites,
            SeriesRepository series, ProvisionedDeviceRepository provisioned,
            ObjectProvider<ProvisioningPublisher> provisioning,
            ObjectProvider<EnrollmentService> enrollment) {
        this.devices = devices;
        this.sites = sites;
        this.series = series;
        this.provisioned = provisioned;
        this.provisioning = provisioning;
        this.enrollment = enrollment;
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
        // Two ID formats are typo-gated so a mistyped ID fails fast (422)
        // instead of silently creating a ghost device that would "wait for first
        // data" forever:
        //   - Sticker IDs (VP-...) must exist in the manufacturing registry.
        //   - Self-generated edge refs (edge-...) must carry a valid check
        //     character (the format the shipping Edge-App shows on its :8484 web
        //     app). A single-character typo breaks the checksum (see EdgeRef).
        // Other free-form refs (dev seeds, integrations) stay ungated.
        String kind = request.kind();
        if (externalRef.startsWith(STICKER_PREFIX)) {
            Optional<String> provisionedKind = provisioned.findKind(externalRef);
            if (provisionedKind.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Unknown Geräte-ID '" + externalRef + "' - not a provisioned device");
            }
            if (kind == null || kind.isBlank()) {
                kind = provisionedKind.get();
            }
        } else if (EdgeRef.isGeneratedFormat(externalRef) && !EdgeRef.isValid(externalRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Unknown Geräte-ID '" + externalRef + "' - Prüfzeichen ungültig (Tippfehler?)");
        }
        try {
            DeviceDto claimed = devices.claim(tenantId, request.siteId(), externalRef, kind);
            // Zero-touch onboarding: hand the waiting device its identity via the
            // retained provision/{ref}/config (best-effort; see ProvisioningPublisher).
            // The claim still succeeds if the broker is down, but a discarded
            // failure means the device only converges on its next hello retry -
            // so surface it as a WARN naming the device rather than swallowing it.
            provisioning.ifAvailable(p -> {
                if (!p.publishConfig(claimed.externalRef(), tenantId, claimed.siteId(), claimed.id())) {
                    log.warn("Claim of device {} (ref '{}') succeeded but the retained "
                            + "provisioning config did not go out - the device converges on its "
                            + "next hello via the ingest resolver", claimed.id(), claimed.externalRef());
                }
            });
            return ResponseEntity.status(HttpStatus.CREATED).body(claimed);
        } catch (DuplicateKeyException ex) {
            // external_ref already claimed by another tenant (which RLS hides above).
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Device '" + externalRef + "' is already claimed");
        }
    }

    /**
     * Update a device's editable fields: TYPE and label (Bezeichnung) only.
     * The {@code external_ref} is the device's identity - MQTT topics and the
     * registry gate hang off it - and stays immutable; a wrong ref is fixed by
     * unclaiming and re-claiming. RLS makes a foreign device a 404.
     */
    @PutMapping("/{deviceId}")
    public DeviceDto update(@PathVariable UUID deviceId,
            @Valid @RequestBody UpdateDeviceRequest request) {
        DeviceDto existing = devices.findById(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        String kind = request.kind() == null || request.kind().isBlank()
                ? existing.kind() : request.kind();
        return devices.update(deviceId, kind, request.nameOrNull())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
    }

    /**
     * Unclaim (delete) a device: removes the device row AND its telemetry, and
     * cleans the broker - the retained {@code provision/{ref}/config} and the
     * retained schedule topic are cleared (best-effort, like the on-claim
     * publish), so the physical device falls back to its watchdog default and
     * the ref becomes claimable again. A sticker ref stays registered in the
     * manufacturing registry, so re-claiming it later just works.
     */
    @DeleteMapping("/{deviceId}")
    @Transactional
    public ResponseEntity<Void> unclaim(@PathVariable UUID deviceId) {
        UUID tenantId = TenantContext.get();
        DeviceDto device = devices.findById(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        series.deleteForDevice(deviceId);
        if (!devices.delete(deviceId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found");
        }
        provisioning.ifAvailable(p ->
                p.clearRetained(device.externalRef(), tenantId, device.siteId(), device.id()));
        // First-boot enrollment counterpart: drop the device's broker ACL grant
        // so an issued mTLS certificate loses topic access (best-effort; CRL
        // revocation stays the operator-run cryptographic backstop).
        enrollment.ifAvailable(e -> e.onDeviceUnclaimed(device.id()));
        return ResponseEntity.noContent().build();
    }

    /**
     * Canonicalize a typed Geräte-ID so the same physical device never becomes
     * two rows and so the typo gates see a normalized form. Sticker IDs are
     * printed uppercase ({@code VP-1234-ABCD}) and self-generated edge refs are
     * lowercase ({@code edge-k7m2xqp}); both are case-folded to their canonical
     * form (a mobile keyboard's {@code autoCapitalize} must not matter). Other
     * free-form refs pass through untouched apart from trimming.
     */
    static String canonicalExternalRef(String raw) {
        String trimmed = raw.trim();
        if (trimmed.regionMatches(true, 0, STICKER_PREFIX, 0, STICKER_PREFIX.length())) {
            return trimmed.toUpperCase(Locale.ROOT);
        }
        if (trimmed.regionMatches(true, 0, EdgeRef.PREFIX, 0, EdgeRef.PREFIX.length())) {
            return trimmed.toLowerCase(Locale.ROOT);
        }
        return trimmed;
    }
}
