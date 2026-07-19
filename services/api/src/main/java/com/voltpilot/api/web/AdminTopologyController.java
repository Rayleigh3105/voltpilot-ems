package com.voltpilot.api.web;

import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.topology.TopologyRepository;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.TopologyResponse;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Admin-only capability→role ASSIGNMENT for the Anlagen-Topologie-Read-Model
 * (AE1). Platform-admins re-assign a capability's role and pick the maßgebliche
 * (primary) measurement per role, through the {@code X-Tenant-Id} switcher over
 * the RLS path (no BYPASSRLS - a foreign site is 404). Governance mirrors the
 * module surface ("VoltPilot richtet ein"); the customer read is
 * {@code GET /api/v1/sites/{siteId}/topology}. Absent an override the
 * {@code TopologyDeriver.defaultRole} mapping applies, so a defaults-only site
 * needs no call here.
 */
@RestController
@RequestMapping("/api/v1/admin/sites/{siteId}/topology-roles")
@PreAuthorize("hasRole('platform-admin')")
public class AdminTopologyController {

    private static final Set<String> ROLE_VOCAB = Set.of("pv", "storage", "grid", "consumer");

    /** One assignment: role = null/blank REVERTS the capability to its default. */
    public record Assignment(UUID entityId, String channel, String role, boolean primary) {}

    /** The PUT body: a batch of assignments applied in order. */
    public record AssignmentRequest(List<Assignment> assignments) {}

    private final EntityRegistryRepository registry;
    private final TopologyRepository repo;
    private final TopologyService topology;

    public AdminTopologyController(EntityRegistryRepository registry, TopologyRepository repo,
            TopologyService topology) {
        this.registry = registry;
        this.repo = repo;
        this.topology = topology;
    }

    /**
     * Upsert (or clear) capability role overrides and return the recomputed
     * read-model. Every entity must be a v2 entity of the switched tenant's site
     * (else 404); an unknown role is 400. A blank role clears the override.
     */
    @PutMapping
    @Transactional
    public TopologyResponse set(@PathVariable UUID siteId,
            @RequestBody AssignmentRequest request) {
        List<Assignment> assignments =
                request == null || request.assignments() == null ? List.of() : request.assignments();
        UUID tenantId = TenantContext.get();
        for (Assignment a : assignments) {
            if (a.entityId() == null || a.channel() == null || a.channel().isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Jede Zuordnung braucht entityId und channel.");
            }
            if (registry.entityForSite(siteId, a.entityId()) == null) {
                // RLS hides sites/entities outside the switched tenant.
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Entity not found");
            }
            String role = a.role() == null ? "" : a.role().trim();
            if (role.isEmpty()) {
                repo.deleteOverride(siteId, a.entityId(), a.channel());
                continue;
            }
            if (!ROLE_VOCAB.contains(role)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Unbekannte Rolle \"" + role + "\" (erlaubt: pv, storage, grid, consumer).");
            }
            repo.upsertOverride(tenantId, siteId, a.entityId(), a.channel(), role, a.primary());
        }
        return topology.topology(siteId);
    }
}
