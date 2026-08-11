package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ComponentAdoptionService;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.SiteRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Platform-admin surface of the v2 entity registry: the E1a PILOT MAPPING
 * (bootstrap composes the three pilot entities from v1 master data; nothing
 * converts automatically - the E13a cutover calls it per site) plus the E1b
 * catalog-driven CRUD for the open entity types (wallbox / heating-rod /
 * generic-load / ... - the type catalog is data, adding a type is never a
 * schema release). Composed pilot configs stay maintained through their v1
 * master data; direct create/guard-edit of them is refused (never two
 * truths).
 *
 * <p>Like {@link AdminOptimizerController}, this reads/writes THROUGH the
 * RLS-scoped app datasource via the {@code X-Tenant-Id} switcher: no tenant
 * selected, or the wrong one, and the site is invisible => 404. No BYPASSRLS.
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}/v2-entities")
@PreAuthorize("hasRole('platform-admin')")
public class AdminEntityRegistryController {

    /** One registry entity as the admin surface renders it. */
    public record EntityAdminDto(UUID id, String entityType, String role, String label,
            UUID deviceId, JsonNode capabilities, JsonNode guards) {}

    /** Bootstrap/push response envelope. */
    public record BootstrapResponse(List<EntityAdminDto> entities, List<String> skipped,
            EntityRegistryService.PushOutcome push) {}

    /** Create/edit request. capabilities/guards are optional JSON overrides. */
    public record SaveEntityRequest(
            @Size(max = 63) String entityType,
            @Size(max = 200) String label,
            @DecimalMin("0.0") @DecimalMax("10000.0") BigDecimal maxPowerKw,
            JsonNode capabilities,
            JsonNode guards) {}

    /**
     * Adopt an edge-reported source (U2, report §3.3): {@code sourceId} is the
     * edge source id from the heartbeat local_setup; {@code entityType} the
     * catalog type (suggested from the reported role, confirmable by the admin).
     * capacityKwp / registryUnitId are the customer-only master data captured
     * once here (the ErzeugerSourcesPanel job, §3.4).
     */
    public record AdoptRequest(
            @Size(max = 128) String sourceId,
            @Size(max = 63) String entityType,
            @Size(max = 200) String label,
            @DecimalMin("0.0") @DecimalMax("10000.0") BigDecimal maxPowerKw,
            @DecimalMin("0.0") @DecimalMax("100000.0") BigDecimal capacityKwp,
            @Size(max = 64) String registryUnitId) {}

    private final SiteRepository sites;
    private final EntityRegistryRepository repo;
    private final EntityRegistryService service;
    private final ComponentAdoptionService adoption;
    private final ObjectMapper mapper;

    public AdminEntityRegistryController(SiteRepository sites, EntityRegistryRepository repo,
            EntityRegistryService service, ComponentAdoptionService adoption,
            ObjectMapper mapper) {
        this.sites = sites;
        this.repo = repo;
        this.service = service;
        this.adoption = adoption;
        this.mapper = mapper;
    }

    @GetMapping
    public List<EntityAdminDto> list(@PathVariable UUID siteId) {
        requireSite(siteId);
        return repo.entitiesForSite(siteId).stream().map(this::toDto).toList();
    }

