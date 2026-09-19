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

/**
 * Second hop of the ingest pipe: takes each validated MQTT telemetry message and
 * produces a {@code telemetry.raw} event to Redpanda, keyed by
 * {@code {tenant_id}:{site_id}} so a site's samples land on one partition and
 * stay ordered for the writer.
 *
 * <p>Malformed messages ({@link InvalidTelemetryException} or serialization
 * failures) are logged and skipped - never rethrown - so one bad payload cannot
 * stall or crash the ingest stream. Producer send failures ARE logged; the QoS1
 * delivery is already acked, and the durable log is Redpanda, not the broker.
 *
 * <p>Jede dieser Stellen zaehlt seither auch auf {@link IngestMetriken} — das Verwerfverhalten
 * selbst ist unveraendert, es ist nur abholbar geworden. Das ist der Kernweg der steuernden
 * Bestandsanlagen; hier still zu verlieren war die teuerste der vier Luecken.
 */
@Component
public class TelemetryIngestHandler {

    private static final Logger log = LoggerFactory.getLogger(TelemetryIngestHandler.class);

    private final TelemetryValidator validator;
    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;
    private final String topic;
    private final Clock clock;
    private final IngestMetriken metriken;

    public TelemetryIngestHandler(
            TelemetryValidator validator,
            ObjectMapper mapper,
            KafkaTemplate<String, String> kafka,
            @Value("${voltpilot.redpanda.telemetry-topic:telemetry.raw}") String topic,
            Clock clock,
            IngestMetriken metriken) {
        this.validator = validator;
        this.mapper = mapper;
        this.kafka = kafka;
        this.topic = topic;
        this.clock = clock;
        this.metriken = metriken;
    }

    @ServiceActivator(inputChannel = MqttIngestConfig.INBOUND_CHANNEL)
    public void handle(Message<String> message, @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic) {
        metriken.angenommen(IngestMetriken.TELEMETRY);
        TelemetryRawEvent event;
        try {
            event = validator.toEvent(mqttTopic, message.getPayload(), clock.instant());
        } catch (InvalidTelemetryException e) {
            // Der v1-Validator wirft EINE Ausnahmeart fuer unlesbares JSON, fehlende Pflichtfelder
            // UND eine Topic-Abweichung; ohne Grund-Kennung bleibt hier nur das grobe Label.
            metriken.verworfen(IngestMetriken.TELEMETRY, IngestMetriken.UNGUELTIG);
            log.warn("Dropping malformed telemetry on '{}': {}", mqttTopic, e.getMessage());
            return;
        }

        final String json;
        try {
            json = mapper.writeValueAsString(event);
        } catch (Exception e) {
            metriken.verworfen(IngestMetriken.TELEMETRY, IngestMetriken.SERIALISIERUNG);
            log.warn("Failed to serialize telemetry.raw event from '{}': {}", mqttTopic, e.getMessage());
            return;
        }

        kafka.send(topic, event.kafkaKey(), json).whenComplete((res, ex) -> {
            if (ex != null) {
                log.error("Failed to produce telemetry.raw for {}: {}", event.kafkaKey(), ex.getMessage());
            } else {
                metriken.schreibzugBestaetigt(IngestMetriken.TELEMETRY, clock.instant());
            }
        });
        metriken.weitergereicht(IngestMetriken.TELEMETRY);
        if (log.isDebugEnabled()) {
            log.debug("Ingested telemetry {} -> {} (event_id={})", event.kafkaKey(), topic, event.event_id());
        }
    }
}
