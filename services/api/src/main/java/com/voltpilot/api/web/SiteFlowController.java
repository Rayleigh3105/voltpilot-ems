package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.flows.FlowService;
import com.voltpilot.api.flows.FlowService.EntityStrategyDto;
import com.voltpilot.api.flows.FlowService.FlowSummaryDto;
import com.voltpilot.api.flows.FlowService.FlowVersionDto;
import com.voltpilot.api.flows.FlowService.GovernanceResponse;
import com.voltpilot.api.flows.FlowService.SaveFlowRequest;
import com.voltpilot.api.flows.FlowService.ValidationResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
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
 * The CUSTOMER flow-editor surface (E3b, "Kunden-Freigabe"): a Portal-User
 * builds, validates, simulates, activates, and deactivates the flows of THEIR
 * OWN sites. Tenant-scoped like every {@code /api/v1/sites/**} route
 * ({@link SiteController}, {@link UsageProfileController}): NO {@code @PreAuthorize}
 * - authentication + Postgres RLS are the fence. A customer's tenant comes from
 * the JWT {@code tenant_id} claim; a Portal-Admin reaches any site through the
 * {@code X-Tenant-Id} switcher (the same RLS-scoped path). A foreign or unset
 * tenant sees nothing => 404, never 403.
 *
 * <p>The whole lifecycle is {@link FlowService}, shared verbatim with
 * {@link AdminFlowController} - so no server-side gate is weakened for
 * customers. In particular activation still refuses a flow carrying a GATED
 * strategy node ({@code gated_node_not_enabled}) until a Portal-Admin enables
 * that node type for the site: this surface exposes governance READ-ONLY (to
 * render a locked node in the editor with the "VoltPilot richtet ein" hint) and
 * deliberately offers NO governance WRITE and NO auto-start (both stay
 * admin-only on {@link AdminFlowController}).
 *
 * <p>Lifecycle steps a customer gets: full draft → validate → simulate →
 * activate for FREE-node flows (Eigenverbrauch + device-control/data/logic/
 * action nodes), deactivate + delete their own flows, and version-history read.
 */
@RestController
@RequestMapping("/api/v1")
public class SiteFlowController {

    private final FlowService flows;

    public SiteFlowController(FlowService flows) {
        this.flows = flows;
    }

    /** The node catalog the customer editor palettes/validates against. */
    @GetMapping("/flow-catalog")
    public JsonNode flowCatalog() {
        return flows.catalogRaw();
    }

    /**
     * READ-ONLY governance: which gated node types are enabled for the site, so
     * the editor can render a not-enabled gated node "locked" with the Beratung
     * hint. A customer cannot change this (no PUT here) - VoltPilot richtet ein.
     */
    @GetMapping("/sites/{siteId}/flow-node-governance")
    public GovernanceResponse governance(@PathVariable UUID siteId) {
        return flows.governance(siteId);
    }

    @GetMapping("/sites/{siteId}/flows")
    public List<FlowSummaryDto> list(@PathVariable UUID siteId) {
        return flows.list(siteId);
    }

    /**
     * Which ACTIVE flows touch each entity of the site (U2 "Ihre Geräte"
     * strategy chips - read-only, a link into Steuerung). Keyed by entity id.
     */
    @GetMapping("/sites/{siteId}/entity-strategies")
    public Map<String, List<EntityStrategyDto>> entityStrategies(@PathVariable UUID siteId) {
        return flows.entityStrategies(siteId);
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
