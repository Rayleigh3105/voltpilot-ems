package com.voltpilot.writer;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * v2 consumer, NEXT TO the v1 {@link TelemetryRawConsumer} (dual-consume; the
 * v1 path is byte-identical untouched): reads {@code telemetry-v2.raw} events
 * and hands them to the generic per-entity writer. Same posture as v1: poison
 * messages are logged and skipped (offset advances); transient DB failures
 * re-throw so Kafka redelivers - safe because the insert is idempotent per
 * (entity_id, channel, time).
 */
@Component
public class TelemetryV2RawConsumer {

    private static final Logger log = LoggerFactory.getLogger(TelemetryV2RawConsumer.class);

    private final ObjectMapper mapper;
    private final TelemetryV2WriteRepository repository;

    public TelemetryV2RawConsumer(ObjectMapper mapper, TelemetryV2WriteRepository repository) {
        this.mapper = mapper;
        this.repository = repository;
    }

    @KafkaListener(topics = "${voltpilot.redpanda.telemetry-v2-topic:telemetry-v2.raw}",
            groupId = "${spring.kafka.consumer.group-id:timescale-writer}")
    public void onMessage(String value) {
        TelemetryV2RawEvent event;
        try {
            event = mapper.readValue(value, TelemetryV2RawEvent.class);
        } catch (JsonProcessingException e) {
            log.warn("Skipping unparseable telemetry-v2.raw record: {}", e.getMessage());
            return;
        }
        if (event.tenant_id() == null || event.site_id() == null || event.device_id() == null
                || event.observed_at() == null || event.entities() == null
                || !event.entities().isObject()) {
            log.warn("Skipping telemetry-v2.raw record with missing identity/entities "
                    + "(event_id={})", event.event_id());
            return;
        }
        int rows = repository.insert(event);
        if (log.isDebugEnabled()) {
            log.debug("telemetry-v2.raw event {} -> {} rows", event.event_id(), rows);
        }
    }
}
