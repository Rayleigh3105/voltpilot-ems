package com.voltpilot.api.ocpp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.OcppActionDto;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class OcppCommandValidatorTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private OcppCommandValidator validator;

    @BeforeEach
    void setUp() throws Exception {
        var registry = new OcppDataTransferRegistry(mapper);
        registry.load();
        validator = new OcppCommandValidator(mapper, registry);
    }

    @Test
    void profileOwnershipMatchesEdgeVectors() throws Exception {
        var vectors = mapper.readTree(java.nio.file.Path.of("../../docs/contracts/v2/ocpp-profile-ownership-vectors.json").toFile()).path("vectors");
        for (var v : vectors) {
            if (v.path("allowed").asBoolean()) validator.validate(v.path("action").asText(), v.path("request"));
            else assertThatThrownBy(() -> validator.validate(v.path("action").asText(), v.path("request")))
                    .as(v.path("name").asText()).hasMessageContaining("Lastmanagement");
        }
    }

    @Test
    void requiredFieldsAndUnknownFieldsFailBeforeTransport() throws Exception {
        assertThatThrownBy(() -> validator.validate("RemoteStartTransaction", mapper.readTree("{}")))
                .hasMessageContaining("idTag");
        assertThatThrownBy(() -> validator.validate("ClearCache", mapper.readTree("{\"surprise\":true}")))
                .hasMessageContaining("Unbekanntes Feld");
        assertThatThrownBy(() -> validator.validate("TriggerMessage", mapper.readTree("{\"requestedMessage\":\"Magic\"}")))
                .hasMessageContaining("ungültig");
        assertThatThrownBy(() -> validator.validate("ChangeConfiguration",
                mapper.readTree("{\"key\":\"AuthorizationKey\",\"value\":\"must-not-send\"}")))
                .hasMessageContaining("nicht für Remote-Änderungen freigegeben");
    }

    @Test
    void dataTransferIsRegistryBoundAndSchemaIdNeverReachesOcpp() throws Exception {
        var wire = validator.validate("DataTransfer", mapper.readTree("""
                {"schemaId":"voltpilot.health-check.v1","vendorId":"de.voltpilot",
                 "messageId":"HealthCheck","data":{"nonce":"n-1"}}
                """));
        assertThat(wire.has("schemaId")).isFalse();
        assertThat(wire.path("vendorId").asText()).isEqualTo("de.voltpilot");
        assertThatThrownBy(() -> validator.validate("DataTransfer", mapper.readTree("""
                {"schemaId":"voltpilot.health-check.v1","vendorId":"evil.vendor",
                 "messageId":"HealthCheck","data":{"nonce":"n-1"}}
                """))).hasMessageContaining("Vendor/Message");
        assertThatThrownBy(() -> validator.validate("DataTransfer", mapper.readTree("""
                {"schemaId":"unknown.v1","vendorId":"de.voltpilot","messageId":"HealthCheck","data":{}}
                """))).hasMessageContaining("nicht registriert");
        assertThatThrownBy(() -> validator.validate("DataTransfer", mapper.readTree("""
                {"schemaId":"voltpilot.health-check.v1","vendorId":"de.voltpilot",
                 "messageId":"HealthCheck","data":{"nonce":"n-1","freeJson":"blocked"}}
                """))).hasMessageContaining("nicht registriert");
    }

    @Test
    void idempotencyReplayIsBoundToExactTargetAndPayloadHash() {
        UUID site = UUID.randomUUID(), device = UUID.randomUUID(), actionId = UUID.randomUUID();
        var action = new OcppActionDto.Action(actionId, device, "CP-1", "ClearCache", "sent",
                "corr", "idem", "actor", null, null, mapper.createObjectNode(), mapper.createObjectNode(),
                null, mapper.createObjectNode(), null, Instant.now(), Instant.now(), null, null,
                Instant.now().plusSeconds(30), Instant.now());
        var stored = new OcppActionRepository.StoredAction(action, UUID.randomUUID(), site, "hash-a", "ClearCache");
        var request = new OcppActionDto.ActionRequest("ClearCache", null, null, mapper.createObjectNode(), null, null);
        assertThat(OcppActionService.sameOperation(stored, site, device, "CP-1", request, "hash-a")).isSameAs(action);
        assertThatThrownBy(() -> OcppActionService.sameOperation(stored, UUID.randomUUID(), device, "CP-1", request, "hash-a"))
                .hasMessageContaining("anderes Ziel");
        assertThatThrownBy(() -> OcppActionService.sameOperation(stored, site, device, "CP-1", request, "hash-b"))
                .hasMessageContaining("andere Nutzlast");
    }
}
