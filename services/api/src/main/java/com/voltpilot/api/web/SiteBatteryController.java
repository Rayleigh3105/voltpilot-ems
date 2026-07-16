package com.voltpilot.api.web;

import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.SaveBatteryRequest;
import com.voltpilot.api.web.dto.SiteAssetDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Maintain a site's battery master data by hand ("Ihr Wechselrichter steuert
 * diesen Speicher"): capacity/power/efficiency plus the controlling-device
 * link. This is the surface for plants NOT in the Marktstammdatenregister (the
 * long-standing gap - such a plant could not keep its battery data in the app
 * at all) and for correcting the device link on a multi-device site.
 *
 * <p>Tenant-scoped exactly like the rest of the site API: the site resolution
 * runs under RLS (foreign site => 404 before any write), the asset upsert lands
 * in the caller's tenant via RLS' WITH CHECK, and a device chosen for the link
 * is validated to belong to this site (RLS makes another tenant's device
 * invisible => 404). Admins reach any tenant through the {@code X-Tenant-Id}
 * switcher like every customer endpoint.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteBatteryController {

    private final SiteRepository sites;
    private final AssetRepository assets;
    private final DeviceRepository devices;

    public SiteBatteryController(SiteRepository sites, AssetRepository assets,
            DeviceRepository devices) {
        this.sites = sites;
        this.assets = assets;
        this.devices = devices;
    }

    /**
     * Upsert the battery params and maintain its device link, then return the
     * site's full asset list (the drawer re-renders from it). One transaction so
     * the param write and the link never half-apply.
     *
     * <p>Device link: when {@code deviceId} is given it is validated to belong to
     * this site and linked; when omitted the auto-link claims the site's single
     * device (the self-maintaining rule) - a multi-device site with no explicit
     * choice is simply left unlinked, and the portal warns.
     *
     * <p>Speicherschonung (FK4): a given preset is mapped onto the battery's
     * {@code wear_cost_ct_per_kwh} - and ONLY that column; the admin SoC-band /
     * backup-reserve overrides are never part of a preset write. Null/absent
     * keeps the stored value.
     */
    @Transactional
    @PutMapping("/battery")
    public List<SiteAssetDto> saveBattery(@PathVariable UUID siteId,
            @Valid @RequestBody SaveBatteryRequest request) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();
        assets.saveBattery(tenantId, siteId, request.capacityKwh(), request.maxChargeKw(),
                request.maxDischargeKw(), request.roundtripEfficiencyPct());
        if (request.speicherschonung() != null) {
            assets.setBatteryWearCost(siteId,
                    Speicherschonung.wearCtFor(request.speicherschonung()));
        }
        if (request.deviceId() != null) {
            DeviceDto device = devices.findById(request.deviceId())
                    .filter(d -> d.siteId().equals(siteId))
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                            "Device not found at this site"));
            assets.linkBatteryDevice(siteId, device.id());
        } else {
            // Common single-device case: link the one device automatically.
            assets.autoLinkBatteryDevice(siteId);
        }
        return assets.findForSite(siteId);
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
    }
}
