package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.core.util.Separators;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.springframework.integration.acks.SimpleAcknowledgment;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.messaging.support.GenericMessage;

/**
 * Die Ingest-Hälfte von {@code docs/contracts/v2/datenannahme-events-vectors.json} (UEMS AP-07
 * IP-5 × IP-8): aus jedem {@code input} (Topic, Umschlag, Eingangszeit) erzeugt die Datenannahme
 * GENAU die {@code expected.events_raw}-Nachrichten ({@code event_id} ausgenommen) und reicht
 * {@code expected.weiter} Werte weiter. Die Writer-Hälfte ({@code DatenannahmeNachrichtenTest})
 * beweist, dass {@code EventsRawConsumer} jede dieser Nachrichten annimmt.
 *
 * <p>Wer die Datenannahme ändert, erzeugt {@code expected} neu:
 * {@code ./mvnw test -Dtest=DatenannahmeVektorenTest -Dvektoren.schreiben=true} — und prüft den
 * Diff der Vektor-Datei, bevor der Writer-Test sie annehmen muss.
 */
class DatenannahmeVektorenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final Path DATEI = V2.resolve("datenannahme-events-vectors.json");

    private record Ergebnis(long weiter, ArrayNode eventsRaw) {}

    @SuppressWarnings("unchecked")
    private static Ergebnis lauf(JsonNode input) throws Exception {
        List<String[]> sendungen = new ArrayList<>();
        KafkaTemplate<String, String> kafka = mock(KafkaTemplate.class);
        when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(inv -> {
            sendungen.add(new String[] {inv.getArgument(0), inv.getArgument(2)});
            return CompletableFuture.completedFuture(mock(SendResult.class));
        });
        EventsTopicPruefung eventsTopic = mock(EventsTopicPruefung.class);
        when(eventsTopic.vorhanden()).thenReturn(true);
        EventsRawProducer producer =
                new EventsRawProducer(MAPPER, kafka, "events.raw", eventsTopic, new SimpleMeterRegistry());
        Clock uhr = Clock.fixed(Instant.parse(input.path("eingang").asText()), ZoneOffset.UTC);
        String topic = input.path("topic").asText();
        String payload = input.has("payload_text") ? input.get("payload_text").asText()
                : MAPPER.writeValueAsString(input.get("payload"));
        GenericMessage<String> nachricht = new GenericMessage<>(payload);
        SimpleAcknowledgment quittung = mock(SimpleAcknowledgment.class);
        switch (topic.substring(topic.lastIndexOf('/') + 1)) {
            case "measurement-samples" -> new MeasurementIngestHandler(
                    new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13), MAPPER, kafka,
                    "measurements.raw", producer, uhr, new IngestMetriken(new SimpleMeterRegistry(), uhr))
                    .handle(nachricht, topic, quittung);
            case "telemetry" -> new TelemetryV2IngestHandler(
                    new TelemetryV2Validator(MAPPER, Messzeitregel.E13), MAPPER, kafka,
                    "telemetry-v2.raw", producer, uhr, new IngestMetriken(new SimpleMeterRegistry(), uhr))
                    .handle(nachricht, topic);
            case "events" -> new BoxEventsIngestHandler(
                    new BoxEventsValidator(MAPPER, Messzeitregel.E13), producer, uhr,
                    new IngestMetriken(new SimpleMeterRegistry(), uhr))
                    .handle(nachricht, topic, quittung);
            default -> throw new AssertionError("unbekannter Strom: " + topic);
        }
        long weiter = 0;
        ArrayNode eventsRaw = MAPPER.createArrayNode();
        for (String[] s : sendungen) {
            JsonNode value = MAPPER.readTree(s[1]);
            switch (s[0]) {
                case "measurements.raw" -> weiter += value.path("samples").size();
                case "telemetry-v2.raw" -> {
                    for (JsonNode e : value.path("entities")) {
                        weiter += e.path("channels").size();
                    }
                }
                case "events.raw" -> {
                    if ("box".equals(value.path("urheber").asText())) {
                        weiter++;
                    }
                    ((ObjectNode) value).remove("event_id");
                    eventsRaw.add(value);
                }
                default -> throw new AssertionError(s[0]);
            }
        }
        return new Ergebnis(weiter, eventsRaw);
    }

    @Test
    void derCodeErzeugtGenauDieNachrichtenDerVektorDatei() throws Exception {
        ObjectNode doc = (ObjectNode) MAPPER.readTree(Files.readString(DATEI));
        JsonNode schema = MAPPER.readTree(Files.readString(V2.resolve("events-raw.event.schema.json")));
        boolean schreiben = Boolean.getBoolean("vektoren.schreiben");
        List<String> abweichungen = new ArrayList<>();
        Set<String> arten = new HashSet<>();
        Set<String> gruende = new HashSet<>();
        for (JsonNode c : doc.path("cases")) {
            Ergebnis e = lauf(c.path("input"));
            ObjectNode expected = (ObjectNode) c.path("expected");
            if (schreiben) {
                expected.put("weiter", e.weiter());
                expected.set("events_raw", e.eventsRaw());
            } else if (expected.path("weiter").asLong(-1) != e.weiter()
                    || !expected.path("events_raw").equals(e.eventsRaw())) {
                abweichungen.add(c.path("name").asText() + ": weiter " + e.weiter() + ", events.raw "
                        + e.eventsRaw());
            }
            for (JsonNode r : e.eventsRaw()) {
                ObjectNode mitId = r.deepCopy();
                mitId.put("event_id", "5e7a0000-0000-4000-8000-00000000ffff");
                assertThat(ContractSchemaRunner.violations(mitId, schema)).as(c.path("name").asText()).isEmpty();
                arten.add(r.path("ereignis").path("art").asText());
                if (r.path("ereignis").has("grund")) {
                    gruende.add(r.path("ereignis").path("grund").asText());
                }
            }
        }
        if (schreiben) {
            DefaultPrettyPrinter pp = new DefaultPrettyPrinter(Separators.createDefaultInstance()
                    .withObjectFieldValueSpacing(Separators.Spacing.AFTER))
                    .withArrayIndenter(DefaultIndenter.SYSTEM_LINEFEED_INSTANCE);
            Files.writeString(DATEI, MAPPER.writer(pp).writeValueAsString(doc) + "\n");
        }
        assertThat(abweichungen).isEmpty();
        // Jede Art und jeder Grund, den die Datenannahme erzeugen kann, steht mindestens einmal drin.
        assertThat(arten).containsExactlyInAnyOrder("clock_ahead", "too_old", "rejected", "box_restart",
                "device_restart", "frozen_source", "range_limit", "layout_changed", "data_gap");
        assertThat(gruende).containsExactlyInAnyOrder("schema_verletzt", "wort_unbekannt", "regel_verletzt",
                "kennung_abweichend", "fassung_unbekannt", "urheber_unzulaessig", "zeit_ungueltig");
    }
}
