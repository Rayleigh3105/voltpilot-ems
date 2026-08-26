package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.UUID;

public record MeasurementRawEvent(String schema_version, UUID event_id, UUID tenant_id,
        UUID site_id, UUID device_id, String catalog_version, long sequence,
        Instant observed_at, Instant ingested_at, String source_topic, JsonNode samples,
        long dropped_samples, boolean gap) {
    public String kafkaKey() {
        return tenant_id + ":" + site_id + ":" + device_id;
    }
}
