package com.voltpilot.api.consumers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.consumers.ConsumerRepository.ConsumerRow;
import com.voltpilot.api.consumers.ConsumerRepository.PolicyRow;
import com.voltpilot.api.flows.FlowActivationService;
import com.voltpilot.api.flows.FlowCatalog;
import com.voltpilot.api.flows.FlowClaims;
import com.voltpilot.api.flows.FlowCompiler;
import com.voltpilot.api.flows.FlowCompilerException;
import com.voltpilot.api.flows.FlowDeployment;
import com.voltpilot.api.repo.FlowRepository;
import com.voltpilot.api.repo.FlowRepository.FlowVersionRow;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Clock;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * The consumer-policy ACTIVATION path (docs/verbrauchssteuerung.md §11/§13.2/
 * §16, Inkrement 4): validate → compile → atomically activate (draft→active,
 * previous version retired) → roll the generated artifact out through the
 * EXISTING flow-deployment machinery. Plus its counterparts: deactivate (the
 * echte Stopppfad), pause (failsafe) and resume.
 *
 * <p>The rules this class carries:
 * <ul>
 *   <li><b>Atomic:</b> the flowc compile runs BEFORE any state change, all DB
 *       writes share one transaction, and the artifact publish happens INSIDE
 *       it as the last step - a compiler or publish failure is a 503 and the
 *       previously active version stays untouched (§11).</li>
 *   <li><b>Flag-gated start, flag-INDEPENDENT stop (§16):</b> activation and
 *       resume refuse honestly while {@code voltpilot.consumer-control.enabled}
 *       (VOLTPILOT_CONSUMER_CONTROL_ENABLED) is off, and the compile/rollout
 *       half additionally needs {@code voltpilot.consumer-control.policy-compiler-enabled}
 *       (VOLTPILOT_CONSUMER_POLICY_COMPILER_ENABLED) - both default OFF.
 *       Deactivate and pause run REGARDLESS of both flags AND retract the
 *       retained artifact (the OTA/flow lesson: Flag aus ≠ gestoppt).</li>
 *   <li><b>V-5 honesty:</b> a consumer whose entity is claimed by another
 *       ACTIVE flow refuses activation naming that flow - two rules never
 *       fight over one entity.</li>
 *   <li><b>Audit (§16):</b> every activate/deactivate/pause/resume appends to
 *       {@code consumer_audit_event}.</li>
 * </ul>
 */
@Service
public class ConsumerPolicyActivationService {

    private static final Logger log = LoggerFactory.getLogger(ConsumerPolicyActivationService.class);

    /** Outcome envelope the controller returns verbatim (the flows pattern). */
    public record ActivationOutcome(boolean activated, String reason, String message,
            boolean published, Integer policyVersion) {

        static ActivationOutcome refused(String reason, String message) {
            return new ActivationOutcome(false, reason, message, false, null);
        }
    }

    public record StopOutcome(boolean published, String message) {}

    private final ConsumerRepository repo;
    private final ConsumerPolicyValidator validator;
    private final ConsumerPolicyCompiler compiler;
    private final ConsumerPolicyCompiler.WindowSource windowSource;
    private final ObjectProvider<FlowCompiler> flowc;
    private final FlowRepository flows;
    private final FlowCatalog flowCatalog;
    private final FlowActivationService deployments;
    private final ConsumerAuditRepository audit;
    private final ObjectMapper mapper;
    private final boolean controlEnabled;
    private final boolean compilerEnabled;
    private final Clock clock;

    /** The @Autowired is LOAD-BEARING (two-constructor footgun, BrokerAuthzReloader). */
    @Autowired
    public ConsumerPolicyActivationService(ConsumerRepository repo,
            ConsumerPolicyValidator validator, ConsumerPolicyCompiler compiler,
            PriceWindowSource windowSource, ObjectProvider<FlowCompiler> flowc,
            FlowRepository flows, FlowCatalog flowCatalog, FlowActivationService deployments,
            ConsumerAuditRepository audit, ObjectMapper mapper,
            @Value("${voltpilot.consumer-control.enabled:false}") boolean controlEnabled,
            @Value("${voltpilot.consumer-control.policy-compiler-enabled:false}") boolean compilerEnabled) {
        this(repo, validator, compiler, windowSource, flowc, flows, flowCatalog, deployments,
                audit, mapper, controlEnabled, compilerEnabled, Clock.systemUTC());
    }

    ConsumerPolicyActivationService(ConsumerRepository repo, ConsumerPolicyValidator validator,
            ConsumerPolicyCompiler compiler, ConsumerPolicyCompiler.WindowSource windowSource,
            ObjectProvider<FlowCompiler> flowc, FlowRepository flows, FlowCatalog flowCatalog,
            FlowActivationService deployments, ConsumerAuditRepository audit, ObjectMapper mapper,
            boolean controlEnabled, boolean compilerEnabled, Clock clock) {
        this.repo = repo;
        this.validator = validator;
        this.compiler = compiler;
        this.windowSource = windowSource;
        this.flowc = flowc;
        this.flows = flows;
        this.flowCatalog = flowCatalog;
        this.deployments = deployments;
        this.audit = audit;
        this.mapper = mapper;
        this.controlEnabled = controlEnabled;
        this.compilerEnabled = compilerEnabled;
        this.clock = clock;
    }

