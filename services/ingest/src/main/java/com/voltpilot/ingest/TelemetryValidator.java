package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.DateTimeException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * Validates + normalizes an inbound MQTT telemetry message against the binding
 * contract {@code docs/contracts/mqtt-telemetry.schema.json} and maps it to a
 * {@link TelemetryRawEvent} for the Redpanda log.
 *
 * <p>Validation (fail -> {@link InvalidTelemetryException}, i.e. log+skip):
 * <ul>
 *   <li>payload is a JSON object with {@code schema_version == "1.0"};</li>
 *   <li>{@code tenant_id}/{@code site_id}/{@code device_id} are present UUIDs;</li>
 *   <li>{@code ts} is an RFC-3339 instant;</li>
 *   <li>{@code measurements} is present and an object;</li>
 *   <li>the topic {@code ems/{tenant}/{site}/{device}/telemetry} identities
 *       match the payload identities (a device may not publish under another's
 *       topic).</li>
 * </ul>
 */
@Component
public class TelemetryValidator {

    private static final String EXPECTED_VERSION = "1.0";

    private final ObjectMapper mapper;

    public TelemetryValidator(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /**
     * @param topic   the originating MQTT topic (authoritative device identity)
     * @param payload the raw JSON payload bytes as a string
     * @param now     the ingest timestamp to stamp onto the event
     */
    public TelemetryRawEvent toEvent(String topic, String payload, Instant now) {
        final JsonNode root;
        try {
            root = mapper.readTree(payload);
        } catch (Exception e) {
            throw new InvalidTelemetryException("payload is not valid JSON: " + e.getMessage());
        }
        if (root == null || !root.isObject()) {
            throw new InvalidTelemetryException("payload is not a JSON object");
        }

        String version = text(root, "schema_version");
        if (!EXPECTED_VERSION.equals(version)) {
            throw new InvalidTelemetryException(
                    "unsupported schema_version=" + version + " (expected " + EXPECTED_VERSION + ")");
        }

        UUID tenantId = uuid(root, "tenant_id");
        UUID siteId = uuid(root, "site_id");
        UUID deviceId = uuid(root, "device_id");
        Instant observedAt = instant(root, "ts");

        JsonNode measurements = root.get("measurements");
        if (measurements == null || !measurements.isObject()) {
            throw new InvalidTelemetryException("measurements missing or not an object");
        }

        TopicIds topicIds = parseTopic(topic);
        if (!topicIds.tenantId().equals(tenantId)
                || !topicIds.siteId().equals(siteId)
                || !topicIds.deviceId().equals(deviceId)) {
            throw new InvalidTelemetryException(
                    "topic identity " + topicIds + " does not match payload "
                            + tenantId + "/" + siteId + "/" + deviceId);
        }

        return new TelemetryRawEvent(
                TelemetryRawEvent.SCHEMA_VERSION,
                UUID.randomUUID(),
                tenantId,
                siteId,
                deviceId,
                observedAt,
                now,
                topic,
                measurements);
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static UUID uuid(JsonNode node, String field) {
        String v = text(node, field);
        if (v == null) {
            throw new InvalidTelemetryException(field + " is missing");
        }
        try {
            return UUID.fromString(v);
        } catch (IllegalArgumentException e) {
            throw new InvalidTelemetryException(field + " is not a UUID: " + v);
        }
    }

    private static Instant instant(JsonNode node, String field) {
        String v = text(node, field);
        if (v == null) {
            throw new InvalidTelemetryException(field + " is missing");
        }
        try {
            return OffsetDateTime.parse(v).toInstant();
        } catch (DateTimeException e) {
            throw new InvalidTelemetryException(field + " is not an RFC-3339 timestamp: " + v);
        }
    }

    /** Topic template: {@code ems/{tenant_id}/{site_id}/{device_id}/telemetry}. */
    private static TopicIds parseTopic(String topic) {
        if (topic == null) {
            throw new InvalidTelemetryException("missing MQTT topic header");
        }
        String[] parts = topic.split("/");
        if (parts.length != 5 || !"ems".equals(parts[0]) || !"telemetry".equals(parts[4])) {
            throw new InvalidTelemetryException("unexpected topic shape: " + topic);
        }
        try {
            return new TopicIds(UUID.fromString(parts[1]), UUID.fromString(parts[2]), UUID.fromString(parts[3]));
        } catch (IllegalArgumentException e) {
            throw new InvalidTelemetryException("topic segments are not UUIDs: " + topic);
        }
    }

    private record TopicIds(UUID tenantId, UUID siteId, UUID deviceId) {
        @Override
        public String toString() {
            return tenantId + "/" + siteId + "/" + deviceId;
        }
    }
}
