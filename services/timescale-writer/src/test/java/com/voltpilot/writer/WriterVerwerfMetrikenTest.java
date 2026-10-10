package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.writer.MessreiheEreignisRepository.Ausgang;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.micrometer.prometheusmetrics.PrometheusConfig;
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

class WriterVerwerfMetrikenTest {

    private static final String TENANT = "00000000-0000-4000-8000-000000000001";
    private static final String SITE = "00000000-0000-4000-8000-000000000002";
    private static final String DEVICE = "00000000-0000-4000-8000-000000000003";
    private static final String EVENT = "00000000-0000-4000-8000-000000000004";

    private final ObjectMapper mapper = Jackson2ObjectMapperBuilder.json().build();

    @Test
    void alleGeschlossenenReihenSindAbStartNullUndOhneKennungExportiert() {
        PrometheusMeterRegistry registry = new PrometheusMeterRegistry(PrometheusConfig.DEFAULT);
        new WriterVerwerfMetriken(registry);

        String[] zeilen = registry.scrape().lines()
                .filter(line -> line.startsWith("voltpilot_writer_verworfen"))
                .toArray(String[]::new);
        assertThat(zeilen).hasSize(20).allSatisfy(line -> {
            assertThat(line).endsWith(" 0.0");
            assertThat(line).doesNotContain(TENANT, SITE, DEVICE, EVENT);
        });
    }

    @Test
    void unlesbarerMeasurementUmschlagWirdEinmalGezaehltUndNichtGeschrieben() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        MeasurementWriteRepository repository = mock(MeasurementWriteRepository.class);

        new MeasurementRawConsumer(mapper, repository, metriken).onMessage("{");

