package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.web.dto.OcppActionDto;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** The API half of the OCPP command gateway. */
@Service
public class OcppActionService {
    private final OcppActionRepository actions;
    private final OcppPrivacy privacy;
    private final ObjectMapper mapper;
    private final ObjectProvider<ProvisioningPublisher> publisher;
    private final OcppCommandValidator validator;
    private final TransactionTemplate transactions;

    public OcppActionService(OcppActionRepository actions, OcppPrivacy privacy,
            ObjectMapper mapper, ObjectProvider<ProvisioningPublisher> publisher,
            OcppCommandValidator validator, PlatformTransactionManager transactionManager) {
        this.actions = actions; this.privacy = privacy; this.mapper = mapper;
        this.publisher = publisher; this.validator = validator;
        this.transactions = new TransactionTemplate(transactionManager);
    }

    public OcppActionDto.Intent intent(UUID siteId, String cp, OcppActionDto.IntentRequest req, String actor) {
        requireAction(req.action());
        if (!requiresIntent(req.action(), req.request())) throw bad("Für diese Aktion ist kein Hochrisiko-Intent vorgesehen.");
        var target = actions.target(siteId, cp).orElseThrow(() -> notFound("Station nicht bekannt"));
        try { validator.validate(req.action(), req.request()); }
        catch (IllegalArgumentException e) { throw bad(e.getMessage()); }
        validateArtifactPolicy(req.action(), req.request());
        Integer connectorId = boundIdentifier(req.connectorId(), req.request(), "connectorId");
        Integer transactionId = boundIdentifier(req.transactionId(), req.request(), "transactionId");
        String requestHash = requestHash(siteId, target.deviceId(), cp, req.action(), connectorId, transactionId, req.request());
        boolean fourEyes = isForeignFirmware(req.action(), req.request());
        String phrase = confirmationPhrase(req.action(), cp);
        return actions.insertIntent(currentTenant(), siteId, target.deviceId(), cp, req.action(), phrase,
                actor, requestHash, connectorId, transactionId, fourEyes,
                Instant.now().plus(Duration.ofMinutes(5)));
    }

