package com.voltpilot.api.ocpp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.OcppDto;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/** Persistence and read model for the complete OCPP 1.6 event foundation. */
@Repository
public class OcppRepository {
    private static final Set<String> STATUSES = Set.of("Available", "Preparing", "Charging",
            "SuspendedEVSE", "SuspendedEV", "Finishing", "Reserved", "Unavailable", "Faulted");
    private static final Set<String> ERRORS = Set.of("ConnectorLockFailure", "EVCommunicationError",
            "GroundFailure", "HighTemperature", "InternalError", "LocalListConflict", "NoError",
            "OtherError", "OverCurrentFailure", "OverVoltage", "PowerMeterFailure",
            "PowerSwitchFailure", "ReaderFailure", "ResetFailure", "UnderVoltage", "WeakSignal");

    /** A5's standard configuration keys. Anything else remains visible as a vendor key. */
    private static final Set<String> STANDARD_CONFIGURATION_KEYS = Set.of(
            "AllowOfflineTxForUnknownId", "AuthorizationCacheEnabled", "AuthorizeRemoteTxRequests",
            "BlinkRepeat", "ClockAlignedDataInterval", "ConnectionTimeOut", "ConnectorPhaseRotation",
            "ConnectorPhaseRotationMaxLength", "GetConfigurationMaxKeys", "HeartbeatInterval",
            "LightIntensity", "LocalAuthorizeOffline", "LocalPreAuthorize", "MaxEnergyOnInvalidId",
            "MeterValuesAlignedData", "MeterValuesAlignedDataMaxLength", "MeterValuesSampledData",
            "MeterValuesSampledDataMaxLength", "MeterValueSampleInterval", "MinimumStatusDuration",
            "NumberOfConnectors", "ResetRetries", "StopTransactionOnEVSideDisconnect",
            "StopTransactionOnInvalidId", "StopTxnAlignedData", "StopTxnAlignedDataMaxLength",
            "StopTxnSampledData", "StopTxnSampledDataMaxLength", "SupportedFeatureProfiles",
            "SupportedFeatureProfilesMaxLength", "TransactionMessageAttempts",
            "TransactionMessageRetryInterval", "UnlockConnectorOnEVSideDisconnect",
            "WebSocketPingInterval", "LocalAuthListEnabled", "LocalAuthListMaxLength",
            "SendLocalListMaxLength", "ReserveConnectorZeroSupported", "ChargeProfileMaxStackLevel",
            "ChargingScheduleAllowedChargingRateUnit", "ChargingScheduleMaxPeriods",
            "ConnectorSwitch3to1PhaseSupported", "MaxChargingProfilesInstalled",
            "CentralContractValidationAllowed", "CertificateSignedMaxChainSize",
            "CertSigningWaitMinimum", "CertSigningRepeatTimes", "CertificateStoreMaxLength",
            "ContractValidationOffline", "ISO15118PnCEnabled", "AdditionalRootCertificateCheck",
            "AuthorizationKey", "CpoName", "SecurityProfile");

    private final JdbcTemplate jdbc;
    private final OcppPrivacy privacy;
    private final ObjectMapper mapper;

    public OcppRepository(JdbcTemplate jdbc, OcppPrivacy privacy, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.privacy = privacy;
        this.mapper = mapper;
    }

