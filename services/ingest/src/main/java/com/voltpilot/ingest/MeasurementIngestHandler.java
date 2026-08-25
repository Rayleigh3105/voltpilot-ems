package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.integration.annotation.ServiceActivator;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.messaging.Message;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

@Component
public class MeasurementIngestHandler {
    private static final Logger log = LoggerFactory.getLogger(MeasurementIngestHandler.class);
    private final MeasurementSamplesValidator validator;
    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;
    private final String topic;
    private final Clock clock;

    public MeasurementIngestHandler(MeasurementSamplesValidator validator, ObjectMapper mapper,
            KafkaTemplate<String, String> kafka,
            @Value("${voltpilot.redpanda.measurements-topic:measurements.raw}") String topic,
            Clock clock) {
        this.validator = validator;
        this.mapper = mapper;
        this.kafka = kafka;
        this.topic = topic;
        this.clock = clock;
    }

    @ServiceActivator(inputChannel = MqttMeasurementIngestConfig.CHANNEL)
    public void handle(Message<String> message,
            @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic) {
        try {
            var event = validator.toEvent(mqttTopic, message.getPayload(), clock.instant());
            kafka.send(topic, event.kafkaKey(), mapper.writeValueAsString(event))
                    .whenComplete((result, error) -> {
                        if (error != null) log.error("measurements.raw produce failed", error);
                    });
        } catch (InvalidTelemetryException e) {
            log.warn("rejected measurement samples on {}: {}", mqttTopic, e.getMessage());
        } catch (Exception e) {
            log.error("measurement ingest failed", e);
        }
    }
}
