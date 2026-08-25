package com.voltpilot.api.web;

import com.voltpilot.api.ocpp.OcppActionPolicy;
import com.voltpilot.api.ocpp.OcppActionService;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.web.dto.OcppActionDto;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** Write boundary for the complete OCPP 1.6 CSMS action surface. */
@RestController
@RequestMapping("/api/v1/sites/{siteId}/ocpp")
@PreAuthorize("hasAnyRole('operator', 'admin', 'site-admin', 'platform-admin')")
public class SiteOcppActionController {
    private final SiteRepository sites;
    private final OcppActionPolicy policy;
    private final OcppActionService service;

    public SiteOcppActionController(SiteRepository sites, OcppActionPolicy policy, OcppActionService service) {
        this.sites = sites; this.policy = policy; this.service = service;
    }

    @PostMapping("/stations/{chargePointId}/action-intents")
    @ResponseStatus(HttpStatus.CREATED)
    public OcppActionDto.Intent intent(@PathVariable UUID siteId, @PathVariable String chargePointId,
            @Valid @RequestBody OcppActionDto.IntentRequest request, Authentication auth) {
        requireSite(siteId); requireAllowed(auth, request.action());
        return service.intent(siteId, chargePointId, request, actor(auth));
    }

    @PostMapping("/stations/{chargePointId}/actions")
    @ResponseStatus(HttpStatus.CREATED)
    public OcppActionDto.Action create(@PathVariable UUID siteId, @PathVariable String chargePointId,
            @RequestHeader(value = "Idempotency-Key", required = false) String key,
            @Valid @RequestBody OcppActionDto.ActionRequest request, Authentication auth) {
        requireSite(siteId); requireAllowed(auth, request.action());
        return service.create(siteId, chargePointId, request, key, actor(auth));
    }

    @GetMapping("/actions")
    public List<OcppActionDto.Action> list(@PathVariable UUID siteId,
            @RequestParam(required = false) String chargePointId,
            @RequestParam(defaultValue = "100") int limit) {
        requireSite(siteId); return service.list(siteId, chargePointId, limit);
    }

    @GetMapping("/actions/{actionId}")
    public OcppActionDto.Action get(@PathVariable UUID siteId, @PathVariable UUID actionId) {
        requireSite(siteId); return service.get(siteId, actionId);
    }

    @GetMapping("/actions/{actionId}/audit")
    public List<OcppActionDto.Audit> audit(@PathVariable UUID siteId, @PathVariable UUID actionId) {
        requireSite(siteId); return service.audit(siteId, actionId);
    }

    @DeleteMapping("/actions/{actionId}")
    public void cancel(@PathVariable UUID siteId, @PathVariable UUID actionId, Authentication auth) {
        requireSite(siteId); service.cancel(siteId, actionId, actor(auth));
    }

    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
    }
    private void requireAllowed(Authentication auth, String action) {
        if (!policy.allowed(auth, action)) throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                "Für diese OCPP-Aktion fehlt die serverseitige Berechtigung.");
    }
    private static String actor(Authentication auth) { return auth == null ? "unknown" : auth.getName(); }
}
