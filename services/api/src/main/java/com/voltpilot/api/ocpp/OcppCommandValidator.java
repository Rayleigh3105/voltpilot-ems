package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/** Fail-closed API validation for the complete OCPP 1.6 outbound surface. */
@Component
public final class OcppCommandValidator {
    private record Shape(Set<String> allowed, Set<String> required) {}
    private static final Set<String> EMPTY = Set.of();
    private static final Map<String, Shape> SHAPES = Map.ofEntries(
            e("RemoteStartTransaction", s("connectorId","idTag","chargingProfile"), s("idTag")),
            e("RemoteStopTransaction", s("transactionId"), s("transactionId")),
            e("UnlockConnector", s("connectorId"), s("connectorId")),
            e("SoftReset", EMPTY, EMPTY), e("HardReset", EMPTY, EMPTY),
            e("ChangeAvailability", s("connectorId","type"), s("connectorId","type")),
            e("TriggerMessage", s("requestedMessage","connectorId"), s("requestedMessage")),
            e("GetConfiguration", s("key"), EMPTY),
            e("ChangeConfiguration", s("key","value"), s("key","value")),
            e("ClearCache", EMPTY, EMPTY),
            e("GetDiagnostics", s("location","retries","retryInterval","startTime","stopTime"), s("location")),
            e("UpdateFirmware", s("location","retrieveDate","retries","retryInterval","sha256","signature"), s("location","retrieveDate","sha256","signature")),
            e("ReserveNow", s("connectorId","expiryDate","idTag","reservationId","parentIdTag"), s("connectorId","expiryDate","idTag","reservationId")),
            e("CancelReservation", s("reservationId"), s("reservationId")),
            e("GetLocalListVersion", EMPTY, EMPTY),
            e("SendLocalList", s("listVersion","localAuthorizationList","updateType"), s("listVersion","updateType")),
            e("SetChargingProfile", s("connectorId","csChargingProfiles"), s("connectorId","csChargingProfiles")),
            e("ClearChargingProfile", s("id","connectorId","chargingProfilePurpose","stackLevel"), EMPTY),
            e("GetCompositeSchedule", s("connectorId","duration","chargingRateUnit"), s("connectorId","duration")),
            e("DataTransfer", s("vendorId","messageId","data","schemaId"), s("vendorId","messageId","schemaId")));
    private static final Set<String> INTEGER_FIELDS = s("connectorId","transactionId","retries","retryInterval","reservationId","listVersion","stackLevel","id","duration");
    private static final Set<String> DATE_FIELDS = s("retrieveDate","startTime","stopTime","expiryDate");
    private static final Set<String> CHANGE_CONFIGURATION_ALLOWLIST = s(
            "AllowOfflineTxForUnknownId", "AuthorizationCacheEnabled", "AuthorizeRemoteTxRequests",
            "BlinkRepeat", "ClockAlignedDataInterval", "ConnectionTimeOut", "HeartbeatInterval",
            "LightIntensity", "LocalAuthListEnabled", "LocalAuthorizeOffline", "LocalPreAuthorize",
            "MaxEnergyOnInvalidId", "MeterValueSampleInterval", "MeterValuesAlignedData",
            "MeterValuesSampledData", "MinimumStatusDuration", "StopTransactionOnEVSideDisconnect",
            "StopTransactionOnInvalidId", "StopTxnAlignedData", "StopTxnSampledData",
            "TransactionMessageAttempts", "TransactionMessageRetryInterval", "WebSocketPingInterval");
    private final ObjectMapper mapper;
    private final OcppDataTransferRegistry dataTransfers;

    public OcppCommandValidator(ObjectMapper mapper, OcppDataTransferRegistry dataTransfers) {
        this.mapper = mapper; this.dataTransfers = dataTransfers;
    }

