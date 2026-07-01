package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.UUID;

/**
 * Event emitted to the Redpanda {@code telemetry.raw} topic after an inbound MQTT
 * telemetry payload has been validated. Field names/shape are the BINDING
 * contract {@code docs/contracts/telemetry-raw.event.schema.json}; the record's
 * JSON serialization must match it exactly (snake_case, ISO-8601 timestamps).
 *
 * <p>{@code measurements} is carried through unchanged from the MQTT payload so
 * unknown/future measurement fields survive to downstream consumers.
 */
public record TelemetryRawEvent(
        String schema_version,
        UUID event_id,
        UUID tenant_id,
        UUID site_id,
        UUID device_id,
        Instant observed_at,
        Instant ingested_at,
        String source_topic,
        JsonNode measurements) {

    /** The frozen contract version this service speaks. */
    public static final String SCHEMA_VERSION = "1.0";

    /** Kafka record key: {@code {tenant_id}:{site_id}} (partition by site). */
    public String kafkaKey() {
        return tenant_id + ":" + site_id;
    }
}