    /** Idempotently stores one edge-journal envelope and derives its read models. */
    @Transactional
    public boolean ingest(UUID tenantId, UUID siteId, UUID deviceId, JsonNode envelope) {
        if (!"1.0".equals(envelope.path("schema_version").asText())) {
            return false;
        }
        UUID eventId = uuid(envelope, "event_id");
        Instant occurredAt = instant(envelope, "occurred_at", null);
        String chargePointId = text(envelope, "charge_point_id");
        String direction = text(envelope, "direction");
        String messageType = text(envelope, "message_type");
        String action = text(envelope, "action");
        if (eventId == null || occurredAt == null || chargePointId == null || chargePointId.isBlank()
                || !Set.of("station_to_csms", "csms_to_station", "internal").contains(direction)
                || !Set.of("Call", "CallResult", "CallError", "Event").contains(messageType)
                || action == null || action.isBlank()) {
            return false;
        }
        String correlation = nullableText(envelope, "correlation_id");
        JsonNode payload = privacy.redact(envelope.path("payload"), action);
        JsonNode errorDetails = privacy.redact(envelope.path("error_details"), action);
        String errorDescription = privacy.redactErrorDescription(
                nullableText(envelope, "error_description"));
        int inserted = jdbc.update("INSERT INTO ocpp_protocol_event (occurred_at, event_id, tenant_id, "
                        + "site_id, device_id, charge_point_id, direction, message_type, correlation_id, "
                        + "action, error_code, error_description, error_details, payload) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb) "
                        + "ON CONFLICT (event_id, occurred_at) DO NOTHING",
                Timestamp.from(occurredAt), eventId, tenantId, siteId, deviceId, chargePointId,
                direction, messageType, correlation, action, nullableText(envelope, "error_code"),
                errorDescription, json(errorDetails), json(payload));
        if (inserted == 0) {
            return false;
        }

        if ("station_to_csms".equals(direction)
                || ("internal".equals(direction) && !"JournalGap".equals(action))) {
            touchStation(tenantId, siteId, deviceId, chargePointId, occurredAt);
        }
        if ("Event".equals(messageType)) {
            connectionEvent(tenantId, siteId, deviceId, chargePointId, action, occurredAt);
            return true;
        }
        if ("Call".equals(messageType) && "station_to_csms".equals(direction)) {
            switch (action) {
                case "BootNotification" -> boot(tenantId, siteId, deviceId, chargePointId,
                        occurredAt, payload);
                case "StatusNotification" -> status(tenantId, siteId, deviceId, chargePointId,
                        eventId, occurredAt, payload);
                case "Authorize" -> authorizeCall(tenantId, siteId, deviceId, chargePointId,
                        eventId, correlation, occurredAt, payload);
                case "MeterValues" -> meterValues(tenantId, siteId, deviceId, chargePointId,
                        eventId, occurredAt, payload, "MeterValues", payload.path("connectorId").asInt(0),
                        nullableInt(payload, "transactionId"));
                case "StopTransaction" -> stopTransaction(tenantId, siteId, deviceId,
                        chargePointId, eventId, occurredAt, payload);
                case "DiagnosticsStatusNotification" -> stationStatus(tenantId, siteId, deviceId,
                        chargePointId, eventId, occurredAt, "diagnostics", payload.path("status").asText());
                case "FirmwareStatusNotification" -> stationStatus(tenantId, siteId, deviceId,
                        chargePointId, eventId, occurredAt, "firmware", payload.path("status").asText());
                default -> { /* protocol journal remains the complete source */ }
            }
        } else if ("Call".equals(messageType) && "csms_to_station".equals(direction)
                && "SetChargingProfile".equals(action)) {
            linkChargingProfile(deviceId, chargePointId, payload, occurredAt);
        } else if ("CallResult".equals(messageType)) {
            if ("StartTransaction".equals(action) && "csms_to_station".equals(direction)) {
                startTransactionResult(tenantId, siteId, deviceId, chargePointId, correlation,
                        occurredAt, payload);
            } else if ("Authorize".equals(action) && "csms_to_station".equals(direction)) {
                authorizeResult(deviceId, chargePointId, correlation, payload);
            } else if ("StopTransaction".equals(action) && "csms_to_station".equals(direction)) {
                stopTransactionResult(deviceId, chargePointId, correlation, payload);
            } else if ("GetConfiguration".equals(action) && "station_to_csms".equals(direction)) {
                configurationResult(tenantId, siteId, deviceId, chargePointId, eventId,
                        correlation, occurredAt, payload);
            }
        }
        return true;
    }

    /**
     * Existing edge Smart-Charging calls are already on the journal. Linking
     * their TxProfile to the station-originated transaction is derivation only:
     * no new command path and no station call is introduced by this service.
     */
    private void linkChargingProfile(UUID deviceId, String cp, JsonNode payload, Instant at) {
        JsonNode profile = payload.path("csChargingProfiles");
        Integer transactionId = nullableInt(profile, "transactionId");
        Integer profileId = nullableInt(profile, "chargingProfileId");
        String purpose = nullableText(profile, "chargingProfilePurpose");
        if (transactionId == null || profileId == null) return;
        jdbc.update("UPDATE ocpp_transaction SET charging_profile_id=?, "
                        + "charging_profile_purpose=?, updated_at=GREATEST(updated_at, ?) "
                        + "WHERE device_id=? AND charge_point_id=? AND transaction_id=?",
                profileId, purpose, Timestamp.from(at), deviceId, cp, transactionId);
    }

    private void touchStation(UUID tenantId, UUID siteId, UUID deviceId, String cp, Instant at) {
        jdbc.update("INSERT INTO ocpp_station (device_id, charge_point_id, tenant_id, site_id, "
                        + "last_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (device_id, charge_point_id) DO UPDATE SET "
                        + "last_seen = GREATEST(ocpp_station.last_seen, excluded.last_seen), "
                        + "updated_at = GREATEST(ocpp_station.updated_at, excluded.updated_at)",
                deviceId, cp, tenantId, siteId, Timestamp.from(at), Timestamp.from(at));
    }

    private void connectionEvent(UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String action, Instant at) {
        if ("Connected".equals(action)) {
            jdbc.update("UPDATE ocpp_station SET connected = true, connected_at = ?, last_seen = ?, "
                    + "updated_at = ? WHERE device_id = ? AND charge_point_id = ?",
                    Timestamp.from(at), Timestamp.from(at), Timestamp.from(at), deviceId, cp);
        } else if ("Disconnected".equals(action)) {
            jdbc.update("UPDATE ocpp_station SET connected = false, disconnected_at = ?, updated_at = ? "
                    + "WHERE device_id = ? AND charge_point_id = ?",
                    Timestamp.from(at), Timestamp.from(at), deviceId, cp);
        }
    }

