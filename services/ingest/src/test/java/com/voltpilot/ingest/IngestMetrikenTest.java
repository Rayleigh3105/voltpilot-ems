package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
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
 * Die vier Verwerf-Stellen der Datenannahme sind zaehlbar — und das Verhalten ist dabei
 * unveraendert geblieben (PR 972 hat sie gefunden, dieses Paket macht sie abholbar).
 *
 * <p>Jeder Fall prueft BEIDES: genau ein Zuwachs mit dem richtigen {@code grund} UND dass die
 * Nachricht weiterhin nicht weitergereicht wird. Ein Zaehler, der eine Nachricht rettet oder
 * verschluckt, waere auf dem Kernweg der steuernden Bestandsanlagen der schlimmste Fehler dieses
 * Pakets.
 *
 * <p>Rein, kein Docker: das {@link KafkaTemplate} ist eine Attrappe, die jede Sendung festhaelt
 * (dieselbe Bauart wie {@code DatenannahmeTest}).
 */
class IngestMetrikenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private static final Path EXAMPLES = Path.of("../../docs/contracts/v2/examples");

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String FREMDE_BOX = "00000000-0000-0000-0000-0000000000ff";

    private static final String EREIGNIS_KB = "a4e0b000-0000-4000-8000-000000000001";
    private static final String EREIGNIS_AN = "a4e0b000-0000-4000-8000-0000000000a2";
    private static final String EREIGNIS_BOX = "a4e0b000-0000-4000-8000-0000000002e2";

    private record Sendung(String topic, String key, String value) {}

    private final List<Sendung> sendungen = new ArrayList<>();
    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    /**
     * Jeder Beispiel-Umschlag hat seinen eigenen Zeitpunkt, und die Messzeitregel E13 weist eine
     * Uhr weit vor oder mehr als 90 Tage zurueck ab. Darum eine Uhr je Strom - sonst misst der
     * Test die Zeitregel statt der Zaehler.
     */
    private final Clock uhr = Clock.fixed(Instant.parse("2026-08-25T12:00:11Z"), ZoneOffset.UTC);

    private static final Clock UHR_EREIGNIS =
            Clock.fixed(Instant.parse("2027-02-01T07:01:35Z"), ZoneOffset.UTC);
    private final IngestMetriken metriken = new IngestMetriken(registry, uhr);
    private final SimpleAcknowledgment quittung = mock(SimpleAcknowledgment.class);
    private final EventsTopicPruefung eventsTopic = mock(EventsTopicPruefung.class);

    {
        when(eventsTopic.vorhanden()).thenReturn(true);
    }

    // ---------------------------------------------------------------- Aufbau

    @SuppressWarnings("unchecked")
    private KafkaTemplate<String, String> kafka() {
        KafkaTemplate<String, String> kafka = mock(KafkaTemplate.class);
        when(kafka.send(anyString(), anyString(), anyString())).thenAnswer(inv -> {
            sendungen.add(new Sendung(inv.getArgument(0), inv.getArgument(1), inv.getArgument(2)));
            return CompletableFuture.completedFuture(mock(SendResult.class));
        });
        return kafka;
    }

    private EventsRawProducer producer(KafkaTemplate<String, String> kafka) {
        return new EventsRawProducer(MAPPER, kafka, "events.raw", eventsTopic, registry);
    }

    private static String v2Topic(String tenant, String site, String box, String strom) {
        return "ems/" + tenant + "/" + site + "/" + box + "/v2/" + strom;
    }

    private static String beispiel(String datei) throws Exception {
        return Files.readString(EXAMPLES.resolve(datei));
    }

    private static String v1Payload() {
        return "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"ts\":\"2026-08-25T12:00:10Z\",\"seq\":24,"
                + "\"measurements\":{\"power_kw\":2.29}}";
    }

    // -------------------------------------------------------------- Ablesung

    private double zaehler(String name, String... tags) {
        var c = registry.find(name).tags(tags).counter();
        return c == null ? 0 : c.count();
    }

    private double angenommen(String strom) {
        return zaehler(IngestMetriken.ANGENOMMEN, "strom", strom);
    }

    private double weitergereicht(String strom) {
        return zaehler(IngestMetriken.WEITERGEREICHT, "strom", strom);
    }

    private double verworfen(String strom, String grund) {
        return zaehler(IngestMetriken.VERWORFEN, "strom", strom, "grund", grund);
    }

    /** Summe ueber ALLE Gruende - so faellt auch ein Zuwachs am falschen Label auf. */
    private double verworfenGesamt(String strom) {
        return registry.find(IngestMetriken.VERWORFEN).tags("strom", strom).counters()
                .stream().mapToDouble(c -> c.count()).sum();
    }

    private double alter(String strom) {
        Gauge g = registry.find(IngestMetriken.SCHREIBZUG_ALTER).tags("strom", strom).gauge();
        return g == null ? Double.NaN : g.value();
    }

    private List<Sendung> an(String topic) {
        return sendungen.stream().filter(s -> s.topic().equals(topic)).toList();
    }

    // ------------------------------------------------------------ Der Export

    /**
     * Ab Prozessstart sind alle geschlossenen Reihen als {@code 0} da (sonst kann eine Regel
     * „Zuwachs > 0" nie feuern, weil die Reihe erst mit dem ersten Fehler entsteht) - und keine
     * einzige traegt eine Kennung.
     */
    @Test
    void alleReihenStehenAbStartAufNullUndTragenKeineKennung() {
        PrometheusMeterRegistry prometheus = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new IngestMetriken(prometheus, uhr);

        List<String> zeilen = prometheus.scrape().lines()
                .filter(l -> l.startsWith("voltpilot_ingest_"))
                .filter(l -> !l.startsWith("#"))
                .toList();

        assertThat(zeilen.stream().filter(l -> l.startsWith("voltpilot_ingest_angenommen_total")))
                .hasSize(4).allMatch(l -> l.endsWith(" 0.0"));
        assertThat(zeilen.stream().filter(l -> l.startsWith("voltpilot_ingest_weitergereicht_total")))
                .hasSize(4).allMatch(l -> l.endsWith(" 0.0"));
        // vier Stroeme x vier Gruende (seit AP-20 IP-16 mit kundenbereich_beendet)
        assertThat(zeilen.stream().filter(l -> l.startsWith("voltpilot_ingest_verworfen_total")))
                .hasSize(16).allMatch(l -> l.endsWith(" 0.0"));

        assertThat(zeilen).allSatisfy(zeile ->
                assertThat(zeile).doesNotContain(TENANT, SITE, DEVICE, EREIGNIS_KB, EREIGNIS_BOX));
    }

    /** Ohne bestaetigten Schreibzug KEIN erfundenes Alter 0 - sonst sieht ein toter Strom frisch aus. */
    @Test
    void dasAlterIstNaNBisZumErstenBestaetigtenSchreibzug() {
        PrometheusMeterRegistry prometheus = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new IngestMetriken(prometheus, uhr);

        assertThat(prometheus.scrape())
                .contains("voltpilot_ingest_letzter_schreibzug_age_seconds")
                .doesNotContain("voltpilot_ingest_letzter_schreibzug_age_seconds{strom=\"telemetry\",} 0.0");
        assertThat(alter(IngestMetriken.TELEMETRY)).isNaN();
    }

    // ------------------------------------------- Stelle 1: v1-Telemetrie (Kernweg)

    private void v1(String topic, String payload, ObjectMapper mapper, KafkaTemplate<String, String> kafka) {
        new TelemetryIngestHandler(new TelemetryValidator(MAPPER), mapper, kafka, "telemetry.raw",
                uhr, metriken).handle(new GenericMessage<>(payload), topic);
    }

    @Test
    void ungueltigeV1TelemetrieZaehltEinmalUndWirdNichtWeitergereicht() {
        KafkaTemplate<String, String> kafka = kafka();

        v1("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry", "{kein json", MAPPER, kafka);

        assertThat(angenommen(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.TELEMETRY, IngestMetriken.UNGUELTIG)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.TELEMETRY)).isZero();
        verify(kafka, never()).send(anyString(), anyString(), anyString());
        assertThat(alter(IngestMetriken.TELEMETRY)).as("nichts geschrieben, also kein Alter").isNaN();
    }

    /**
     * Die zweite Haelfte der Stelle {@code TelemetryIngestHandler.java:59-70}: ein Umschlag, der
     * die Pruefung besteht, sich aber nicht serialisieren laesst. Bis hierher nur eine WARN-Zeile.
     */
    @Test
    void scheiterndeSerialisierungDerV1TelemetrieZaehltAlsSerialisierung() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();
        ObjectMapper kaputt = mock(ObjectMapper.class);
        when(kaputt.writeValueAsString(org.mockito.ArgumentMatchers.any()))
                .thenThrow(new JsonProcessingException("kein Schreiber") {});

        v1("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry", v1Payload(), kaputt, kafka);

        assertThat(verworfen(IngestMetriken.TELEMETRY, IngestMetriken.SERIALISIERUNG)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.TELEMETRY)).isZero();
        verify(kafka, never()).send(anyString(), anyString(), anyString());
    }

    @Test
    void gueltigeV1TelemetrieZaehltAngenommenUndWeitergereichtAberNichtVerworfen() {
        KafkaTemplate<String, String> kafka = kafka();

        v1("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry", v1Payload(), MAPPER, kafka);

        assertThat(angenommen(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY)).isZero();
        assertThat(an("telemetry.raw")).hasSize(1);
        // Redpanda hat quittiert, also bewegt sich jetzt auch das Alter.
        assertThat(alter(IngestMetriken.TELEMETRY)).isEqualTo(0d);
    }

    // ------------------------------------------------ Stelle 2: v2-Telemetrie

    private void v2(String topic, String payload, ObjectMapper mapper, KafkaTemplate<String, String> kafka) {
        new TelemetryV2IngestHandler(new TelemetryV2Validator(MAPPER, Messzeitregel.E13), mapper, kafka,
                "telemetry-v2.raw", producer(kafka), uhr, metriken)
                .handle(new GenericMessage<>(payload), topic);
    }

    @Test
    void abgewiesenerV2UmschlagZaehltEinmalUndErreichtTelemetryV2RawNicht() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        v2(v2Topic(TENANT, SITE, DEVICE, "telemetry"), "{kein json", MAPPER, kafka);

        assertThat(angenommen(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.TELEMETRY_V2, IngestMetriken.UNGUELTIG)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.TELEMETRY_V2)).isZero();
        assertThat(an("telemetry-v2.raw")).isEmpty();
    }

    /** Eine Box unter dem Topic einer anderen: das ist {@code identitaet}, nicht {@code ungueltig}. */
    @Test
    void v2UnterFremdemTopicZaehltAlsIdentitaet() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        v2(v2Topic(TENANT, SITE, FREMDE_BOX, "telemetry"),
                beispiel("mqtt-telemetry-2.0.valid.single-entity.json"), MAPPER, kafka);

        assertThat(verworfen(IngestMetriken.TELEMETRY_V2, IngestMetriken.IDENTITAET)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(an("telemetry-v2.raw")).isEmpty();
    }

    /**
     * {@code TelemetryV2IngestHandler.java:87-89} war die EINZIGE Stelle im ingest ganz ohne
     * Zaehler - nicht einmal ein prozessinterner {@code AtomicLong} lief mit.
     */
    @Test
    void scheiterndeSerialisierungDerV2TelemetrieZaehltAlsSerialisierung() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();
        ObjectMapper kaputt = mock(ObjectMapper.class);
        when(kaputt.writeValueAsString(org.mockito.ArgumentMatchers.any()))
                .thenThrow(new JsonProcessingException("kein Schreiber") {});

        v2(v2Topic(TENANT, SITE, DEVICE, "telemetry"),
                beispiel("mqtt-telemetry-2.0.valid.single-entity.json"), kaputt, kafka);

        assertThat(verworfen(IngestMetriken.TELEMETRY_V2, IngestMetriken.SERIALISIERUNG)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.TELEMETRY_V2)).isZero();
        assertThat(an("telemetry-v2.raw")).isEmpty();
    }

    @Test
    void gueltigeV2TelemetrieWirdWeitergereicht() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        v2(v2Topic(TENANT, SITE, DEVICE, "telemetry"),
                beispiel("mqtt-telemetry-2.0.valid.single-entity.json"), MAPPER, kafka);

        assertThat(angenommen(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY_V2)).isZero();
        assertThat(an("telemetry-v2.raw")).hasSize(1);
    }

    // ------------------------------------------------- Stelle 3: Messwerte

    private void messwerte(String topic, String payload, KafkaTemplate<String, String> kafka) {
        new MeasurementIngestHandler(new MeasurementSamplesValidator(MAPPER, Messzeitregel.E13), MAPPER,
                kafka, "measurements.raw", producer(kafka), uhr, metriken)
                .handle(new GenericMessage<>(payload), topic, quittung);
    }

    @Test
    void abgewiesenerMesswertUmschlagZaehltEinmalUndErreichtMeasurementsRawNicht() {
        KafkaTemplate<String, String> kafka = kafka();

        messwerte(v2Topic(TENANT, SITE, DEVICE, "measurement-samples"), "{kein json", kafka);

        assertThat(angenommen(IngestMetriken.MEASUREMENTS)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.MEASUREMENTS, IngestMetriken.UNGUELTIG)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.MEASUREMENTS)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.MEASUREMENTS)).isZero();
        assertThat(an("measurements.raw")).isEmpty();
    }

    @Test
    void messwerteUnterFremdemTopicZaehlenAlsIdentitaet() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        messwerte(v2Topic(TENANT, SITE, FREMDE_BOX, "measurement-samples"),
                beispiel("mqtt-measurement-samples.valid.json"), kafka);

        assertThat(verworfen(IngestMetriken.MEASUREMENTS, IngestMetriken.IDENTITAET)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.MEASUREMENTS)).isEqualTo(1);
        assertThat(an("measurements.raw")).isEmpty();
    }

    @Test
    void gueltigeMesswerteWerdenWeitergereicht() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        messwerte(v2Topic(TENANT, SITE, DEVICE, "measurement-samples"),
                beispiel("mqtt-measurement-samples.valid.json"), kafka);

        assertThat(angenommen(IngestMetriken.MEASUREMENTS)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.MEASUREMENTS)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.MEASUREMENTS)).isZero();
        assertThat(an("measurements.raw")).hasSize(1);
        assertThat(alter(IngestMetriken.MEASUREMENTS)).isEqualTo(0d);
    }

    // --------------------------------------------- Stelle 4: Box-Ereignisse

    private void boxEreignisse(String topic, String payload, KafkaTemplate<String, String> kafka) {
        new BoxEventsIngestHandler(new BoxEventsValidator(MAPPER, Messzeitregel.E13), producer(kafka),
                UHR_EREIGNIS, metriken).handle(new GenericMessage<>(payload), topic, quittung);
    }

    @Test
    void abgewiesenerBoxUmschlagZaehltEinmal() {
        KafkaTemplate<String, String> kafka = kafka();

        boxEreignisse(v2Topic(EREIGNIS_KB, EREIGNIS_AN, EREIGNIS_BOX, "events"), "{kein json", kafka);

        assertThat(angenommen(IngestMetriken.EVENTS)).isEqualTo(1);
        assertThat(verworfen(IngestMetriken.EVENTS, IngestMetriken.UNGUELTIG)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.EVENTS)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.EVENTS)).isZero();
        // Der Umschlag selbst geht nicht durch; die Abweisung meldet der ingest als rejected.
        assertThat(an("events.raw")).as("nur die Abweisungs-Meldung").hasSize(1);
    }

    @Test
    void gueltigeBoxEreignisseWerdenWeitergereicht() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        boxEreignisse(v2Topic(EREIGNIS_KB, EREIGNIS_AN, EREIGNIS_BOX, "events"),
                beispiel("mqtt-events-2.1.valid.restart.json"), kafka);

        assertThat(angenommen(IngestMetriken.EVENTS)).isEqualTo(1);
        assertThat(weitergereicht(IngestMetriken.EVENTS)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.EVENTS)).isZero();
        assertThat(an("events.raw")).isNotEmpty();
    }

    // ------------------------------------------------------- Die Abgrenzung

    /**
     * Abgelehnte TEILWERTE sind kein stiller Verlust: sie gehen als Ereignis auf {@code events.raw}
     * heraus. Sie duerfen deshalb NICHT als verworfener Umschlag zaehlen - sonst zaehlt der
     * Betreiber dieselbe Ablehnung zweimal und jede Regel „Verwerfungen > 0" feuert im Normalbetrieb.
     * Genau diese Trennung hat PR 972 beim Writer gezogen.
     */
    @Test
    void abgelehnteTeilwerteZaehlenNichtAlsVerworfenerUmschlag() throws Exception {
        KafkaTemplate<String, String> kafka = kafka();

        v2(v2Topic(TENANT, SITE, DEVICE, "telemetry"),
                beispiel("mqtt-telemetry-2.0.invalid.string-channel.json"), MAPPER, kafka);

        assertThat(angenommen(IngestMetriken.TELEMETRY_V2)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY_V2))
                .as("der Umschlag wurde angenommen, nur ein Kanal fiel weg").isZero();
        assertThat(an("events.raw")).as("die Ablehnung ist als Ereignis sichtbar").isNotEmpty();
    }

    /** Ein Strom faerbt den anderen nicht ein - die Label sind wirklich getrennt. */
    @Test
    void einVerworfenerStromLaesstDieAnderenDreiAufNull() {
        KafkaTemplate<String, String> kafka = kafka();

        v1("ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry", "{kein json", MAPPER, kafka);

        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY)).isEqualTo(1);
        assertThat(verworfenGesamt(IngestMetriken.MEASUREMENTS)).isZero();
        assertThat(verworfenGesamt(IngestMetriken.TELEMETRY_V2)).isZero();
        assertThat(verworfenGesamt(IngestMetriken.EVENTS)).isZero();
        assertThat(angenommen(IngestMetriken.MEASUREMENTS)).isZero();
    }

    /** Die Abbildung des Vertrags-Grundes auf das kleine Metrik-Wort, an einer Stelle festgehalten. */
    @Test
    void nurDieKennungsabweichungWirdZuIdentitaet() {
        for (Grund grund : Grund.values()) {
            String erwartet = grund == Grund.KENNUNG_ABWEICHEND
                    ? IngestMetriken.IDENTITAET : IngestMetriken.UNGUELTIG;
            assertThat(IngestMetriken.grundVon(new UmschlagAbgewiesen(grund, "x", null, null)))
                    .as("%s", grund).isEqualTo(erwartet);
        }
    }

    /** Der Zaehler des {@link EventsRawProducer} ist keine Kopie der neuen Familie. */
    @Test
    void derVorhandeneNichtZugestelltZaehlerBleibtEigenstaendig() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(false);
        KafkaTemplate<String, String> kafka = kafka();

        boxEreignisse(v2Topic(EREIGNIS_KB, EREIGNIS_AN, EREIGNIS_BOX, "events"),
                beispiel("mqtt-events-2.1.valid.restart.json"), kafka);

        assertThat(registry.find(EventsRawProducer.NICHT_ZUGESTELLT).counters()).isNotEmpty();
        verify(kafka, never()).send(eq("events.raw"), anyString(), anyString());
        // Ohne Topic ist nichts hinausgegangen - also auch kein weitergereicht.
        assertThat(weitergereicht(IngestMetriken.EVENTS)).isZero();
        assertThat(angenommen(IngestMetriken.EVENTS)).isEqualTo(1);
    }
}
