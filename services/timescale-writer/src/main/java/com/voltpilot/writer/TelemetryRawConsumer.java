package com.voltpilot.writer;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Consumes {@code telemetry.raw} from Redpanda and writes each event to the
 * TimescaleDB hypertable via {@link TelemetryWriteRepository}.
 *
 * <p>Error policy:
 * <ul>
 *   <li><b>Poison message</b> (unparseable JSON / wrong shape): logged and
 *       skipped so the offset advances - a bad record cannot wedge the consumer.</li>
 *   <li><b>Transient write failure</b> (DB down, etc.): the exception propagates
 *       so the container does not commit the offset and Kafka redelivers. The
 *       insert is idempotent, so redelivery cannot double-write.</li>
 * </ul>
 */
@Component
public class TelemetryRawConsumer {

    private static final Logger log = LoggerFactory.getLogger(TelemetryRawConsumer.class);

    private final ObjectMapper mapper;
    private final TelemetryWriteRepository repository;

    public TelemetryRawConsumer(ObjectMapper mapper, TelemetryWriteRepository repository) {
        this.mapper = mapper;
        this.repository = repository;
    }

    @KafkaListener(
            topics = "${voltpilot.redpanda.telemetry-topic:telemetry.raw}",
            groupId = "${spring.kafka.consumer.group-id:timescale-writer}")
    public void onMessage(String value) {
        TelemetryRawEvent event;
        try {
            event = mapper.readValue(value, TelemetryRawEvent.class);
        } catch (JsonProcessingException e) {
            log.warn("Skipping unparseable telemetry.raw record: {}", e.getMessage());
            return;
        }
        if (event.tenant_id() == null || event.site_id() == null
                || event.device_id() == null || event.observed_at() == null) {
            log.warn("Skipping telemetry.raw record missing required identity/timestamp: {}", value);
            return;
        }

        boolean inserted = repository.insert(event, value);
        if (log.isDebugEnabled()) {
            log.debug("{} telemetry row for device={} at {} (tenant={})",
                    inserted ? "Inserted" : "Skipped duplicate",
                    event.device_id(), event.observed_at(), event.tenant_id());
        }
    }
}