    private void boot(UUID tenantId, UUID siteId, UUID deviceId, String cp, Instant at,
            JsonNode p) {
        jdbc.update("UPDATE ocpp_station SET connected = true, booted_at = ?, last_seen = ?, "
                        + "charge_box_serial_number = ?, charge_point_model = ?, "
                        + "charge_point_serial_number = ?, charge_point_vendor = ?, firmware_version = ?, "
                        + "iccid = ?, imsi = ?, meter_serial_number = ?, meter_type = ?, updated_at = ? "
                        + "WHERE device_id = ? AND charge_point_id = ?",
                Timestamp.from(at), Timestamp.from(at), nullableText(p, "chargeBoxSerialNumber"),
                nullableText(p, "chargePointModel"), nullableText(p, "chargePointSerialNumber"),
                nullableText(p, "chargePointVendor"), nullableText(p, "firmwareVersion"),
                nullableText(p, "iccid"), nullableText(p, "imsi"),
                nullableText(p, "meterSerialNumber"), nullableText(p, "meterType"),
                Timestamp.from(at), deviceId, cp);
    }

    private void status(UUID tenantId, UUID siteId, UUID deviceId, String cp, UUID eventId,
            Instant at, JsonNode p) {
        String status = p.path("status").asText();
        String error = p.path("errorCode").asText();
        if (!STATUSES.contains(status) || !ERRORS.contains(error)) {
            return;
        }
        int connector = p.path("connectorId").asInt(-1);
        if (connector < 0) {
            return;
        }
        Instant stationAt = instant(p, "timestamp", null);
        jdbc.update("INSERT INTO ocpp_connector_status_event (occurred_at, event_id, tenant_id, "
                        + "site_id, device_id, charge_point_id, connector_id, status, error_code, info, "
                        + "vendor_id, vendor_error_code, station_timestamp) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                Timestamp.from(stationAt == null ? at : stationAt), eventId, tenantId, siteId,
                deviceId, cp, connector, status, error, nullableText(p, "info"),
                nullableText(p, "vendorId"), nullableText(p, "vendorErrorCode"), ts(stationAt));
        jdbc.update("INSERT INTO ocpp_connector_state (device_id, charge_point_id, connector_id, "
                        + "tenant_id, site_id, status, error_code, info, vendor_id, vendor_error_code, "
                        + "station_timestamp, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (device_id, charge_point_id, connector_id) DO UPDATE SET "
                        + "status=excluded.status, error_code=excluded.error_code, info=excluded.info, "
                        + "vendor_id=excluded.vendor_id, vendor_error_code=excluded.vendor_error_code, "
                        + "station_timestamp=excluded.station_timestamp, reported_at=excluded.reported_at",
                deviceId, cp, connector, tenantId, siteId, status, error, nullableText(p, "info"),
                nullableText(p, "vendorId"), nullableText(p, "vendorErrorCode"), ts(stationAt),
                Timestamp.from(at));
    }

    private void authorizeCall(UUID tenantId, UUID siteId, UUID deviceId, String cp, UUID eventId,
            String correlation, Instant at, JsonNode p) {
        String ref = nullableText(p, "idTag");
        if (ref == null || correlation == null) return;
        jdbc.update("INSERT INTO ocpp_authorization_event (occurred_at, event_id, tenant_id, site_id, "
                        + "device_id, charge_point_id, correlation_id, id_tag_ref) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", Timestamp.from(at), eventId, tenantId,
                siteId, deviceId, cp, correlation, ref);
    }

    private void authorizeResult(UUID deviceId, String cp, String correlation, JsonNode p) {
        JsonNode info = p.path("idTagInfo");
        jdbc.update("UPDATE ocpp_authorization_event SET status=?, expiry_date=?, parent_id_tag_ref=? "
                        + "WHERE device_id=? AND charge_point_id=? AND correlation_id=?",
                nullableText(info, "status"), ts(instant(info, "expiryDate", null)),
                nullableText(info, "parentIdTag"), deviceId, cp, correlation);
    }

