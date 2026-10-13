package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.integration.channel.DirectChannel;
import org.springframework.integration.mqtt.inbound.MqttPahoMessageDrivenChannelAdapter;
import org.springframework.integration.mqtt.support.MqttHeaders;
import org.springframework.integration.support.MessageBuilder;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.support.InterceptableChannel;

/**
 * {@code request_id} und {@code tenant_id} je MQTT-Nachricht ({@link NachrichtenVorgang}). Ohne Docker:
 * die Adapter starten nicht, die Nachricht wird direkt in den Kanal gegeben - genau die Stelle, an der
 * der Adapter sie im Betrieb abgibt.
 */
class NachrichtenVorgangTest {

    private static final String MANDANT = "7f3c1e6a-2b4d-4c8e-9a10-5d6e7f8091a2";
    private static final String TOPIC = "ems/" + MANDANT
            + "/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/telemetry";

    @AfterEach
    void aufraeumen() {
        MDC.clear();
    }

    private static Message<String> nachricht(String topic) {
        return MessageBuilder.withPayload("kein json").setHeader(MqttHeaders.RECEIVED_TOPIC, topic).build();
    }

    /** Ein Kanal wie die der Adapter, mit einem Handler, der festhält, was er im MDC vorfindet. */
    private static Map<String, String> imHandler(Message<String> nachricht) {
        DirectChannel kanal = new DirectChannel();
        kanal.addInterceptor(new NachrichtenVorgang());
        List<Map<String, String>> gesehen = new ArrayList<>();
        kanal.subscribe(m -> gesehen.add(MDC.getCopyOfContextMap()));
        kanal.send(nachricht);
        assertThat(gesehen).hasSize(1);
        return gesehen.get(0);
    }

    @Test
    void derHandlerSiehtDieKennungDerNachrichtUndDenMandantenAusDemTopic() {
        Message<String> nachricht = nachricht(TOPIC);

        Map<String, String> mdc = imHandler(nachricht);

        assertThat(mdc).containsOnly(
                Map.entry("request_id", nachricht.getHeaders().getId().toString()),
                Map.entry("tenant_id", MANDANT));
        assertThat(MDC.getCopyOfContextMap()).as("nach der Nachricht trägt der Faden nichts mehr").isNullOrEmpty();
    }

    @Test
    void jedeNachrichtBekommtIhreEigeneKennung() {
        assertThat(imHandler(nachricht(TOPIC)).get("request_id"))
                .isNotEqualTo(imHandler(nachricht(TOPIC)).get("request_id"));
    }

    @Test
    void ohneMandantenSegmentFehltDerMandantStattFalschZuSein() {
        assertThat(imHandler(nachricht("provision/VP-ABCD-EFGH/hello"))).containsOnlyKeys("request_id");
        assertThat(imHandler(nachricht("ems/kein-uuid/x/y/telemetry"))).containsOnlyKeys("request_id");
        assertThat(imHandler(nachricht("ems/" + MANDANT))).containsOnlyKeys("request_id");
        assertThat(imHandler(MessageBuilder.withPayload("ohne Topic").build())).containsOnlyKeys("request_id");
    }

    /** Der Mandant der vorigen Nachricht darf nie an der nächsten hängen bleiben. */
    @Test
    void einWorfDesHandlersLaesstNichtsAmFadenZurueck() {
        DirectChannel kanal = new DirectChannel();
        kanal.addInterceptor(new NachrichtenVorgang());
        kanal.subscribe(m -> {
            throw new IllegalStateException("Redpanda weg");
        });

        assertThatThrownBy(() -> kanal.send(nachricht(TOPIC))).hasRootCauseMessage("Redpanda weg");

        assertThat(MDC.getCopyOfContextMap()).isNullOrEmpty();
    }

