package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.FlowClaimRepository;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.tenant.TenantContext;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Activation = the lifecycle capstone (flow-graph contract §5 + flow-artifact
 * §3): validation already passed when this runs; here the flow is COMPILED
 * (the E2 {@link FlowCompiler} seam), the previous active version retired,
 * the new version marked active, and the COMPLETE deployment set of the
 * site's gateway device published retained on {@code …/v2/flows}.
 *
 * <p>The compiler is the E2 flowc sidecar, wired via {@link FlowCompilerClient}
 * (a bean is always present now), so activation compiles the REAL artifact and
 * publishes the D-11 deployment set carrying flowc's own content_hash /
 * min_palette_version. Honest stops, in order:
 * <ol>
 *   <li>No compiler bean (only via the null-provider test seam - "Compiler
 *       folgt"): changes NOTHING, publishes NOTHING.</li>
 *   <li>Feature flag {@code voltpilot.flows.activation.enabled} (default OFF;
 *       only the simulator-rig environment sets it): with a compiler present
 *       but the flag off, activation still refuses - so no production device
 *       may ever receive a deployment from this MVP.</li>
 *   <li>Compiler failure ({@link FlowCompilerException}: sidecar unreachable or
 *       the flow rejected) or a malformed artifact: activation refuses with a
 *       German message and changes NOTHING - the flow stays "simuliert".</li>
 * </ol>
 * Rollback = re-activating a previous version (its stored artifact is
 * re-published; deterministic tab ids make it a clean replace).
 */
@Service
public class FlowActivationService {

    private static final Logger log = LoggerFactory.getLogger(FlowActivationService.class);

    /** Outcome envelope the controller returns verbatim. */
    public record ActivationOutcome(boolean activated, String reason, String message,
            boolean published, UUID deviceId) {

        static ActivationOutcome refused(String reason, String message) {
            return new ActivationOutcome(false, reason, message, false, null);
        }
    }

    /** Outcome of a deactivation (retire the active version + re-publish). */
    public record DeactivationOutcome(boolean published) {}

    private final FlowRepository flows;
    private final EntityRegistryRepository entities;
    private final FlowClaimRepository claims;
    private final FlowCatalog catalog;
    private final ObjectProvider<EntityRegistryService> registry;
    private final ObjectProvider<FlowCompiler> compiler;
    private final ObjectProvider<FlowDeploymentPublisher> publisher;
    private final ObjectMapper mapper;
    private final boolean activationEnabled;
    private final Clock clock;

    /**
     * The @Autowired is LOAD-BEARING (the BrokerAuthzReloader two-constructor
     * footgun): with the test-seam constructor below and no annotation, Spring
     * cannot pick an injection constructor.
     */
    @org.springframework.beans.factory.annotation.Autowired
    public FlowActivationService(FlowRepository flows, EntityRegistryRepository entities,
            FlowClaimRepository claims, FlowCatalog catalog,
            ObjectProvider<EntityRegistryService> registry,
            ObjectProvider<FlowCompiler> compiler, ObjectProvider<FlowDeploymentPublisher> publisher,
            ObjectMapper mapper,
            @Value("${voltpilot.flows.activation.enabled:false}") boolean activationEnabled) {
        this(flows, entities, claims, catalog, registry, compiler, publisher, mapper,
                activationEnabled, Clock.systemUTC());
    }

    FlowActivationService(FlowRepository flows, EntityRegistryRepository entities,
            FlowClaimRepository claims, FlowCatalog catalog,
            ObjectProvider<EntityRegistryService> registry,
            ObjectProvider<FlowCompiler> compiler, ObjectProvider<FlowDeploymentPublisher> publisher,
            ObjectMapper mapper, boolean activationEnabled, Clock clock) {
        this.flows = flows;
        this.entities = entities;
        this.claims = claims;
        this.catalog = catalog;
        this.registry = registry;
        this.compiler = compiler;
        this.publisher = publisher;
        this.mapper = mapper;
        this.activationEnabled = activationEnabled;
        this.clock = clock;
    }

    /** Activate one validated version. Never throws for the honest stops. */
    @Transactional
    public ActivationOutcome activate(UUID siteId, FlowVersionRow version, JsonNode document) {
        FlowCompiler flowCompiler = compiler.getIfAvailable();
        if (flowCompiler == null) {
            return ActivationOutcome.refused("compiler_missing",
                    "Compiler folgt: Der Flow-Compiler (E2) ist noch nicht verfügbar. Der Flow "
                            + "wurde vollständig geprüft, aber nichts ausgerollt - Entwurf, "
                            + "Validierung und Simulation funktionieren bereits vollständig.");
        }
        if (!activationEnabled) {
            return ActivationOutcome.refused("activation_disabled",
                    "Die Flow-Aktivierung ist auf dieser Umgebung deaktiviert (Feature-Flag "
                            + "VOLTPILOT_FLOWS_ACTIVATION_ENABLED, nur für das Simulator-Rig).");
        }
        UUID gateway = gatewayDevice(siteId);
        if (gateway == null) {
            return ActivationOutcome.refused("no_gateway_device",
                    "Diese Anlage hat kein eindeutiges Gateway-Gerät - der Rollout braucht "
                            + "genau ein beanspruchtes Gerät (oder ein mit dem Speicher "
                            + "verknüpftes).");
        }

        // Compile the real artifact (the E2 flowc sidecar) and validate its
        // manifest+bundle against the flow-artifact contract shape BEFORE any
        // state change - so a sidecar outage or a compiler rejection leaves the
        // flow at "simuliert", never a half-activated state.
        JsonNode artifact;
        try {
            artifact = flowCompiler.compile(document);
            FlowDeployment.requireArtifactShape(artifact);
        } catch (FlowCompilerException e) {
            log.warn("flow {} activation aborted: {} ({})", version.flowId(), e.getMessage(),
                    e.reason());
            return ActivationOutcome.refused(e.reason(), e.getMessage());
        } catch (IllegalArgumentException e) {
            log.warn("flow {} activation aborted: compiled artifact invalid: {}",
                    version.flowId(), e.getMessage());
            return ActivationOutcome.refused("compiler_rejected",
                    "Das kompilierte Flow-Artefakt ist ungültig und wurde nicht ausgerollt: "
                            + e.getMessage());
        }

        flows.retireActive(version.flowId());
        flows.markActive(version.flowId(), version.flowVersion(), artifact.toString());
        // Steuerung Stufe 3 (§3.7 A3/A4): materialize this flow's claims in the
        // SAME transaction, then re-push the registry so the box learns
        // owner_claimed and stops injecting a plan setpoint for the claimed
        // component. FlowClaims stays the ONE derivation - the table is only
        // its projection for the two consumers outside this process (the push
        // and the optimizer).
        writeClaims(siteId, version, document);
        boolean published = publishDeploymentSet(siteId, gateway);
        pushRegistry(siteId);
        return new ActivationOutcome(true, null,
                "Flow aktiviert (Version " + version.flowVersion() + ").", published, gateway);
    }

    /**
     * Deactivate a flow: retire its active version and re-publish the site's
     * (now smaller) COMPLETE deployment set so the edge drops the retired flow.
     * Never gated by the activation flag - stopping a running flow must always
     * be possible. Best-effort publish (no gateway / no broker → not published,
     * logged, never thrown); the retire itself always commits.
     */
    @Transactional
    public DeactivationOutcome deactivate(UUID siteId, UUID flowId, FlowVersionRow active) {
        flows.retireActive(flowId);
        // A claim never outlives the flow that holds it (Stufe 3): dropping it
        // here is what makes the plan take the component back on the next push.
        claims.clearForFlow(flowId);
        UUID gateway = gatewayDevice(siteId);
        boolean published = gateway != null && publishDeploymentSet(siteId, gateway);
        if (gateway == null) {
            log.warn("flow {} deactivated but deployment for site {} not re-published: "
                    + "no unique gateway device", flowId, siteId);
        }
        pushRegistry(siteId);
        return new DeactivationOutcome(published);
    }

    /**
     * Materialize the ACTIVE version's claims (Stufe 3). Derived here from the
     * SAME {@link FlowClaims} the validator uses - never a second rule.
     */
    private void writeClaims(UUID siteId, FlowVersionRow version, JsonNode document) {
        List<FlowClaimRepository.ClaimRow> rows = new ArrayList<>();
        for (FlowClaims.DerivedClaim claim : FlowClaims.derive(document, catalog)) {
            for (String command : claim.commands()) {
                rows.add(new FlowClaimRepository.ClaimRow(UUID.fromString(claim.entityId()),
                        command, version.flowId(), version.flowVersion(), version.name(),
                        claim.delegated()));
            }
        }
        claims.replaceForFlow(TenantContext.get(), siteId, version.flowId(), version.flowVersion(),
                version.name(), rows);
    }

    /**
     * Re-push the entity registry so a claim change reaches the box
     * ({@code owner_claimed}). Best-effort exactly like every other push - a
     * missing gateway or a broker outage never fails the activation, the
     * retained delivery converges later.
     */
    private void pushRegistry(UUID siteId) {
        EntityRegistryService svc = registry.getIfAvailable();
        if (svc != null) {
            svc.pushRegistryBestEffort(siteId);
        }
    }

    /**
     * Re-publish the site's COMPLETE deployment set (the consumer-policy
     * activation/stop paths, D-19). Best-effort: no unique gateway / no broker
     * → {@code false}, logged - the caller decides whether that is fatal.
     */
    public boolean republishForSite(UUID siteId) {
        UUID gateway = gatewayDevice(siteId);
        if (gateway == null) {
            log.warn("deployment for site {} not re-published: no unique gateway device", siteId);
            return false;
        }
        return publishDeploymentSet(siteId, gateway);
    }

    /** Whether the site resolves to exactly one gateway device (E1a rule). */
    public boolean hasGatewayDevice(UUID siteId) {
        return gatewayDevice(siteId) != null;
    }

    /**
     * The COMPLETE desired state for the gateway: every active edge flow's
     * stored artifact of this site (never a diff, contract §3).
     */
    boolean publishDeploymentSet(UUID siteId, UUID gateway) {
        FlowDeploymentPublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            log.warn("flow deployment for site {} not published: broker not configured", siteId);
            return false;
        }
        UUID tenantId = TenantContext.get();
        List<JsonNode> artifacts = new ArrayList<>();
        for (FlowVersionRow row : flows.versionsForSite(siteId)) {
            if ("active".equals(row.lifecycle()) && "edge".equals(row.runtime())
                    && row.artifactJson() != null) {
                try {
                    artifacts.add(mapper.readTree(row.artifactJson()));
                } catch (Exception e) {
                    log.warn("stored artifact of flow {} v{} unreadable, skipped: {}",
                            row.flowId(), row.flowVersion(), e.getMessage());
                }
            }
        }
        ObjectNode deployment = FlowDeployment.deploymentSet(mapper, tenantId, siteId, gateway,
                clock.instant(), artifacts);
        return pub.publishDeployment(tenantId, siteId, gateway,
                deployment.toString().getBytes(StandardCharsets.UTF_8));
    }

    /**
     * The device carrying the site's v2 subtree - the E1a gateway rule: the
     * battery's controlling device when linked, else the site's SINGLE claimed
     * device, never a guess between several.
     */
    private UUID gatewayDevice(UUID siteId) {
        EntityRegistryRepository.BatteryAsset battery = entities.batteryAsset(siteId);
        if (battery != null && battery.deviceId() != null) {
            return battery.deviceId();
        }
        List<UUID> devices = entities.siteDeviceIds(siteId);
        return devices.size() == 1 ? devices.get(0) : null;
    }
}
