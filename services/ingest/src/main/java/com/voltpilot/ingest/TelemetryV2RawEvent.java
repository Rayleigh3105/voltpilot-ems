package com.voltpilot.ingest;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.UUID;

/**
 * Event produced to the Redpanda topic {@code telemetry-v2.raw} after
 * envelope-validating an inbound mqtt-telemetry-2.0 payload. Contract:
 * {@code docs/contracts/v2/telemetry-v2-raw.event.schema.json} - lives NEXT TO
 * the v1 {@link TelemetryRawEvent} (dual-consume; the v1 contract is
 * untouched). {@code entities} is the validated per-entity channel block,
 * carried through unchanged (minus refused values, UEMS AP-07 IP-5). {@code seq}
 * is the box's sequence, forwarded unchanged; a box that sends none gets no
 * field (absent = not reported, never 0).
 */
public record TelemetryV2RawEvent(
        String schema_version,
        UUID event_id,
        UUID tenant_id,
        UUID site_id,
        UUID device_id,
        Instant observed_at,
        Instant ingested_at,
        String source_topic,
        @JsonInclude(JsonInclude.Include.NON_NULL) Long seq,
        JsonNode entities) {

    /** The v2 event contract is brand-new and starts at 1.0. */
    public static final String SCHEMA_VERSION = "1.0";

    /** Partitioning key: a site's samples share a partition (the v1 rule). */
    public String kafkaKey() {
        return tenant_id + ":" + site_id;
    }
}
