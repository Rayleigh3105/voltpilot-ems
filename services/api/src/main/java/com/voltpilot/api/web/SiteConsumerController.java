package com.voltpilot.api.web;

import com.voltpilot.api.consumers.ConsumerDeviationReader;
import com.voltpilot.api.consumers.ConsumerFulfillmentReader;
import com.voltpilot.api.consumers.ConsumerOverrideService;
import com.voltpilot.api.consumers.ConsumerOverrideService.OverrideOutcome;
import com.voltpilot.api.consumers.ConsumerOverrideService.OverrideRequest;
import com.voltpilot.api.consumers.ConsumerPolicyActivationService;
import com.voltpilot.api.consumers.ConsumerScheduleRepository;
import com.voltpilot.api.consumers.ConsumerScheduleRepository.ConsumerScheduleDto;
import com.voltpilot.api.consumers.ConsumerService;
import com.voltpilot.api.consumers.ConsumerService.ConsumerDto;
import com.voltpilot.api.consumers.ConsumerService.ConsumerOptionsDto;
import com.voltpilot.api.consumers.ConsumerService.CreateConsumerRequest;
import com.voltpilot.api.consumers.ConsumerService.PatchConsumerRequest;
import com.voltpilot.api.consumers.ConsumerService.PolicyDto;
import com.voltpilot.api.consumers.ConsumerService.SavePolicyRequest;
import com.voltpilot.api.repo.ConsumerOverrideRepository;
import com.voltpilot.api.repo.ConsumerRuntimeStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.ConsumerDeviationDto;
import com.voltpilot.api.web.dto.ConsumerFulfillmentDto;
import com.voltpilot.api.web.dto.ConsumerOverrideDto;
import com.voltpilot.api.web.dto.ConsumerRuntimeStatusDto;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * The CUSTOMER surface for steuerbare Verbraucher (docs/verbrauchssteuerung.md
 * §11, Increment 1: contract + master data + CRUD + the Anlagen-Modell
 * assistant). Tenant-scoped like every {@code /api/v1/sites/**} route
 * ({@link SiteFlowController}, {@link SiteController}): NO {@code @PreAuthorize} -
 * authentication + Postgres RLS are the fence. A customer's tenant comes from
 * the JWT {@code tenant_id} claim; a Portal-Admin reaches any site via the
 * {@code X-Tenant-Id} switcher (same RLS-scoped path). A foreign site/consumer
 * is 404, never 403, and a body {@code tenant_id}/{@code site_id} is never
 * trusted (§16).
 *
 * <p>Increment 1 exposes exactly the routes it implements: {@code consumer-options}
 * (the assistant's capability-/context-filtered inputs), consumer CRUD, and
 * policy GET/PUT (a DRAFT is stored; there is no activation yet, so every surface
 * reports "Steuerung noch nicht aktiviert"). The heavier §11 routes (simulate,
 * activate, pause, override, status, consumer-schedule) belong to later
 * increments and are deliberately absent.
 */
@RestController
@RequestMapping("/api/v1/sites/{siteId}")
public class SiteConsumerController {

    private final SiteRepository sites;
    private final ConsumerService consumers;
    private final ConsumerScheduleRepository consumerSchedules;
    private final ConsumerRuntimeStatusRepository runtimeStatus;
    private final ConsumerPolicyActivationService activation;
    private final ConsumerFulfillmentReader fulfillment;
    private final ConsumerDeviationReader deviation;
    private final ConsumerOverrideService overrideService;
    private final ConsumerOverrideRepository overrides;

    public SiteConsumerController(SiteRepository sites, ConsumerService consumers,
            ConsumerScheduleRepository consumerSchedules,
            ConsumerRuntimeStatusRepository runtimeStatus,
            ConsumerPolicyActivationService activation, ConsumerFulfillmentReader fulfillment,
            ConsumerDeviationReader deviation, ConsumerOverrideService overrideService,
            ConsumerOverrideRepository overrides) {
        this.sites = sites;
        this.consumers = consumers;
        this.consumerSchedules = consumerSchedules;
        this.runtimeStatus = runtimeStatus;
        this.activation = activation;
        this.fulfillment = fulfillment;
        this.deviation = deviation;
        this.overrideService = overrideService;
        this.overrides = overrides;
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    @GetMapping("/consumer-options")
    public ConsumerOptionsDto options(@PathVariable UUID siteId) {
        requireSite(siteId);
        return consumers.options(siteId);
    }

    /** Die zuletzt gemeldeten Ein-/Ausgänge eines I/O-Moduls (Ebyte M31) samt Zuordnung. */
    @GetMapping("/io-modules/{entityId}/zustand")
    public com.voltpilot.api.consumers.ConsumerService.IoModuleStateDto ioModuleState(
            @PathVariable UUID siteId, @PathVariable UUID entityId) {
        requireSite(siteId);
        return consumers.ioModuleState(siteId, entityId);
    }

    @GetMapping("/consumers")
    public List<ConsumerDto> list(@PathVariable UUID siteId) {
        requireSite(siteId);
        return consumers.list(siteId);
    }

    @PostMapping("/consumers")
    public ResponseEntity<ConsumerDto> create(@PathVariable UUID siteId,
            @RequestBody CreateConsumerRequest request) {
        requireSite(siteId);
        return ResponseEntity.status(HttpStatus.CREATED).body(consumers.create(siteId, request));
    }

    @GetMapping("/consumers/{id}")
    public ConsumerDto get(@PathVariable UUID siteId, @PathVariable UUID id) {
        requireSite(siteId);
        return consumers.get(siteId, id);
    }

    @PatchMapping("/consumers/{id}")
    public ConsumerDto patch(@PathVariable UUID siteId, @PathVariable UUID id,
            @RequestBody PatchConsumerRequest request) {
        requireSite(siteId);
        return consumers.patch(siteId, id, request);
    }

    @DeleteMapping("/consumers/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID siteId, @PathVariable UUID id) {
        requireSite(siteId);
        consumers.delete(siteId, id);
        return ResponseEntity.noContent().build();
    }

    /** The active/latest policy, or 204 when none exists yet. */
    @GetMapping("/consumers/{id}/policy")
    public ResponseEntity<PolicyDto> getPolicy(@PathVariable UUID siteId, @PathVariable UUID id) {
        requireSite(siteId);
        PolicyDto dto = consumers.getPolicy(siteId, id);
        return dto == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(dto);
    }

    /** Store a NEW draft policy version (lifecycle stays draft in Increment 1). */
    @PutMapping("/consumers/{id}/policy")
    public PolicyDto putPolicy(@PathVariable UUID siteId, @PathVariable UUID id,
            @RequestBody SavePolicyRequest request,
            @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        String createdBy = jwt == null ? null : jwt.getSubject();
        return consumers.savePolicyDraft(siteId, id, request.document(), createdBy);
    }

    // -- policy lifecycle (Inkrement 4, §11/§16) -----------------------------

    /**
     * Validate → compile → atomically activate the LATEST policy version and
     * roll the generated artifact out (§11). Refuses honestly while the
     * feature flags are off ({@code activated:false}, the portal keeps saying
     * "Steuerung noch nicht aktiviert"); a compiler/publish failure is 503 and
     * the previously active version stays untouched.
     */
    @PostMapping("/consumers/{id}/policy/activate")
    public ConsumerPolicyActivationService.ActivationOutcome activatePolicy(
            @PathVariable UUID siteId, @PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return activation.activate(siteId, id, jwt == null ? null : jwt.getSubject());
    }

    /**
     * The echte Stopppfad (§16): retire the active policy AND retract the
     * retained generated artifact. Works with the feature flags OFF - a
     * disabled flag must never leave a deployed rule looking stopped.
     */
    @PostMapping("/consumers/{id}/policy/deactivate")
    public ConsumerPolicyActivationService.StopOutcome deactivatePolicy(
            @PathVariable UUID siteId, @PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return activation.deactivate(siteId, id, jwt == null ? null : jwt.getSubject());
    }

    /** Pause = Gesamtschalter aus + Artefakt-Rückzug → the device failsafe (§11). */
    @PostMapping("/consumers/{id}/pause")
    public ConsumerPolicyActivationService.StopOutcome pause(
            @PathVariable UUID siteId, @PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return activation.pause(siteId, id, jwt == null ? null : jwt.getSubject());
    }

    /** Resume after a pause: re-enable + re-deploy the stored artifact (no compile). */
    @PostMapping("/consumers/{id}/resume")
    public ConsumerPolicyActivationService.ActivationOutcome resume(
            @PathVariable UUID siteId, @PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return activation.resume(siteId, id, jwt == null ? null : jwt.getSubject());
    }

    /**
     * Consumer slots of the newest co-optimizer run for the Fahrplan view
     * (§11/§14.11, Inkrement 2). SHADOW semantics: the slots exist only for
     * sites the optimizer co-plans (VOLTPILOT_V2_PLAN_SITES); without a stored
     * run the body is well-formed and empty - the Fahrplan then renders
     * byte-identical to the pre-consumer view. RLS-fenced like every site
     * route (foreign site 404 via {@link #requireSite}).
     */
    @GetMapping("/consumer-schedule")
    public ConsumerScheduleDto consumerSchedule(@PathVariable UUID siteId) {
        requireSite(siteId);
        return consumerSchedules.latestForSite(siteId);
    }

    /**
     * The edge-reported live states of the site's consumers (Inkrement 3,
     * D9/§15.1 - a §11 status excerpt). An EMPTY list is the honest no-evidence
     * state ("Zustand nicht bestätigt"): no device reported a consumers block
     * yet, and the portal then renders byte-identical to before.
     */
    @GetMapping("/consumer-status")
    public List<ConsumerRuntimeStatusDto> consumerStatus(@PathVariable UUID siteId) {
        requireSite(siteId);
        return runtimeStatus.listForSite(siteId);
    }

    /** One consumer's edge-reported live state; 204 without evidence. */
    @GetMapping("/consumers/{id}/status")
    public ResponseEntity<ConsumerRuntimeStatusDto> consumerStatusOne(@PathVariable UUID siteId,
            @PathVariable UUID id) {
        requireSite(siteId);
        return runtimeStatus.forEntity(siteId, id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    // -- fulfilment ledger (Inkrement 5, §9.4 / §14.13) ----------------------

    /**
     * The fulfilment ledger of one consumer (§9.4): the current/recent instances
     * of its recurring requirements with Ist runtime/energy DERIVED FROM
     * TELEMETRY, the D3 confirmation level, and the effective state + "Frist
     * gefährdet" warn. Empty {@code tasks} = no recurring requirement / no
     * evidence yet.
     */
    @GetMapping("/consumers/{id}/fulfillment")
    public ConsumerFulfillmentDto fulfillment(@PathVariable UUID siteId, @PathVariable UUID id) {
        requireSite(siteId);
        consumers.get(siteId, id); // 404 for a foreign/unknown consumer
        return fulfillment.forEntity(siteId, id);
    }

    /**
     * Soll/Ist-Abweichung je Verbraucher (§18): the PLANNED current slot vs. the
     * CONFIRMED Ist - a support/diagnosis read for the platform layer
     * ({@code showTechnicalLayer()} in the portal), not a customer surface.
     */
    @GetMapping("/consumer-deviation")
    public ConsumerDeviationDto consumerDeviation(@PathVariable UUID siteId) {
        requireSite(siteId);
        return deviation.forSite(siteId);
    }

    // -- manual override (Inkrement 5, §11 + §14.13 Sofortaktionen) -----------

    /** Every ACTIVE (unexpired) manual override of a site's consumers. */
    @GetMapping("/consumer-overrides")
    public List<ConsumerOverrideDto> consumerOverrides(@PathVariable UUID siteId) {
        requireSite(siteId);
        return overrides.activeForSite(siteId).stream()
                .map(r -> new ConsumerOverrideDto(r.entityId(), r.kind(), r.targetCommand(),
                        r.targetValue(), r.endsAt()))
                .toList();
    }

    /**
     * "Jetzt starten" / "Jetzt stoppen" (§14.13): a TTL-bound manual intervention
     * (Endzeit/Dauer PFLICHT). It never changes the stored rule; the physical
     * push rides the master control flag (honest {@code applied} otherwise) and
     * the arbiter's bounded override TTL is the failsafe (§16).
     */
    @PostMapping("/consumers/{id}/override")
    public OverrideOutcome startOverride(@PathVariable UUID siteId, @PathVariable UUID id,
            @RequestBody OverrideRequest request, @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return overrideService.start(siteId, id, request, jwt == null ? null : jwt.getSubject());
    }

    /** "Automatik fortsetzen" (§14.13): end the manual intervention now. */
    @DeleteMapping("/consumers/{id}/override")
    public OverrideOutcome clearOverride(@PathVariable UUID siteId, @PathVariable UUID id,
            @AuthenticationPrincipal Jwt jwt) {
        requireSite(siteId);
        return overrideService.clear(siteId, id, jwt == null ? null : jwt.getSubject());
    }

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
