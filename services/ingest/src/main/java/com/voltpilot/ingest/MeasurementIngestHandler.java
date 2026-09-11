package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
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

/**
 * {@code measurement-samples} → {@code measurements.raw} + {@code events.raw} (UEMS AP-07 IP-5):
 * die angenommenen Samples gehen weiter, jede Ablehnung (Vertragsverstoß, Uhr vor, zu alt) wird
 * gebündelt als Ereignis der Datenannahme festgehalten — nicht nur als Log. Quittiert wird die
 * QoS-1-Zustellung erst, wenn Redpanda ALLE Sendungen bestätigt hat. Fehlt das Topic
 * {@code events.raw}, sendet {@link EventsRawProducer} keine Ereignisse (nur Log + Zähler) — dann
 * wird nach den Messwerten quittiert, der Messwert-Weg wartet nie auf {@code events.raw}.
 */
@Component
public class MeasurementIngestHandler {
    private static final Logger log = LoggerFactory.getLogger(MeasurementIngestHandler.class);
    private final MeasurementSamplesValidator validator;
    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;
    private final String topic;
    private final EventsRawProducer ereignisse;
    private final Clock clock;

    public MeasurementIngestHandler(MeasurementSamplesValidator validator, ObjectMapper mapper,
            KafkaTemplate<String, String> kafka,
            @Value("${voltpilot.redpanda.measurements-topic:measurements.raw}") String topic,
            EventsRawProducer ereignisse, Clock clock) {
        this.validator = validator;
        this.mapper = mapper;
        this.kafka = kafka;
        this.topic = topic;
        this.ereignisse = ereignisse;
        this.clock = clock;
    }

    @ServiceActivator(inputChannel = MqttMeasurementIngestConfig.CHANNEL)
    public void handle(Message<String> message,
            @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic,
            @Header(name = IntegrationMessageHeaderAccessor.ACKNOWLEDGMENT_CALLBACK,
                    required = false) SimpleAcknowledgment acknowledgement) {
        Instant eingang = clock.instant();
        String payload = message.getPayload();
        try {
            List<CompletableFuture<?>> sends = new ArrayList<>();
            try {
                Annahme<MeasurementRawEvent> annahme = validator.annehmen(mqttTopic, payload, eingang);
                if (annahme.weiter() != null) {
                    MeasurementRawEvent event = annahme.weiter();
                    sends.add(kafka.send(topic, event.kafkaKey(), mapper.writeValueAsString(event)));
                }
                if (!annahme.ablehnungen().isEmpty()) {
                    log.warn("refused measurement samples on {}: {}", mqttTopic, annahme.ablehnungen());
                }
                sends.addAll(ereignisse.sende(EventsRawEvent.ablehnungen(annahme, mqttTopic, payload, eingang)));
            } catch (UmschlagAbgewiesen e) {
                log.warn("rejected measurement samples on {}: {}", mqttTopic, e.getMessage());
                sends.addAll(ereignisse.sende(
                        EventsRawEvent.abweisung(e, mqttTopic, payload, eingang).stream().toList()));
            }
            EventsRawProducer.abwarten(sends);
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
