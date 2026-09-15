package com.voltpilot.api.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.chargers.ChargingConfigRepository;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.ocpp.OcppControlValidator;
import com.voltpilot.api.repo.DeviceChargerStatusRepository;
import com.voltpilot.api.repo.SiteRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/v1/sites/{siteId}/ocpp/control")
// AP-03 IP-3: or a customer account without realm role (KONTO_benutzer, KeycloakRealmRoleConverter)
@PreAuthorize("hasAnyRole('operator', 'admin', 'site-admin', 'platform-admin') or hasAuthority('KONTO_benutzer')")
public class SiteOcppControlController {
    private final SiteRepository sites;
    private final ChargingConfigRepository configs;
    private final ChargingConfigService distribution;
    private final DeviceChargerStatusRepository status;
    private final OcppControlValidator validator;
    private final ObjectMapper mapper;

    public SiteOcppControlController(SiteRepository sites, ChargingConfigRepository configs,
            ChargingConfigService distribution, DeviceChargerStatusRepository status,
            OcppControlValidator validator, ObjectMapper mapper) {
        this.sites = sites; this.configs = configs; this.distribution = distribution;
        this.status = status; this.validator = validator; this.mapper = mapper;
    }

    public record View(JsonNode desired, List<Map<String, Object>> observed) {}

    @GetMapping
    public View read(@PathVariable UUID siteId) {
        requireSite(siteId);
        return new View(parse(configs.ocppControl(siteId)), status.ocppControlStatus(siteId));
    }

    @PutMapping
    @PreAuthorize("hasAnyRole('admin', 'site-admin', 'platform-admin')")
    @Transactional
    public View save(@PathVariable UUID siteId, @RequestBody JsonNode input, Authentication caller) {
        requireSite(siteId);
        if (!input.isObject() || !input.path("revision").isIntegralNumber() || !input.path("revision").canConvertToLong() || input.path("revision").asLong() < 0)
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "OCPP-Revision fehlt.");
        long expected = input.path("revision").asLong();
        ObjectNode next = input.deepCopy(); next.put("revision", expected + 1);
        try { validator.validate(next); }
        catch (IllegalArgumentException ex) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage()); }
        // The portal receives complete collections even when an API client
        // uses the additive contract's absent/null collection form.
        for (String field : List.of("electrical", "phase_limits_a", "limits"))
            if (!next.hasNonNull(field)) next.putArray(field);
        ObjectNode auth = (ObjectNode) next.path("authorization");
        if (!auth.hasNonNull("allowed_tags")) auth.putArray("allowed_tags");
        UUID tenantId = TenantContext.get();
        if (!configs.saveOcppControl(tenantId, siteId, next.toString(), expected, caller.getName()))
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Die OCPP-Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.");
        // Publish only committed configuration. A rolled-back edit must never
        // become an active retained instruction on the customer box.
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { distribution.pushFor(tenantId, siteId); }
        });
        return new View(next, status.ocppControlStatus(siteId));
    }

    private JsonNode parse(String raw) {
        if (raw == null) return null;
        try { return mapper.readTree(raw); } catch (Exception ex) { throw new IllegalStateException("Gespeicherte OCPP-Steuerung beschädigt", ex); }
    }
    private void requireSite(UUID siteId) {
        if (!sites.existsForCurrentTenant(siteId)) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
    }
}
