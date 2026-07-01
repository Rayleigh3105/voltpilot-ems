package com.voltpilot.writer;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.UUID;

/**
 * The {@code telemetry.raw} event consumed from Redpanda. Shape is the BINDING
 * contract {@code docs/contracts/telemetry-raw.event.schema.json}; field names
 * are snake_case to match the wire format the ingest service produces.
 *
 * <p>Unknown top-level fields are ignored so an additive contract change on the
 * producer side never breaks the writer.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
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
}
