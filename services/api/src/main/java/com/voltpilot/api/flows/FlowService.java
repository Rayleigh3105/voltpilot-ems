package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityTypeCatalog;
import com.voltpilot.api.flows.FlowGraphValidator.EntityCapabilities;
import com.voltpilot.api.flows.FlowGraphValidator.ForeignClaim;
import com.voltpilot.api.profile.UsageProfileDeriver;
import com.voltpilot.api.repo.FlowGatedNodeRepository;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.repo.SimulationDefaultsRepository;
import com.voltpilot.api.repo.FlowLayoutRepository;
import com.voltpilot.api.repo.FlowStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.simulation.SimulationClient;
import com.voltpilot.api.simulation.SimulationJobRegistry;
import com.voltpilot.api.simulation.SimulationPayload;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SimulationRequestDto;
import com.voltpilot.api.web.dto.SiteDto;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The ONE flow-editor lifecycle engine (E3a build → validate → simulate →
 * activate + E3b customer release): CRUD + versioning + the authoritative state
 * machine (draft → simulated → active → retired, contract flow-graph.md §5),
 * server-side validation (V-1..V-8), the dry-run mapping onto the existing
 * Ersparnis-Simulation infrastructure, and the AE7 governance-gated activation.
 *
 * <p>Both the platform-admin surface ({@link com.voltpilot.api.web.AdminFlowController})
 * and the customer surface ({@link com.voltpilot.api.web.SiteFlowController})
 * delegate here, so there is exactly ONE lifecycle truth and no forked gate.
 * Everything reads/writes THROUGH the RLS-scoped app datasource: the site (and
 * its flows) is visible only to its owning tenant - a customer via the JWT
 * {@code tenant_id} claim, a Portal-Admin via the {@code X-Tenant-Id} switcher;
 * a foreign or unset tenant sees nothing => 404. The server stamps flow
 * identity (flow_id / flow_version / site_id / tenant_id) into every stored
 * document - a client can never pick identities.
 *
 * <p>Server-side governance is the law regardless of caller: a flow carrying a
 * GATED strategy node (Arbitrage/Peak/atyp. NN) activates only after a
 * Portal-Admin enables that node type for the site ({@code gated_node_not_enabled});
 * this gate does NOT relax for customers. Only the governance WRITE
 * ({@link #setGovernance}) stays admin-only - a customer never enables a gated
 * node type directly; since Portal v3 M3 the per-site enablement is written by
 * {@code SiteProfileService} as an authorized server-side effect of an explicit
 * Modus-Profil toggle on the caller's OWN site. The auto-start seed is reachable
 * from both surfaces (it only creates a DRAFT). The
 * customer controller never exposes them.
 */
@Service
public class FlowService {

    /**
     * Marks a dry-run that is SCOPED to the flow itself (audit E-8): no job
     * exists in the simulation service, so the poll must answer it locally.
     * The prefix cannot collide with a service-issued id (those are UUIDs).
     */
    private static final String SCOPED_DRY_RUN_PREFIX = "flow-scoped-";

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

    /** One gated node type and whether it is enabled for the site (AE7 governance). */
    public record GatedNodeDto(String type, String label, boolean gated, boolean enabled) {}

    public record GovernanceResponse(List<GatedNodeDto> gatedNodes) {}

    /** One node's canvas position - a PORTAL concern, never part of the document. */
    public record LayoutPosition(double x, double y) {}

    public record LayoutRequest(Map<String, LayoutPosition> positions) {}

    public record LayoutResponse(Map<String, LayoutPosition> positions) {}

    /** One deployed artifact as the device acknowledges it. */
    public record FlowAckDto(UUID flowId, int flowVersion, String contentHash, String state,
            String detail, String reportedAt) {}

    /** One node's live state as the device reports it (never derived cloud-side). */
    public record FlowNodeStatusDto(UUID flowId, String nodeId, String state, String text,
            String since) {}

    public record FlowLiveStatusResponse(List<FlowAckDto> acks, List<FlowNodeStatusDto> nodes) {}

    public record GovernanceRequest(List<Enablement> enablements) {

        public record Enablement(String nodeType, boolean enabled) {}
    }

    private final SiteRepository sites;
    private final FlowLayoutRepository layouts;
    private final FlowStatusRepository flowStatus;
    private final FlowRepository flows;
    private final FlowCatalog catalog;
    private final FlowGraphValidator validator;
    private final EntityRegistryRepository entities;
    private final EntityTypeCatalog entityTypes;
    private final FlowActivationService activation;
    private final FlowGatedNodeRepository gatedNodes;
    private final FlowClaimRepository claims;
    private final FlowTemplateService templates;
    private final SimulationDefaultsRepository simulationDefaults;
    private final SimulationClient simulationClient;
    private final SimulationJobRegistry simulationJobs;
    private final ObjectMapper mapper;

    public FlowService(SiteRepository sites, FlowLayoutRepository layouts,
            FlowStatusRepository flowStatus, FlowRepository flows, FlowCatalog catalog,
            FlowGraphValidator validator, EntityRegistryRepository entities,
            EntityTypeCatalog entityTypes,
            FlowActivationService activation, FlowGatedNodeRepository gatedNodes,
            FlowTemplateService templates, SimulationDefaultsRepository simulationDefaults,
            SimulationClient simulationClient, SimulationJobRegistry simulationJobs,
            FlowClaimRepository claims, ObjectMapper mapper) {
        this.sites = sites;
        this.layouts = layouts;
        this.flowStatus = flowStatus;
        this.flows = flows;
        this.catalog = catalog;
        this.validator = validator;
        this.entities = entities;
        this.entityTypes = entityTypes;
        this.activation = activation;
        this.gatedNodes = gatedNodes;
        this.templates = templates;
        this.simulationDefaults = simulationDefaults;
        this.simulationClient = simulationClient;
        this.simulationJobs = simulationJobs;
        this.claims = claims;
        this.mapper = mapper;
    }

    /** The node catalog the editor palettes/validates against (one truth). */
    public JsonNode catalogRaw() {
        return catalog.raw();
    }

    // -- governance (read for everyone; write admin-only) -------------------

    /**
     * The gated strategy node types (from the catalog) and their per-site
     * enablement. Read by BOTH surfaces: the admin console to toggle, the
     * customer editor to render a gated node "locked" (with the Beratung-CTA)
     * when it is not enabled for the site.
     */
    public GovernanceResponse governance(UUID siteId) {
        requireSite(siteId);
        return governanceResponse(siteId);
    }

    /** Enable/disable gated node types for the site (Portal-Admin ONLY). */
    @Transactional
    public GovernanceResponse setGovernance(UUID siteId, GovernanceRequest request) {
        requireSite(siteId);
        Set<String> gated = catalog.gatedTypes();
        List<GovernanceRequest.Enablement> enablements =
                request == null || request.enablements() == null ? List.of() : request.enablements();
        for (GovernanceRequest.Enablement e : enablements) {
            if (e == null || e.nodeType() == null || !gated.contains(e.nodeType())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Unbekannter oder nicht freischaltbarer Baustein: "
                                + (e == null ? "null" : e.nodeType()) + ".");
            }
            gatedNodes.upsert(TenantContext.get(), siteId, e.nodeType(), e.enabled());
        }
        return governanceResponse(siteId);
    }

    private GovernanceResponse governanceResponse(UUID siteId) {
        Set<String> enabled = gatedNodes.enabledNodeTypes(siteId);
        List<GatedNodeDto> nodes = new ArrayList<>();
        for (String type : catalog.gatedTypes()) {
            JsonNode entry = catalog.type(type);
            String label = entry == null ? type : entry.path("label").asText(type);
            nodes.add(new GatedNodeDto(type, label, true, enabled.contains(type)));
        }
        return new GovernanceResponse(nodes);
    }

    // -- CRUD + lifecycle ---------------------------------------------------

    public List<FlowSummaryDto> list(UUID siteId) {
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

    /** One active strategy touching an entity (U2 "Ihre Geräte" strategy chip). */
    public record EntityStrategyDto(UUID flowId, String flowName) {}

    /**
     * Which ACTIVE flows touch each of the site's entities (U2, report §3.2):
     * the entity→flow map the "Ihre Geräte" cards render as read-only strategy
     * chips (a link into Steuerung), making the Entities⇄Flows model visible.
     * Derived from each active flow document's D-13 claims ({@link FlowClaims}),
     * so it agrees with what actually controls the entity. Tenant-scoped (RLS;
     * foreign site 404). Keyed by entity id (string).
     */
    public Map<String, List<EntityStrategyDto>> entityStrategies(UUID siteId) {
        requireSite(siteId);
        Map<String, List<EntityStrategyDto>> byEntity = new LinkedHashMap<>();
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            if (!"active".equals(row.lifecycle())) {
                continue;
            }
            JsonNode doc = parse(row.documentJson());
            if (doc == null) {
                continue;
            }
            Set<String> entityIds = new LinkedHashSet<>();
            for (FlowClaims.DerivedClaim claim : FlowClaims.derive(doc, catalog)) {
                if (claim.entityId() != null && !claim.entityId().isBlank()) {
                    entityIds.add(claim.entityId());
                }
            }
            for (String entityId : entityIds) {
                byEntity.computeIfAbsent(entityId, k -> new ArrayList<>())
                        .add(new EntityStrategyDto(row.flowId(), row.name()));
            }
        }
        return byEntity;
    }

    /**
     * AE7 auto-start (spec §3): seed the site's derived-profile starter flow
     * DRAFT if it has none. Reachable from BOTH surfaces since Portal v3 M3
     * (a draft cannot control anything; activation stays gated as before).
     * Idempotent - a site with any flow is left untouched.
     */
    @Transactional
    public FlowTemplateService.AutoStartOutcome autoStart(UUID siteId) {
        requireSite(siteId);
        return templates.autoStart(siteId, TenantContext.get());
    }

    @Transactional
    public FlowVersionDto create(UUID siteId, SaveFlowRequest request) {
        requireSite(siteId);
        String name = requireName(request);
        UUID flowId = UUID.randomUUID();
        ObjectNode document = stampedDocument(request.document(), flowId, 1, siteId, name, "draft");
        flows.insertDraft(TenantContext.get(), siteId, flowId, 1, name,
                document.path("runtime").asText("edge"), document.toString());
        return dto(flows.find(flowId, 1));
    }

    public FlowVersionDto get(UUID siteId, UUID flowId, int version) {
        return dto(requireVersion(siteId, flowId, version));
    }

    /**
     * Save. A DRAFT is updated in place; a simulated/active version yields a
     * NEW draft version (contract §5: any edit produces a new draft) - the
     * response carries the resulting version, the caller must not assume the
     * version it PUT to. Retired versions are read-only.
     */
    @Transactional
    public FlowVersionDto save(UUID siteId, UUID flowId, int version, SaveFlowRequest request) {
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
    @Transactional
    public void delete(UUID siteId, UUID flowId) {
        List<FlowVersionRow> versions = flows.versionsForFlow(flowId);
        if (versions.isEmpty() || !versions.get(0).siteId().equals(siteId)) {
            throw notFound();
        }
        if (versions.stream().anyMatch(v -> "active".equals(v.lifecycle()))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Flow hat eine aktive Version - bitte zuerst stilllegen.");
        }
        flows.deleteFlow(flowId);
        claims.clearForFlow(flowId);
    }

    /**
     * Still every OTHER active flow whose DELEGATED claim (a Betriebsmodell
     * strategy) collides with a claim of the document being activated, and
     * return their names for the response. A rule of the customer wins over a
     * Betriebsmodell (§3.7 A5b); two Betriebsmodelle never reach here (the
     * validator still refuses that with V-5).
     */
    private List<String> yieldDelegatedFlows(UUID siteId, UUID flowId, JsonNode document) {
        Set<String> mine = new HashSet<>();
        for (FlowClaims.DerivedClaim claim : FlowClaims.derive(document, catalog)) {
            if (!claim.delegated()) {
                mine.add(claim.entityId());
            }
        }
        if (mine.isEmpty()) {
            return List.of();
        }
        List<String> yielded = new ArrayList<>();
        for (FlowVersionRow row : flows.activeVersionsForSiteExcept(siteId,
                document.path("runtime").asText("edge"), flowId)) {
            JsonNode doc = parse(row.documentJson());
            if (doc == null) {
                continue;
            }
            boolean collides = FlowClaims.derive(doc, catalog).stream()
                    .anyMatch(c -> c.delegated() && mine.contains(c.entityId()));
            if (collides) {
                activation.deactivate(siteId, row.flowId(), row);
                yielded.add(row.name());
            }
        }
        return yielded;
    }

    public ValidationResponse validate(UUID siteId, UUID flowId, int version) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        List<FlowValidationFinding> findings = validateDocument(siteId, flowId,
                parse(row.documentJson()));
        return new ValidationResponse(FlowGraphValidator.valid(findings), findings);
    }

    /**
     * Start the dry-run: compile the flow to its deterministic simulation
     * mapping and submit an Ersparnis-Simulation job over the site's real
     * master data. Returns {simulationId, flowScenario}; throws 422 with a
     * German reason for an invalid flow or one without a simulierbar strategy.
     */
    public Map<String, Object> simulate(UUID siteId, UUID flowId, int version) {
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
        // E-8: the dry-run is SCOPED to what the flow actually touches. A flow
        // without a battery strategy cannot change the dispatch economics, so
        // no year-long simulation is submitted at all - it neither needs a full
        // previous calendar year of day-ahead prices nor the weather archive,
        // and the customer is not made to wait ~2,5 minutes for a number that
        // would be the untouched baseline by construction.
        if (!mapping.yearSimulation()) {
            String scopedId = SCOPED_DRY_RUN_PREFIX + UUID.randomUUID();
            simulationJobs.registerSiteJob(scopedId, siteId);
            Map<String, Object> scoped = new LinkedHashMap<>();
            scoped.put("simulationId", scopedId);
            scoped.put("flowScenario", null);
            scoped.put("scope", "automation");
            return scoped;
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
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("simulationId", simulationId);
        body.put("flowScenario", mapping.scenario());
        return body;
    }

    /**
     * Poll the dry-run. When the job completes, the version's lifecycle flips
     * draft → simulated and the summary is recorded (the authoritative state
     * machine lives HERE, contract §5).
     */
    public Map<String, Object> simulationStatus(UUID siteId, UUID flowId, int version,
            String simulationId) {
        FlowVersionRow row = requireVersion(siteId, flowId, version);
        if (!simulationJobs.isSiteJob(simulationId, siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Simulation nicht gefunden.");
        }
        // E-8: a scoped dry-run has no job in the simulation service - it is
        // done the moment it is asked for (the flow was validated against the
        // plant model before the id was ever handed out).
        if (simulationId.startsWith(SCOPED_DRY_RUN_PREFIX)) {
            flows.markSimulated(flowId, version, scopedSummary(simulationId));
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("status", "done");
            done.put("progress", 1.0);
            done.put("flowScenario", null);
            done.put("scope", "automation");
            return done;
        }
        Map<String, Object> status = simulationClient.status(simulationId);
        if (status == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Simulation nicht gefunden.");
        }
        FlowSimulationMapper.Mapping mapping = FlowSimulationMapper.map(parse(row.documentJson()));
        Map<String, Object> enriched = new LinkedHashMap<>(status);
        enriched.put("flowScenario", mapping.scenario());
        if ("done".equals(status.get("status"))) {
            flows.markSimulated(flowId, version,
                    simulationSummary(simulationId, mapping, status));
        }
        return enriched;
    }

    /**
     * Activate: strict validation, the D1 safety gate (a draft must be
     * simulated first; re-activating a formerly active version is the rollback
     * path), the AE7 node-governance gate ({@code gated_node_not_enabled}, never
     * relaxed for customers), the E5 peak-shaving precondition, then
     * {@link FlowActivationService}. Returns the response verbatim (varied
     * status codes), never weakens a gate by caller kind.
     */
    @Transactional
    public ResponseEntity<Map<String, Object>> activate(UUID siteId, UUID flowId, int version) {
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
        // AE7 node governance (spec §3): a flow carrying a GATED strategy node
        // (Arbitrage/Peak/atyp. NN) stays inactive until a Portal-Admin enables
        // that node type for THIS site - refused here BEFORE the compiler is ever
        // contacted, so a gated draft never reaches flowc. Identical for a
        // customer: only a Portal-Admin enablement opens the gate.
        List<String> notEnabled = FlowGovernance.notEnabledNodeTypes(document, catalog,
                gatedNodes.enabledNodeTypes(siteId));
        if (!notEnabled.isEmpty()) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("activated", false);
            body.put("reason", "gated_node_not_enabled");
            body.put("message", "Dieser Flow enthält Bausteine, die VoltPilot erst für diese "
                    + "Anlage freischalten muss: " + String.join(", ", notEnabled) + ".");
            body.put("published", false);
            body.put("lifecycle", row.lifecycle());
            body.put("gatedNodesNotEnabled", notEnabled);
            return ResponseEntity.ok(body);
        }
        // E5 peak-shaving precondition (after governance, before compile).
        ResponseEntity<Map<String, Object>> peakGate = peakShavingGate(siteId, document, row);
        if (peakGate != null) {
            return peakGate;
        }
        // Steuerung Stufe 3 (§3.7 A5b): still the Betriebsmodell flows whose
        // DELEGATED claim this rule takes over. The validator turned that
        // collision into a warning above, so this is the only place the actual
        // handover happens - and it happens BEFORE the activation, so a claim
        // is never held twice.
        List<String> yielded = yieldDelegatedFlows(siteId, flowId, document);
        FlowActivationService.ActivationOutcome outcome = activation.activate(siteId, row, document);
        Map<String, Object> body = new LinkedHashMap<>();
        if (!yielded.isEmpty()) {
            body.put("yieldedFlows", yielded);
        }
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

    /**
     * Deactivate a flow: retire its ACTIVE version and re-publish the site's
     * (now smaller) deployment set so the edge removes the retired flow. A flow
     * with no active version is a 409. This is the "turn my flow off again"
     * lever both surfaces expose.
     */
    @Transactional
    public Map<String, Object> deactivate(UUID siteId, UUID flowId) {
        List<FlowVersionRow> versions = flows.versionsForFlow(flowId);
        if (versions.isEmpty() || !versions.get(0).siteId().equals(siteId)) {
            throw notFound();
        }
        requireSite(siteId);
        FlowVersionRow active = flows.findActive(flowId);
        if (active == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Dieser Flow ist nicht aktiv - es gibt nichts stillzulegen.");
        }
        FlowActivationService.DeactivationOutcome outcome = activation.deactivate(siteId, flowId,
                active);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("deactivated", true);
        body.put("published", outcome.published());
        body.put("message", "Flow stillgelegt (Version " + active.flowVersion() + ").");
        body.put("lifecycle", "retired");
        return body;
    }

    // -- helpers -----------------------------------------------------------

    /**
     * The E5 peak-shaving activation precondition (returns a 422 refusal, or
     * {@code null} to proceed): a {@code vp.strategy.peakshaving} flow needs the
     * site's {@code leistungspreis_eur_kw} configured (admin optimizer-config),
     * else the co-optimizer epigraph is inactive - refuse rather than deploy a
     * no-op strategy the co-optimizer would ignore.
     */
    private ResponseEntity<Map<String, Object>> peakShavingGate(UUID siteId, JsonNode document,
            FlowVersionRow row) {
        if (containsNodeType(document, UsageProfileDeriver.NODE_PEAKSHAVING)) {
            SiteDto site = sites.findById(siteId);
            if (site == null || site.leistungspreisEurKw() == null) {
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("activated", false);
                body.put("reason", "peakshaving_not_configured");
                body.put("message", "Für die Lastspitzenkappung fehlt der Leistungspreis dieser "
                        + "Anlage. VoltPilot muss ihn zunächst im Optimizer hinterlegen "
                        + "(Leistungspreis in €/kW) - erst dann kann der Baustein den Speicher "
                        + "wirksam steuern.");
                body.put("published", false);
                body.put("lifecycle", row.lifecycle());
                return ResponseEntity.unprocessableEntity().body(body);
            }
        }
        return null;
    }

    private static boolean containsNodeType(JsonNode doc, String type) {
        for (JsonNode node : doc.path("nodes")) {
            if (type.equals(node.path("type").asText())) {
                return true;
            }
        }
        return false;
    }

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
            // MB-M1: composed types (config derived from v1 master data) refuse
            // Modbus-read mappings - their channels feed the guard chain.
            EntityTypeCatalog.EntityType type = entityTypes.find(row.entityType());
            boolean composed = type != null && type.composed();
            view.put(row.id().toString(), new EntityCapabilities(measure, actuate, composed));
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
                claims.add(new ForeignClaim(claim.entityId(), row.flowId(), row.name(),
                        claim.delegated()));
            }
        }
        return claims;
    }

    /** Server-stamped document identity - clients never pick ids/versions. */
    private ObjectNode stampedDocument(JsonNode document, UUID flowId, int version, UUID siteId,
            String name, String lifecycle) {
        // D-19: `origin` marks a GENERATED flow and is stamped exclusively by
        // the consumer-policy activation path (which writes the repository
        // directly). Refusing it here is what makes the origin marker - and
        // with it the generated-only node types + their override - unforgeable
        // through the customer/admin save surface.
        if (document != null && document.has("origin")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Dieses Dokument ist einer Verbraucherregel vorbehalten - bitte die Regel "
                            + "im Verbraucher-Regelbaukasten bearbeiten.");
        }
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

    // --- Portal v3 M5: canvas layout + the device-reported live flow state ---

    /** The canvas layout of one flow (Portal v3 M5 Part A). Never in the document. */
    public LayoutResponse layout(UUID siteId, UUID flowId) {
        requireFlow(siteId, flowId);
        Map<String, LayoutPosition> positions = new LinkedHashMap<>();
        layouts.find(flowId).forEach((id, p) -> positions.put(id, new LayoutPosition(p.x(), p.y())));
        return new LayoutResponse(positions);
    }

    /**
     * Replace the canvas layout. Unknown node ids are DROPPED server-side (a
     * stale layout must never resurrect a deleted node), and nothing here ever
     * touches the flow document - so a drag can not change `content_hash`.
     */
    @Transactional
    public LayoutResponse saveLayout(UUID siteId, UUID flowId, LayoutRequest request) {
        requireFlow(siteId, flowId);
        Set<String> known = new LinkedHashSet<>();
        for (FlowVersionRow row : flows.versionsForFlow(flowId)) {
            JsonNode doc = parseDocument(row.documentJson());
            for (JsonNode node : doc.path("nodes")) {
                known.add(node.path("id").asText(""));
            }
        }
        Map<String, FlowLayoutRepository.Position> clean = new LinkedHashMap<>();
        Map<String, LayoutPosition> echo = new LinkedHashMap<>();
        if (request != null && request.positions() != null) {
            request.positions().forEach((id, pos) -> {
                if (pos == null || !known.contains(id)
                        || !Double.isFinite(pos.x()) || !Double.isFinite(pos.y())) {
                    return;
                }
                double x = Math.max(0, pos.x());
                double y = Math.max(0, pos.y());
                clean.put(id, new FlowLayoutRepository.Position(x, y));
                echo.put(id, new LayoutPosition(x, y));
            });
        }
        layouts.save(flowId, siteId, clean);
        return new LayoutResponse(echo);
    }

    /**
     * What the DEVICE says about this site's flows: the deployment acks (which
     * version really runs) plus - only when the edge sends the feature-flagged
     * block - the per-node live states. An empty node list means "the device
     * does not report node states", and the editor then shows none.
     */
    public FlowLiveStatusResponse liveStatus(UUID siteId) {
        requireSite(siteId);
        List<FlowAckDto> acks = flowStatus.acksForSite(siteId).stream()
                .map(a -> new FlowAckDto(a.flowId(), a.flowVersion(), a.contentHash(), a.state(),
                        a.detail(), a.reportedAt() == null ? null : a.reportedAt().toString()))
                .toList();
        List<FlowNodeStatusDto> nodes = flowStatus.nodeStatusesForSite(siteId).stream()
                .map(n -> new FlowNodeStatusDto(n.flowId(), n.nodeId(), n.state(), n.text(),
                        n.since() == null ? null : n.since().toString()))
                .toList();
        return new FlowLiveStatusResponse(acks, nodes);
    }

    private void requireFlow(UUID siteId, UUID flowId) {
        requireSite(siteId);
        List<FlowVersionRow> versions = flows.versionsForFlow(flowId);
        if (versions.isEmpty() || !versions.get(0).siteId().equals(siteId)) {
            throw notFound();
        }
    }

    private JsonNode parseDocument(String raw) {
        try {
            return mapper.readTree(raw);
        } catch (Exception e) {
            return mapper.createObjectNode();
        }
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

    /** The recorded summary of a SCOPED (no-year-simulation) dry-run - E-8. */
    private String scopedSummary(String simulationId) {
        ObjectNode summary = mapper.createObjectNode();
        summary.put("simulationId", simulationId);
        summary.put("scope", "automation");
        summary.put("finishedAt", Instant.now().toString());
        return summary.toString();
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
