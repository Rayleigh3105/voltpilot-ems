package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.UUID;

/** REST shapes for the OCPP command gateway. */
public final class OcppActionDto {
    private OcppActionDto() {}

    public record ActionRequest(@NotBlank String action, Integer connectorId, Integer transactionId,
            JsonNode request, UUID intentId, String confirmationPhrase) {}

    public record IntentRequest(@NotBlank String action, Integer connectorId, Integer transactionId,
            JsonNode request) {}

    public record Intent(UUID id, String action, String phrase, boolean fourEyes, Instant expiresAt) {}

    public record Action(UUID id, UUID deviceId, String chargePointId, String action, String state,
            String correlationId, String idempotencyKey, String actor, Integer connectorId,
            Integer transactionId, JsonNode request, JsonNode response, String responseStatus,
            JsonNode effect, String reason, Instant preparedAt, Instant sentAt, Instant responseAt,
            Instant effectAt, Instant deadlineAt, Instant updatedAt) {}

    public record Audit(long id, String actor, String state, String reason, UUID deviceId,
            String chargePointId, Integer connectorId, Integer transactionId, Instant occurredAt) {}
}
