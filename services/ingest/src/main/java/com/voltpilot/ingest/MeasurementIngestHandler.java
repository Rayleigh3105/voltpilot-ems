package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.integration.IntegrationMessageHeaderAccessor;
import org.springframework.integration.acks.SimpleAcknowledgment;
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
            @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic,
            @Header(name = IntegrationMessageHeaderAccessor.ACKNOWLEDGMENT_CALLBACK,
                    required = false) SimpleAcknowledgment acknowledgement) {
        try {
            var event = validator.toEvent(mqttTopic, message.getPayload(), clock.instant());
            kafka.send(topic, event.kafkaKey(), mapper.writeValueAsString(event)).get(10, TimeUnit.SECONDS);
            acknowledge(acknowledgement);
        } catch (InvalidTelemetryException e) {
            log.warn("rejected measurement samples on {}: {}", mqttTopic, e.getMessage());
            acknowledge(acknowledgement);
        } catch (Exception e) {
            log.error("measurement ingest failed", e);
            // Manual MQTT acknowledgement is deliberately withheld. The
            // broker redelivers this QoS1 message after Redpanda recovers.
            throw new IllegalStateException("measurements.raw produce did not complete", e);
        }
    }

    private static void acknowledge(SimpleAcknowledgment acknowledgement) {
        if (acknowledgement != null) {
            acknowledgement.acknowledge();
        }
    }
}