    /** Whether the portal may offer a REAL activate button (both flags on). */
    public boolean activationAvailable() {
        return controlEnabled && compilerEnabled;
    }

    // -- activate ------------------------------------------------------------

    @Transactional
    public ActivationOutcome activate(UUID siteId, UUID entityId, String actor) {
        ConsumerRow row = require(siteId, entityId);
        PolicyRow latest = repo.latestPolicy(siteId, entityId);
        if (latest == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Für diesen Verbraucher ist noch keine Regel gespeichert.");
        }

        // E11: a draft may exist unconnected; ACTIVATION needs the physical
        // connection - an activated rule on a connectionless consumer would
        // claim control nobody can execute.
        if (row.deviceId() == null && row.edgeSourceId() == null) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Dieser Verbraucher ist noch nicht verbunden - die Regel bleibt gespeichert "
                            + "und kann nach dem Verbinden aktiviert werden.");
        }

        if (!controlEnabled) {
            return ActivationOutcome.refused("activation_disabled",
                    "Die Verbrauchersteuerung ist auf dieser Umgebung noch nicht aktiviert - "
                            + "die Regel bleibt als Entwurf gespeichert.");
        }

        JsonNode document = parse(latest.documentJson());
        var errors = validator.validate(document).stream()
                .filter(ConsumerFinding::isError).toList();
        if (!errors.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, errors.get(0).message());
        }

        if ("active".equals(latest.lifecycle())) {
            // Idempotent: the newest version already runs; self-heal the
            // retained deployment set instead of failing the button.
            boolean published = deployments.republishForSite(siteId);
            return new ActivationOutcome(true, null,
                    "Diese Regel ist bereits aktiv.", published, latest.version());
        }

        // Compile FIRST (no state change yet). null = no reactive-with-local
        // part, the market plan alone carries the policy (D1 split).
        UUID generatedFlowId = ConsumerPolicyCompiler.generatedFlowId(entityId);
        ObjectNode generatedDoc = compiler.compile(document, row, siteId, TenantContext.get(),
                latest.policyId(), latest.version(), windowSource, clock.instant());
        JsonNode artifact = null;
        if (generatedDoc != null) {
            if (!compilerEnabled) {
                return ActivationOutcome.refused("compiler_disabled",
                        "Der Regel-Compiler ist auf dieser Umgebung deaktiviert (Feature-Flag "
                                + "VOLTPILOT_CONSUMER_POLICY_COMPILER_ENABLED) - die Regel bleibt "
                                + "als Entwurf gespeichert.");
            }
            requireNoForeignClaim(siteId, entityId, generatedFlowId, row);
            FlowCompiler flowCompiler = flowc.getIfAvailable();
            if (flowCompiler == null) {
                throw unavailable("Der Flow-Compiler ist nicht verfügbar.");
            }
            try {
                artifact = flowCompiler.compile(generatedDoc);
                FlowDeployment.requireArtifactShape(artifact);
            } catch (FlowCompilerException e) {
                log.warn("consumer policy {} v{} activation aborted: {} ({})", latest.policyId(),
                        latest.version(), e.getMessage(), e.reason());
                throw unavailable("Die Regel konnte nicht kompiliert werden: " + e.getMessage());
            } catch (IllegalArgumentException e) {
                throw unavailable("Das kompilierte Regel-Artefakt ist ungültig: " + e.getMessage());
            }
        }

        // The atomic DB half: previous version retired, this one active, the
        // Gesamtschalter on, the generated flow replaced (or retired when the
        // new version needs no artifact).
        repo.retireActivePolicy(siteId, entityId);
        repo.markPolicyActive(siteId, entityId, latest.version());
        repo.setEnabled(siteId, entityId, true);
        if (artifact != null) {
            flows.upsertGenerated(TenantContext.get(), siteId, generatedFlowId, latest.version(),
                    "Verbraucherregel: " + displayName(row), "edge", generatedDoc.toString());
            flows.retireActive(generatedFlowId);
            flows.markActive(generatedFlowId, latest.version(), artifact.toString());
        } else {
            flows.retireActive(generatedFlowId);
        }

        // Publish INSIDE the transaction, as the last step: a failed rollout of
        // a needed artifact rolls everything back (503, active version
        // unchanged). A pure-plan policy tolerates a failed republish (there is
        // nothing new on the wire; the next publish heals).
        boolean published = deployments.republishForSite(siteId);
        if (artifact != null && !published) {
            throw unavailable("Die Regel konnte nicht an das Gerät verteilt werden - "
                    + "bitte später erneut versuchen.");
        }

        audit.append(siteId, entityId, "policy_activated", latest.policyId(), latest.version(),
                actor, artifact != null ? "mit Edge-Artefakt" : "nur Marktplan");
        return new ActivationOutcome(true, null,
                "Regel aktiviert (Version " + latest.version() + ").", published,
                latest.version());
    }

    // -- the echte Stopppfad (§16: flag-independent, retracts retained state) --

    @Transactional
    public StopOutcome deactivate(UUID siteId, UUID entityId, String actor) {
        require(siteId, entityId);
        PolicyRow active = repo.activePolicy(siteId, entityId);
        if (active == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für diesen Verbraucher ist keine Regel aktiv.");
        }
        repo.retireActivePolicy(siteId, entityId);
        boolean published = retractGeneratedFlow(siteId, entityId);
        audit.append(siteId, entityId, "policy_deactivated", active.policyId(), active.version(),
                actor, null);
        return new StopOutcome(published, "Regel deaktiviert.");
    }

    @Transactional
    public StopOutcome pause(UUID siteId, UUID entityId, String actor) {
        require(siteId, entityId);
        repo.setEnabled(siteId, entityId, false);
        boolean published = retractGeneratedFlow(siteId, entityId);
        audit.append(siteId, entityId, "paused", null, null, actor, null);
        return new StopOutcome(published, "Verbraucher pausiert - der Failsafe des Geräts gilt.");
    }

    /**
     * Resume after a pause: re-enable + re-deploy the ACTIVE policy's stored
     * artifact (no compile - the artifact was compiled at activation; a policy
     * without one just returns to the market plan). Gated on the control flag:
     * resuming re-establishes control.
     */
    @Transactional
    public ActivationOutcome resume(UUID siteId, UUID entityId, String actor) {
        ConsumerRow row = require(siteId, entityId);
        if (!controlEnabled) {
            return ActivationOutcome.refused("activation_disabled",
                    "Die Verbrauchersteuerung ist auf dieser Umgebung noch nicht aktiviert.");
        }
        PolicyRow active = repo.activePolicy(siteId, entityId);
        if (active == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Für diesen Verbraucher ist keine Regel aktiv - bitte zuerst aktivieren.");
        }
        repo.setEnabled(siteId, entityId, true);
        UUID generatedFlowId = ConsumerPolicyCompiler.generatedFlowId(entityId);
        FlowVersionRow flow = flows.find(generatedFlowId, active.version());
        boolean published;
        if (flow != null && flow.artifactJson() != null) {
            flows.retireActive(generatedFlowId);
            flows.markActive(generatedFlowId, active.version(), flow.artifactJson());
            published = deployments.republishForSite(siteId);
            if (!published) {
                throw unavailable("Die Regel konnte nicht an das Gerät verteilt werden - "
                        + "bitte später erneut versuchen.");
            }
        } else {
            published = deployments.republishForSite(siteId);
        }
        audit.append(siteId, entityId, "resumed", active.policyId(), active.version(), actor, null);
        return new ActivationOutcome(true, null, "Verbraucher fortgesetzt.", published,
                active.version());
    }

    // -- helpers -------------------------------------------------------------

    /** Retire the generated flow (if any) and re-publish the shrunken set. */
    private boolean retractGeneratedFlow(UUID siteId, UUID entityId) {
        UUID generatedFlowId = ConsumerPolicyCompiler.generatedFlowId(entityId);
        flows.retireActive(generatedFlowId);
        return deployments.republishForSite(siteId);
    }

    /**
     * V-5 across flows: another ACTIVE flow claiming this entity refuses the
     * activation honestly, naming the flow ("wird bereits durch Automation X
     * gesteuert") - never two rules fighting over one entity.
     */
    private void requireNoForeignClaim(UUID siteId, UUID entityId, UUID generatedFlowId,
            ConsumerRow row) {
        for (FlowVersionRow foreign : flows.activeVersionsForSiteExcept(siteId, "edge",
                generatedFlowId)) {
            JsonNode doc = parse(foreign.documentJson());
            for (FlowClaims.DerivedClaim claim : FlowClaims.derive(doc, flowCatalog)) {
                if (claim.entityId().equals(entityId.toString())) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            "\"" + displayName(row) + "\" wird bereits durch die Automation \""
                                    + foreign.name() + "\" gesteuert. Bitte diese Automation "
                                    + "zuerst stilllegen.");
                }
            }
        }
    }

    private ConsumerRow require(UUID siteId, UUID entityId) {
        ConsumerRow row = repo.findForSite(siteId, entityId);
        if (row == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unbekannter Verbraucher.");
        }
        return row;
    }

    private JsonNode parse(String json) {
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("stored JSON unreadable", e);
        }
    }

    private static String displayName(ConsumerRow row) {
        return row.label() == null || row.label().isBlank()
                ? row.entityId().toString() : row.label();
    }

    private static ResponseStatusException unavailable(String message) {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, message);
    }
}