    /** Create a v2-native entity of an open catalog type (E1b). */
    @PostMapping
    public EntityAdminDto create(@PathVariable UUID siteId,
            @Valid @RequestBody SaveEntityRequest request) {
        requireSite(siteId);
        if (request.entityType() == null || request.entityType().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "entityType ist erforderlich.");
        }
        return toDto(service.createEntity(siteId, request.entityType(), request.label(),
                request.maxPowerKw(), request.capabilities(), request.guards()));
    }

    /**
     * Adopt an edge-reported source into a v2 entity (U2 adoption bridge,
     * admin-only first increment). Idempotent per {@code sourceId}.
     */
    @PostMapping("/adopt")
    public EntityAdminDto adopt(@PathVariable UUID siteId,
            @Valid @RequestBody AdoptRequest request) {
        requireSite(siteId);
        if (request.entityType() == null || request.entityType().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "entityType ist erforderlich.");
        }
        return toDto(service.adopt(siteId, request.sourceId(), request.entityType(),
                request.label(), request.maxPowerKw(), request.capacityKwp(),
                request.registryUnitId()));
    }

    /** Edit an entity (label; config only for non-composed types). */
    @PutMapping("/{pointId}")
    public EntityAdminDto update(@PathVariable UUID siteId, @PathVariable UUID pointId,
            @Valid @RequestBody SaveEntityRequest request) {
        requireSite(siteId);
        EntityRegistryRepository.EntityRow row = service.updateEntity(siteId, pointId,
                request.label(), request.maxPowerKw(), request.capabilities(), request.guards());
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        return toDto(row);
    }

    /**
     * Remove an entity (v1-backed rows only lose their entity config).
     * {@code purgePoint=true} additionally deletes the measurement point
     * outright - kWp released from the aggregate, source pin freed - the
     * duplicate-cleanup lever (vp-vier-erzeuger-p9); without it a wrongly
     * adopted duplicate reappears as "Neues Gerät gefunden" forever.
     */
    @DeleteMapping("/{pointId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID siteId, @PathVariable UUID pointId,
            @RequestParam(defaultValue = "false") boolean purgePoint) {
        requireSite(siteId);
        if (!service.deleteEntity(siteId, pointId, purgePoint)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
    }

    /**
     * Dry-run the conversion (MIG migration runbook step 1): report exactly what
     * {@code bootstrap} would create/refresh from the site's current master
     * data - the entities, their derived roles, capabilities and guards, the
     * resolved gateway device - WITHOUT writing anything. Idempotent + safe to
     * call repeatedly while reviewing.
     */
    @GetMapping("/preview")
    public EntityRegistryService.ConversionPreview preview(@PathVariable UUID siteId) {
        requireSite(siteId);
        return service.preview(siteId);
    }

    /**
     * Create/refresh the pilot entities from the site's current master data and
     * best-effort push the registry to the gateway device. Idempotent.
     */
    @PostMapping("/bootstrap")
    public BootstrapResponse bootstrap(@PathVariable UUID siteId) {
        requireSite(siteId);
        EntityRegistryService.BootstrapResult result = service.bootstrap(siteId);
        return new BootstrapResponse(
                result.entities().stream().map(this::toDto).toList(),
                result.skipped(), result.push());
    }

    /** Set/clear the v1->v2 history cutover request body. */
    public record HistoryCutoverRequest(java.time.Instant at) {}

    /** The site's current history cutover status (null = un-migrated / pure v1). */
    @GetMapping("/history-cutover")
    public EntityRegistryService.HistoryCutover historyCutover(@PathVariable UUID siteId) {
        requireSite(siteId);
        return service.historyCutover(siteId);
    }

    /**
     * Set the site's history cutover instant (MIG runbook: the portal Historie
     * splices v1 before / v2 after this instant). Body {@code at} optional -
     * defaults to now.
     */
    @PutMapping("/history-cutover")
    public EntityRegistryService.HistoryCutover setHistoryCutover(@PathVariable UUID siteId,
            @RequestBody(required = false) HistoryCutoverRequest request) {
        requireSite(siteId);
        EntityRegistryService.HistoryCutover result = service.setHistoryCutover(siteId,
                request == null ? null : request.at());
        if (result == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return result;
    }

    /** Clear the history cutover (MIG rollback: Historie reverts to pure v1). */
    @DeleteMapping("/history-cutover")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void clearHistoryCutover(@PathVariable UUID siteId) {
        requireSite(siteId);
        service.clearHistoryCutover(siteId);
    }

    /**
     * Die Bestands-Übernahme JETZT versuchen (Einheitsmodell Stufe 2).
     *
     * <p>Sie läuft ohnehin automatisch (Captain-Entscheid E2); diese Route ist
     * der Support-Hebel, um sie ohne Wartezeit anzustoßen und - vor allem - ihren
     * GRUND zu sehen: der Ausgang nennt beim Namen, warum eine Anlage noch
     * box-verwaltet ist („meldet noch nicht, wie ihre Geräte angebunden sind",
     * „steht nicht im Geräte-Verzeichnis", …). Ohne ihn wäre das Warten
     * unerklärlich.
     */
    @PostMapping("/adopt-from-device")
    public ComponentAdoptionService.Outcome adoptFromDevice(@PathVariable UUID siteId) {
        requireSite(siteId);
        return adoption.adoptIfComplete(siteId);
    }

    /**
     * Der RÜCKWEG: die Anlage wieder am Gerät verwalten lassen.
     *
     * <p>Er existiert für den Fall, dass eine Übernahme in der Praxis klemmt.
     * Er nimmt AUSSCHLIESSLICH die Autorität zurück - die gespeicherten
     * Definitionen bleiben stehen (sie sind der Beleg, was übernommen wurde, und
     * der Weg zurück nach vorn). Der folgende Push trägt das Autoritäts-Feld
     * nicht mehr, womit der Applier auf der Box strukturell nichts mehr anwendet
     * und {@code :8484} wieder bedient.
     */
    @PostMapping("/revert-to-device")
    public ComponentAdoptionService.Outcome revertToDevice(@PathVariable UUID siteId,
            org.springframework.security.core.Authentication auth) {
        requireSite(siteId);
        return adoption.revertToBox(siteId, auth == null ? "admin" : auth.getName());
    }

    /** Re-push the stored registry (e.g. after a broker outage or re-claim). */
    @PostMapping("/push")
    public BootstrapResponse push(@PathVariable UUID siteId) {
        requireSite(siteId);
        EntityRegistryService.PushOutcome push = service.pushRegistryBestEffort(siteId);
        return new BootstrapResponse(
                repo.entitiesForSite(siteId).stream().map(this::toDto).toList(),
                List.of(), push);
    }

    private EntityAdminDto toDto(EntityRegistryRepository.EntityRow row) {
        return new EntityAdminDto(row.id(), row.entityType(), row.role(), row.label(),
                row.deviceId(), parse(row.capabilitiesJson()), parse(row.guardConfigJson()));
    }

    private JsonNode parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
    }
}
