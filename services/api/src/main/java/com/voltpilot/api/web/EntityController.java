package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityObservedRepository.ObservedRow;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryRepository.EntityRow;
import com.voltpilot.api.entities.EntityRegistryRepository.RegistryState;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.history.HistoryRange;
import com.voltpilot.api.repo.EntityHistoryRepository;
import com.voltpilot.api.repo.SiteRepository;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The customer-facing entity surface (E1b "Geräte &amp; Entitäten"): the
 * site's v2 registry entities WITH their Soll/Ist reconciliation (registry
 * revision vs the edge-reported observed state - drift is SURFACED, never
 * silently resolved), the edge-local commissioning view, and the per-entity
 * history over the generic v2 telemetry rollups.
 *
 * <p>Tenant-scoped like every site route (RLS; foreign site = 404). Admins
 * read it through the {@code X-Tenant-Id} switcher; WRITES stay admin-only
 * under {@code /api/v1/admin/sites/{siteId}/v2-entities}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/entities")
public class EntityController {

    /** Per-entity Soll/Ist sync verdicts (portal renders the German copy). */
    static final String SYNC_IN_SYNC = "in_sync";
    static final String SYNC_PENDING = "pending";
    static final String SYNC_MISSING_ON_DEVICE = "missing_on_device";
    static final String SYNC_UNREPORTED = "unreported";
    static final String SYNC_NEVER_PUSHED = "never_pushed";

    public record ObservedDto(String health, Instant lastTelemetryAt, JsonNode channels,
            String appliedType, Instant reportedAt) {}

    public record EntityDto(UUID id, String entityType, String typeLabel, String role,
            String label, boolean control, UUID deviceId, JsonNode capabilities, JsonNode guards,
            String syncStatus, ObservedDto observed, String edgeSourceId) {}

    /** One edge-local commissioning item. {@code adoptedEntityId} != null when a
     *  v2 entity was already adopted from this source (U2 "Vom Gerät gemeldet"). */
    public record LocalSetupDto(String id, String kind, String role, String brand, String label,
            Instant reportedAt, String adoptedEntityId) {}

    public record RegistrySummaryDto(String revision, Instant composedAt, UUID deviceId,
            String reportedRevision, Instant reportedAt) {}

    /** The whole surface. staleOnDevice = edge-applied entities the registry
     *  no longer contains (cleared on the next converged push). */
    public record SiteEntitiesDto(RegistrySummaryDto registry, List<EntityDto> entities,
            List<LocalSetupDto> localSetup, List<String> staleOnDevice) {}

    public record EntityHistoryDto(String range, Instant from, Instant to, int bucketMinutes,
            Map<String, List<EntityHistoryRepository.Bucket>> channels) {}

    private final SiteRepository sites;
    private final EntityRegistryRepository registry;
    private final EntityObservedRepository observed;
    private final EntityHistoryRepository history;
    private final EntityTypeCatalog catalog;
    private final ObjectMapper mapper;

    public EntityController(SiteRepository sites, EntityRegistryRepository registry,
            EntityObservedRepository observed, EntityHistoryRepository history,
            EntityTypeCatalog catalog, ObjectMapper mapper) {
        this.sites = sites;
        this.registry = registry;
        this.observed = observed;
        this.history = history;
        this.catalog = catalog;
        this.mapper = mapper;
    }

