package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
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
 * partitioning rule). Malformed messages never crash the stream (the QoS1
 * delivery is acked; Redpanda is the durable log). UEMS AP-07 IP-5: a refused
 * value drops only itself, and every refusal - of a value or of the whole
 * envelope - lands as a datenannahme event on {@code events.raw}, not only in
 * the log. The v1 {@link TelemetryIngestHandler} is untouched.
 *
 * <p>Auf {@link IngestMetriken} zaehlt ein abgewiesener Umschlag als {@code verworfen}; abgelehnte
 * TEILWERTE tun das nicht — sie stehen als Ereignis auf {@code events.raw} und sind damit kein
 * stiller Verlust (dieselbe Trennung wie beim Writer, PR 972). Der Serialisierungs-/Sendefehler
 * ganz unten war bis hierher die einzige Stelle im ingest ohne jeden Zaehler.
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
    private final EventsRawProducer ereignisse;
    private final Clock clock;
    private final IngestMetriken metriken;

    public TelemetryV2IngestHandler(TelemetryV2Validator validator, ObjectMapper mapper,
            KafkaTemplate<String, String> kafka,
            @Value("${voltpilot.redpanda.telemetry-v2-topic:telemetry-v2.raw}") String topic,
            EventsRawProducer ereignisse, Clock clock, IngestMetriken metriken) {
        this.validator = validator;
        this.mapper = mapper;
        this.kafka = kafka;
        this.topic = topic;
        this.ereignisse = ereignisse;
        this.clock = clock;
        this.metriken = metriken;
    }

    @ServiceActivator(inputChannel = MqttIngestV2Config.V2_CHANNEL)
    public void handle(Message<String> message,
            @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic) {
        Instant eingang = clock.instant();
        String payload = message.getPayload();
        metriken.angenommen(IngestMetriken.TELEMETRY_V2);
        Annahme<TelemetryV2RawEvent> annahme;
        try {
            annahme = validator.annehmen(mqttTopic, payload, eingang);
        } catch (UmschlagAbgewiesen e) {
            metriken.verworfen(IngestMetriken.TELEMETRY_V2, IngestMetriken.grundVon(e));
            log.warn("rejected v2 telemetry on {}: {}", mqttTopic, e.getMessage());
            melde(EventsRawEvent.abweisung(e, mqttTopic, payload, eingang).stream().toList(), mqttTopic);
            return;
        }
        if (!annahme.ablehnungen().isEmpty()) {
            log.warn("refused v2 telemetry values on {}: {}", mqttTopic, annahme.ablehnungen());
            melde(EventsRawEvent.ablehnungen(annahme, mqttTopic, payload, eingang), mqttTopic);
        }
        TelemetryV2RawEvent event = annahme.weiter();
        if (event == null) {
            // Alle Teilwerte abgelehnt: nichts zu senden, aber auch nichts still verloren - die
            // Ablehnungen sind oben als Ereignis herausgegangen. Darum KEIN verworfen-Zuwachs.
            return;
        }
        try {
            String json = mapper.writeValueAsString(event);
            kafka.send(topic, event.kafkaKey(), json).whenComplete((result, error) -> {
                if (error != null) {
                    log.error("producing v2 event {} to {} failed", event.event_id(), topic, error);
                } else {
                    metriken.schreibzugBestaetigt(IngestMetriken.TELEMETRY_V2, clock.instant());
                }
            });
            metriken.weitergereicht(IngestMetriken.TELEMETRY_V2);
        } catch (Exception e) {
            metriken.verworfen(IngestMetriken.TELEMETRY_V2, IngestMetriken.SERIALISIERUNG);
            log.error("cannot serialize/produce v2 event from {}", mqttTopic, e);
        }
    }

    /** The Kern leg stays fire-and-forget (auto-acked QoS1): a failed event send is logged. */
    private void melde(List<EventsRawEvent> events, String mqttTopic) {
        try {
            ereignisse.sende(events).forEach(f -> f.whenComplete((result, error) -> {
                if (error != null) {
                    log.error("producing events.raw for {} failed", mqttTopic, error);
                }
            }));
        } catch (Exception e) {
            log.error("cannot serialize/produce events.raw for {}", mqttTopic, e);
        }
    }
}
