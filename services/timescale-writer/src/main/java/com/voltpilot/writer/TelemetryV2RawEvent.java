package com.voltpilot.writer;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.UUID;

/**
 * The {@code telemetry-v2.raw} event as consumed from Redpanda (contract:
 * {@code docs/contracts/v2/telemetry-v2-raw.event.schema.json}). Tolerant of
 * unknown additive fields like its v1 twin. {@code entities} is the per-entity
 * channel block the writer explodes into generic (entity_id, channel, value)
 * rows.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TelemetryV2RawEvent(
        String schema_version,
        UUID event_id,
        UUID tenant_id,
        UUID site_id,
        UUID device_id,
        Instant observed_at,
        Instant ingested_at,
        String source_topic,
        JsonNode entities) {
}
