package com.voltpilot.api.web;

import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.topology.TopologyService;
import com.voltpilot.api.topology.TopologyService.Assignment;
import com.voltpilot.api.topology.TopologyService.TopologyResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The CUSTOMER capability→role ASSIGNMENT surface for the Anlagen-Topologie-
 * Read-Model (AE1 / U2 "Rollen &amp; Zuordnung", report §3.2): a Portal-User
 * re-assigns a capability's role and picks the maßgebliche (primary)
 * measurement for THEIR OWN site. Tenant-scoped like every {@code /api/v1/sites/**}
 * route ({@link SiteController}, {@link SiteFlowController}): NO
 * {@code @PreAuthorize} - authentication + Postgres RLS are the fence; a
 * foreign site is 404, never 403. Admins reach any tenant through the
 * {@code X-Tenant-Id} switcher over this same RLS-scoped path.
 *
 * <p>Opening role assignment to customers is safe by construction: a role is
 * PRESENTATION-level and never widens control (guards/arbitration key on
 * capabilities, not roles), so the customer twin shares the admin rule verbatim
 * ({@link TopologyService#applyAssignments}) with no relaxed gate. The read is
 * {@link TopologyController}; the admin twin is {@link AdminTopologyController}.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/topology-roles")
public class SiteTopologyController {

    /** The PUT body: a batch of assignments applied in order. */
    public record AssignmentRequest(List<Assignment> assignments) {}

    private final SiteRepository sites;
    private final TopologyService topology;

    public SiteTopologyController(SiteRepository sites, TopologyService topology) {
        this.sites = sites;
        this.topology = topology;
    }

    @PutMapping
    @Transactional
    public TopologyResponse set(@PathVariable UUID siteId,
            @RequestBody AssignmentRequest request) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        return topology.applyAssignments(siteId,
                request == null ? null : request.assignments());
    }

    /** German reasons reach the portal as {"message": ...} (SiteFlowController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