    private void startTransactionResult(UUID tenantId, UUID siteId, UUID deviceId, String cp,
            String correlation, Instant resultAt, JsonNode result) {
        PairedCall call = pairedCall(deviceId, cp, correlation, "station_to_csms");
        Integer transactionId = nullableInt(result, "transactionId");
        if (call == null || transactionId == null) return;
        JsonNode p = call.payload();
        Instant started = instant(p, "timestamp", call.occurredAt());
        JsonNode info = result.path("idTagInfo");
        jdbc.update("INSERT INTO ocpp_transaction (device_id, charge_point_id, transaction_id, tenant_id, "
                        + "site_id, connector_id, started_at, meter_start, start_id_tag_ref, reservation_id, "
                        + "start_auth_status, parent_id_tag_ref, start_event_id, updated_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (device_id, charge_point_id, transaction_id) DO UPDATE SET "
                        + "connector_id=excluded.connector_id, started_at=excluded.started_at, "
                        + "meter_start=excluded.meter_start, start_id_tag_ref=excluded.start_id_tag_ref, "
                        + "reservation_id=excluded.reservation_id, start_auth_status=excluded.start_auth_status, "
                        + "parent_id_tag_ref=excluded.parent_id_tag_ref, start_event_id=excluded.start_event_id, "
                        + "updated_at=excluded.updated_at",
                deviceId, cp, transactionId, tenantId, siteId, p.path("connectorId").asInt(0),
                Timestamp.from(started), p.path("meterStart").asLong(), nullableText(p, "idTag"),
                nullableInt(p, "reservationId"), nullableText(info, "status"),
                nullableText(info, "parentIdTag"), call.eventId(), Timestamp.from(resultAt));
    }

    private void stopTransaction(UUID tenantId, UUID siteId, UUID deviceId, String cp, UUID eventId,
            Instant at, JsonNode p) {
        Integer tx = nullableInt(p, "transactionId");
        if (tx == null) return;
        Instant stopped = instant(p, "timestamp", at);
        String reason = nullableText(p, "reason");
        if (reason == null) reason = "Local";
        int updated = jdbc.update("UPDATE ocpp_transaction SET stopped_at=?, meter_stop=?, stop_reason=?, "
                        + "stop_id_tag_ref=?, transaction_data=?::jsonb, stop_event_id=?, updated_at=? "
                        + "WHERE device_id=? AND charge_point_id=? AND transaction_id=?",
                Timestamp.from(stopped), p.path("meterStop").asLong(), reason, nullableText(p, "idTag"),
                json(p.path("transactionData")), eventId, Timestamp.from(at), deviceId, cp, tx);
        if (updated == 0) {
            jdbc.update("INSERT INTO ocpp_transaction (device_id, charge_point_id, transaction_id, "
                            + "tenant_id, site_id, connector_id, started_at, stopped_at, meter_start, meter_stop, "
                            + "stop_reason, stop_id_tag_ref, transaction_data, stop_event_id, updated_at) "
                            + "VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?::jsonb, ?, ?)",
                    deviceId, cp, tx, tenantId, siteId, Timestamp.from(stopped), Timestamp.from(stopped),
                    p.path("meterStop").asLong(), reason, nullableText(p, "idTag"),
                    json(p.path("transactionData")), eventId, Timestamp.from(at));
        }
        meterValues(tenantId, siteId, deviceId, cp, eventId, at, p, "TransactionData",
                connectorForTransaction(deviceId, cp, tx), tx);
    }

    private void stopTransactionResult(UUID deviceId, String cp, String correlation, JsonNode p) {
        PairedCall call = pairedCall(deviceId, cp, correlation, "station_to_csms");
        if (call == null) return;
        Integer tx = nullableInt(call.payload(), "transactionId");
        if (tx == null) return;
        JsonNode info = p.path("idTagInfo");
        jdbc.update("UPDATE ocpp_transaction SET stop_auth_status=?, parent_id_tag_ref=COALESCE(?, parent_id_tag_ref) "
                        + "WHERE device_id=? AND charge_point_id=? AND transaction_id=?",
                nullableText(info, "status"), nullableText(info, "parentIdTag"), deviceId, cp, tx);
    }

    private int connectorForTransaction(UUID deviceId, String cp, int tx) {
        List<Integer> rows = jdbc.query("SELECT connector_id FROM ocpp_transaction WHERE device_id=? "
                        + "AND charge_point_id=? AND transaction_id=?", (rs, n) -> rs.getInt(1),
                deviceId, cp, tx);
        return rows.isEmpty() ? 0 : rows.get(0);
    }

    private void meterValues(UUID tenantId, UUID siteId, UUID deviceId, String cp, UUID eventId,
            Instant receivedAt, JsonNode payload, String source, int connectorId, Integer transactionId) {
        JsonNode values = "TransactionData".equals(source) ? payload.path("transactionData")
                : payload.path("meterValue");
        if (!values.isArray()) return;
        int mi = 0;
        for (JsonNode meter : values) {
            Instant sampledAt = instant(meter, "timestamp", receivedAt);
            JsonNode samples = meter.path("sampledValue");
            if (!samples.isArray()) { mi++; continue; }
            int si = 0;
            for (JsonNode sample : samples) {
                String measurand = defaultText(sample, "measurand", "Energy.Active.Import.Register");
                String context = defaultText(sample, "context", "Sample.Periodic");
                String format = defaultText(sample, "format", "Raw");
                String phase = defaultText(sample, "phase", "None");
                String location = defaultText(sample, "location", "Outlet");
                String unit = defaultText(sample, "unit", "Wh");
                String value = sample.path("value").asText("");
                Double numeric = "Raw".equals(format) ? finiteDouble(value) : null;
                String pointKey = pointKey(measurand, context, format, phase, location, unit);
                jdbc.update("INSERT INTO ocpp_meter_sample (sampled_at, event_id, meter_value_index, "
                                + "sampled_value_index, tenant_id, site_id, device_id, charge_point_id, "
                                + "connector_id, transaction_id, source, point_key, measurand, context, "
                                + "value_format, phase, location, unit, value_text, value_numeric, received_at) "
                                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                                + "ON CONFLICT DO NOTHING",
                        Timestamp.from(sampledAt), eventId, mi, si, tenantId, siteId, deviceId, cp,
                        connectorId, transactionId, source, pointKey, measurand, context, format,
                        phase, location, unit, value, numeric, Timestamp.from(receivedAt));
                si++;
            }
            mi++;
        }
    }