    public OcppActionDto.Action create(UUID siteId, String cp, OcppActionDto.ActionRequest req,
            String idempotencyKey, String actor) {
        if (idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 200)
            throw bad("Idempotency-Key fehlt oder ist zu lang.");
        requireAction(req.action());
        UUID tenant = currentTenant();
        var target = actions.target(siteId, cp).orElseThrow(() -> notFound("Station nicht bekannt"));
        JsonNode originalRequest = req.request() == null ? mapper.createObjectNode() : req.request();
        JsonNode wireRequest;
        try { wireRequest = validator.validate(req.action(), originalRequest); }
        catch (IllegalArgumentException e) { throw bad(e.getMessage()); }
        validateArtifactPolicy(req.action(), originalRequest);
        Integer connectorId = boundIdentifier(req.connectorId(), originalRequest, "connectorId");
        Integer transactionId = boundIdentifier(req.transactionId(), originalRequest, "transactionId");
        if ("CancelReservation".equals(req.action()) && connectorId == null)
            throw bad("CancelReservation benötigt den Connector der aktiven Reservierung.");
        String requestHash = requestHash(siteId, target.deviceId(), cp, req.action(), connectorId, transactionId, originalRequest);
        var existing = actions.storedByIdempotency(tenant, idempotencyKey);
        if (existing.isPresent()) return sameOperation(existing.get(), siteId, target.deviceId(), cp, req, requestHash);
        Instant now = Instant.now();
        Instant deadline = now.plus(deadline(req.action()));
        UUID id = UUID.randomUUID();
        String correlation = "ocpp-" + id;
        String conflictKey = conflictKey(req.action(), originalRequest);
        OcppActionDto.Action result = transactions.execute(status -> {
            actions.lockIdempotency(tenant, idempotencyKey);
            var concurrent = actions.storedByIdempotency(tenant, idempotencyKey);
            if (concurrent.isPresent()) return sameOperation(concurrent.get(), siteId, target.deviceId(), cp, req, requestHash);
            if (actions.hasRunning(target.deviceId(), cp, conflictKey))
                throw conflict("Für diese Station läuft bereits eine kollidierende Aktion.");
            if (requiresIntent(req.action(), originalRequest)) {
                boolean fourEyesRequired = isForeignFirmware(req.action(), originalRequest);
                if (req.intentId() == null || req.confirmationPhrase() == null || !actions.consumeIntent(req.intentId(),
                        tenant, siteId, target.deviceId(), cp, req.action(), requestHash, connectorId,
                        transactionId, fourEyesRequired, req.confirmationPhrase(), actor, now))
                    throw conflict("Intent, Akteur, Nutzlast oder Bestätigungsphrase stimmen nicht überein.");
            }
            try {
                var inserted = actions.insertIfAbsent(id, tenant, siteId, target.deviceId(), cp, req.action(), correlation,
                        idempotencyKey, requestHash, conflictKey, actor, connectorId, transactionId,
                        privacy.redact(originalRequest, req.action()), now, deadline);
                if (inserted.isPresent()) return inserted.get();
                return sameOperation(actions.storedByIdempotency(tenant, idempotencyKey).orElseThrow(),
                        siteId, target.deviceId(), cp, req, requestHash);
            } catch (DuplicateKeyException e) {
                throw conflict("Für diese Station läuft bereits eine kollidierende Aktion.");
            }
        });
        if (result == null || !result.id().equals(id)) return result;
        ObjectNode envelope = mapper.createObjectNode();
        envelope.put("schema_version", "1.0"); envelope.put("type", "ocpp_command");
        envelope.put("tenant_id", tenant.toString()); envelope.put("site_id", siteId.toString());
        envelope.put("device_id", target.deviceId().toString()); envelope.put("charge_point_id", cp);
        envelope.put("action_id", id.toString()); envelope.put("correlation_id", correlation);
        envelope.put("requested_at", now.toString()); envelope.put("deadline_at", deadline.toString());
        envelope.put("request_hash", requestHash); envelope.put("action", req.action()); envelope.set("request", wireRequest);
        if ("DataTransfer".equals(req.action())) envelope.put("data_transfer_schema_id", originalRequest.path("schemaId").asText());
        if (!target.connected()) {
            actions.transition(id, tenant, actor, "not_sendable", "Die Station ist offline.", now, "none");
            return actions.byId(id).orElse(result);
        }
        dispatchLocked(id, tenant, siteId, target.deviceId(), envelope);
        return actions.byId(id).orElse(result);
    }

    public OcppActionDto.Action get(UUID siteId, UUID id) { return actions.byIdForSite(siteId, id).orElseThrow(() -> notFound("Aktion nicht gefunden")); }
    public java.util.List<OcppActionDto.Action> list(UUID siteId, String cp, int limit) { return actions.list(siteId, cp, limit); }
    public java.util.List<OcppActionDto.Audit> audit(UUID siteId, UUID id) { get(siteId, id); return actions.audit(siteId, id); }
    public void cancel(UUID siteId, UUID id, String actor) {
        get(siteId, id);
        if (!actions.cancel(id, currentTenant(), actor, Instant.now()))
            throw conflict("Der Befehl wurde bereits an die Edge übergeben und kann nicht ehrlich zurückgerufen werden.");
    }

    @Scheduled(fixedDelayString = "${voltpilot.ocpp.action-expiry-ms:10000}")
    public void expire() { Instant now = Instant.now(); actions.expire(now); actions.purgeRetention(now.minus(Duration.ofDays(90)), now.minus(Duration.ofDays(1))); }

