package com.voltpilot.api.web;

import com.voltpilot.api.entities.EntityAutoComposer;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BelegeImWeg;
import com.voltpilot.api.uems.BerichtsBelege;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.SaveBatteryRequest;
import com.voltpilot.api.web.dto.SiteAssetDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
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

    private final Geltungsbereich geltungsbereich;
    private final AssetRepository assets;
    private final DeviceRepository devices;
    private final EntityAutoComposer autoCompose;
    private final EntityRegistryService registry;
    private final EntityRegistryRepository entities;
    private final BerichtsBelege berichtsBelege;

    public SiteBatteryController(Geltungsbereich geltungsbereich, AssetRepository assets,
            DeviceRepository devices, EntityAutoComposer autoCompose,
            EntityRegistryService registry, EntityRegistryRepository entities,
            BerichtsBelege berichtsBelege) {
        this.geltungsbereich = geltungsbereich;
        this.assets = assets;
        this.devices = devices;
        this.autoCompose = autoCompose;
        this.registry = registry;
        this.entities = entities;
        this.berichtsBelege = berichtsBelege;
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
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
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
        // Ein Speicher, der NACH dem Gerät eingetragen wird, vervollständigt die
        // Komposition: bis hierher trägt die Anlage nur die aus dem Gateway
        // synthetisierten Netz-/Haus-Zeilen, die battery-hybrid-Zeile (PV +
        // Speicher des Hybriden) fehlt. Bewusst NACH dem Commit dieser
        // Transaktion - eine Ausnahme im Modell-Aufbau darf den Speicher-
        // Schreibvorgang niemals zurückrollen.
        autoCompose.ensureComposed(siteId);
        return assets.findForSite(siteId);
    }

    /**
     * "Batterie am Standort abmelden" (vp-komp-loeschen E1): the customer-facing
     * way to remove a {@code battery-hybrid} the platform otherwise hard-blocks.
     * It removes the three things that make up the battery TOGETHER - the {@code
     * asset} nameplate the optimizer reads, the battery entity's {@code
     * flow_claim} orphan, and the entity/measurement point (its recorded
     * telemetry is KEPT, only the live visibility goes) - and re-pushes the
     * registry so the edge forgets the source. See {@link
     * EntityRegistryService#unregisterBattery}.
     *
     * <p>Returns the site's remaining assets like {@link #saveBattery}, so the
     * drawer re-renders from one shape. Idempotent: a site without a battery is
     * a no-op that returns the unchanged list.
     */
    @Transactional
    @DeleteMapping("/battery")
    @Recht(value = "komponente.loeschen", ziel = RechtZiel.ANLAGE)
    public List<SiteAssetDto> unregisterBattery(@PathVariable UUID siteId) {
        requireSite(siteId);
        // UEMS AP-12 E13 S2: the battery-hybrid point is a component - when a released Berichtsstand
        // cites a Messstelle it fed, it is a Beleg: 409 with the list, before anything is written.
        UUID batterie = entities.batteryHybridPointId(siteId);
        if (batterie != null) {
            berichtsBelege.pruefeKomponente(siteId, batterie);
        }
        registry.unregisterBattery(siteId);
        return assets.findForSite(siteId);
    }

    /** The battery is a Beleg of released Berichtsstände (UEMS AP-12 E13 S2): 409 with the list - nothing written. */
    @ExceptionHandler(BelegeImWeg.class)
    public ResponseEntity<Map<String, Object>> belegeImWeg(BelegeImWeg e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }
}
