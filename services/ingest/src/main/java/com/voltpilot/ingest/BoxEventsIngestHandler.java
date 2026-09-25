package com.voltpilot.ingest;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.integration.IntegrationMessageHeaderAccessor;
import org.springframework.integration.acks.SimpleAcknowledgment;
import org.springframework.integration.annotation.ServiceActivator;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.messaging.Message;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

/**
 * Box-Ereignisse {@code ems/+/+/+/v2/events} → {@code events.raw} (UEMS AP-07 IP-5, Weg 1 des
 * Ereignis-Vertrags): je Eintrag eines angenommenen Umschlags EIN Ereignis mit Urheber
 * {@code box}; ein abgewiesener Umschlag hinterlässt EIN {@code rejected}, eine falsche Uhr ein
 * {@code clock_ahead}/{@code too_old}. Wie {@code measurement-samples}: persistente Sitzung, und
 * die QoS-1-Zustellung wird erst quittiert, wenn Redpanda alle Ereignisse bestätigt hat — ein
 * Ereignis wird nie gelöscht, also auch nicht beim Ausfall von Redpanda verloren. Der Adapter
 * verbindet sich erst, wenn es das Topic {@code events.raw} gibt ({@link BoxEreignisTor}).
 *
 * <p>Auf {@link IngestMetriken} zaehlt nur ein ABGEWIESENER Umschlag als {@code verworfen};
 * abgelehnte Eintraege eines angenommenen Umschlags gehen selbst als {@code rejected} heraus.
 */
@Component
public class BoxEventsIngestHandler {
    private static final Logger log = LoggerFactory.getLogger(BoxEventsIngestHandler.class);
    private final BoxEventsValidator validator;
    private final EventsRawProducer ereignisse;
    private final Clock clock;
    private final IngestMetriken metriken;
    private BeendeteKundenbereiche beendete;

    public BoxEventsIngestHandler(BoxEventsValidator validator, EventsRawProducer ereignisse,
            Clock clock, IngestMetriken metriken) {
        this.validator = validator;
        this.ereignisse = ereignisse;
        this.clock = clock;
        this.metriken = metriken;
    }

    /** UEMS AP-20 IP-16 - fehlt die Sperre (abgeschaltet, Tests), nimmt der Strom alles an wie vorher. */
    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    @ServiceActivator(inputChannel = MqttEventsIngestConfig.CHANNEL)
    public void handle(Message<String> message,
            @Header(MqttHeaders.RECEIVED_TOPIC) String mqttTopic,
            @Header(name = IntegrationMessageHeaderAccessor.ACKNOWLEDGMENT_CALLBACK,
                    required = false) SimpleAcknowledgment acknowledgement) {
        Instant eingang = clock.instant();
        String payload = message.getPayload();
        metriken.angenommen(IngestMetriken.EVENTS);
        if (beendete != null && beendete.beendet(mqttTopic)) {
            // UEMS AP-20 IP-16: ein beendeter Kundenbereich nimmt nichts mehr an - gezaehlt, nicht gemeldet.
            metriken.verworfen(IngestMetriken.EVENTS, IngestMetriken.KUNDENBEREICH_BEENDET);
            if (acknowledgement != null) {
                acknowledgement.acknowledge();
            }
            return;
        }
        boolean weitergereicht = false;
        try {
            List<CompletableFuture<?>> sends = new ArrayList<>();
            try {
                Annahme<List<EventsRawEvent>> annahme = validator.annehmen(mqttTopic, payload, eingang);
                // Was WIRKLICH hinausging: fehlt events.raw, liefert sende() eine leere Liste
                // (nur Log + der vorhandene Zaehler) - dann ist nichts weitergereicht worden.
                List<CompletableFuture<?>> nutzlast = ereignisse.sende(annahme.weiter());
                sends.addAll(nutzlast);
                if (!nutzlast.isEmpty()) {
                    metriken.weitergereicht(IngestMetriken.EVENTS);
                    weitergereicht = true;
                }
                if (!annahme.ablehnungen().isEmpty()) {
                    log.warn("refused box events on {}: {}", mqttTopic, annahme.ablehnungen());
                }
                sends.addAll(ereignisse.sende(EventsRawEvent.ablehnungen(annahme, mqttTopic, payload, eingang)));
            } catch (UmschlagAbgewiesen e) {
                metriken.verworfen(IngestMetriken.EVENTS, IngestMetriken.grundVon(e));
                log.warn("rejected box events on {}: {}", mqttTopic, e.getMessage());
                sends.addAll(ereignisse.sende(
                        EventsRawEvent.abweisung(e, mqttTopic, payload, eingang).stream().toList()));
            }
            EventsRawProducer.abwarten(sends);
            if (weitergereicht) {
                metriken.schreibzugBestaetigt(IngestMetriken.EVENTS, clock.instant());
            }
            if (acknowledgement != null) {
                acknowledgement.acknowledge();
            }
        } catch (Exception e) {
            log.error("box event ingest failed", e);
            // Quittung bewusst zurückgehalten: der Broker stellt erneut zu, sobald Redpanda wieder da ist.
            throw new IllegalStateException("events.raw produce did not complete", e);
        }
    }
}
