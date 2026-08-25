package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.web.dto.OcppActionDto;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.dao.DuplicateKeyException;

/** The API half of the OCPP command gateway. */
@Service
public class OcppActionService {
    private final OcppActionRepository actions;
    private final OcppActionPolicy policy;
    private final OcppPrivacy privacy;
    private final ObjectMapper mapper;
    private final ObjectProvider<ProvisioningPublisher> publisher;

    public OcppActionService(OcppActionRepository actions, OcppActionPolicy policy, OcppPrivacy privacy,
            ObjectMapper mapper, ObjectProvider<ProvisioningPublisher> publisher) {
        this.actions = actions; this.policy = policy; this.privacy = privacy; this.mapper = mapper; this.publisher = publisher;
    }

    public OcppActionDto.Intent intent(UUID siteId, String cp, OcppActionDto.IntentRequest req, String actor) {
        requireAction(req.action());
        requireRiskIntent(req.action(), req.phrase(), true);
        var target = actions.target(siteId, cp).orElseThrow(() -> notFound("Station nicht bekannt"));
        String phrase = req.phrase() == null || req.phrase().isBlank() ? confirmationPhrase(req.action(), cp) : req.phrase().trim();
        return actions.insertIntent(currentTenant(), siteId, target.deviceId(), cp, req.action(), phrase, actor,
                Instant.now().plus(Duration.ofMinutes(5)));
    }

