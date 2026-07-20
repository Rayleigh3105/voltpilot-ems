package com.voltpilot.api.web;

import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.Assignment;
import com.voltpilot.api.topology.TopologyService.TopologyResponse;
import java.util.List;
import java.util.UUID;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

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

    /** The PUT body: a batch of assignments applied in order. */
    public record AssignmentRequest(List<Assignment> assignments) {}

    private final TopologyService topology;

    public AdminTopologyController(TopologyService topology) {
        this.topology = topology;
    }

    /**
     * Upsert (or clear) capability role overrides and return the recomputed
     * read-model. Every entity must be a v2 entity of the switched tenant's site
     * (else 404); an unknown role is 400. A blank role clears the override. The
     * rule is shared verbatim with the customer twin ({@link SiteTopologyController})
     * via {@link TopologyService#applyAssignments}.
     */
    @PutMapping
    @Transactional
    public TopologyResponse set(@PathVariable UUID siteId,
            @RequestBody AssignmentRequest request) {
        return topology.applyAssignments(siteId,
                request == null ? null : request.assignments());
    }
}
