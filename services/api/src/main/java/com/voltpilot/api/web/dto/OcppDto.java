package com.voltpilot.api.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Read-only API shapes for the Slice-10 OCPP 1.6 data foundation. */
public final class OcppDto {
    private OcppDto() {}

    public record Station(UUID deviceId, String chargePointId, boolean connected,
            Instant connectedAt, Instant disconnectedAt, Instant lastSeen, Instant bootedAt,
            String chargeBoxSerialNumber, String chargePointModel,
            String chargePointSerialNumber, String chargePointVendor, String firmwareVersion,
            String iccid, String imsi, String meterSerialNumber, String meterType,
            String diagnosticsStatus, Instant diagnosticsStatusAt, String firmwareStatus,
            Instant firmwareStatusAt, List<ConnectorState> connectors,
            List<String> supportedFeatureProfiles) {}

    public record ConnectorState(int connectorId, String status, String errorCode, String info,
            String vendorId, String vendorErrorCode, Instant stationTimestamp,
            Instant reportedAt) {}

    public record ProtocolEvent(UUID eventId, Instant occurredAt, UUID deviceId,
            String chargePointId, String direction, String messageType, String correlationId,
            String action, String errorCode, String errorDescription, JsonNode errorDetails,
            JsonNode payload) {}

    public record Transaction(UUID deviceId, String chargePointId, int transactionId,
            int connectorId, Instant startedAt, Instant stoppedAt, long meterStart,
            Long meterStop, String stopReason, String startIdTagRef, String stopIdTagRef,
            Integer reservationId, Integer chargingProfileId, String chargingProfilePurpose,
            String startAuthStatus, String stopAuthStatus, String parentIdTagRef,
            JsonNode transactionData, Instant transactionDataPurgedAt) {}

    public record MeterSample(Instant sampledAt, UUID eventId, int meterValueIndex,
            int sampledValueIndex, UUID deviceId, String chargePointId, int connectorId,
            Integer transactionId, String source, String pointKey, String measurand,
            String context, String format, String phase, String location, String unit,
            String value, Double numericValue) {}

    public record ConfigurationKey(String key, String value, boolean readonly, boolean secret,
            boolean redacted, boolean standardKey, boolean meaningKnown, Instant reportedAt) {}

    public record Configuration(UUID deviceId, String chargePointId,
            List<ConfigurationKey> keys, List<String> unknownKeys,
            List<String> supportedFeatureProfiles) {}

    /** D4 is data in this slice: the dependent command PR consumes this map. */
    public record ActionPermissions(Map<String, Boolean> actions) {}
}
