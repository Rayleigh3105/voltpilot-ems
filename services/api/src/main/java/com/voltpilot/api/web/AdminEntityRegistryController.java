package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.SiteRepository;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Platform-admin surface of the v2 entity registry (E1a): the PILOT MAPPING
 * utility that creates the three pilot entities of one v1 site from its
 * existing asset/measurement_point master data, plus list + re-push. Nothing
 * converts automatically - the E13a cutover calls the bootstrap per site.
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

    private final SiteRepository sites;
    private final EntityRegistryRepository repo;
    private final EntityRegistryService service;
    private final ObjectMapper mapper;

    public AdminEntityRegistryController(SiteRepository sites, EntityRegistryRepository repo,
            EntityRegistryService service, ObjectMapper mapper) {
        this.sites = sites;
        this.repo = repo;
        this.service = service;
        this.mapper = mapper;
    }

    @GetMapping
    public List<EntityAdminDto> list(@PathVariable UUID siteId) {
        requireSite(siteId);
        return repo.entitiesForSite(siteId).stream().map(this::toDto).toList();
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