        assertEinUmschlag(registry, "measurements", WriterVerwerfMetriken.UNLESBAR);
        verifyNoInteractions(repository);
    }

    @Test
    void identitaetsAbweichungAusPr950ZaehltUmschlagUndBekannteSamples() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        MeasurementWriteRepository repository = mock(MeasurementWriteRepository.class);
        String record = measurement("ems/" + TENANT + "/" + SITE + "/"
                + UUID.randomUUID() + "/v2/measurement-samples", zweiSamples());

        new MeasurementRawConsumer(mapper, repository, metriken).onMessage(record);

        assertEinUmschlag(registry, "measurements", WriterVerwerfMetriken.IDENTITAET);
        assertThat(sample(registry, WriterVerwerfMetriken.IDENTITAET)).isEqualTo(2);
        verifyNoInteractions(repository);
    }

    @Test
    void ungueltigerMeasurementUmschlagZaehltBekannteSamplesUndBleibtUngeschrieben() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        MeasurementWriteRepository repository = mock(MeasurementWriteRepository.class);
        String record = measurement(topic(), "[{\"point_key\":\"bad key\",\"raw\":1,"
                + "\"quality\":\"good\"}]");

        new MeasurementRawConsumer(mapper, repository, metriken).onMessage(record);

        assertEinUmschlag(registry, "measurements", WriterVerwerfMetriken.UNGUELTIG);
        assertThat(sample(registry, WriterVerwerfMetriken.UNGUELTIG)).isOne();
        verifyNoInteractions(repository);
    }

    @Test
    void telemetryVerwerfstellenZaehlenJeGenauEinenUmschlag() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        TelemetryWriteRepository repository = mock(TelemetryWriteRepository.class);
        ComposedEntityFanout fanout = mock(ComposedEntityFanout.class);
        TelemetryRawConsumer consumer = new TelemetryRawConsumer(mapper, repository, fanout, metriken);

        consumer.onMessage("{");
        consumer.onMessage("{\"tenant_id\":null}");

        assertThat(umschlag(registry, "telemetry", WriterVerwerfMetriken.UNLESBAR)).isOne();
        assertThat(umschlag(registry, "telemetry", WriterVerwerfMetriken.PFLICHTFELD)).isOne();
        verifyNoInteractions(repository, fanout);
    }

    @Test
    void telemetryV2VerwerfstellenZaehlenJeGenauEinenUmschlag() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        TelemetryV2WriteRepository repository = mock(TelemetryV2WriteRepository.class);
        TelemetryV2RawConsumer consumer = new TelemetryV2RawConsumer(mapper, repository, metriken);

        consumer.onMessage("{");
        consumer.onMessage("{\"tenant_id\":null}");

        assertThat(umschlag(registry, "telemetry_v2", WriterVerwerfMetriken.UNLESBAR)).isOne();
        assertThat(umschlag(registry, "telemetry_v2", WriterVerwerfMetriken.PFLICHTFELD)).isOne();
        verifyNoInteractions(repository);
    }

    @Test
    void eventsVerwerfstellenZaehlenUnlesbarIdentitaetUndDatenbankJeEinmal() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        MessreiheEreignisRepository repository = mock(MessreiheEreignisRepository.class);
        EventsRawConsumer consumer = new EventsRawConsumer(mapper, repository, registry, metriken);

        consumer.onMessage("{");
        consumer.onMessage(boxEvent(UUID.randomUUID().toString()));
        when(repository.anhaengen(any(), any(), any(), any(), any()))
                .thenThrow(new DataIntegrityViolationException("test"));
        consumer.onMessage(cloudEvent());

        assertThat(umschlag(registry, "events", WriterVerwerfMetriken.UNLESBAR)).isOne();
        assertThat(umschlag(registry, "events", WriterVerwerfMetriken.IDENTITAET)).isOne();
        assertThat(umschlag(registry, "events", WriterVerwerfMetriken.UNGUELTIG)).isOne();
        verify(repository).anhaengen(any(), any(), any(), any(), any());
    }

    @Test
    void vomEreignisVertragVerworfenZaehltEinmalUndWirdNichtAngehaengt() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        MessreiheEreignisRepository repository = mock(MessreiheEreignisRepository.class);
        when(repository.anhaengen(any(), any(), any(), any(), any()))
                .thenReturn(new MessreiheEreignisRepository.Ergebnis(
                        Ausgang.VERWORFEN, "wort_unbekannt", "test"));

        new EventsRawConsumer(mapper, repository, registry, metriken).onMessage(cloudEvent());

        assertEinUmschlag(registry, "events", WriterVerwerfMetriken.UNGUELTIG);
    }

    @Test
    void gueltigerUmschlagUndDuplikatZaehlenNichtAlsVerworfen() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        WriterVerwerfMetriken metriken = new WriterVerwerfMetriken(registry);
        MeasurementWriteRepository measurements = mock(MeasurementWriteRepository.class);
        TelemetryWriteRepository telemetry = mock(TelemetryWriteRepository.class);
        ComposedEntityFanout fanout = mock(ComposedEntityFanout.class);
        when(telemetry.insert(any())).thenReturn(false);

        new MeasurementRawConsumer(mapper, measurements, metriken)
                .onMessage(measurement(topic(), zweiSamples()));
        new TelemetryRawConsumer(mapper, telemetry, fanout, metriken).onMessage(telemetry());

        verify(measurements).insert(any());
        verify(telemetry).insert(any());
        assertThat(summe(registry, WriterVerwerfMetriken.UMSCHLAEGE)).isZero();
        assertThat(summe(registry, WriterVerwerfMetriken.SAMPLES)).isZero();
    }

    private static void assertEinUmschlag(SimpleMeterRegistry registry, String strom, String grund) {
        assertThat(umschlag(registry, strom, grund)).isOne();
        assertThat(summe(registry, WriterVerwerfMetriken.UMSCHLAEGE)).isOne();
    }

    private static double umschlag(SimpleMeterRegistry registry, String strom, String grund) {
        return registry.find(WriterVerwerfMetriken.UMSCHLAEGE)
                .tag("strom", strom).tag("grund", grund).counter().count();
    }

    private static double sample(SimpleMeterRegistry registry, String grund) {
        return registry.find(WriterVerwerfMetriken.SAMPLES).tag("grund", grund).counter().count();
    }

    private static double summe(SimpleMeterRegistry registry, String name) {
        return registry.find(name).counters().stream().mapToDouble(Counter::count).sum();
    }

    private static String topic() {
        return "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/measurement-samples";
    }

    private static String zweiSamples() {
        return "[{\"point_key\":\"power_kw\",\"raw\":1,\"quality\":\"good\"},"
                + "{\"point_key\":\"soc_pct\",\"raw\":2,\"quality\":\"good\"}]";
    }

    private static String measurement(String sourceTopic, String samples) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + EVENT
                + "\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"catalog_version\":\"test\","
                + "\"sequence\":1,\"observed_at\":\"2026-09-18T10:00:00Z\","
                + "\"ingested_at\":\"2026-09-18T10:00:01Z\",\"source_topic\":\""
                + sourceTopic + "\",\"samples\":" + samples
                + ",\"dropped_samples\":0,\"gap\":false}";
    }

    private static String telemetry() {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + EVENT
                + "\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"observed_at\":"
                + "\"2026-09-18T10:00:00Z\",\"ingested_at\":\"2026-09-18T10:00:01Z\","
                + "\"source_topic\":\"ems/test\",\"measurements\":{\"power_kw\":1}}";
    }

    private static String cloudEvent() {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + EVENT
                + "\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"urheber\":\"cloud\",\"ingested_at\":\"2026-09-18T10:00:01Z\","
                + "\"ereignis\":{}}";
    }

    private static String boxEvent(String ereignisBox) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"" + EVENT
                + "\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"urheber\":\"box\",\"ingested_at\":\"2026-09-18T10:00:01Z\","
                + "\"device_id\":\"" + DEVICE + "\",\"source_topic\":\"ems/" + TENANT
                + "/" + SITE + "/" + DEVICE + "/v2/events\",\"sequence\":1,"
                + "\"observed_at\":\"2026-09-18T10:00:00Z\",\"ereignis\":{\"box\":\""
                + ereignisBox + "\"}}";
    }
}
