package com.voltpilot.api.web;

import com.voltpilot.api.consumers.ConsumerScheduleRepository;
import com.voltpilot.api.consumers.ConsumerScheduleRepository.ConsumerScheduleDto;
import com.voltpilot.api.consumers.ConsumerService;
import com.voltpilot.api.consumers.ConsumerService.ConsumerDto;
import com.voltpilot.api.consumers.ConsumerService.ConsumerOptionsDto;
import com.voltpilot.api.consumers.ConsumerService.CreateConsumerRequest;
import com.voltpilot.api.consumers.ConsumerService.PatchConsumerRequest;
import com.voltpilot.api.consumers.ConsumerService.PolicyDto;
import com.voltpilot.api.consumers.ConsumerService.SavePolicyRequest;
import com.voltpilot.api.repo.SiteRepository;
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

    public SiteConsumerController(SiteRepository sites, ConsumerService consumers,
            ConsumerScheduleRepository consumerSchedules) {
        this.sites = sites;
        this.consumers = consumers;
        this.consumerSchedules = consumerSchedules;
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

    /** German reasons reach the portal as {"message": ...} (MastrController pattern). */
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> onStatusException(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode())
                .body(Map.of("message", e.getReason() == null ? "Fehler" : e.getReason()));
    }
}
