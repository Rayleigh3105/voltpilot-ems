package com.voltpilot.api.web;

import com.voltpilot.api.mastr.MastrService;
import com.voltpilot.api.mastr.RegistryLookupException;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.EinheitGeraetRepository;
import com.voltpilot.api.repo.RegisterEinheitRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MastrApplyRequest;
import com.voltpilot.api.web.dto.MastrLokationApplyRequest;
import com.voltpilot.api.web.dto.MastrLokationPreviewDto;
import com.voltpilot.api.web.dto.MastrLookupRequest;
import com.voltpilot.api.web.dto.MastrPreviewDto;
import com.voltpilot.api.web.dto.EinheitGeraetDto;
import com.voltpilot.api.web.dto.RegisterEinheitDto;
import com.voltpilot.api.web.dto.RegisterEinheitHinweisDto;
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
import org.springframework.web.bind.annotation.DeleteMapping;
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
    private final RegisterEinheitRepository einheiten;
    private final EinheitGeraetRepository einheitGeraet;

    public MastrController(Geltungsbereich geltungsbereich, AssetRepository assets, MastrService mastr,
            RegisterEinheitRepository einheiten, EinheitGeraetRepository einheitGeraet) {
        this.geltungsbereich = geltungsbereich;
        this.assets = assets;
        this.mastr = mastr;
        this.einheiten = einheiten;
        this.einheitGeraet = einheitGeraet;
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

    /** S1/S2: every registered unit of the site, confirmed or still-suggested (Abschnitt 5.1). */
    @GetMapping("/register-einheiten")
    public List<RegisterEinheitDto> einheiten(@PathVariable UUID siteId) {
        requireSite(siteId);
        return einheiten.findForSite(siteId);
    }

    /**
     * S2 (Lokations-Suche, Abschnitt 5.3): the typed unit plus every sibling
     * at the same Lokation. NOT persisted - same confirm-first contract as
     * {@link #lookup}.
     */
    @PostMapping("/mastr-lokation-lookup")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public MastrLokationPreviewDto lookupLokation(@PathVariable UUID siteId,
            @Valid @RequestBody MastrLookupRequest request) throws RegistryLookupException {
        requireSite(siteId);
        return mastr.lookupLocation(request.einheitNummer());
    }

    /**
     * Persist the customer-CONFIRMED selection of a Lokations-Suche preview,
     * one unit per upsert in ONE transaction - idempotent on {@code (site_id,
     * registry_unit_id)}, exactly like {@link #apply}.
     */
    @Transactional
    @PostMapping("/mastr-lokation-apply")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public List<RegisterEinheitDto> applyLokation(@PathVariable UUID siteId,
            @Valid @RequestBody MastrLokationApplyRequest request) {
        requireSite(siteId);
        if (request.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "At least one unit (pv/storage) is required");
        }
        UUID tenantId = TenantContext.get();
        einheiten.applyUnits(tenantId, siteId, request.pv(), request.storage(), "mastr", Instant.now(), "kunde");
        return einheiten.findForSite(siteId);
    }

    /**
     * S5 (Abschnitt 5.1/§8, „Zuordnung zu Wechselrichtern"): jede bestehende
     * Geräte-Zuordnung der Anlage, dazu jedes PV-fähige Gerät, das noch frei
     * ist - für den Zuordnen-Dialog in der Gruppe "Solaranlage".
     */
    @GetMapping("/einheit-geraet")
    public EinheitGeraetDto einheitGeraet(@PathVariable UUID siteId) {
        requireSite(siteId);
        return new EinheitGeraetDto(
                einheitGeraet.zuordnungenFuerSite(siteId).stream()
                        .map(z -> new EinheitGeraetDto.Zeile(z.id(), z.einheitId(), z.geraetId(), z.art(), z.bezeichnung()))
                        .toList(),
                einheitGeraet.geraeteFuerSite(siteId).stream()
                        .filter(k -> k.zugeordnetAn() == null)
                        .map(k -> new EinheitGeraetDto.Kandidat(k.id(), k.art(), k.bezeichnung(), k.nennleistungKw()))
                        .toList());
    }

    /** Ordnet ein freies Gerät dieser Einheit zu - 404, wenn Einheit oder Gerät nicht an dieser Anlage hängen. */
    @PostMapping("/register-einheiten/{einheitId}/geraet")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public EinheitGeraetDto geraetZuordnen(@PathVariable UUID siteId, @PathVariable UUID einheitId,
            @Valid @RequestBody EinheitGeraetZuordnenRequest request) {
        requireSite(siteId);
        if (einheiten.findForSite(siteId).stream().noneMatch(e -> e.id().equals(einheitId))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Einheit not found at this site");
        }
        boolean geraetGehoertZurAnlage = einheitGeraet.geraeteFuerSite(siteId).stream()
                .anyMatch(k -> k.id().equals(request.geraetId()) && k.art().equals(request.art()));
        if (!geraetGehoertZurAnlage) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Geraet not found at this site");
        }
        UUID tenantId = TenantContext.get();
        UUID messpunkt = "messpunkt".equals(request.art()) ? request.geraetId() : null;
        UUID geraetTeil = "erzeugungseinheit".equals(request.art()) ? request.geraetId() : null;
        einheitGeraet.zuordnen(tenantId, einheitId, messpunkt, geraetTeil);
        return einheitGeraet(siteId);
    }

    /** Entfernt eine Geräte-Zuordnung (Anzeige-only, keine Berechnung hängt daran). */
    @DeleteMapping("/register-einheiten/{einheitId}/geraet/{linkId}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.ANLAGE)
    public EinheitGeraetDto geraetEntfernen(@PathVariable UUID siteId, @PathVariable UUID einheitId,
            @PathVariable UUID linkId) {
        requireSite(siteId);
        einheitGeraet.entfernen(einheitId, linkId);
        return einheitGeraet(siteId);
    }

    /**
     * S5 (Abschnitt 4.4, „fehlt eine Einheit?"): die gemessene PV-Spitze der
     * letzten 30 Tage gegen die Summe der bestätigten PV-Einheiten - dasselbe
     * Plausibilitäts-Fenster wie {@code AdminFleetController.PV_PEAK_LOOKBACK}.
     */
    @GetMapping("/register-einheiten-hinweis")
    public RegisterEinheitHinweisDto registerEinheitenHinweis(@PathVariable UUID siteId) {
        requireSite(siteId);
        java.math.BigDecimal summe = einheiten.findForSite(siteId).stream()
                .filter(e -> "pv".equals(e.art()) && e.bestaetigtAm() != null && e.leistungKwp() != null)
                .map(RegisterEinheitDto::leistungKwp)
                .reduce(java.math.BigDecimal.ZERO, java.math.BigDecimal::add);
        EinheitGeraetRepository.PvPeak peak = einheitGeraet.gemessenePeak(siteId,
                Instant.now().minus(java.time.Duration.ofDays(30)));
        return new RegisterEinheitHinweisDto(
                einheitGeraet.moeglicherweiseFehlendeEinheit(summe, peak),
                peak.peakKw(), summe, peak.buckets());
    }

    /** Welches Gerät ({@code messpunkt}|{@code erzeugungseinheit}) einer Einheit zugeordnet wird. */
    public record EinheitGeraetZuordnenRequest(@jakarta.validation.constraints.NotNull UUID geraetId,
            @jakarta.validation.constraints.Pattern(regexp = "messpunkt|erzeugungseinheit") String art) {
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
