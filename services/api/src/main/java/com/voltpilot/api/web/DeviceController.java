package com.voltpilot.api.web;

import com.voltpilot.api.control.ControlCertificationService;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.entities.EntityAutoComposer;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.provisioning.ProvisioningTopics;
import com.voltpilot.api.purge.DevicePurgeService;
import com.voltpilot.api.repo.AssetRepository;
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
    private final AssetRepository assets;
    private final ProvisionedDeviceRepository provisioned;
    private final DevicePurgeService purge;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final ObjectProvider<EnrollmentService> enrollment;
    private final ObjectProvider<EntityRegistryPublisher> entityRegistry;
    private final ObjectProvider<RolloutService> rollouts;
    private final EntityAutoComposer autoCompose;
    private final ControlCertificationService controlCertification;

    public DeviceController(DeviceRepository devices, SiteRepository sites,
            SeriesRepository series, AssetRepository assets,
            ProvisionedDeviceRepository provisioned,
            DevicePurgeService purge,
            ObjectProvider<ProvisioningPublisher> provisioning,
            ObjectProvider<EnrollmentService> enrollment,
            ObjectProvider<EntityRegistryPublisher> entityRegistry,
            ObjectProvider<RolloutService> rollouts,
            EntityAutoComposer autoCompose,
            ControlCertificationService controlCertification) {
        this.devices = devices;
        this.sites = sites;
        this.series = series;
        this.assets = assets;
        this.provisioned = provisioned;
        this.purge = purge;
        this.provisioning = provisioning;
        this.enrollment = enrollment;
        this.entityRegistry = entityRegistry;
        this.rollouts = rollouts;
        this.autoCompose = autoCompose;
        this.controlCertification = controlCertification;
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
        // Topic-safety gate (defense in depth, same rule as the enrollment
        // path): the ref is interpolated into the retained MQTT provisioning
        // topic, so '/', '+', '#' and over-long refs must never get that far -
        // reject them here instead of storing a device the broker cannot serve.
        if (!ProvisioningTopics.isValidRef(externalRef)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Ungültige Geräte-ID.");
        }
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
            // Self-maintaining control path: if this claim leaves the site with
            // exactly one device and its battery asset is still unlinked, link
            // them - the battery is controlled by the inverter (this device), so
            // the optimizer can now publish the plan instead of only persisting
            // it. A multi-device site is left alone (the owner picks). Best-effort
            // and idempotent; a claim must never fail on the link bookkeeping.
            if (assets.autoLinkBatteryDevice(claimed.siteId())) {
                log.info("Auto-linked device {} (ref '{}') to the battery asset of site {}",
                        claimed.id(), claimed.externalRef(), claimed.siteId());
            }
            // Self-composing Anlagen-Modell: the claim is the moment the site
            // gains an unambiguous gateway, so this is the earliest point at
            // which its v2 entities CAN be composed - and the customer must
            // never have to ask anyone for it (the composition used to need a
            // platform-admin bootstrap or an api restart). Idempotent +
            // fail-soft; a broken composition never fails the claim.
            autoCompose.ensureComposed(claimed.siteId());
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
     * Purge ALL recorded data of a device ("Datenaufzeichnungen löschen")
     * WITHOUT unclaiming it: raw telemetry goes, the site's rollups are rebuilt
     * without it, the writer refuses replayed old samples via the purge
     * watermark, and the device is told (retained {@code purge_data} command)
     * to wipe its local buffers. Claim/enrollment/config stay intact; new data
     * flows and charts normally afterwards. RLS makes a foreign device a 404.
     * Full design: {@link DevicePurgeService}.
     */
    @PostMapping("/{deviceId}/purge-data")
    public com.voltpilot.api.web.dto.DevicePurgeResultDto purgeData(@PathVariable UUID deviceId) {
        DeviceDto device = devices.findById(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        DevicePurgeService.Result r = purge.purge(device);
        return new com.voltpilot.api.web.dto.DevicePurgeResultDto(
                r.deviceId(), r.purgedRows(), r.purgedBefore(), r.deviceNotified());
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
        series.purgeDeviceRecordings(deviceId, device.siteId(), null);
        if (!devices.delete(deviceId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found");
        }
        provisioning.ifAvailable(p ->
                p.clearRetained(device.externalRef(), tenantId, device.siteId(), device.id()));
        // v2 hygiene: the retained entity-registry slot dies with the device
        // (a re-claim mints a NEW device id, so the old subtree would otherwise
        // keep an orphaned retained push forever). Best-effort like the rest.
        entityRegistry.ifAvailable(p ->
                p.clearRegistry(tenantId, device.siteId(), device.id()));
        // First-boot enrollment counterpart: drop the device's broker ACL grant
        // so an issued mTLS certificate loses topic access (best-effort; CRL
        // revocation stays the operator-run cryptographic backstop).
        enrollment.ifAvailable(e -> e.onDeviceUnclaimed(device.id()));
        // OTA Stufe 2: die Update-Zuweisung stirbt mit dem Gerät. Ohne das
        // wartete auf dem Broker eine retained Anweisung an eine Identität,
        // die es nicht mehr gibt - dieselbe Hygiene wie beim retained
        // Provisionierungs-Config und beim Entity-Push, best-effort.
        rollouts.ifAvailable(r -> r.onDeviceUnclaimed(tenantId, device.siteId(), device.id()));
        // Und die Steuerungs-Freigabe: eine scharfgeschaltete Anlage, deren
        // Gerät niemandem mehr gehört, darf weder in der Liste stehen noch ein
        // retained Zertifizierungs-Dokument auf dem Broker liegen lassen -
        // dieselbe Hygiene wie eine Zeile darüber, best-effort.
        controlCertification.onDeviceUnclaimed(tenantId, device.siteId(), device.id());
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
