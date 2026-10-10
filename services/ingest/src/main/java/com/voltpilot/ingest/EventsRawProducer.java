package com.voltpilot.ingest;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

/**
 * Schreibt {@link EventsRawEvent}s auf das Redpanda-Topic {@code events.raw} (UEMS AP-07 IP-5),
 * geschlüsselt {@code {tenant_id}:{site_id}}. Der Verbraucher (die Ereignis-Tabelle) ist IP-8.
 *
 * <p><b>Fehlt das Topic</b> ({@link EventsTopicPruefung} legt es an; solange das nicht gelungen
 * ist, etwa ohne Rechte oder abgeschaltet), wird NICHTS gesendet: die Ablehnung
 * steht wie vor IP-5 nur im Log, der Zähler {@value #NICHT_ZUGESTELLT} zählt jedes nicht
 * zugestellte Ereignis, und der Aufrufer quittiert, sobald seine Messwerte bestätigt sind — der
 * Messwert-Weg wartet nie auf {@code events.raw}. Sobald die Prüfung das Topic findet, fließen
 * die Ereignisse, und das strenge Quittieren gilt (Entscheid b07-recreate D, 11.09.2026).
 */
@Component
public class EventsRawProducer {

    /** Micrometer-Zähler: Ereignisse, die nicht zugestellt wurden, weil {@code events.raw} fehlt. */
    static final String NICHT_ZUGESTELLT = "voltpilot.ingest.events.undelivered";

    private static final Logger log = LoggerFactory.getLogger(EventsRawProducer.class);

    private final ObjectMapper mapper;
    private final KafkaTemplate<String, String> kafka;
    private final String topic;
    private final EventsTopicPruefung pruefung;
    private final MeterRegistry registry;

    public EventsRawProducer(ObjectMapper mapper, KafkaTemplate<String, String> kafka,
            @Value("${voltpilot.redpanda.events-topic:events.raw}") String topic,
            EventsTopicPruefung pruefung, MeterRegistry registry) {
        this.mapper = mapper;
        this.kafka = kafka;
        this.topic = topic;
        this.pruefung = pruefung;
        this.registry = registry;
    }

    /**
     * Sendet jedes Ereignis; der Aufrufer entscheidet über die Futures, ob er quittiert. Fehlt das
     * Topic, kommt eine LEERE Liste zurück (nichts gesendet, nur Log + Zähler).
     */
    List<CompletableFuture<?>> sende(List<EventsRawEvent> ereignisse) throws JsonProcessingException {
        if (ereignisse.isEmpty()) {
            return List.of();
        }
        if (!pruefung.vorhanden()) {
            for (EventsRawEvent e : ereignisse) {
                Counter.builder(NICHT_ZUGESTELLT)
                        .description("Ereignis nicht zugestellt, events.raw fehlt")
                        .tag("reason", "events_raw_missing")
                        .tag("strom", e.ereignis().path("strom").asText(BoxEventsValidator.STROM))
                        .register(registry).increment();
                log.warn("Ereignis NICHT zugestellt - Redpanda-Topic {} fehlt (nur Log, wie vor IP-5): {}",
                        topic, e.ereignis());
            }
            return List.of();
        }
        List<CompletableFuture<?>> sends = new ArrayList<>();
        for (EventsRawEvent e : ereignisse) {
            sends.add(kafka.send(topic, e.kafkaKey(), mapper.writeValueAsString(e)));
        }
        return sends;
    }

    /** Wartet, bis Redpanda jede Sendung bestätigt hat (die Quittung der QoS-1-Zustellung folgt erst danach). */
    static void abwarten(List<CompletableFuture<?>> sends) throws Exception {
        for (CompletableFuture<?> f : sends) {
            f.get(10, TimeUnit.SECONDS);
        }
    }
}