    @GetMapping
    public SiteEntitiesDto list(@PathVariable UUID siteId) {
        requireSite(siteId);
        List<EntityRow> rows = registry.entitiesForSite(siteId);
        RegistryState state = registry.registryState(siteId);
        List<ObservedRow> observedRows = observed.forSite(siteId);

        // Which edge source each already-adopted entity came from (U2 matcher).
        Map<String, String> adoptedBySource = new LinkedHashMap<>();
        for (EntityRow row : rows) {
            if (row.edgeSourceId() != null) {
                adoptedBySource.put(row.edgeSourceId(), row.id().toString());
            }
        }

        Map<String, ObservedRow> byEntity = new LinkedHashMap<>();
        List<ObservedRow> localRows = new ArrayList<>();
        String reportedRevision = null;
        Instant reportedAt = null;
        for (ObservedRow row : observedRows) {
            if ("local".equals(row.source())) {
                localRows.add(row);
            } else {
                byEntity.put(row.entityId(), row);
            }
            if (row.appliedRevision() != null) {
                reportedRevision = row.appliedRevision();
            }
            reportedAt = row.reportedAt();
        }

        List<LocalSetupDto> localSetup = new ArrayList<>();
        for (ObservedRow row : localRows) {
            String sourceId = row.entityId().replaceFirst("^local:", "");
            localSetup.add(new LocalSetupDto(sourceId, row.entityType(), row.edgeRole(),
                    row.edgeBrand(), row.label(), row.reportedAt(),
                    adoptedBySource.get(sourceId)));
        }

        List<EntityDto> entities = new ArrayList<>();
        for (EntityRow row : rows) {
            ObservedRow obs = byEntity.remove(row.id().toString());
            entities.add(new EntityDto(row.id(), row.entityType(),
                    catalog.labelFor(row.entityType()), row.role(), row.label(), row.control(),
                    row.deviceId(), parse(row.capabilitiesJson()), parse(row.guardConfigJson()),
                    syncStatus(state, obs, !observedRows.isEmpty(), reportedRevision),
                    obs == null ? null
                            : new ObservedDto(obs.health(), obs.lastTelemetryAt(),
                                    parse(obs.channelsJson()), obs.entityType(),
                                    obs.reportedAt()),
                    row.edgeSourceId()));
        }
        // Whatever the edge still reports that the registry no longer knows.
        List<String> staleOnDevice = new ArrayList<>(byEntity.keySet());

        RegistrySummaryDto summary = state == null ? null
                : new RegistrySummaryDto(state.revision(), state.composedAt(), state.deviceId(),
                        reportedRevision, reportedAt);
        return new SiteEntitiesDto(summary, entities, localSetup, staleOnDevice);
    }

    /**
     * Per-entity channel history: day = live 15-min buckets from raw v2
     * telemetry, week = hourly rollup, month/year = Berlin-daily rollup.
     */
    @GetMapping("/{entityId}/history")
    public EntityHistoryDto history(@PathVariable UUID siteId, @PathVariable UUID entityId,
            @RequestParam(defaultValue = "day") String range,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
            LocalDate at) {
        requireSite(siteId);
        if (registry.entityForSite(siteId, entityId) == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
        }
        HistoryRange parsed = HistoryRange.parse(range);
        if (parsed == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "range must be one of day|week|month|year");
        }
        LocalDate anchor = at != null ? at : LocalDate.now(HistoryRange.ZONE);
        HistoryRange.Window window = parsed.window(anchor);
        Map<String, List<EntityHistoryRepository.Bucket>> channels =
                history.history(siteId, entityId.toString(), parsed, window.from(), window.to());
        return new EntityHistoryDto(parsed.name().toLowerCase(), window.from(), window.to(),
                parsed.bucketMinutes(), channels);
    }

    /**
     * The per-entity Soll/Ist verdict. Deliberately layered: no composed Soll
     * yet beats everything (there is nothing the edge could echo), then the
     * device's report decides.
     */
    private static String syncStatus(RegistryState state, ObservedRow obs, boolean deviceReported,
            String reportedRevision) {
        if (state == null) {
            return SYNC_NEVER_PUSHED;
        }
        if (obs != null) {
            return state.revision().equals(obs.appliedRevision()) ? SYNC_IN_SYNC : SYNC_PENDING;
        }
        if (deviceReported) {
            // The edge reports entities, but not this one: the current Soll
            // has not reached it yet (or the entity was just created).
            return state.revision().equals(reportedRevision) ? SYNC_MISSING_ON_DEVICE
                    : SYNC_PENDING;
        }
        return SYNC_UNREPORTED;
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