    /** Returns the exact OCPP payload; API-only proof fields are stripped. */
    public JsonNode validate(String action, JsonNode input) {
        Shape shape = SHAPES.get(action);
        if (shape == null) throw new IllegalArgumentException("OCPP-Aktion wird nicht unterstützt.");
        JsonNode request = input == null ? mapper.createObjectNode() : input;
        if (!request.isObject()) throw new IllegalArgumentException("OCPP-Anforderung muss ein JSON-Objekt sein.");
        if (request.toString().length() > 262_144) throw new IllegalArgumentException("OCPP-Anforderung ist zu groß.");
        request.fieldNames().forEachRemaining(field -> {
            if (!shape.allowed().contains(field)) throw new IllegalArgumentException("Unbekanntes Feld für " + action + ": " + field);
        });
        for (String field : shape.required()) if (!request.hasNonNull(field))
            throw new IllegalArgumentException("Pflichtfeld für " + action + " fehlt: " + field);
        request.fields().forEachRemaining(entry -> {
            String field = entry.getKey(); JsonNode value = entry.getValue();
            if (INTEGER_FIELDS.contains(field) && !value.isIntegralNumber()) throw new IllegalArgumentException(field + " muss eine Ganzzahl sein.");
            if (DATE_FIELDS.contains(field) && !value.isTextual()) throw new IllegalArgumentException(field + " muss ein ISO-Zeitpunkt sein.");
        });
        for (String field : DATE_FIELDS) if (request.has(field)) parseInstant(request.path(field).asText(), field);
        positive(request, "connectorId", true); positive(request, "transactionId", false);
        positive(request, "reservationId", false); positive(request, "duration", false);
        if (request.has("idTag") && (!request.path("idTag").isTextual() || request.path("idTag").asText().isBlank() || request.path("idTag").asText().length() > 20))
            throw new IllegalArgumentException("idTag muss 1 bis 20 Zeichen lang sein.");
        if (request.has("key") && !(request.path("key").isArray() || request.path("key").isTextual()))
            throw new IllegalArgumentException("key hat den falschen Typ.");
        if (request.has("type") && !Set.of("Operative","Inoperative").contains(request.path("type").asText()))
            throw new IllegalArgumentException("Availability-Typ ist ungültig.");
        if (request.has("updateType") && !Set.of("Full","Differential").contains(request.path("updateType").asText()))
            throw new IllegalArgumentException("LocalList updateType ist ungültig.");
        if (request.has("requestedMessage") && !Set.of("BootNotification","DiagnosticsStatusNotification","FirmwareStatusNotification","Heartbeat","MeterValues","StatusNotification").contains(request.path("requestedMessage").asText()))
            throw new IllegalArgumentException("TriggerMessage-Typ ist ungültig.");
        if ("ChangeConfiguration".equals(action)
                && !CHANGE_CONFIGURATION_ALLOWLIST.contains(request.path("key").asText()))
            throw new IllegalArgumentException("Konfigurationsschlüssel ist nicht für Remote-Änderungen freigegeben.");
        if ("DataTransfer".equals(action)) return dataTransfers.validateAndProject(request);
        ObjectNode wire = request.deepCopy();
        wire.remove(Set.of("sha256", "signature"));
        return wire;
    }

    private static void positive(JsonNode n, String field, boolean allowZero) {
        if (!n.has(field)) return;
        int value = n.path(field).asInt();
        if (allowZero ? value < 0 : value <= 0) throw new IllegalArgumentException(field + " liegt außerhalb des gültigen Bereichs.");
    }
    private static void parseInstant(String value, String field) {
        try { Instant.parse(value); } catch (DateTimeParseException e) { throw new IllegalArgumentException(field + " ist kein gültiger ISO-Zeitpunkt."); }
    }
    private static Set<String> s(String... values) { return Set.of(values); }
    private static Map.Entry<String, Shape> e(String key, Set<String> allowed, Set<String> required) { return Map.entry(key, new Shape(allowed, required)); }
}