    private void validateArtifactPolicy(String action, JsonNode n) {
        if ("UpdateFirmware".equals(action)) {
            String url = n == null ? "" : n.path("location").asText("");
            String sha = n == null ? "" : n.path("sha256").asText("").toLowerCase(Locale.ROOT);
            String signature = n == null ? "" : n.path("signature").asText("");
            requireShortLivedSignedHttps(url, Duration.ofMinutes(10), "Firmware-URL");
            if (!sha.matches("[0-9a-f]{64}") || signature.isBlank()) throw bad("Firmware-Hash oder Signatur fehlt.");
        } else if ("GetDiagnostics".equals(action)) {
            requireShortLivedSignedHttps(n == null ? "" : n.path("location").asText(""),
                    Duration.ofMinutes(10), "Diagnoseziel");
        }
    }

    private void requireShortLivedSignedHttps(String raw, Duration maxLifetime, String label) {
        try {
            URI uri = URI.create(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null)
                throw bad(label + " muss eine HTTPS-URL ohne Zugangsdaten sein.");
            Map<String, String> q = query(uri.getRawQuery());
            Instant now = Instant.now();
            Instant expiry;
            if (q.containsKey("x-amz-signature") && q.containsKey("x-amz-date") && q.containsKey("x-amz-expires")
                    && q.containsKey("x-amz-algorithm") && q.containsKey("x-amz-credential")
                    && q.containsKey("x-amz-signedheaders")) {
                if (!"AWS4-HMAC-SHA256".equals(q.get("x-amz-algorithm"))
                        || !q.get("x-amz-signature").matches("[0-9a-fA-F]{64}")
                        || q.get("x-amz-credential").isBlank() || q.get("x-amz-signedheaders").isBlank())
                    throw bad(label + " hat keine vollständige AWS-Signatur.");
                Instant signed = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'").withZone(ZoneOffset.UTC)
                        .parse(q.get("x-amz-date"), Instant::from);
                long lifetime = Long.parseLong(q.get("x-amz-expires"));
                if (lifetime <= 0 || lifetime > maxLifetime.toSeconds() || signed.isAfter(now.plusSeconds(60)))
                    throw bad(label + " ist nicht kurzlebig signiert.");
                expiry = signed.plusSeconds(lifetime);
            } else if (q.containsKey("vp_signature") && q.containsKey("vp_expires")) {
                if (!q.get("vp_signature").matches("[A-Za-z0-9_-]{32,512}"))
                    throw bad(label + " hat keine gültige VoltPilot-Signatur.");
                expiry = Instant.parse(q.get("vp_expires"));
            } else throw bad(label + " ist nicht kryptografisch presigned.");
            if (!expiry.isAfter(now) || expiry.isAfter(now.plus(maxLifetime)))
                throw bad(label + " muss kurzlebig sein und innerhalb von zehn Minuten ablaufen.");
        } catch (ResponseStatusException e) { throw e; }
        catch (Exception e) { throw bad(label + " ist keine gültige kurzlebige presigned HTTPS-URL."); }
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new TreeMap<>();
        if (raw == null || raw.isBlank()) return out;
        for (String part : raw.split("&")) {
            String[] kv = part.split("=", 2);
            String key = URLDecoder.decode(kv[0], StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
            String value = URLDecoder.decode(kv.length == 2 ? kv[1] : "", StandardCharsets.UTF_8);
            if (out.putIfAbsent(key, value) != null) throw bad("Presign-Parameter ist doppelt vorhanden.");
        }
        return out;
    }
    private void requireAction(String action) { if (!OcppActionPolicy.ACTIONS.contains(action)) throw bad("OCPP-Aktion wird nicht unterstützt."); }
    private boolean requiresIntent(String action, JsonNode request) {
        if ("HardReset".equals(action) || "UpdateFirmware".equals(action)) return true;
        return "SendLocalList".equals(action) && request != null
                && "Full".equalsIgnoreCase(request.path("updateType").asText());
    }
    private boolean isForeignFirmware(String action, JsonNode request) {
        if (!"UpdateFirmware".equals(action) || request == null) return false;
        return !actions.firmwareAllowed(request.path("location").asText(""),
                request.path("sha256").asText("").toLowerCase(Locale.ROOT), request.path("signature").asText(""));
    }
    private String confirmationPhrase(String action, String cp) {
        return action + " " + cp + " " + UUID.randomUUID().toString().substring(0, 8).toUpperCase(Locale.ROOT);
    }
    private String conflictKey(String action, JsonNode request) {
        if (Set.of("SoftReset", "HardReset").contains(action)
                || ("TriggerMessage".equals(action)
                    && "BootNotification".equals(request.path("requestedMessage").asText())))
            return "BootNotification";
        if (Set.of("SetChargingProfile", "ClearChargingProfile").contains(action))
            return "ChargingProfileMutation";
        return action;
    }

    static OcppActionDto.Action sameOperation(OcppActionRepository.StoredAction stored,
            UUID siteId, UUID deviceId, String cp, OcppActionDto.ActionRequest request, String requestHash) {
        OcppActionDto.Action a = stored.action();
        if (!stored.siteId().equals(siteId) || !a.deviceId().equals(deviceId)
                || !a.chargePointId().equals(cp) || !a.action().equals(request.action())
                || !stored.requestHash().equals(requestHash))
            throw conflict("Idempotency-Key wurde bereits für ein anderes Ziel oder eine andere Nutzlast verwendet.");
        return a;
    }

    private String requestHash(UUID siteId, UUID deviceId, String cp, String action,
            Integer connectorId, Integer transactionId, JsonNode request) {
        ObjectNode operation = mapper.createObjectNode();
        operation.put("site_id", siteId.toString()); operation.put("device_id", deviceId.toString());
        operation.put("charge_point_id", cp); operation.put("action", action);
        if (connectorId != null) operation.put("connector_id", connectorId);
        if (transactionId != null) operation.put("transaction_id", transactionId);
        operation.set("request", canonical(request == null ? mapper.createObjectNode() : request));
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(mapper.writeValueAsBytes(operation));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (Exception e) { throw new IllegalStateException("OCPP request hash", e); }
    }

    private Integer boundIdentifier(Integer explicit, JsonNode request, String field) {
        Integer inPayload = request != null && request.has(field) && request.path(field).isIntegralNumber()
                ? request.path(field).intValue() : null;
        if (explicit != null && inPayload != null && !explicit.equals(inPayload))
            throw bad(field + " widerspricht der OCPP-Nutzlast.");
        return explicit != null ? explicit : inPayload;
    }

    private JsonNode canonical(JsonNode n) {
        if (n.isObject()) {
            ObjectNode out = mapper.createObjectNode();
            TreeMap<String, JsonNode> fields = new TreeMap<>();
            n.fields().forEachRemaining(e -> fields.put(e.getKey(), e.getValue()));
            fields.forEach((key, value) -> out.set(key, canonical(value)));
            return out;
        }
        if (n.isArray()) {
            var out = mapper.createArrayNode(); n.forEach(v -> out.add(canonical(v))); return out;
        }
        return n.deepCopy();
    }

    private void dispatchLocked(UUID id, UUID tenant, UUID siteId, UUID deviceId, ObjectNode envelope) {
        transactions.executeWithoutResult(status -> {
            var action = actions.lockById(id).orElseThrow();
            if (!"prepared".equals(action.state())) return;
            Instant now = Instant.now();
            if (!now.isBefore(action.deadlineAt())) {
                actions.transition(id, tenant, "system", "transport_failed", "Befehl war vor Zustellung bereits abgelaufen.", now, "none");
                return;
            }
            ProvisioningPublisher p = publisher.getIfAvailable();
            boolean sent = p != null && p.publishOcppCommand(tenant, siteId, deviceId, json(envelope));
            if (sent) actions.transition(id, tenant, "system", "sent", null, Instant.now(), "sent");
            else actions.transition(id, tenant, "system", "transport_failed", "Der Edge-Befehl konnte nicht zugestellt werden.", Instant.now(), "none");
        });
    }
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
