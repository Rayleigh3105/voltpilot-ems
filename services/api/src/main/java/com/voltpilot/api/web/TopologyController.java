package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.TopologyResponse;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The customer-facing Anlagen-Topologie-Read-Model (AE1): the site as an entity
 * graph aggregated into the role-grouped hub topology the adaptive
 * energy-flow diagram (AE2) renders. Tenant-scoped like every site route (RLS;
 * foreign site = 404). Admins read it through the {@code X-Tenant-Id} switcher.
 * A fresh site returns empty entities + empty topology. Read-only; role
 * ASSIGNMENT (overrides) is admin-only under
 * {@code /api/v1/admin/sites/{siteId}/topology-roles}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/topology")
public class TopologyController {

    private final SiteRepository sites;
    private final TopologyService topology;

    public TopologyController(SiteRepository sites, TopologyService topology) {
        this.sites = sites;
        this.topology = topology;
    }

    @GetMapping
    public TopologyResponse get(@PathVariable UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return topology.topology(siteId);
    }
}
