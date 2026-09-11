package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.springframework.integration.acks.SimpleAcknowledgment;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.messaging.support.GenericMessage;

/**
 * Die Datenannahme von UEMS AP-07 IP-5 von MQTT bis Redpanda — rein, kein Docker (KafkaTemplate
 * als Attrappe, die jede Sendung festhält). Abnahmefall A13, „ein falsches Sample“, 91 Tage,
 * Nachlieferung, Kern-{@code seq}, Box-Umschläge; JEDES veröffentlichte {@code events.raw} besteht
 * den Schema-Läufer. Kennungen, Werte und Zeitpunkte aus dem Referenzunternehmen (Kennungen wie in
 * {@code events-vocabulary-vectors.json} {@code kennungen}); wo die Referenz schweigt, steht
 * „Annahme“ am Fall.
 */
class DatenannahmeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private static final Path V2 = Path.of("../../docs/contracts/v2");
    private static final Path EXAMPLES = V2.resolve("examples");

    private static final String KB_AHRENBERG = "a4e0b000-0000-4000-8000-000000000001";
    private static final String AN_1 = "a4e0b000-0000-4000-8000-0000000000a1";
    private static final String AN_3 = "a4e0b000-0000-4000-8000-0000000000a3";
    private static final String E_1 = "a4e0b000-0000-4000-8000-0000000000e1";
    private static final String E_3 = "a4e0b000-0000-4000-8000-0000000000e3";

    /** Eine Sendung an Redpanda. */
    private record Sendung(String topic, String key, JsonNode value) {}

    private final List<Sendung> sendungen = new ArrayList<>();
    private final SimpleAcknowledgment quittung = mock(SimpleAcknowledgment.class);
    /** Gibt es events.raw? Vorgabe ja; die Rückfall-Fälle schalten es ab. */
    private final EventsTopicPruefung eventsTopic = mock(EventsTopicPruefung.class);
    private final SimpleMeterRegistry metriken = new SimpleMeterRegistry();

    {
        when(eventsTopic.vorhanden()).thenReturn(true);
    }

    private EventsRawProducer producer(KafkaTemplate<String, String> kafka) {
        return new EventsRawProducer(MAPPER, kafka, "events.raw", eventsTopic, metriken);
    }

    /** Wie viele Ereignisse dieses Stroms nicht zugestellt wurden, weil events.raw fehlt. */
    private double nichtZugestellt(String strom) {
        var c = metriken.find(EventsRawProducer.NICHT_ZUGESTELLT)
                .tags("reason", "events_raw_missing", "strom", strom).counter();
        return c == null ? 0 : c.count();
    }

    @SuppressWarnings("unchecked")
    private KafkaTemplate<String, String> kafka(boolean eventsKaputt) {
        KafkaTemplate<String, String> kafka = mock(KafkaTemplate.class);
        when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(inv -> {
            String topic = inv.getArgument(0);
            if (eventsKaputt && "events.raw".equals(topic)) {
                return CompletableFuture.failedFuture(new IllegalStateException("redpanda unavailable"));
            }
            sendungen.add(new Sendung(topic, inv.getArgument(1), MAPPER.readTree((String) inv.getArgument(2))));
            return CompletableFuture.completedFuture(mock(SendResult.class));
        });
        return kafka;
    }

    private void messwerte(String topic, String payload, String eingang) {
        messwerte(topic, payload, eingang, false);
    }

    private void messwerte(String topic, String payload, String eingang, boolean eventsKaputt) {
        KafkaTemplate<String, String> kafka = kafka(eventsKaputt);
        new MeasurementIngestHandler(new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13), MAPPER,
                kafka, "measurements.raw", producer(kafka), uhr(eingang))
                .handle(new GenericMessage<>(payload), topic, quittung);
    }

    private static Clock uhr(String eingang) {
        return Clock.fixed(Instant.parse(eingang), ZoneOffset.UTC);
    }

    private List<JsonNode> auf(String topic) {
        return sendungen.stream().filter(s -> s.topic().equals(topic)).map(Sendung::value).toList();
    }

    /** Jedes events.raw besteht den Schema-Läufer und ist je Anlage geschlüsselt. */
    private List<JsonNode> ereignisse() throws Exception {
        JsonNode schema = MAPPER.readTree(Files.readString(V2.resolve("events-raw.event.schema.json")));
        List<JsonNode> out = new ArrayList<>();
        for (Sendung s : sendungen) {
            if (s.topic().equals("events.raw")) {
                assertThat(ContractSchemaRunner.violations(s.value(), schema)).as(s.value().toString()).isEmpty();
                assertThat(s.key()).isEqualTo(s.value().path("tenant_id").asText() + ":"
                        + s.value().path("site_id").asText());
                out.add(s.value());
            }
        }
        return out;
    }

    private static String topic(String tenant, String site, String box, String strom) {
        return "ems/" + tenant + "/" + site + "/" + box + "/v2/" + strom;
    }

    /** Ein Umschlag von Box Lindach (E-3, AN-3) mit dem Wert von K-11 „Wirkleistung“ (387 → 38,7 kW). */
    private static String lindach(long sequenz, String messzeit) {
        return "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + KB_AHRENBERG + "\",\"site_id\":\"" + AN_3
                + "\",\"device_id\":\"" + E_3 + "\",\"catalog_version\":\"2026.08.26.3\",\"sequence\":" + sequenz
                + ",\"observed_at\":\"" + messzeit + "\",\"samples\":[{\"point_key\":\"custom.wirkleistung\","
                + "\"raw\":387,\"decoded\":38.7,\"quality\":\"good\",\"observed_at\":\"" + messzeit + "\"}]}";
    }

    private static JsonNode vektorFall(String name) throws Exception {
        for (JsonNode c : MAPPER.readTree(Files.readString(V2.resolve("events-vocabulary-vectors.json")))
                .path("cases")) {
            if (c.path("name").asText().equals(name)) {
                return c;
            }
        }
        throw new AssertionError("Vektor-Fall fehlt: " + name);
    }

    /** Das Ereignis wie der Vektor-Fall — die Box als Kennung aus dem Topic, die ereignis_id der Datenannahme. */
    private static void wieDerVektorFall(JsonNode ereignis, String fall, String box) throws Exception {
        ObjectNode soll = (ObjectNode) vektorFall(fall).path("input").path("ereignis").deepCopy();
        soll.put("box", box);
        soll.set("ereignis_id", ereignis.path("ereignis_id"));
        assertThat(ereignis).isEqualTo(soll);
    }

    // ------------------------------------------------------------------ A13

    /**
     * A13: Box Lindach stempelt 14 min in der Zukunft → nichts weitergereicht, ein clock_ahead mit
     * Zählung (Vektor-Fall {@code lindach-uhr-14-minuten-vor}); nach Korrektur normale Werte.
     * Annahme: die Referenz nennt kein Paket nach der Korrektur — hier Paket 7817 um 08:30.
     */
    @Test
    void a13DieUhrDerBoxLindachGeht14MinutenVor() throws Exception {
        String t = topic(KB_AHRENBERG, AN_3, E_3, "measurement-samples");
        messwerte(t, lindach(7816, "2026-10-20T08:29:00Z"), "2026-10-20T08:15:00Z");

        assertThat(auf("measurements.raw")).as("keine Rohwerte in der Zukunft").isEmpty();
        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(1);
        JsonNode e = ereignisse.get(0);
        assertThat(e.path("urheber").asText()).isEqualTo("datenannahme");
        assertThat(e.path("tenant_id").asText()).isEqualTo(KB_AHRENBERG);
        assertThat(e.path("site_id").asText()).isEqualTo(AN_3);
        assertThat(e.path("ingested_at").asText()).isEqualTo("2026-10-20T08:15:00Z");
        assertThat(e.has("device_id") || e.has("source_topic")).as("nur Urheber box trägt den Umschlag").isFalse();
        wieDerVektorFall(e.path("ereignis"), "lindach-uhr-14-minuten-vor", E_3);
        verify(quittung).acknowledge();

        sendungen.clear();
        messwerte(t, lindach(7817, "2026-10-20T08:30:00Z"), "2026-10-20T08:30:03Z");
        assertThat(ereignisse()).isEmpty();
        List<JsonNode> werte = auf("measurements.raw");
        assertThat(werte).hasSize(1);
        assertThat(werte.get(0).path("sequence").asLong()).isEqualTo(7817L);
        assertThat(werte.get(0).path("samples").get(0).path("decoded").asDouble()).isEqualTo(38.7);
    }

    // ------------------------------------------------- ein falsches Sample

    /**
     * Ein Umschlag von Box Halle 1 (Paket 48213, MS-06 Z-5a) mit einem zweiten Sample OHNE
     * {@code raw}: der gültige Wert geht weiter, genau ein rejected mit Grund und Zählung.
     */
    @Test
    void einFalschesSampleVerwirftNurDiesesSample() throws Exception {
        Path datei = EXAMPLES.resolve("mqtt-measurement-samples-2.1.valid.ms06-letzter-wert-z5a.json");
        ObjectNode u = (ObjectNode) MAPPER.readTree(Files.readString(datei));
        ((com.fasterxml.jackson.databind.node.ArrayNode) u.get("samples")).add(MAPPER.readTree(
                "{\"point_key\":\"custom.wirkleistung\",\"quality\":\"good\",\"observed_at\":\"2026-11-18T09:39:00Z\"}"));
        messwerte(topic(KB_AHRENBERG, AN_1, E_1, "measurement-samples"), u.toString(), "2026-11-18T09:39:07Z");

        List<JsonNode> werte = auf("measurements.raw");
        assertThat(werte).hasSize(1);
        assertThat(werte.get(0).path("sequence").asLong()).isEqualTo(48213L);
        assertThat(werte.get(0).path("samples")).hasSize(1);
        assertThat(werte.get(0).path("samples").get(0).path("raw").asLong()).isEqualTo(10834152L);
        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(1);
        JsonNode e = ereignisse.get(0).path("ereignis");
        assertThat(e.path("art").asText()).isEqualTo("rejected");
        assertThat(e.path("grund").asText()).isEqualTo("schema_verletzt");
        assertThat(e.path("anzahl").asLong()).isEqualTo(1L);
        assertThat(e.path("sequenz").asLong()).isEqualTo(48213L);
        assertThat(e.path("strom").asText()).isEqualTo("measurement-samples");
        assertThat(e.path("box").asText()).isEqualTo(E_1);
        assertThat(e.path("zeitpunkt").asText()).isEqualTo("2026-11-18T09:39:07Z");
        verify(quittung).acknowledge();
    }

    // -------------------------------------------------- Vergangenheit

    /** 91 Tage + 1 h alt (Vektor-Fall {@code wert-91-tage-alt}, Herkunft {@code wert-91-tage-alt-too-old}). */
    @Test
    void einWert91TageAltWirdAbgewiesen() throws Exception {
        String payload = "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + KB_AHRENBERG + "\",\"site_id\":\""
                + AN_1 + "\",\"device_id\":\"" + E_1 + "\",\"catalog_version\":\"2026.08.26.3\",\"sequence\":6429,"
                + "\"observed_at\":\"2026-10-20T08:15:00Z\",\"samples\":[{\"point_key\":\"custom.wirkleistung\","
                + "\"raw\":1486,\"decoded\":148.6,\"quality\":\"good\"}]}";
        messwerte(topic(KB_AHRENBERG, AN_1, E_1, "measurement-samples"), payload, "2027-01-19T09:15:00Z");

        assertThat(auf("measurements.raw")).isEmpty();
        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(1);
        ObjectNode e = (ObjectNode) ereignisse.get(0).path("ereignis").deepCopy();
        assertThat(e.remove("anzahl").asLong()).isEqualTo(1L);
        wieDerVektorFall(e, "wert-91-tage-alt", E_1);
    }

    /**
     * Nachlieferung bleibt unberührt: das Paket 48285 von Box Halle 2 (Messzeit 03.11.2026 14:12)
     * geht zur Rückkehr um 17:31 (Referenz) wie drei Tage später (Annahme) durch — ohne Ereignis.
     */
    @Test
    void eineNachlieferungWirdAngenommen() throws Exception {
        Path datei = EXAMPLES.resolve("mqtt-measurement-samples.valid.box-halle-2-nachlieferung.json");
        JsonNode u = MAPPER.readTree(Files.readString(datei));
        String t = topic(u.path("tenant_id").asText(), u.path("site_id").asText(), u.path("device_id").asText(),
                "measurement-samples");
        for (String eingang : List.of("2026-11-03T17:31:00Z", "2026-11-06T14:12:00Z")) {
            sendungen.clear();
            messwerte(t, Files.readString(datei), eingang);
            assertThat(ereignisse()).as(eingang).isEmpty();
            assertThat(auf("measurements.raw")).as(eingang).hasSize(1);
            assertThat(auf("measurements.raw").get(0).path("observed_at").asText()).isEqualTo("2026-11-03T14:12:00Z");
        }
    }

    // ------------------------------------------------ der ganze Umschlag

    /** Nennt der Umschlag eine andere Box, gilt das Topic: das rejected geht an dessen Anlage. */
    @Test
    void einAbgewiesenerUmschlagHinterlaesstEinRejectedBeimAbsenderDesTopics() throws Exception {
        String t = topic(KB_AHRENBERG, AN_3, E_3, "measurement-samples");
        messwerte(t, lindach(7816, "2026-10-20T08:15:00Z").replace("\"device_id\":\"" + E_3, "\"device_id\":\"" + E_1),
                "2026-10-20T08:15:02Z");
        messwerte(t, "kein json", "2026-10-20T08:15:03Z");

        assertThat(auf("measurements.raw")).isEmpty();
        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(2);
        JsonNode kennung = ereignisse.get(0).path("ereignis");
        assertThat(ereignisse.get(0).path("site_id").asText()).isEqualTo(AN_3);
        assertThat(kennung.path("box").asText()).isEqualTo(E_3);
        assertThat(kennung.path("grund").asText()).isEqualTo("kennung_abweichend");
        assertThat(kennung.path("sequenz").asLong()).isEqualTo(7816L);
        assertThat(kennung.path("anzahl").asLong()).isEqualTo(1L);
        JsonNode unlesbar = ereignisse.get(1).path("ereignis");
        assertThat(unlesbar.path("grund").asText()).isEqualTo("schema_verletzt");
        assertThat(unlesbar.has("sequenz") || unlesbar.has("anzahl")).as("nie geraten").isFalse();
    }

    /** Dieselbe Zustellung zweimal (QoS 1) trägt dieselbe ereignis_id — die Wiederholung ist erkennbar. */
    @Test
    void eineWiederholungTraegtDieselbeEreignisId() throws Exception {
        String t = topic(KB_AHRENBERG, AN_3, E_3, "measurement-samples");
        messwerte(t, lindach(7816, "2026-10-20T08:29:00Z"), "2026-10-20T08:15:00Z");
        messwerte(t, lindach(7816, "2026-10-20T08:29:00Z"), "2026-10-20T08:15:40Z");
        messwerte(t, lindach(7818, "2026-10-20T08:29:10Z"), "2026-10-20T08:15:10Z");
        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(3);
        assertThat(ereignisse.get(1).path("ereignis").path("ereignis_id"))
                .isEqualTo(ereignisse.get(0).path("ereignis").path("ereignis_id"));
        assertThat(ereignisse.get(2).path("ereignis").path("ereignis_id"))
                .isNotEqualTo(ereignisse.get(0).path("ereignis").path("ereignis_id"));
        assertThat(ereignisse.get(1).path("event_id")).isNotEqualTo(ereignisse.get(0).path("event_id"));
    }

    /** Bestätigt Redpanda das Ereignis nicht, bleibt die Quittung aus — der Broker stellt erneut zu. */
    @Test
    void ohneBestaetigtesEreignisKeineQuittung() {
        assertThatThrownBy(() -> messwerte(topic(KB_AHRENBERG, AN_3, E_3, "measurement-samples"),
                lindach(7816, "2026-10-20T08:29:00Z"), "2026-10-20T08:15:00Z", true))
                .isInstanceOf(IllegalStateException.class);
        verify(quittung, never()).acknowledge();
    }

    // ------------------------------------- Rückfall: events.raw fehlt (Entscheid b07-recreate D)

    /**
     * Fehlt events.raw, wartet der Messwert-Weg nie darauf: der gültige Wert geht weiter und die
     * Zustellung wird quittiert; die Ablehnung steht nur im Log und wird gezählt — kein Ereignis.
     */
    @Test
    void fehltEventsRawLaufenDieMesswerteUndDieAblehnungWirdNurGezaehlt() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(false);
        Path datei = EXAMPLES.resolve("mqtt-measurement-samples-2.1.valid.ms06-letzter-wert-z5a.json");
        ObjectNode u = (ObjectNode) MAPPER.readTree(Files.readString(datei));
        ((com.fasterxml.jackson.databind.node.ArrayNode) u.get("samples")).add(MAPPER.readTree(
                "{\"point_key\":\"custom.wirkleistung\",\"quality\":\"good\",\"observed_at\":\"2026-11-18T09:39:00Z\"}"));
        messwerte(topic(KB_AHRENBERG, AN_1, E_1, "measurement-samples"), u.toString(), "2026-11-18T09:39:07Z");
        // A13 bei fehlendem Topic: nichts in der Zukunft, kein Ereignis, trotzdem quittiert.
        messwerte(topic(KB_AHRENBERG, AN_3, E_3, "measurement-samples"), lindach(7816, "2026-10-20T08:29:00Z"),
                "2026-10-20T08:15:00Z");

        assertThat(auf("measurements.raw")).hasSize(1);
        assertThat(auf("measurements.raw").get(0).path("samples")).hasSize(1);
        assertThat(auf("events.raw")).as("kein Ereignis ohne Topic").isEmpty();
        verify(quittung, org.mockito.Mockito.times(2)).acknowledge();
        assertThat(nichtZugestellt("measurement-samples")).isEqualTo(2.0);
    }

    /** Sobald die Prüfung das Topic findet, fließen die Ereignisse — und es wird wieder streng quittiert. */
    @Test
    void erscheintDasTopicFliessenDieEreignisse() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(false, true);
        String t = topic(KB_AHRENBERG, AN_3, E_3, "measurement-samples");
        messwerte(t, lindach(7816, "2026-10-20T08:29:00Z"), "2026-10-20T08:15:00Z");
        assertThat(ereignisse()).isEmpty();
        messwerte(t, lindach(7817, "2026-10-20T08:29:10Z"), "2026-10-20T08:15:10Z");
        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(1);
        assertThat(ereignisse.get(0).path("ereignis").path("sequenz").asLong()).isEqualTo(7817L);
        assertThat(nichtZugestellt("measurement-samples")).isEqualTo(1.0);
    }

    /** Der Kern-Pfad fällt genauso zurück: der gültige Kanal geht weiter, der falsche wird nur gezählt. */
    @Test
    void fehltEventsRawLaeuftDerKernWeiter() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(false);
        KafkaTemplate<String, String> kafka = kafka(false);
        new TelemetryV2IngestHandler(new TelemetryV2Validator(MAPPER, Messzeitregel.E13), MAPPER, kafka,
                "telemetry-v2.raw", producer(kafka), uhr("2026-07-18T11:31:00Z"))
                .handle(new GenericMessage<>(Files.readString(
                        EXAMPLES.resolve("mqtt-telemetry-2.0.valid.three-entities.json"))
                        .replace("\"soc_pct\": 62.5", "\"soc_pct\": \"62.5\"")),
                        topic("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002",
                                "00000000-0000-0000-0000-000000000003", "telemetry"));
        assertThat(auf("telemetry-v2.raw")).hasSize(1);
        assertThat(auf("events.raw")).isEmpty();
        assertThat(nichtZugestellt("telemetry")).isEqualTo(1.0);
    }

    // ------------------------------------------------------- Kern-Pfad

    /** Kern {@code seq} im telemetry-v2.raw-Ereignis; ohne seq fehlt das Feld (nie 0). Beide schema-gültig. */
    @Test
    void derKernReichtSeqWeiter() throws Exception {
        String t = topic("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002",
                "00000000-0000-0000-0000-000000000003", "telemetry");
        JsonNode schema = MAPPER.readTree(Files.readString(V2.resolve("telemetry-v2-raw.event.schema.json")));
        KafkaTemplate<String, String> kafka = kafka(false);
        var handler = new TelemetryV2IngestHandler(new TelemetryV2Validator(MAPPER, Messzeitregel.E13), MAPPER,
                kafka, "telemetry-v2.raw", producer(kafka),
                uhr("2026-07-18T11:31:00Z"));
        handler.handle(new GenericMessage<>(Files.readString(
                EXAMPLES.resolve("mqtt-telemetry-2.0.valid.three-entities.json"))), t);
        handler.handle(new GenericMessage<>(Files.readString(
                EXAMPLES.resolve("mqtt-telemetry-2.0.valid.single-entity.json"))), t);

        List<JsonNode> kern = auf("telemetry-v2.raw");
        assertThat(kern).hasSize(2);
        assertThat(kern.get(0).path("seq").asLong()).isEqualTo(4711L);
        assertThat(kern.get(1).has("seq")).isFalse();
        for (JsonNode e : kern) {
            assertThat(ContractSchemaRunner.violations(e, schema)).as(e.toString()).isEmpty();
        }
        assertThat(ereignisse()).isEmpty();

        // Ein Kanal als Text: nur er wird verworfen, als Ereignis mit strom telemetry und seq.
        sendungen.clear();
        handler.handle(new GenericMessage<>(Files.readString(
                EXAMPLES.resolve("mqtt-telemetry-2.0.valid.three-entities.json"))
                .replace("\"soc_pct\": 62.5", "\"soc_pct\": \"62.5\"")), t);
        assertThat(auf("telemetry-v2.raw").get(0).path("entities").path("5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f")
                .path("channels").has("soc_pct")).isFalse();
        JsonNode e = ereignisse().get(0).path("ereignis");
        assertThat(e.path("art").asText()).isEqualTo("rejected");
        assertThat(e.path("strom").asText()).isEqualTo("telemetry");
        assertThat(e.path("sequenz").asLong()).isEqualTo(4711L);
        assertThat(e.path("anzahl").asLong()).isEqualTo(1L);
    }

    // ------------------------------------------------------- Box-Weg

    private void boxEreignisse(String topic, String payload, String eingang) {
        KafkaTemplate<String, String> kafka = kafka(false);
        new BoxEventsIngestHandler(new BoxEventsValidator(MAPPER, Messzeitregel.E13),
                producer(kafka), uhr(eingang))
                .handle(new GenericMessage<>(payload), topic, quittung);
    }

    /** Ein Box-Umschlag mit zwei Einträgen → zwei events.raw mit Urheber box. */
    @Test
    void einBoxUmschlagWirdJeEintragEinEreignis() throws Exception {
        Path datei = EXAMPLES.resolve("mqtt-events-2.1.valid.restart.json");
        JsonNode u = MAPPER.readTree(Files.readString(datei));
        String t = topic(u.path("tenant_id").asText(), u.path("site_id").asText(), u.path("device_id").asText(),
                "events");
        boxEreignisse(t, Files.readString(datei), "2027-02-01T07:01:31Z");

        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(2);
        assertThat(ereignisse).allSatisfy(e -> {
            assertThat(e.path("urheber").asText()).isEqualTo("box");
            assertThat(e.path("source_topic").asText()).isEqualTo(t);
            assertThat(e.path("ereignis").path("box").asText()).isEqualTo(u.path("device_id").asText());
        });
        assertThat(ereignisse.get(0).path("ereignis").path("art").asText()).isEqualTo("box_restart");
        assertThat(ereignisse.get(1).path("ereignis").path("art").asText()).isEqualTo("device_restart");
        verify(quittung).acknowledge();
    }

    /** Ein ungültiger Box-Umschlag (die Box meldet eine Übergabe) → EIN rejected mit Grund, kein Eintrag. */
    @Test
    void einUngueltigerBoxUmschlagHinterlaesstEinRejected() throws Exception {
        Path datei = EXAMPLES.resolve("mqtt-events-2.1.invalid.handover-from-box.json");
        JsonNode u = MAPPER.readTree(Files.readString(datei));
        String t = topic(u.path("tenant_id").asText(), u.path("site_id").asText(), u.path("device_id").asText(),
                "events");
        boxEreignisse(t, Files.readString(datei), "2027-04-10T05:31:06Z");

        List<JsonNode> ereignisse = ereignisse();
        assertThat(ereignisse).hasSize(1);
        assertThat(ereignisse.get(0).path("urheber").asText()).isEqualTo("datenannahme");
        JsonNode e = ereignisse.get(0).path("ereignis");
        assertThat(e.path("art").asText()).isEqualTo("rejected");
        assertThat(e.path("grund").asText()).isEqualTo("urheber_unzulaessig");
        assertThat(e.path("strom").asText()).isEqualTo("events");
        assertThat(e.path("box").asText()).isEqualTo(u.path("device_id").asText());
        assertThat(e.path("sequenz").asLong()).isEqualTo(u.path("sequence").asLong());
        assertThat(e.path("anzahl").asLong()).isEqualTo(u.path("events").size());
        verify(quittung).acknowledge();
    }
}
