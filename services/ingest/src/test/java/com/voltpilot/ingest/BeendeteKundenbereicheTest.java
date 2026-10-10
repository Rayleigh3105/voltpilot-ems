package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.integration.acks.SimpleAcknowledgment;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.messaging.support.GenericMessage;

/**
 * UEMS AP-20 IP-16 (E10 = A, §5.5): der Eingang verwirft Umschläge eines beendeten Kundenbereichs mit Zählung
 * ({@code verworfen{grund="kundenbereich_beendet"}}) — auf allen vier Strömen, ohne Nutzlast und ohne
 * {@code rejected}-Ereignis, quittiert. Ein aktiver Kundenbereich nebenan läuft unverändert.
 *
 * <p>Rein, kein Docker: Kafka ist eine Attrappe, die jede Sendung zählt; der Stand kommt von Hand.
 */
class BeendeteKundenbereicheTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private static final UUID BEENDET = UUID.fromString("00000000-0000-0000-0000-0000000000b1");
    private static final UUID AKTIV = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String BOX = "00000000-0000-0000-0000-000000000003";

    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    private final Clock uhr = Clock.fixed(Instant.parse("2029-07-01T08:00:00Z"), ZoneOffset.UTC);
    private final IngestMetriken metriken = new IngestMetriken(registry, uhr);
    private final AtomicInteger sendungen = new AtomicInteger();
    private final SimpleAcknowledgment quittung = mock(SimpleAcknowledgment.class);
    private final BeendeteKundenbereiche beendete = new BeendeteKundenbereiche(() -> Set.of(BEENDET), uhr);

    @SuppressWarnings("unchecked")
    private KafkaTemplate<String, String> kafka() {
        KafkaTemplate<String, String> kafka = mock(KafkaTemplate.class);
        when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(inv -> {
            sendungen.incrementAndGet();
            return java.util.concurrent.CompletableFuture.completedFuture(null);
        });
        return kafka;
    }

    private EventsRawProducer producer(KafkaTemplate<String, String> kafka) {
        EventsTopicPruefung topic = mock(EventsTopicPruefung.class);
        when(topic.vorhanden()).thenReturn(true);
        return new EventsRawProducer(MAPPER, kafka, "events.raw", topic, registry);
    }

    private static String topic(UUID tenant, String rest) {
        return "ems/" + tenant + "/" + SITE + "/" + BOX + rest;
    }

    private double verworfen(String strom) {
        return registry.get(IngestMetriken.VERWORFEN).tag("strom", strom)
                .tag("grund", IngestMetriken.KUNDENBEREICH_BEENDET).counter().count();
    }

    @Test
    void jederStromVerwirftDenBeendetenBereichMitZaehlungUndOhneSendung() {
        KafkaTemplate<String, String> kafka = kafka();

        TelemetryIngestHandler v1 = new TelemetryIngestHandler(new TelemetryValidator(MAPPER), MAPPER, kafka,
                "telemetry.raw", uhr, metriken);
        v1.setBeendeteKundenbereiche(beendete);
        v1.handle(new GenericMessage<>("{kein json"), topic(BEENDET, "/telemetry"));

        TelemetryV2IngestHandler v2 = new TelemetryV2IngestHandler(new TelemetryV2Validator(MAPPER, Messzeitregel.E13),
                MAPPER, kafka, "telemetry-v2.raw", producer(kafka), uhr, metriken);
        v2.setBeendeteKundenbereiche(beendete);
        v2.handle(new GenericMessage<>("{kein json"), topic(BEENDET, "/v2/telemetry"));

        MeasurementIngestHandler messwerte = new MeasurementIngestHandler(
                new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13), MAPPER, kafka, "measurements.raw",
                producer(kafka), uhr, metriken);
        messwerte.setBeendeteKundenbereiche(beendete);
        messwerte.handle(new GenericMessage<>("{kein json"), topic(BEENDET, "/v2/measurement-samples"), quittung);

        BoxEventsIngestHandler ereignisse = new BoxEventsIngestHandler(
                new BoxEventsValidator(MAPPER, Messzeitregel.E13), producer(kafka), uhr, metriken);
        ereignisse.setBeendeteKundenbereiche(beendete);
        ereignisse.handle(new GenericMessage<>("{kein json"), topic(BEENDET, "/v2/events"), quittung);

        assertThat(verworfen(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.MEASUREMENTS)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.EVENTS)).isEqualTo(1);
        // Nichts ging hinaus — auch keine Abweisungs-Meldung auf events.raw (sie wäre ein Schreibweg in den Bereich).
        assertThat(sendungen.get()).isZero();
        // Die QoS-1-Zustellung ist quittiert: die Box schickt denselben Umschlag nicht endlos nach.
        verify(quittung, org.mockito.Mockito.times(2)).acknowledge();
    }

    @Test
    void einAktiverBereichNebenanLaeuftWieVorher() {
        KafkaTemplate<String, String> kafka = kafka();
        TelemetryV2IngestHandler v2 = new TelemetryV2IngestHandler(new TelemetryV2Validator(MAPPER, Messzeitregel.E13),
                MAPPER, kafka, "telemetry-v2.raw", producer(kafka), uhr, metriken);
        v2.setBeendeteKundenbereiche(beendete);

        v2.handle(new GenericMessage<>("{kein json"), topic(AKTIV, "/v2/telemetry"));

        assertThat(verworfen(IngestMetriken.TELEMETRY_V2)).isZero();
        assertThat(registry.get(IngestMetriken.VERWORFEN).tag("strom", IngestMetriken.TELEMETRY_V2)
                .tag("grund", IngestMetriken.UNGUELTIG).counter().count()).as("die gewohnte Prüfung lief").isEqualTo(1);
        assertThat(sendungen.get()).as("die Abweisungs-Meldung ging wie immer hinaus").isEqualTo(1);
    }

    @Test
    void derStandGiltEineMinuteUndEinLesefehlerBehaeltDenLetzten() {
        AtomicReference<Instant> jetzt = new AtomicReference<>(Instant.parse("2029-07-01T08:00:00Z"));
        Clock laufend = new Clock() {
            @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
            @Override public Clock withZone(java.time.ZoneId zone) { return this; }
            @Override public Instant instant() { return jetzt.get(); }
        };
        AtomicInteger lesungen = new AtomicInteger();
        AtomicReference<Set<UUID>> db = new AtomicReference<>(Set.of(BEENDET));
        BeendeteKundenbereiche stand = new BeendeteKundenbereiche(() -> {
            lesungen.incrementAndGet();
            Set<UUID> s = db.get();
            if (s == null) {
                throw new IllegalStateException("Datenbank weg");
            }
            return s;
        }, laufend);

        assertThat(stand.beendet(topic(BEENDET, "/v2/telemetry"))).isTrue();
        assertThat(stand.beendet(topic(AKTIV, "/v2/telemetry"))).isFalse();
        assertThat(lesungen.get()).as("ein Lesen je Minute, nicht je Umschlag").isEqualTo(1);

        db.set(null);
        jetzt.set(jetzt.get().plusSeconds(61));
        assertThat(stand.beendet(topic(BEENDET, "/v2/telemetry"))).as("der letzte Stand bleibt").isTrue();

        db.set(Set.of());
        jetzt.set(jetzt.get().plusSeconds(61));
        assertThat(stand.beendet(topic(BEENDET, "/v2/telemetry"))).as("wieder aufgenommen").isFalse();
        assertThat(lesungen.get()).isEqualTo(3);
    }

    @Test
    void einTopicOhneKennungGehoertKeinemBereich() {
        assertThat(BeendeteKundenbereiche.kundenbereich("ems/" + BEENDET + "/x/y/v2/events")).isEqualTo(BEENDET);
        assertThat(BeendeteKundenbereiche.kundenbereich("ems/kein-uuid/x")).isNull();
        assertThat(BeendeteKundenbereiche.kundenbereich("provision/VP-1/hello")).isNull();
        assertThat(BeendeteKundenbereiche.kundenbereich(null)).isNull();
        verify(quittung, never()).acknowledge();
    }
}