    public OcppActionDto.Action create(UUID siteId, String cp, OcppActionDto.ActionRequest req,
            String idempotencyKey, String actor) {
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 200)
            throw bad("Idempotency-Key fehlt oder ist zu lang.");
        requireAction(req.action());
        validateRequest(req);
        UUID tenant = currentTenant();
        var existing = actions.byIdempotency(tenant, idempotencyKey);
        if (existing.isPresent()) return existing.get();
        var target = actions.target(siteId, cp).orElseThrow(() -> notFound("Station nicht bekannt"));
        if (actions.hasRunning(target.deviceId(), cp, req.action())) throw conflict("Für diese Station läuft bereits dieselbe Aktion.");
        if (requiresIntent(req)) {
            if (req.intentId() == null || !actions.consumeIntent(req.intentId(), tenant, siteId, target.deviceId(), cp,
                    req.action(), Instant.now()))
                throw conflict("Für diese Aktion ist eine frische Server-Bestätigung erforderlich.");
        }
        Instant now = Instant.now();
        Instant deadline = now.plus(deadline(req.action()));
        UUID id = UUID.randomUUID();
        String correlation = "ocpp-" + id;
        JsonNode request = req.request() == null ? mapper.createObjectNode() : req.request();
        ObjectNode envelope = mapper.createObjectNode();
        envelope.put("schema_version", "1.0"); envelope.put("type", "ocpp_command");
        envelope.put("tenant_id", tenant.toString()); envelope.put("site_id", siteId.toString());
        envelope.put("device_id", target.deviceId().toString()); envelope.put("charge_point_id", cp);
        envelope.put("action_id", id.toString()); envelope.put("correlation_id", correlation);
        envelope.put("action", req.action()); envelope.set("request", request);
        OcppActionDto.Action result;
        try {
            result = actions.insert(id, tenant, siteId, target.deviceId(), cp, req.action(), correlation,
                    idempotencyKey, actor, req.connectorId(), req.transactionId(), privacy.redact(request, req.action()), now, deadline);
        } catch (DuplicateKeyException e) {
            throw conflict("Für diese Station läuft bereits dieselbe Aktion.");
        }
        if (!target.connected()) {
            actions.transition(id, tenant, actor, "not_sendable", "Die Station ist offline.", now, "none");
            return actions.byId(id).orElse(result);
        }
        ProvisioningPublisher p = publisher.getIfAvailable();
        boolean sent = p != null && p.publishOcppCommand(tenant, siteId, target.deviceId(), json(envelope));
        if (sent) actions.transition(id, tenant, actor, "sent", null, Instant.now(), "sent");
        else actions.transition(id, tenant, actor, "transport_failed", "Der Edge-Befehl konnte nicht zugestellt werden.", Instant.now(), "none");
        return actions.byId(id).orElse(result);
    }

    public OcppActionDto.Action get(UUID siteId, UUID id) { return actions.byIdForSite(siteId, id).orElseThrow(() -> notFound("Aktion nicht gefunden")); }
    public java.util.List<OcppActionDto.Action> list(UUID siteId, String cp, int limit) { return actions.list(siteId, cp, limit); }
    public java.util.List<OcppActionDto.Audit> audit(UUID siteId, UUID id) { get(siteId, id); return actions.audit(siteId, id); }
    public void cancel(UUID siteId, UUID id, String actor) {
        var a = get(siteId, id); actions.cancel(id, currentTenant(), actor, Instant.now());
    }

    @Scheduled(fixedDelayString = "${voltpilot.ocpp.action-expiry-ms:10000}")
    public void expire() { actions.expire(Instant.now()); }

    private void validateRequest(OcppActionDto.ActionRequest req) {
        JsonNode n = req.request();
        if ("UpdateFirmware".equals(req.action())) {
            String url = n == null ? "" : n.path("location").asText("");
            if (!url.startsWith("https://")) throw bad("Firmware muss über HTTPS bereitgestellt werden.");
            if (!isAllowlistedUrl(url) || n.path("sha256").asText("").matches("[A-Fa-f0-9]{64}") == false
                    || n.path("signature").asText("").isBlank()) throw bad("Firmware ist nicht allowlisted oder Hash/Signatur fehlt.");
        }
        if ("GetDiagnostics".equals(req.action())) {
            String url = n == null ? "" : n.path("location").asText("");
            if (!url.startsWith("https://") || !isAllowlistedUrl(url) || n.path("expiresAt").isMissingNode())
                throw bad("Diagnoseziel muss eine kurzlebige presigned HTTPS-URL sein.");
            try {
                Instant expires = Instant.parse(n.path("expiresAt").asText());
                Instant now = Instant.now();
                if (!expires.isAfter(now) || expires.isAfter(now.plus(Duration.ofMinutes(10))))
                    throw bad("Diagnoseziel muss innerhalb von zehn Minuten ablaufen.");
            } catch (java.time.format.DateTimeParseException e) {
                throw bad("Diagnoseziel hat kein gültiges Ablaufdatum.");
            }
        }
        if ("DataTransfer".equals(req.action()) && (n == null || n.path("vendorId").asText("").isBlank()
                || n.path("schemaId").asText("").isBlank())) throw bad("DataTransfer benötigt ein registriertes Vendor-Schema.");
    }
    private boolean isAllowlistedUrl(String url) {
        try {
            URI uri = URI.create(url);
            String host = uri.getHost();
            return host != null && host.endsWith(".voltpilot.local") && !url.contains("@")
                    && (url.contains("X-Amz-") || url.contains("presigned=true"));
        } catch (IllegalArgumentException e) { return false; }
    }
    private void requireAction(String action) { if (!OcppActionPolicy.ACTIONS.contains(action)) throw bad("OCPP-Aktion wird nicht unterstützt."); }
    private boolean requiresIntent(OcppActionDto.ActionRequest req) {
        if ("HardReset".equals(req.action()) || "UpdateFirmware".equals(req.action())) return true;
        return "SendLocalList".equals(req.action()) && req.request() != null
                && "Full".equalsIgnoreCase(req.request().path("updateType").asText());
    }
    private void requireRiskIntent(String action, String phrase, boolean create) {
        if (phrase != null && phrase.length() > 200) throw bad("Bestätigung ist zu lang.");
    }
    private String confirmationPhrase(String action, String cp) { return action + ":" + cp; }
    private Duration deadline(String action) {
        if ("TriggerMessage".equals(action)) return Duration.ofSeconds(20);
        if ("SoftReset".equals(action)) return Duration.ofMinutes(3);
        if ("HardReset".equals(action) || "UpdateFirmware".equals(action) || "GetDiagnostics".equals(action)) return Duration.ofMinutes(10);
        return Duration.ofSeconds(30);
    }
    private UUID currentTenant() { UUID id = com.voltpilot.api.tenant.TenantContext.get(); if (id == null) throw bad("Kein Tenant-Kontext."); return id; }
    private static ResponseStatusException bad(String s) { return new ResponseStatusException(HttpStatus.BAD_REQUEST, s); }
    private static ResponseStatusException conflict(String s) { return new ResponseStatusException(HttpStatus.CONFLICT, s); }
    private static ResponseStatusException notFound(String s) { return new ResponseStatusException(HttpStatus.NOT_FOUND, s); }
    private String json(JsonNode n) { try { return mapper.writeValueAsString(n); } catch (Exception e) { throw new IllegalArgumentException(e); } }
}
