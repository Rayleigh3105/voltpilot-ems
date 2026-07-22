package com.voltpilot.api.web;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.repo.SiteRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The CUSTOMER twin of the v2 entity adoption bridge (Portal v3 M6 "Neues Gerät
 * gefunden … jetzt zuordnen", OPEN O3). A Portal-User assigns an edge-reported
 * source of THEIR OWN site to a component in one move. Tenant-scoped like every
 * {@code /api/v1/sites/**} route ({@link SiteTopologyController},
 * {@link SiteFlowController}): NO {@code @PreAuthorize} — authentication +
 * Postgres RLS are the fence; a foreign site is 404, never 403. Admins reach any
 * tenant through the {@code X-Tenant-Id} switcher over this same RLS-scoped path.
 *
 * <p>It delegates to the SAME {@link EntityRegistryService#adopt} the admin route
 * uses, but is <b>catalog-guarded to the GUIDED types only</b> — producer,
 * grid-meter and consumer-category types (the set the guided suggestion derives,
 * `rollen.ts suggestEntityType`). It is never a free type picker and never takes
 * guard-config input: platform-managed composed types (battery-hybrid /
 * house-load) and free installer types (modbus-generic) are refused, so a
 * customer can never inject a raw type or a guard band through this door.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/v2-entities")
public class SiteEntityAdoptController {

    /** The adopt body (the admin route's shape, minus any guard-config input). */
    public record AdoptRequest(
            @Size(max = 128) String sourceId,
            @Size(max = 63) String entityType,
            @Size(max = 200) String label,
            @DecimalMin("0.0") @DecimalMax("10000.0") BigDecimal maxPowerKw,
            @DecimalMin("0.0") @DecimalMax("100000.0") BigDecimal capacityKwp,
            @Size(max = 64) String registryUnitId) {}

    /** The adopted entity as the customer surface needs it (the AdminEntity shape). */
    public record AdoptedEntityDto(UUID id, String entityType, String role, String label,
            UUID deviceId) {}

    /** The two composed types adoptable FROM a source (never battery-hybrid/house-load). */
    private static final Set<String> COMPOSED_ADOPTABLE = Set.of("producer", "grid-meter");

    private final SiteRepository sites;
    private final EntityRegistryService service;
    private final EntityTypeCatalog catalog;

    public SiteEntityAdoptController(SiteRepository sites, EntityRegistryService service,
            EntityTypeCatalog catalog) {
        this.sites = sites;
        this.service = service;
        this.catalog = catalog;
    }

    @PostMapping("/adopt")
    @Transactional
    public AdoptedEntityDto adopt(@PathVariable UUID siteId,
            @Valid @RequestBody AdoptRequest request) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        String type = request.entityType();
        if (type == null || type.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "entityType ist erforderlich.");
        }
        requireGuidedType(type);
        EntityRegistryRepository.EntityRow row = service.adopt(siteId, request.sourceId(), type,
                request.label(), request.maxPowerKw(), request.capacityKwp(),
                request.registryUnitId());
        return new AdoptedEntityDto(row.id(), row.entityType(), row.role(), row.label(),
                row.deviceId());
    }

    /**
     * Only the guided types may be adopted here: producer, grid-meter and any
     * consumer-category type. An unknown type is 400; a known-but-not-guided
     * type (battery-hybrid / house-load / a free installer type like
     * modbus-generic) is 422 with an honest German reason.
     */
    private void requireGuidedType(String type) {
        EntityTypeCatalog.EntityType def = catalog.find(type);
        if (def == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Diese Geräteart kennen wir nicht. Bitte wenden Sie sich an VoltPilot.");
        }
        boolean guided = COMPOSED_ADOPTABLE.contains(type) || "consumer".equals(def.category());
        if (!guided) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Geräteart richtet VoltPilot für Sie ein — sprechen Sie uns an.");
        }
    }

    /** German reasons reach the portal as {"message": ...} (SiteFlowController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