    private void stationStatus(UUID tenantId, UUID siteId, UUID deviceId, String cp, UUID eventId,
            Instant at, String kind, String status) {
        if (status == null || status.isBlank()) return;
        jdbc.update("INSERT INTO ocpp_station_status_event (occurred_at, event_id, tenant_id, site_id, "
                        + "device_id, charge_point_id, status_kind, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                Timestamp.from(at), eventId, tenantId, siteId, deviceId, cp, kind, status);
        String column = "diagnostics".equals(kind) ? "diagnostics" : "firmware";
        jdbc.update("UPDATE ocpp_station SET " + column + "_status=?, " + column
                        + "_status_at=?, updated_at=? WHERE device_id=? AND charge_point_id=?",
                status, Timestamp.from(at), Timestamp.from(at), deviceId, cp);
    }

    private void configurationResult(UUID tenantId, UUID siteId, UUID deviceId, String cp,
            UUID eventId, String correlation, Instant at, JsonNode payload) {
        PairedCall call = pairedCall(deviceId, cp, correlation, "csms_to_station");
        JsonNode requested = call == null ? null : call.payload().path("key");
        boolean full = requested == null || requested.isMissingNode() || !requested.isArray()
                || requested.isEmpty();
        if (full) {
            jdbc.update("DELETE FROM ocpp_configuration_key WHERE device_id=? AND charge_point_id=?", deviceId, cp);
            jdbc.update("DELETE FROM ocpp_configuration_unknown_key WHERE device_id=? AND charge_point_id=?", deviceId, cp);
            jdbc.update("DELETE FROM ocpp_station_capability WHERE device_id=? AND charge_point_id=?", deviceId, cp);
        }
        JsonNode keys = payload.path("configurationKey");
        if (keys.isArray()) {
            for (JsonNode key : keys) {
                String name = nullableText(key, "key");
                if (name == null || name.isBlank()) continue;
                boolean secret = OcppPrivacy.isSecretConfigurationKey(name);
                String value = secret ? null : nullableText(key, "value");
                boolean redacted = secret || key.path("redacted").asBoolean(false);
                boolean standard = STANDARD_CONFIGURATION_KEYS.contains(name);
                jdbc.update("INSERT INTO ocpp_configuration_key (device_id, charge_point_id, "
                                + "configuration_key, tenant_id, site_id, value, readonly, secret, redacted, "
                                + "standard_key, meaning_known, reported_at, source_event_id) "
                                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                                + "ON CONFLICT (device_id, charge_point_id, configuration_key) DO UPDATE SET "
                                + "value=excluded.value, readonly=excluded.readonly, secret=excluded.secret, "
                                + "redacted=excluded.redacted, standard_key=excluded.standard_key, "
                                + "meaning_known=excluded.meaning_known, reported_at=excluded.reported_at, "
                                + "source_event_id=excluded.source_event_id",
                        deviceId, cp, name, tenantId, siteId, value, key.path("readonly").asBoolean(),
                        secret, redacted, standard, standard, Timestamp.from(at), eventId);
                jdbc.update("DELETE FROM ocpp_configuration_unknown_key WHERE device_id=? "
                        + "AND charge_point_id=? AND configuration_key=?", deviceId, cp, name);
                if ("SupportedFeatureProfiles".equals(name) && value != null) {
                    if (!full) {
                        jdbc.update("DELETE FROM ocpp_station_capability WHERE device_id=? AND charge_point_id=?",
                                deviceId, cp);
                    }
                    for (String profile : value.split(",")) {
                        String p = profile.trim();
                        if (!p.isEmpty()) {
                            jdbc.update("INSERT INTO ocpp_station_capability (device_id, charge_point_id, "
                                            + "feature_profile, tenant_id, site_id, reported_at, source_event_id) "
                                            + "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, charge_point_id, "
                                            + "feature_profile) DO UPDATE SET supported=true, reported_at=excluded.reported_at, "
                                            + "source_event_id=excluded.source_event_id",
                                    deviceId, cp, p, tenantId, siteId, Timestamp.from(at), eventId);
                        }
                    }
                }
            }
        }
        JsonNode unknown = payload.path("unknownKey");
        if (unknown.isArray()) {
            for (JsonNode item : unknown) {
                String name = item.asText("").trim();
                if (name.isEmpty()) continue;
                jdbc.update("DELETE FROM ocpp_configuration_key WHERE device_id=? AND charge_point_id=? "
                        + "AND configuration_key=?", deviceId, cp, name);
                jdbc.update("INSERT INTO ocpp_configuration_unknown_key (device_id, charge_point_id, "
                                + "configuration_key, tenant_id, site_id, reported_at, source_event_id) "
                                + "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, charge_point_id, "
                                + "configuration_key) DO UPDATE SET reported_at=excluded.reported_at, "
                                + "source_event_id=excluded.source_event_id",
                        deviceId, cp, name, tenantId, siteId, Timestamp.from(at), eventId);
            }
        }
    }

    private PairedCall pairedCall(UUID deviceId, String cp, String correlation, String direction) {
        if (correlation == null) return null;
        List<PairedCall> calls = jdbc.query("SELECT event_id, occurred_at, payload::text FROM "
                        + "ocpp_protocol_event WHERE device_id=? AND charge_point_id=? AND correlation_id=? "
                        + "AND direction=? AND message_type='Call' ORDER BY occurred_at DESC LIMIT 1",
                (rs, n) -> new PairedCall(UUID.fromString(rs.getString(1)),
                        rs.getTimestamp(2).toInstant(), parse(rs.getString(3))),
                deviceId, cp, correlation, direction);
        return calls.isEmpty() ? null : calls.get(0);
    }

    private record PairedCall(UUID eventId, Instant occurredAt, JsonNode payload) {}

    // ---- tenant-scoped read API -------------------------------------------

    public List<OcppDto.Station> stations(UUID siteId) {
        List<OcppDto.Station> out = jdbc.query("SELECT * FROM ocpp_station WHERE site_id=? "
                        + "ORDER BY charge_point_id", (rs, n) -> station(rs, siteId), siteId);
        return out;
    }

    private OcppDto.Station station(ResultSet rs, UUID siteId) throws SQLException {
        UUID deviceId = UUID.fromString(rs.getString("device_id"));
        String cp = rs.getString("charge_point_id");
        List<OcppDto.ConnectorState> connectors = jdbc.query("SELECT * FROM ocpp_connector_state "
                        + "WHERE device_id=? AND charge_point_id=? ORDER BY connector_id",
                (c, n) -> new OcppDto.ConnectorState(c.getInt("connector_id"), c.getString("status"),
                        c.getString("error_code"), c.getString("info"), c.getString("vendor_id"),
                        c.getString("vendor_error_code"), instant(c, "station_timestamp"),
                        instant(c, "reported_at")), deviceId, cp);
        List<String> profiles = jdbc.query("SELECT feature_profile FROM ocpp_station_capability "
                        + "WHERE device_id=? AND charge_point_id=? AND supported ORDER BY feature_profile",
                (c, n) -> c.getString(1), deviceId, cp);
        return new OcppDto.Station(deviceId, cp, rs.getBoolean("connected"),
                instant(rs, "connected_at"), instant(rs, "disconnected_at"),
                instant(rs, "last_seen"), instant(rs, "booted_at"),
                rs.getString("charge_box_serial_number"), rs.getString("charge_point_model"),
                rs.getString("charge_point_serial_number"), rs.getString("charge_point_vendor"),
                rs.getString("firmware_version"), rs.getString("iccid"), rs.getString("imsi"),
                rs.getString("meter_serial_number"), rs.getString("meter_type"),
                rs.getString("diagnostics_status"), instant(rs, "diagnostics_status_at"),
                rs.getString("firmware_status"), instant(rs, "firmware_status_at"), connectors, profiles);
    }

    public List<OcppDto.ProtocolEvent> events(UUID siteId, Instant from, Instant to,
            String action, String messageType, int limit) {
        StringBuilder sql = new StringBuilder("SELECT * FROM ocpp_protocol_event WHERE site_id=?");
        List<Object> args = new ArrayList<>(List.of(siteId));
        if (from != null) { sql.append(" AND occurred_at>=?"); args.add(Timestamp.from(from)); }
        if (to != null) { sql.append(" AND occurred_at<?"); args.add(Timestamp.from(to)); }
        if (action != null && !action.isBlank()) { sql.append(" AND action=?"); args.add(action); }
        if (messageType != null && !messageType.isBlank()) { sql.append(" AND message_type=?"); args.add(messageType); }
        sql.append(" ORDER BY occurred_at DESC LIMIT ?"); args.add(Math.max(1, Math.min(limit, 1000)));
        return jdbc.query(sql.toString(), (rs, n) -> new OcppDto.ProtocolEvent(
                UUID.fromString(rs.getString("event_id")), instant(rs, "occurred_at"),
                UUID.fromString(rs.getString("device_id")), rs.getString("charge_point_id"),
                rs.getString("direction"), rs.getString("message_type"), rs.getString("correlation_id"),
                rs.getString("action"), rs.getString("error_code"), rs.getString("error_description"),
                parse(rs.getString("error_details")), parse(rs.getString("payload"))), args.toArray());
    }

    public List<OcppDto.DataGap> gaps(UUID siteId, int limit) {
        return jdbc.query("SELECT event_id, occurred_at, device_id, payload FROM ocpp_protocol_event "
                        + "WHERE site_id=? AND message_type='Event' AND action='JournalGap' "
                        + "ORDER BY occurred_at DESC LIMIT ?",
                (rs, n) -> {
                    JsonNode payload = parse(rs.getString("payload"));
                    Map<String, Long> reasons = new LinkedHashMap<>();
                    JsonNode reasonNode = payload.path("reasons");
                    if (reasonNode.isObject()) {
                        reasonNode.fields().forEachRemaining(e -> reasons.put(e.getKey(), e.getValue().asLong()));
                    }
                    return new OcppDto.DataGap(UUID.fromString(rs.getString("event_id")),
                            instant(rs, "occurred_at"), UUID.fromString(rs.getString("device_id")),
                            payload.path("dropped_count").asLong(), payload.path("total_dropped").asLong(),
                            parseInstant(payload.path("first_occurred_at").asText()),
                            parseInstant(payload.path("last_occurred_at").asText()),
                            payload.path("first_event_id").asText(null),
                            payload.path("last_event_id").asText(null), reasons);
                }, siteId, Math.max(1, Math.min(limit, 1000)));
    }

    public List<OcppDto.Transaction> transactions(UUID siteId, int limit) {
        return jdbc.query("SELECT * FROM ocpp_transaction WHERE site_id=? ORDER BY started_at DESC LIMIT ?",
                (rs, n) -> new OcppDto.Transaction(UUID.fromString(rs.getString("device_id")),
                        rs.getString("charge_point_id"), rs.getInt("transaction_id"),
                        rs.getInt("connector_id"), instant(rs, "started_at"), instant(rs, "stopped_at"),
                        rs.getLong("meter_start"), nullableLong(rs, "meter_stop"), rs.getString("stop_reason"),
                        rs.getString("start_id_tag_ref"), rs.getString("stop_id_tag_ref"),
                        nullableInt(rs, "reservation_id"), nullableInt(rs, "charging_profile_id"),
                        rs.getString("charging_profile_purpose"), rs.getString("start_auth_status"),
                        rs.getString("stop_auth_status"), rs.getString("parent_id_tag_ref"),
                        parse(rs.getString("transaction_data")), instant(rs, "transaction_data_purged_at")),
                siteId, Math.max(1, Math.min(limit, 1000)));
    }

    public List<OcppDto.MeterSample> meterSamples(UUID siteId, Instant from, Instant to,
            String pointKey, Integer transactionId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT * FROM ocpp_meter_sample WHERE site_id=?");
        List<Object> args = new ArrayList<>(List.of(siteId));
        if (from != null) { sql.append(" AND sampled_at>=?"); args.add(Timestamp.from(from)); }
        if (to != null) { sql.append(" AND sampled_at<?"); args.add(Timestamp.from(to)); }
        if (pointKey != null && !pointKey.isBlank()) { sql.append(" AND point_key=?"); args.add(pointKey); }
        if (transactionId != null) { sql.append(" AND transaction_id=?"); args.add(transactionId); }
        sql.append(" ORDER BY sampled_at DESC, meter_value_index, sampled_value_index LIMIT ?");
        args.add(Math.max(1, Math.min(limit, 5000)));
        return jdbc.query(sql.toString(), (rs, n) -> new OcppDto.MeterSample(
                instant(rs, "sampled_at"), UUID.fromString(rs.getString("event_id")),
                rs.getInt("meter_value_index"), rs.getInt("sampled_value_index"),
                UUID.fromString(rs.getString("device_id")), rs.getString("charge_point_id"),
                rs.getInt("connector_id"), nullableInt(rs, "transaction_id"), rs.getString("source"),
                rs.getString("point_key"), rs.getString("measurand"), rs.getString("context"),
                rs.getString("value_format"), rs.getString("phase"), rs.getString("location"),
                rs.getString("unit"), rs.getString("value_text"), nullableDouble(rs, "value_numeric")),
                args.toArray());
    }

    public List<OcppDto.Configuration> configurations(UUID siteId, String onlyChargePoint) {
        // Start from the union: a valid GetConfiguration response may contain
        // only unknownKey entries (or only the derived feature profiles). Such
        // a station must not disappear from the inventory merely because it
        // did not return a known configuration value.
        String sql = "SELECT DISTINCT device_id, charge_point_id FROM ("
                + "SELECT device_id, charge_point_id, site_id FROM ocpp_configuration_key UNION ALL "
                + "SELECT device_id, charge_point_id, site_id FROM ocpp_configuration_unknown_key UNION ALL "
                + "SELECT device_id, charge_point_id, site_id FROM ocpp_station_capability"
                + ") inventory WHERE site_id=?"
                + (onlyChargePoint == null ? "" : " AND charge_point_id=?")
                + " ORDER BY charge_point_id";
        Object[] args = onlyChargePoint == null ? new Object[]{siteId} : new Object[]{siteId, onlyChargePoint};
        return jdbc.query(sql, (rs, n) -> configuration(UUID.fromString(rs.getString(1)), rs.getString(2)), args);
    }

    private OcppDto.Configuration configuration(UUID deviceId, String cp) {
        List<OcppDto.ConfigurationKey> keys = jdbc.query("SELECT * FROM ocpp_configuration_key "
                        + "WHERE device_id=? AND charge_point_id=? ORDER BY configuration_key",
                (rs, n) -> new OcppDto.ConfigurationKey(rs.getString("configuration_key"),
                        // Belt-and-suspenders: a secret is NULL in the DB and is
                        // suppressed again here, so it can never be rendered.
                        rs.getBoolean("secret") ? null : rs.getString("value"),
                        rs.getBoolean("readonly"), rs.getBoolean("secret"),
                        rs.getBoolean("redacted"), rs.getBoolean("standard_key"),
                        rs.getBoolean("meaning_known"), instant(rs, "reported_at")), deviceId, cp);
        List<String> unknown = jdbc.query("SELECT configuration_key FROM ocpp_configuration_unknown_key "
                        + "WHERE device_id=? AND charge_point_id=? ORDER BY configuration_key",
                (rs, n) -> rs.getString(1), deviceId, cp);
        List<String> profiles = jdbc.query("SELECT feature_profile FROM ocpp_station_capability "
                        + "WHERE device_id=? AND charge_point_id=? AND supported ORDER BY feature_profile",
                (rs, n) -> rs.getString(1), deviceId, cp);
        return new OcppDto.Configuration(deviceId, cp, keys, unknown, profiles);
    }

    private static String pointKey(String measurand, String context, String format, String phase,
            String location, String unit) {
        return "ocpp16/measurand=" + enc(measurand) + "/context=" + enc(context) + "/format="
                + enc(format) + "/phase=" + enc(phase) + "/location=" + enc(location)
                + "/unit=" + enc(unit);
    }

    private static String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private JsonNode parse(String value) {
        if (value == null) return null;
        try { return mapper.readTree(value); } catch (Exception e) { return mapper.createObjectNode(); }
    }

    private String json(JsonNode value) {
        try { return mapper.writeValueAsString(value == null ? mapper.createObjectNode() : value); }
        catch (Exception e) { return "{}"; }
    }

    private static String text(JsonNode n, String field) {
        String value = n.path(field).asText(null);
        return value == null || value.isBlank() ? null : value;
    }

    private static String nullableText(JsonNode n, String field) {
        if (n == null || n.path(field).isMissingNode() || n.path(field).isNull()) return null;
        return n.path(field).asText();
    }

    private static String defaultText(JsonNode n, String field, String fallback) {
        String value = nullableText(n, field);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static UUID uuid(JsonNode n, String field) {
        try { return UUID.fromString(n.path(field).asText()); } catch (Exception e) { return null; }
    }

    private static Instant parseInstant(String value) {
        try { return Instant.parse(value); } catch (Exception e) { return null; }
    }

    private static Integer nullableInt(JsonNode n, String field) {
        JsonNode v = n == null ? null : n.get(field);
        return v == null || v.isNull() || !v.canConvertToInt() ? null : v.asInt();
    }

    private static Instant instant(JsonNode n, String field, Instant fallback) {
        String value = nullableText(n, field);
        if (value == null) return fallback;
        try { return Instant.parse(value); } catch (DateTimeParseException e) { return fallback; }
    }

    private static Instant instant(ResultSet rs, String field) throws SQLException {
        Timestamp value = rs.getTimestamp(field);
        return value == null ? null : value.toInstant();
    }

    private static Timestamp ts(Instant value) { return value == null ? null : Timestamp.from(value); }

    private static Integer nullableInt(ResultSet rs, String field) throws SQLException {
        int value = rs.getInt(field); return rs.wasNull() ? null : value;
    }

    private static Long nullableLong(ResultSet rs, String field) throws SQLException {
        long value = rs.getLong(field); return rs.wasNull() ? null : value;
    }

    private static Double nullableDouble(ResultSet rs, String field) throws SQLException {
        double value = rs.getDouble(field); return rs.wasNull() ? null : value;
    }

    private static Double finiteDouble(String value) {
        try { double d = Double.parseDouble(value); return Double.isFinite(d) ? d : null; }
        catch (Exception e) { return null; }
    }
}