    @Test
    void einSpaetererRueckrufAufFremdemFadenTraegtDieKennungenUndRaeumtDortWiederAb() throws Exception {
        ExecutorService fremd = Executors.newSingleThreadExecutor();
        try {
            fremd.submit(() -> MDC.put("request_id", "gehört dem fremden Faden")).get(5, TimeUnit.SECONDS);
            CompletableFuture<String> quittung = new CompletableFuture<>();
            List<Map<String, String>> gesehen = new ArrayList<>();
            DirectChannel kanal = new DirectChannel();
            kanal.addInterceptor(new NachrichtenVorgang());
            kanal.subscribe(m -> quittung.whenComplete(
                    NachrichtenVorgang.fortsetzen((ergebnis, fehler) -> gesehen.add(MDC.getCopyOfContextMap()))));
            Message<String> nachricht = nachricht(TOPIC);
            kanal.send(nachricht);

            fremd.submit(() -> quittung.complete("ok")).get(5, TimeUnit.SECONDS);

            assertThat(gesehen).containsExactly(Map.of(
                    "request_id", nachricht.getHeaders().getId().toString(), "tenant_id", MANDANT));
            assertThat(fremd.submit(MDC::getCopyOfContextMap).get(5, TimeUnit.SECONDS))
                    .containsOnly(Map.entry("request_id", "gehört dem fremden Faden"));
        } finally {
            fremd.shutdownNow();
        }
    }

    /** Ist die Quittung schon da, läuft der Rückruf im Faden des Handlers - dessen Kennungen bleiben stehen. */
    @Test
    void einSofortigerRueckrufNimmtDemHandlerNichtsWeg() {
        MDC.put("request_id", "läuft noch");
        MDC.put("tenant_id", MANDANT);

        CompletableFuture.completedFuture("ok").whenComplete(NachrichtenVorgang.fortsetzen((ergebnis, fehler) -> { }));

        assertThat(MDC.getCopyOfContextMap()).containsOnly(
                Map.entry("request_id", "läuft noch"), Map.entry("tenant_id", MANDANT));
    }

    /**
     * Die Verdrahtung im echten Dienst: der Interceptor liegt an JEDEM MQTT-Eingang, und die Zeile, die
     * ein echter Handler schreibt, trägt beide Kennungen.
     */
    @Nested
    @SpringBootTest(
            webEnvironment = SpringBootTest.WebEnvironment.NONE,
            properties = {
                "spring.integration.endpoints.no-auto-startup=*",
                // ohne Datenbank: die Sperre beendeter Kundenbereiche fragt sie sonst je Nachricht
                "voltpilot.kundenbereich-ende.enabled=false"
            })
    class ImDienst {

        /** Ob events.raw existiert - in diesem Test gibt es kein Redpanda. */
        @MockBean EventsTopicPruefung eventsTopic;

        @Autowired List<MqttPahoMessageDrivenChannelAdapter> adapter;

        @Autowired
        @Qualifier(MqttIngestConfig.INBOUND_CHANNEL)
        MessageChannel telemetrie;

        @Test
        void jederMqttEingangLiegtInDerKlammer() {
            assertThat(adapter).as("Telemetrie v1 und v2, Messwerte, Ereignisse, Box-Auskunft").hasSize(5);
            assertThat(adapter).allSatisfy(a -> assertThat(((InterceptableChannel) a.getOutputChannel()).getInterceptors())
                    .as("Kanal von %s", a.getBeanName())
                    .hasAtLeastOneElementOfType(NachrichtenVorgang.class));
        }

        @Test
        void dieZeileDesHandlersTraegtBeideKennungen() {
            ch.qos.logback.classic.Logger logger =
                    (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(TelemetryIngestHandler.class);
            // Das MDC gehört dem schreibenden Faden: beim Anhängen festhalten, nicht erst beim Nachsehen.
            ListAppender<ILoggingEvent> zeilen = new ListAppender<>() {
                @Override
                protected void append(ILoggingEvent zeile) {
                    zeile.prepareForDeferredProcessing();
                    super.append(zeile);
                }
            };
            zeilen.start();
            logger.addAppender(zeilen);
            try {
                Message<String> nachricht = nachricht(TOPIC);

                telemetrie.send(nachricht);

                List<ILoggingEvent> eigene = List.copyOf(zeilen.list).stream()
                        .filter(z -> z.getFormattedMessage().startsWith("Dropping malformed telemetry on '" + TOPIC))
                        .toList();
                assertThat(eigene).hasSize(1);
                assertThat(eigene.get(0).getMDCPropertyMap()).containsOnly(
                        Map.entry("request_id", nachricht.getHeaders().getId().toString()),
                        Map.entry("tenant_id", MANDANT));
            } finally {
                logger.detachAppender(zeilen);
            }
        }
    }
}
