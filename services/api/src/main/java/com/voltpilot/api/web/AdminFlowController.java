package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowClaims;
import com.voltpilot.api.flows.FlowGraphValidator;
import com.voltpilot.api.flows.FlowGraphValidator.EntityCapabilities;
import com.voltpilot.api.flows.FlowGraphValidator.ForeignClaim;
import com.voltpilot.api.flows.FlowSimulationMapper;
import com.voltpilot.api.flows.FlowValidationFinding;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.repo.SimulationDefaultsRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.simulation.SimulationClient;
import com.voltpilot.api.simulation.SimulationJobRegistry;
import com.voltpilot.api.simulation.SimulationPayload;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SimulationRequestDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
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
 * The flow-editor backend (E3a, platform-admin only): CRUD + versioning +
 * the authoritative lifecycle (draft → simulated → active → retired, contract
 * flow-graph.md §5), server-side validation (V-1..V-8), the dry-run mapping
 * onto the existing Ersparnis-Simulation job infrastructure, and activation
 * (honestly stubbed until the E2 compiler lands - see
 * {@link FlowActivationService}).
 *
 * <p>Like {@link AdminEntityRegistryController}, everything reads/writes
 * THROUGH the RLS-scoped app datasource via the {@code X-Tenant-Id} switcher:
 * no tenant selected, or the wrong one, and site + flows are invisible => 404.
 * The server stamps flow identity (flow_id / flow_version / site_id /
 * tenant_id) into every stored document - a client can never pick identities.
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminFlowController {

    /** One stored flow version, document verbatim. */
    public record FlowVersionDto(UUID flowId, int flowVersion, UUID siteId, String name,
            String runtime, String lifecycle, JsonNode document, JsonNode simulation,
            Instant createdAt, Instant updatedAt, Instant simulatedAt, Instant activatedAt) {}

    /** List entry: one flow with its version spine. */
    public record FlowSummaryDto(UUID flowId, String name, String runtime, int latestVersion,
            String latestLifecycle, Integer activeVersion, Instant updatedAt, JsonNode simulation,
            JsonNode latestDocument, List<Integer> versions) {}

    /** Save/create request; document optional on create (skeleton then). */
    public record SaveFlowRequest(String name, JsonNode document) {}

    /** Validation response: findings + the blocking verdict. */
    public record ValidationResponse(boolean valid, List<FlowValidationFinding> findings) {}

    private final SiteRepository sites;
    private final FlowRepository flows;
    private final FlowCatalog catalog;
    private final FlowGraphValidator validator;
    private final EntityRegistryRepository entities;
    private final FlowActivationService activation;
    private final SimulationDefaultsRepository simulationDefaults;
    private final SimulationClient simulationClient;
    private final SimulationJobRegistry simulationJobs;
    private final ObjectMapper mapper;

    public AdminFlowController(SiteRepository sites, FlowRepository flows, FlowCatalog catalog,
            FlowGraphValidator validator, EntityRegistryRepository entities,
            FlowActivationService activation, SimulationDefaultsRepository simulationDefaults,
            SimulationClient simulationClient, SimulationJobRegistry simulationJobs,
            ObjectMapper mapper) {
        this.sites = sites;
        this.flows = flows;
        this.catalog = catalog;
        this.validator = validator;
        this.entities = entities;
        this.activation = activation;
        this.simulationDefaults = simulationDefaults;
        this.simulationClient = simulationClient;
        this.simulationJobs = simulationJobs;
        this.mapper = mapper;
    }

    /** The node catalog the editor palettes/validates against (one truth). */
    @GetMapping("/flow-catalog")
    public JsonNode flowCatalog() {
        return catalog.raw();
    }

    @GetMapping("/sites/{siteId}/flows")
    public List<FlowSummaryDto> list(@PathVariable UUID siteId) {
        requireSite(siteId);
        Map<UUID, List<FlowVersionRow>> byFlow = new LinkedHashMap<>();
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            byFlow.computeIfAbsent(row.flowId(), k -> new ArrayList<>()).add(row);
        }
        List<FlowSummaryDto> summaries = new ArrayList<>();
        for (List<FlowVersionRow> versions : byFlow.values()) {
            versions.sort((a, b) -> Integer.compare(b.flowVersion(), a.flowVersion()));
            FlowVersionRow latest = versions.get(0);
            Integer activeVersion = versions.stream()
                    .filter(v -> "active".equals(v.lifecycle()))
                    .map(FlowVersionRow::flowVersion).findFirst().orElse(null);
            JsonNode simulation = versions.stream()
                    .map(FlowVersionRow::simulationJson)
                    .filter(s -> s != null)
                    .findFirst().map(this::parse).orElse(null);
            summaries.add(new FlowSummaryDto(latest.flowId(), latest.name(), latest.runtime(),
                    latest.flowVersion(), latest.lifecycle(), activeVersion, latest.updatedAt(),
                    simulation, parse(latest.documentJson()),
                    versions.stream().map(FlowVersionRow::flowVersion).toList()));
        }
        return summaries;
    }

    @PostMapping("/sites/{siteId}/flows")
    @Transactional
    public ResponseEntity<FlowVersionDto> create(@PathVariable UUID siteId,
            @RequestBody SaveFlowRequest request) {
        requireSite(siteId);
        String name = requireName(request);
        UUID flowId = UUID.randomUUID();
        ObjectNode document = stampedDocument(request.document(), flowId, 1, siteId, name,
                "draft");
        flows.insertDraft(TenantContext.get(), siteId, flowId, 1, name,
                document.path("runtime").asText("edge"), document.toString());
        return ResponseEntity.status(HttpStatus.CREATED).body(dto(flows.find(flowId, 1)));
    }

    @GetMapping("/sites/{siteId}/flows/{flowId}/versions/{version}")
    public FlowVersionDto get(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @PathVariable int version) {
        return dto(requireVersion(siteId, flowId, version));
    }

    /**
     * Save. A DRAFT is updated in place; a simulated/active version yields a
     * NEW draft version (contract §5: any edit produces a new draft) - the
     * response carries the resulting version, the caller must not assume the
     * version it PUT to. Retired versions are read-only.
     */
    @PutMapping("/sites/{siteId}/flows/{flowId}/versions/{version}")
    @Transactional
    public FlowVersionDto save(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @PathVariable int version, @RequestBody SaveFlowRequest request) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        String name = requireName(request);
        if ("retired".equals(row.lifecycle())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Version ist stillgelegt und kann nicht mehr bearbeitet werden.");
        }
        int targetVersion = "draft".equals(row.lifecycle()) ? version : flows.maxVersion(flowId) + 1;
        ObjectNode document = stampedDocument(request.document(), flowId, targetVersion, siteId,
                name, "draft");
        if (targetVersion == version && "draft".equals(row.lifecycle())) {
            flows.updateDraft(flowId, version, name, document.toString());
        } else {
            flows.insertDraft(TenantContext.get(), siteId, flowId, targetVersion, name,
                    document.path("runtime").asText("edge"), document.toString());
        }
        return dto(flows.find(flowId, targetVersion));
    }

    /** Delete a whole flow (draft cleanup). Refused while a version is active. */
    @DeleteMapping("/sites/{siteId}/flows/{flowId}")
    @Transactional
    public ResponseEntity<Void> delete(@PathVariable UUID siteId, @PathVariable UUID flowId) {
        List<FlowVersionRow> versions = flows.versionsForFlow(flowId);
        if (versions.isEmpty() || !versions.get(0).siteId().equals(siteId)) {
            throw notFound();
        }
        if (versions.stream().anyMatch(v -> "active".equals(v.lifecycle()))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Flow hat eine aktive Version - bitte zuerst stilllegen.");
        }
        flows.deleteFlow(flowId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/validate")
    public ValidationResponse validate(@PathVariable UUID siteId, @PathVariable UUID flowId,
            @PathVariable int version) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        List<FlowValidationFinding> findings = validateDocument(siteId, flowId,
                parse(row.documentJson()));
        return new ValidationResponse(FlowGraphValidator.valid(findings), findings);
    }

    /**
     * Start the dry-run: compile the flow to its deterministic simulation
     * mapping and submit an Ersparnis-Simulation job over the site's real
     * master data (historical prices + weather). 422 with a German reason
     * when the flow has no simulierbar strategy or fails validation.
     */
    @PostMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/simulate")
    public ResponseEntity<Map<String, Object>> simulate(@PathVariable UUID siteId,
            @PathVariable UUID flowId, @PathVariable int version) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        JsonNode document = parse(row.documentJson());
        List<FlowValidationFinding> findings = validateDocument(siteId, flowId, document);
        if (!FlowGraphValidator.valid(findings)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Bitte zuerst die Validierungsfehler beheben - simuliert wird nur ein "
                            + "gültiger Flow.");
        }
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(document);
        if (!mapping.supported()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, mapping.reason());
        }
        SimulationDefaultsRepository.SimulationDefaults site = simulationDefaults
                .findForSite(siteId);
        if (site == null) {
            throw notFound();
        }
        SimulationRequestDto dto = new SimulationRequestDto(null, null, null, null, null,
                new SimulationRequestDto.Battery(null, null, null, null,
                        mapping.speicherschonung()),
                null);
        Map<String, Object> payload = SimulationPayload.forSite(dto, site);
        String simulationId = simulationClient.submit(payload);
        simulationJobs.registerSiteJob(simulationId, siteId);
        return ResponseEntity.accepted().body(Map.of(
                "simulationId", simulationId,
                "flowScenario", mapping.scenario()));
    }

    /**
     * Poll the dry-run. When the job completes, the version's lifecycle flips
     * draft → simulated and the summary is recorded (the authoritative state
     * machine lives HERE, contract §5).
     */
    @GetMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/simulation/{simulationId}")
    public Map<String, Object> simulationStatus(@PathVariable UUID siteId,
            @PathVariable UUID flowId, @PathVariable int version,
            @PathVariable String simulationId) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        if (!simulationJobs.isSiteJob(simulationId, siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Simulation nicht gefunden.");
        }
        Map<String, Object> status = simulationClient.status(simulationId);
        if (status == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Simulation nicht gefunden.");
        }
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper
                .map(parse(row.documentJson()));
        Map<String, Object> enriched = new LinkedHashMap<>(status);
        enriched.put("flowScenario", mapping.scenario());
        if ("done".equals(status.get("status"))) {
            flows.markSimulated(flowId, version,
                    simulationSummary(simulationId, mapping, status));
        }
        return enriched;
    }

    /**
     * Activate: strict validation, then the D1 safety gate (a draft must be
     * simulated first; re-activating a formerly active version is the
     * rollback path), then {@link FlowActivationService} (which honestly
     * refuses until the E2 compiler + rig flag exist).
     */
    @PostMapping("/sites/{siteId}/flows/{flowId}/versions/{version}/activate")
    @Transactional
    public ResponseEntity<Map<String, Object>> activate(@PathVariable UUID siteId,
            @PathVariable UUID flowId, @PathVariable int version) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        if ("active".equals(row.lifecycle())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Diese Version ist bereits aktiv.");
        }
        JsonNode document = parse(row.documentJson());
        List<FlowValidationFinding> findings = validateDocument(siteId, flowId, document);
        if (!FlowGraphValidator.valid(findings)) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("message", "Der Flow hat Validierungsfehler und kann nicht aktiviert werden.");
            body.put("findings", findings);
            return ResponseEntity.unprocessableEntity().body(body);
        }
        if ("draft".equals(row.lifecycle())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Bitte zuerst simulieren - die Aktivierung setzt einen erfolgreichen "
                            + "Dry-Run dieser Version voraus.");
        }
        FlowActivationService.ActivationOutcome outcome = activation.activate(siteId, row,
                document);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("activated", outcome.activated());
        if (outcome.reason() != null) {
            body.put("reason", outcome.reason());
        }
        body.put("message", outcome.message());
        body.put("published", outcome.published());
        if (outcome.deviceId() != null) {
            body.put("deviceId", outcome.deviceId().toString());
        }
        body.put("lifecycle", outcome.activated() ? "active" : row.lifecycle());
        return ResponseEntity.ok(body);
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }

    // -- helpers -----------------------------------------------------------

    private List<FlowValidationFinding> validateDocument(UUID siteId, UUID flowId, JsonNode doc) {
        return validator.validate(doc, capabilityView(siteId),
                foreignClaims(siteId, doc.path("runtime").asText("edge"), flowId));
    }

    /** The site's registry capability view (V-6): entity id → measure/actuate sets. */
    private Map<String, EntityCapabilities> capabilityView(UUID siteId) {
        Map<String, EntityCapabilities> view = new HashMap<>();
        for (EntityRegistryRepository.EntityRow row : entities.entitiesForSite(siteId)) {
            Set<String> measure = new HashSet<>();
            Set<String> actuate = new HashSet<>();
            JsonNode caps = parse(row.capabilitiesJson());
            if (caps != null) {
                for (JsonNode m : caps.path("measure")) {
                    measure.add(m.path("channel").asText());
                }
                for (JsonNode a : caps.path("actuate")) {
                    actuate.add(a.path("command").asText());
                }
            }
            view.put(row.id().toString(), new EntityCapabilities(measure, actuate));
        }
        return view;
    }

    /** Claims of the site's OTHER active flows of the same runtime (V-5). */
    private List<ForeignClaim> foreignClaims(UUID siteId, String runtime, UUID exceptFlowId) {
        List<ForeignClaim> claims = new ArrayList<>();
        for (FlowVersionRow row : flows.activeVersionsForSiteExcept(siteId, runtime,
                exceptFlowId)) {
            JsonNode doc = parse(row.documentJson());
            if (doc == null) {
                continue;
            }
            for (FlowClaims.DerivedClaim claim : FlowClaims.derive(doc, catalog)) {
                claims.add(new ForeignClaim(claim.entityId(), row.flowId(), row.name()));
            }
        }
        return claims;
    }

    /** Server-stamped document identity - clients never pick ids/versions. */
    private ObjectNode stampedDocument(JsonNode document, UUID flowId, int version, UUID siteId,
            String name, String lifecycle) {
        ObjectNode doc = document != null && document.isObject()
                ? ((ObjectNode) document).deepCopy()
                : mapper.createObjectNode();
        doc.put("schema_version", "1.0");
        doc.put("flow_id", flowId.toString());
        doc.put("flow_version", version);
        doc.put("site_id", siteId.toString());
        doc.put("tenant_id", TenantContext.get().toString());
        doc.put("name", name);
        doc.put("lifecycle", lifecycle);
        if (!doc.has("runtime")) {
            doc.put("runtime", "edge");
        }
        if (!doc.has("nodes")) {
            doc.putArray("nodes");
        }
        if (!doc.has("edges")) {
            doc.putArray("edges");
        }
        if (!doc.has("triggers") || doc.path("triggers").isEmpty()) {
            ObjectNode trigger = doc.putArray("triggers").addObject();
            trigger.put("id", "t1");
            trigger.put("kind", "slot-boundary");
        }
        return doc;
    }

    private String requireName(SaveFlowRequest request) {
        if (request == null || request.name() == null || request.name().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Flow braucht einen Namen.");
        }
        if (request.name().length() > 120) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Der Name darf höchstens 120 Zeichen lang sein.");
        }
        return request.name().trim();
    }

    private FlowVersionRow requireVersion(UUID siteId, UUID flowId, int version) {
        requireSite(siteId);
        FlowVersionRow row = flows.find(flowId, version);
        if (row == null || !row.siteId().equals(siteId)) {
            throw notFound();
        }
        return row;
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw notFound();
        }
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Nicht gefunden.");
    }

    private String simulationSummary(String simulationId, FlowSimulationMapper.Mapping mapping,
            Map<String, Object> status) {
        ObjectNode summary = mapper.createObjectNode();
        summary.put("simulationId", simulationId);
        summary.put("scenario", mapping.scenario());
        summary.put("finishedAt", Instant.now().toString());
        JsonNode result = mapper.valueToTree(status.get("result"));
        if (result != null && result.has("headline")) {
            summary.set("headline", result.get("headline"));
        }
        if (result != null && result.path("annahmen").has("preisjahr")) {
            summary.put("preisjahr", result.path("annahmen").path("preisjahr").asText());
        }
        return summary.toString();
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

    private FlowVersionDto dto(FlowVersionRow row) {
        return new FlowVersionDto(row.flowId(), row.flowVersion(), row.siteId(), row.name(),
                row.runtime(), row.lifecycle(), parse(row.documentJson()),
                parse(row.simulationJson()), row.createdAt(), row.updatedAt(), row.simulatedAt(),
                row.activatedAt());
    }
}
