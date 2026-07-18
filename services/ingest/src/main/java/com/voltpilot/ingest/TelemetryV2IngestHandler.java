package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.integration.annotation.ServiceActivator;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.messaging.Message;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

/**
 * v2 hop: envelope-validate an inbound mqtt-telemetry-2.0 message and produce
 * the {@code telemetry-v2.raw} event, keyed {@code {tenant}:{site}} (the v1
 * partitioning rule). Malformed messages are LOGGED AND SKIPPED - never crash
 * the stream (the QoS1 delivery is acked; Redpanda is the durable log). The v1
 * {@link TelemetryIngestHandler} is untouched.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.telemetry-v2.enabled", havingValue = "true",
        matchIfMissing = true)
public class TelemetryV2IngestHandler {

    private static final Logger log = LoggerFactory.getLogger(TelemetryV2IngestHandler.class);

    private final TelemetryV2Validator validator;
    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;
    private final String topic;
    private final Clock clock;

    private final AtomicLong accepted = new AtomicLong();
    private final AtomicLong rejected = new AtomicLong();

    public TelemetryV2IngestHandler(TelemetryV2Validator validator, ObjectMapper mapper,
            KafkaTemplate<String, String> kafka,
            @Value("${voltpilot.redpanda.telemetry-v2-topic:telemetry-v2.raw}") String topic,
            Clock clock) {
        this.validator = validator;
        this.mapper = mapper;
        this.kafka = kafka;
        this.topic = topic;
        this.clock = clock;
    }

    @ServiceActivator(inputChannel = MqttIngestV2Config.V2_CHANNEL)
    public void handle(Message<String> message,
            @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic) {
        TelemetryV2RawEvent event;
        try {
            event = validator.toEvent(mqttTopic, message.getPayload(), clock.instant());
        } catch (InvalidTelemetryException e) {
            rejected.incrementAndGet();
            log.warn("rejected v2 telemetry on {}: {}", mqttTopic, e.getMessage());
            return;
        }
        try {
            String json = mapper.writeValueAsString(event);
            kafka.send(topic, event.kafkaKey(), json).whenComplete((result, error) -> {
                if (error != null) {
                    log.error("producing v2 event {} to {} failed", event.event_id(), topic, error);
                }
            });
            accepted.incrementAndGet();
        } catch (Exception e) {
            log.error("cannot serialize/produce v2 event from {}", mqttTopic, e);
        }
    }

    long acceptedCount() {
        return accepted.get();
    }

    long rejectedCount() {
        return rejected.get();
    }
}
