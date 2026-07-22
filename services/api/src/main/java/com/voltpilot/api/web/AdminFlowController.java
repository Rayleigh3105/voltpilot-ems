package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.flows.FlowService;
import com.voltpilot.api.flows.FlowService.FlowSummaryDto;
import com.voltpilot.api.flows.FlowService.FlowVersionDto;
import com.voltpilot.api.flows.FlowService.FlowLiveStatusResponse;
import com.voltpilot.api.flows.FlowService.GovernanceRequest;
import com.voltpilot.api.flows.FlowService.GovernanceResponse;
import com.voltpilot.api.flows.FlowService.LayoutRequest;
import com.voltpilot.api.flows.FlowService.LayoutResponse;
import com.voltpilot.api.flows.FlowService.SaveFlowRequest;
import com.voltpilot.api.flows.FlowService.ValidationResponse;
import com.voltpilot.api.flows.FlowTemplateService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The Portal-Admin flow-editor surface (E3a): CRUD + versioning + validation +
 * dry-run + governance-gated activation. This is a THIN wrapper - the whole
 * lifecycle lives in {@link FlowService}, shared verbatim with the customer
 * surface ({@link SiteFlowController}) so there is one lifecycle truth and no
 * forked gate. The only admin-exclusive endpoints are the governance WRITE
 * (enable gated node types for a site) and the AE7 auto-start seed.
 *
 * <p>Like {@link AdminEntityRegistryController}, everything reads/writes THROUGH
 * the RLS-scoped app datasource via the {@code X-Tenant-Id} switcher: no tenant
 * selected, or the wrong one, and site + flows are invisible => 404.
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFlowController {

    private final FlowService flows;

    public AdminFlowController(FlowService flows) {
        this.flows = flows;
    }

    /** The node catalog the editor palettes/validates against (one truth). */
    @GetMapping("/flow-catalog")
    public JsonNode flowCatalog() {
        return flows.catalogRaw();
    }

    /** The gated strategy node types + their per-site enablement (AE7 governance). */
    @GetMapping("/sites/{siteId}/flow-node-governance")
    public GovernanceResponse governance(@PathVariable UUID siteId) {
        return flows.governance(siteId);
    }

    /** Enable/disable gated node types for the site (Portal-Admin ONLY). */
    @PutMapping("/sites/{siteId}/flow-node-governance")
    public GovernanceResponse setGovernance(@PathVariable UUID siteId,
            @RequestBody GovernanceRequest request) {
        return flows.setGovernance(siteId, request);
    }

    @GetMapping("/sites/{siteId}/flows")
    public List<FlowSummaryDto> list(@PathVariable UUID siteId) {
        return flows.list(siteId);
    }

    /** AE7 auto-start: seed the site's derived-profile starter flow (admin only). */
    @PostMapping("/sites/{siteId}/flows/auto-start")
    public ResponseEntity<FlowTemplateService.AutoStartOutcome> autoStart(
            @PathVariable UUID siteId) {
        FlowTemplateService.AutoStartOutcome outcome = flows.autoStart(siteId);
        HttpStatus status = outcome.created() ? HttpStatus.CREATED : HttpStatus.OK;
        return ResponseEntity.status(status).body(outcome);
    }

    @PostMapping("/sites/{siteId}/flows")
    public ResponseEntity<FlowVersionDto> create(@PathVariable UUID siteId,
            @RequestBody SaveFlowRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(flows.create(siteId, request));
    }

    @GetMapping("/sites/{siteId}/flows/{flowId}/versions/{version}")
    public FlowVersionDto get(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @PathVariable int version) {
        return flows.get(siteId, flowId, version);
    }

    @PutMapping("/sites/{siteId}/flows/{flowId}/versions/{version}")
    public FlowVersionDto save(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @PathVariable int version, @RequestBody SaveFlowRequest request) {
        return flows.save(siteId, flowId, version, request);
    }

    /** The editor's canvas layout - the admin twin of the customer route. */
    @GetMapping("/sites/{siteId}/flows/{flowId}/layout")
    public LayoutResponse layout(@PathVariable UUID siteId, @PathVariable UUID flowId) {
        return flows.layout(siteId, flowId);
    }

    @PutMapping("/sites/{siteId}/flows/{flowId}/layout")
    public LayoutResponse saveLayout(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @RequestBody LayoutRequest request) {
        return flows.saveLayout(siteId, flowId, request);
    }

    /** What the device reports about this site's flows (acks + node states). */
    @GetMapping("/sites/{siteId}/flow-node-status")
    public FlowLiveStatusResponse flowNodeStatus(@PathVariable UUID siteId) {
        return flows.liveStatus(siteId);
    }

    @DeleteMapping("/sites/{siteId}/flows/{flowId}")
    public ResponseEntity<Void> delete(@PathVariable UUID siteId, @PathVariable UUID flowId) {
        flows.delete(siteId, flowId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/validate")
    public ValidationResponse validate(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @PathVariable int version) {
        return flows.validate(siteId, flowId, version);
    }

    @PostMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/simulate")
    public ResponseEntity<Map<String, Object>> simulate(@PathVariable UUID siteId,
            @PathVariable UUID flowId, @PathVariable int version) {
        return ResponseEntity.accepted().body(flows.simulate(siteId, flowId, version));
    }

    @GetMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/simulation/{simulationId}")
    public Map<String, Object> simulationStatus(@PathVariable UUID siteId,
            @PathVariable UUID flowId, @PathVariable int version,
            @PathVariable String simulationId) {
        return flows.simulationStatus(siteId, flowId, version, simulationId);
    }

    @PostMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/activate")
    public ResponseEntity<Map<String, Object>> activate(@PathVariable UUID siteId,
            @PathVariable UUID flowId, @PathVariable int version) {
        return flows.activate(siteId, flowId, version);
    }

    /** Stop a running flow: retire its active version + re-publish the set. */
    @PostMapping("/sites/{siteId}/flows/{flowId}/deactivate")
    public Map<String, Object> deactivate(@PathVariable UUID siteId, @PathVariable UUID flowId) {
        return flows.deactivate(siteId, flowId);
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
