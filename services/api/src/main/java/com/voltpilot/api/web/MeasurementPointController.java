package com.voltpilot.api.web;

import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.MeasurementPointRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.CreateMeasurementPointRequest;
import com.voltpilot.api.web.dto.MeasurementPointDto;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * A site's additional measurement points (multi-source Anlage master data). A
 * site with a battery-hybrid inverter PLUS a separate AC-coupled PV records the
 * second PV here as an Erzeuger source; its kWp sums into the aggregate {@code
 * asset.pv} the forecast reads. NO second device claim - the source is read
 * through the site's one claimed edge (report §3.1/§3.5).
 *
 * <p>Tenant-scoped exactly like the rest of the site API: the site resolution
 * runs under RLS (foreign site => 404 before any write), and every write lands
 * in the caller's tenant via RLS' WITH CHECK. Admins reach any tenant through
 * the {@code X-Tenant-Id} switcher like every customer endpoint.
 *
 * <p>Control safety: a measurement point recorded here is READ-ONLY by
 * construction (only read-only roles are accepted; the DB CHECK forbids control
 * on them). The battery setpoint / curtailment targets the battery-hybrid
 * inverter ONLY.
 *
 * <p>Roles: an Erzeuger (PV) source sums its kWp into {@code asset.pv}; a Netz
 * (grid meter) has no nameplate, does not touch {@code asset.pv}, and is capped
 * at one per site (a single meter at the point of common coupling); a Consumer
 * (Verbraucher, e.g. a go-e wallbox) has no nameplate, does not touch {@code
 * asset.pv}, and is NOT count-limited (a site may have several consumers). This
 * is master data only - the edge is the read authority and folds the meter into
 * the site grid; the aggregation itself lives on the edge (report Increment 1).
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/measurement-points")
public class MeasurementPointController {

    /** Read-only source roles recordable today. */
    private static final String ROLE_ERZEUGER = "pv-generation";
    private static final String ROLE_NETZ = "grid-meter";
    // A Verbraucher (e.g. a go-e wallbox read over its local HTTP API): read-only
    // like the other source roles, no nameplate (never touches asset.pv) and NOT
    // count-limited (a site may have several). Its load_kw rides the per-source
    // topic and (topology layer) renders as a consumer entity.
    private static final String ROLE_CONSUMER = "consumer";

    private final Geltungsbereich geltungsbereich;
    private final MeasurementPointRepository points;
    private final AssetRepository assets;
    private final EntityRegistryService entityRegistry;

    public MeasurementPointController(Geltungsbereich geltungsbereich, MeasurementPointRepository points,
            AssetRepository assets, EntityRegistryService entityRegistry) {
        this.geltungsbereich = geltungsbereich;
        this.points = points;
        this.assets = assets;
        this.entityRegistry = entityRegistry;
    }

    @GetMapping
    public List<MeasurementPointDto> list(@PathVariable UUID siteId) {
        requireSite(siteId);
        return points.findForSite(siteId);
    }

    /**
     * Record an additional read-only source. An Erzeuger adds its kWp to the
     * aggregate site PV (one transaction so the point and the aggregate never
     * half-apply); a Netz meter carries no nameplate and leaves {@code asset.pv}
     * untouched, and there may be at most one Netz per site.
     */
    @Transactional
    @PostMapping
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public List<MeasurementPointDto> create(@PathVariable UUID siteId,
            @Valid @RequestBody CreateMeasurementPointRequest request) {
        requireSite(siteId);
        UUID tenantId = TenantContext.get();

        String role = request.role() == null || request.role().isBlank()
                ? ROLE_ERZEUGER : request.role().trim();
        if (!ROLE_ERZEUGER.equals(role) && !ROLE_NETZ.equals(role) && !ROLE_CONSUMER.equals(role)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Diese Art von Energiequelle wird nicht unterstützt.");
        }
        String label = blankToNull(request.label());
        if (ROLE_NETZ.equals(role) && points.countByRole(siteId, ROLE_NETZ) > 0) {
            // Der ECHTE Zähler übernimmt die von der Plattform synthetisierte
            // Netz-Zeile ("gemessen über den Wechselrichter") - sonst bliebe
            // eine verbundene Anlage für immer beim Platzhalter, seit die
            // Komposition automatisch beim Claim läuft. Zwei Zeilen wären keine
            // Alternative: die Topologie summiert je Rolle.
            if (!points.adoptComposedGridMeter(siteId, label, blankToNull(request.brand()),
                    blankToNull(request.model()), blankToNull(request.registryUnitId()))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "Diese Anlage hat bereits einen Netz-Zähler. Es ist nur einer möglich.");
            }
            return points.findForSite(siteId);
        }
        // Only an Erzeuger's kWp feeds the aggregate PV; a meter and a consumer
        // have no nameplate.
        BigDecimal capacity = ROLE_ERZEUGER.equals(role) ? request.capacityKwp() : null;

        points.create(tenantId, siteId, role, label, blankToNull(request.brand()),
                blankToNull(request.model()), capacity, blankToNull(request.registryUnitId()));
        if (ROLE_ERZEUGER.equals(role)) {
            // The additional generation adds to the aggregate PV nameplate.
            assets.addPvCapacity(tenantId, siteId, capacity);
        }
        return points.findForSite(siteId);
    }

    /**
     * Remove an additional source and subtract its kWp from the aggregate site PV.
     * Unknown id (or another tenant's, which RLS hides) => 404.
     */
    @Transactional
    @DeleteMapping("/{pointId}")
    @Recht(value = "komponente.loeschen", ziel = RechtZiel.ANLAGE)
    public List<MeasurementPointDto> delete(@PathVariable UUID siteId,
            @PathVariable UUID pointId) {
        requireSite(siteId);
        MeasurementPointRepository.RoleAndEntityType row = points.roleAndEntityType(siteId, pointId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Measurement point not found");
        }
        // The battery-hybrid row is the primary inverter's v2 entity-registry
        // entry (control point), platform-managed via the admin bootstrap - the
        // customer source paths never created it and must not delete it.
        if ("battery-hybrid".equals(row.role())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Eintrag gehört zum Wechselrichter Ihrer Anlage und kann hier nicht "
                            + "entfernt werden.");
        }
        BigDecimal removedKwp = points.deleteReturningCapacity(siteId, pointId);
        if (removedKwp == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Measurement point not found");
        }
        assets.addPvCapacity(TenantContext.get(), siteId, removedKwp.negate());
        List<MeasurementPointDto> remaining = points.findForSite(siteId);
        if (row.isEntity()) {
            // The deleted row was a v2 entity: re-push the device's registry so
            // the edge clears its retained per-entity config (best-effort; the
            // delete itself never fails on a broker outage).
            entityRegistry.pushRegistryBestEffort(siteId);
        }
        return remaining;
    }

    private void requireSite(UUID siteId) {
        geltungsbereich.requireSite(siteId);
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }
}
