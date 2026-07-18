package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * ENVELOPE validation of an inbound mqtt-telemetry-2.0 payload (contract:
 * {@code docs/contracts/v2/mqtt-telemetry-2.0.schema.json}): schema version,
 * topic==payload identity (the v1 rule), id formats, timestamps, and the
 * structural shape - entity ids topic-safe, channels flat maps of FINITE
 * numbers. Channel NAMES are deliberately NOT validated against the entity
 * registry, and an unknown entity id is data, not an error (the capability set
 * is an edge/portal concern - contract §3).
 *
 * <p>Like the v1 {@link TelemetryValidator}, every failure throws
 * {@link InvalidTelemetryException}; the caller logs and skips (never crash the
 * stream).
 */
@Component
public class TelemetryV2Validator {

    static final String EXPECTED_VERSION = "2.0";

    private static final Pattern ENTITY_ID =
            Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    private static final Pattern CHANNEL = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");

    private final ObjectMapper mapper;

    public TelemetryV2Validator(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /**
     * Validates the envelope and maps it onto the {@code telemetry-v2.raw}
     * event. Throws {@link InvalidTelemetryException} on any violation.
     */
    public TelemetryV2RawEvent toEvent(String topic, String payload, Instant now) {
        JsonNode root = parse(payload);

        String version = text(root, "schema_version");
        if (!EXPECTED_VERSION.equals(version)) {
            throw new InvalidTelemetryException("unsupported schema_version: " + version);
        }
        UUID tenantId = uuid(root, "tenant_id");
        UUID siteId = uuid(root, "site_id");
        UUID deviceId = uuid(root, "device_id");
        Instant observedAt = timestamp(root, "ts");

        requireTopicIdentity(topic, tenantId, siteId, deviceId);

        JsonNode entities = root.get("entities");
        if (entities == null || !entities.isObject() || entities.isEmpty()) {
            throw new InvalidTelemetryException("entities must be a non-empty object");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = entities.fields(); it.hasNext();) {
            Map.Entry<String, JsonNode> entity = it.next();
            if (!ENTITY_ID.matcher(entity.getKey()).matches()) {
                throw new InvalidTelemetryException("entity id not topic-safe: " + entity.getKey());
            }
            validateEntity(entity.getKey(), entity.getValue());
        }

        return new TelemetryV2RawEvent(TelemetryV2RawEvent.SCHEMA_VERSION, UUID.randomUUID(),
                tenantId, siteId, deviceId, observedAt, now, topic, entities);
    }

    private void validateEntity(String id, JsonNode entity) {
        if (entity == null || !entity.isObject()) {
            throw new InvalidTelemetryException("entity " + id + " must be an object");
        }
        JsonNode ts = entity.get("ts");
        if (ts != null && !ts.isNull()) {
            parseTimestamp(id, ts.asText());
        }
        JsonNode channels = entity.get("channels");
        if (channels == null || !channels.isObject() || channels.isEmpty()) {
            throw new InvalidTelemetryException(
                    "entity " + id + " channels must be a non-empty object");
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = channels.fields(); it.hasNext();) {
            Map.Entry<String, JsonNode> channel = it.next();
            if (!CHANNEL.matcher(channel.getKey()).matches()) {
                throw new InvalidTelemetryException(
                        "entity " + id + " channel name invalid: " + channel.getKey());
            }
            JsonNode value = channel.getValue();
            if (!value.isNumber() || !Double.isFinite(value.asDouble())) {
                throw new InvalidTelemetryException("entity " + id + " channel "
                        + channel.getKey() + " must be a finite number");
            }
        }
    }

    /** Topic shape ems/{t}/{s}/{d}/v2/telemetry, identities equal the payload's. */
    private void requireTopicIdentity(String topic, UUID tenantId, UUID siteId, UUID deviceId) {
        String[] parts = topic == null ? new String[0] : topic.split("/");
        if (parts.length != 6 || !"ems".equals(parts[0]) || !"v2".equals(parts[4])
                || !"telemetry".equals(parts[5])) {
            throw new InvalidTelemetryException("unexpected topic shape: " + topic);
        }
        if (!parts[1].equals(tenantId.toString()) || !parts[2].equals(siteId.toString())
                || !parts[3].equals(deviceId.toString())) {
            throw new InvalidTelemetryException(
                    "topic identity does not match payload identity: " + topic);
        }
    }

    private JsonNode parse(String payload) {
        try {
            JsonNode root = mapper.readTree(payload);
            if (root == null || !root.isObject()) {
                throw new InvalidTelemetryException("payload is not a JSON object");
            }
            return root;
        } catch (InvalidTelemetryException e) {
            throw e;
        } catch (Exception e) {
            throw new InvalidTelemetryException("payload is not valid JSON: " + e.getMessage());
        }
    }

    private String text(JsonNode root, String field) {
        JsonNode node = root.get(field);
        if (node == null || !node.isTextual()) {
            throw new InvalidTelemetryException("missing field: " + field);
        }
        return node.asText();
    }

    private UUID uuid(JsonNode root, String field) {
        try {
            return UUID.fromString(text(root, field));
        } catch (IllegalArgumentException e) {
            throw new InvalidTelemetryException("field " + field + " is not a UUID");
        }
    }

    private Instant timestamp(JsonNode root, String field) {
        return parseTimestamp(field, text(root, field));
    }

    private Instant parseTimestamp(String what, String value) {
        try {
            return OffsetDateTime.parse(value).toInstant();
        } catch (DateTimeParseException e) {
            throw new InvalidTelemetryException(what + " ts is not RFC 3339: " + value);
        }
    }
}
