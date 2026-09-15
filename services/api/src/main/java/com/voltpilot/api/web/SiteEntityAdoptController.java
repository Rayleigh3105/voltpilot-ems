package com.voltpilot.api.web;

import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.uems.BelegeImWeg;
import com.voltpilot.api.uems.BerichtsBelege;
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
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
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

    /** Composed by the platform from the plant's master data - never customer-edited. */
    private static final Set<String> PLATFORM_MANAGED = Set.of("battery-hybrid", "house-load");

    /**
     * The measurement-point roles the platform SYNTHESIZES from the gateway
     * ({@code createComposedPoint}: grid-meter + house-load). A pinless row of
     * one of these roles is ALWAYS the plant's Grundausstattung - there is no
     * customer path to a pinless grid-meter (adopted meters carry a pin; the
     * manual flows create producer / modbus-generic). This is the durable pin
     * guard: {@code source_kind = 'composed'} is stamped only at create time and
     * a legacy composed row keeps it NULL (never back-filled), so guarding by
     * the role too protects those older rows without a data migration.
     */
    private static final Set<String> COMPOSED_BASE_ROLES = Set.of("grid-meter", "house-load");

    private final Geltungsbereich geltungsbereich;
    private final EntityRegistryService service;
    private final EntityTypeCatalog catalog;
    private final EntityObservedRepository observed;
    private final EntityRegistryRepository registry;
    private final BerichtsBelege berichtsBelege;

    public SiteEntityAdoptController(Geltungsbereich geltungsbereich, EntityRegistryService service,
            EntityTypeCatalog catalog, EntityObservedRepository observed,
            EntityRegistryRepository registry, BerichtsBelege berichtsBelege) {
        this.geltungsbereich = geltungsbereich;
        this.service = service;
        this.catalog = catalog;
        this.observed = observed;
        this.registry = registry;
        this.berichtsBelege = berichtsBelege;
    }

    @PostMapping("/adopt")
    @Transactional
    public AdoptedEntityDto adopt(@PathVariable UUID siteId,
            @Valid @RequestBody AdoptRequest request) {
        geltungsbereich.requireSite(siteId);
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
     * Re-pin body: the CURRENTLY reported edge source the entity should follow.
     * {@code swap} (optional, default false) is the customer's explicit consent
     * to take a source that ANOTHER component currently holds - see
     * {@link #repin}. Absent = the documented 409, so an older client can never
     * steal an assignment by accident.
     */
    public record RepinRequest(@Size(max = 128) String sourceId, Boolean swap) {}

    /**
     * RE-PIN an existing entity to a currently reported edge source - the
     * repair for identity churn and crossed pins (vp-vier-erzeuger-p9): a
     * source deleted + re-added on the device got a new id, the entity's pin
     * went stale ({@code orphanedPin}) and the same physical device showed up
     * as "Neues Gerät gefunden"; re-pinning RECONNECTS the existing component
     * instead of minting a duplicate. Safe for customers: it only moves the
     * presentation-level source link of their OWN site (RLS), never guard
     * config or control rights. The target must be currently reported by the
     * device and role-compatible with the entity's type.
     *
     * <p>With {@code swap: true} a target held by ANOTHER component is not
     * refused but EXCHANGED - both assignments move inside one transaction
     * (vp-bereinigung-ui-k3). The captain's Pilsting plant is why: with every
     * reported device already pinned (to the wrong components), plain re-pin
     * only ever answered 409 and the customer had no way out at all. A
     * client-side "release, then set" was rejected as the fix - a failure
     * between the two calls would strand BOTH components unassigned.
     */
    @PostMapping("/{entityId}/edge-source")
    @Transactional
    public AdoptedEntityDto repin(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @Valid @RequestBody RepinRequest request) {
        geltungsbereich.requireSite(siteId);
        String sourceId = request.sourceId() == null ? "" : request.sourceId().trim();
        if (sourceId.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "sourceId ist erforderlich.");
        }
        Set<String> reported = reportedSourceIds(siteId);
        if (!reported.contains(sourceId)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieses Gerät meldet sich derzeit nicht - verbinden ist nur mit einem "
                            + "aktuell gemeldeten Gerät möglich.");
        }
        EntityObservedRepository.ObservedRow local = observed.forSite(siteId).stream()
                .filter(r -> "local".equals(r.source())
                        && ("local:" + sourceId).equals(r.entityId()))
                .findFirst().orElseThrow();
        EntityRegistryRepository.EntityRow current = registry.entityForSite(siteId, entityId);
        if (current == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        requireCustomerManaged(current.entityType());
        requireRoleFit(local.edgeRole(), current.entityType());
        EntityRegistryRepository.EntityRow row = service.repin(siteId, entityId, sourceId,
                Boolean.TRUE.equals(request.swap()), reported);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        return new AdoptedEntityDto(row.id(), row.entityType(), row.role(), row.label(),
                row.deviceId());
    }

    /** Rename body: the customer's own name for this component. */
    public record LabelRequest(@Size(max = 200) String label) {}

    /**
     * RENAME a component - the customer twin of the admin label PUT (concept
     * vp-entity-alias-k1; the M6 docs called it "die eine offene Backend-Arbeit
     * des Designs"). The name is what the customer calls the thing ("Dach Süd"),
     * and after the Label-Hygiene migration a non-null label MEANS human-given,
     * so it wins the customer-facing name chain over the edge label.
     *
     * <p><b>R1 - a name is PRESENTATION, never an intervention.</b> Enforced by
     * construction, not by promise: this route accepts ONLY {@code label}. There
     * is no type, no role, no pin, no guard field in the request, so nothing can
     * be smuggled through the rename door; assignment and control keep their own
     * already-gated routes ({@link #repin}, the admin config PUT).
     *
     * <p><b>Every component may be renamed - deliberately no PLATFORM_MANAGED
     * gate</b> (Captain, 09.08.2026). {@link #repin} and {@link #delete} refuse
     * battery-hybrid / house-load because those CHANGE what a component is or
     * whether it exists; a name changes neither. A customer who calls their
     * battery "Keller" or their grid connection "Hausanschluss Nord" is describing
     * their own plant, and the platform keeps composing and maintaining that row
     * exactly as before - only its TYPE and ROLE stay ours.
     *
     * <p>Semantics mirror {@code updateEntity} so there is ONE label-writing rule
     * in the codebase: an ABSENT/null field keeps the current name (a no-op), an
     * EMPTY one clears it - back to the derived name, never an empty label (R5).
     * Duplicates are allowed on purpose: two arrays may both be called "Dach".
     */
    @PutMapping("/{entityId}/label")
    @Transactional
    public AdoptedEntityDto rename(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @Valid @RequestBody LabelRequest request) {
        geltungsbereich.requireSite(siteId);
        EntityRegistryRepository.EntityRow row = service.updateEntity(siteId, entityId,
                normalizeLabel(request.label()), null, null, null);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        return new AdoptedEntityDto(row.id(), row.entityType(), row.role(), row.label(),
                row.deviceId());
    }

    /**
     * Trim, and collapse newlines/control characters into single spaces - a name
     * is one line of text, and a pasted multi-line string would break every
     * surface that renders it in a row. null stays null (= keep the current
     * name); a string that is only whitespace becomes "" (= clear it, which
     * {@code updateEntity} stores as NULL).
     */
    private static String normalizeLabel(String raw) {
        if (raw == null) {
            return null;
        }
        return raw.replaceAll("[\\p{Cntrl}\\s]+", " ").trim();
    }

    /**
     * DELETE an adopted component - the cleanup lever the customer was missing
     * (vp-bereinigung-ui-k3, the captain's "Wie kann ich das Gerät was nichts
     * misst löschen, ich bekomme es nicht weg."). It PURGES the measurement
     * point outright (the {@code purgePoint} behaviour of PR #271, until now
     * reachable only through the platform-admin route): the producer's kWp is
     * released from the aggregate {@code asset.pv} and the source pin is freed,
     * so the device reappears as "Neues Gerät gefunden" and can be assigned to
     * the RIGHT component. The registry re-push makes the device drop it too.
     *
     * <p>Two guards keep this the CLEANUP lever and not a demolition button:
     * <ul>
     *   <li>the platform-composed base components (battery-hybrid / house-load)
     *       are refused by {@link #requireCustomerManaged} - deleting one would
     *       only make the composition recreate it;</li>
     *   <li>a platform-SYNTHESIZED base row without a device pin (the grid-meter
     *       / house-load {@code EntityRegistryService} derives from the gateway)
     *       is its Grundausstattung, not something a customer adopted by mistake,
     *       and stays refused.</li>
     * </ul>
     *
     * <p><b>A customer-created component with NO pin is now deletable</b>
     * (Captain-Entscheid E2, vp-komp-loeschen). Before, ANY {@code
     * edgeSourceId == null} row was refused as "Grundausstattung" - too coarse:
     * a producer a customer created by mistake and never connected (freshly
     * added or MaStR-imported) could never be removed, and a producer whose pin
     * was released by a swap got stranded as a nameless row.
     *
     * <p>The pinless guard therefore fires only for the SYNTHESIZED base rows,
     * and it recognises them by TWO signals: the {@code source_kind = 'composed'}
     * marker AND the composed base ROLE ({@link #COMPOSED_BASE_ROLES}). The role
     * is load-bearing, not redundant: {@code source_kind} is stamped only at
     * create time, so a grid-meter composed before that column existed carries
     * {@code source_kind = NULL} (never back-filled) - guarding by role too keeps
     * those legacy rows protected without a data migration.
     *
     * <p><b>A component that is a Beleg is refused</b> (UEMS AP-12 E13 S2): when a released
     * Berichtsstand cites a Messstelle this component ever fed, the delete is 409
     * {@code berichts_belege} with the list of those Stände - checked after the guards above and
     * before anything is written ({@link BerichtsBelege#pruefeKomponente}).
     */
    @DeleteMapping("/{entityId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void delete(@PathVariable UUID siteId, @PathVariable UUID entityId) {
        geltungsbereich.requireSite(siteId);
        EntityRegistryRepository.EntityRow row = registry.entityForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        requireCustomerManaged(row.entityType());
        if (row.edgeSourceId() == null
                && (EntityRegistryRepository.SOURCE_KIND_COMPOSED.equals(row.sourceKind())
                        || COMPOSED_BASE_ROLES.contains(row.role()))) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Komponente gehört zur Grundausstattung Ihrer Anlage und kann nicht "
                            + "entfernt werden.");
        }
        berichtsBelege.pruefeKomponente(siteId, entityId);
        if (!service.deleteEntity(siteId, entityId, true)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
    }

    /** The edge source ids the device currently reports (its local setup view). */
    private Set<String> reportedSourceIds(UUID siteId) {
        return observed.forSite(siteId).stream()
                .filter(r -> "local".equals(r.source()) && r.entityId() != null
                        && r.entityId().startsWith("local:"))
                .map(r -> r.entityId().substring("local:".length()))
                .collect(java.util.stream.Collectors.toSet());
    }

    /**
     * The platform composes and maintains the battery/hybrid inverter and the
     * derived house consumption from the plant's master data - they carry no
     * device assignment and are not the customer's to re-pin or remove (the
     * {@code EntityRegistryService} composition would recreate them anyway).
     */
    private void requireCustomerManaged(String entityType) {
        if (PLATFORM_MANAGED.contains(entityType)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Diese Komponente richtet VoltPilot aus den Daten Ihrer Anlage ein - "
                            + "sie lässt sich hier nicht ändern.");
        }
    }

    /**
     * The reported role must fit the entity's type: a producer follows a
     * pv-generation source, a grid-meter a grid-meter source, a consumer-
     * category type a consumer source. A report without a role passes (older
     * edge) - the human confirmed the match in the dialog.
     */
    private void requireRoleFit(String edgeRole, String entityType) {
        if (edgeRole == null || edgeRole.isBlank() || entityType == null) {
            return;
        }
        EntityTypeCatalog.EntityType def = catalog.find(entityType);
        boolean fits = switch (edgeRole) {
            case "pv-generation" -> "producer".equals(entityType);
            case "grid-meter" -> "grid-meter".equals(entityType);
            case "consumer" -> def != null && "consumer".equals(def.category());
            default -> true;
        };
        if (!fits) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieses Gerät meldet eine andere Rolle als die Komponente - bitte als "
                            + "neue Komponente übernehmen.");
        }
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

    /** The component is a Beleg of released Berichtsstände: 409 with the list - nothing written. */
    @ExceptionHandler(BelegeImWeg.class)
    public ResponseEntity<Map<String, Object>> belegeImWeg(BelegeImWeg e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    /** German reasons reach the portal as {"message": ...} (SiteFlowController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
