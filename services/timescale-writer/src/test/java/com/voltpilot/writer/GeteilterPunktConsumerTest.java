package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

/**
 * UEMS AP-07 IP-18b (Cloud-Vorpaket): {@code measurements.raw} 1.0 nennt die Komponente NUR an
 * einem geteilten Punkt - derselbe point_key mehrfach, je mit eigener {@code entity_id}. Dort ist
 * (point_key, entity_id) der Schlüssel; überall sonst gilt die Eindeutigkeit des point_key wie
 * bisher, und ein einfacher Punkt trägt keine Komponente.
 */
class GeteilterPunktConsumerTest {

    private static final String TENANT = "00000000-0000-4000-8000-000000000001";
    private static final String SITE = "00000000-0000-4000-8000-000000000002";
    private static final String DEVICE = "00000000-0000-4000-8000-000000000003";
    private static final String A = "00000000-0000-4000-8000-0000000000a1";
    private static final String B = "00000000-0000-4000-8000-0000000000b2";

    private final ObjectMapper mapper = Jackson2ObjectMapperBuilder.json().build();

    @Test
    void zweiGenannteKomponentenAnEinemPunktGehenInDenSchreibweg() {
        assertGeschrieben(true, sample(A), sample(B));
        assertGeschrieben(true, sample(A), sample(B), "{\"point_key\":\"soc_pct\",\"raw\":2,\"quality\":\"good\"}");
    }

    @Test
    void ohneKomponenteOderMitDerselbenBleibtDerPunktDoppelt() {
        assertGeschrieben(false, sample(A), sample(A.toUpperCase()));
        assertGeschrieben(false, sample(A), "{\"point_key\":\"power_kw\",\"raw\":1,\"quality\":\"good\"}");
        assertGeschrieben(false, "{\"point_key\":\"power_kw\",\"raw\":1,\"quality\":\"good\"}",
                "{\"point_key\":\"power_kw\",\"raw\":1,\"quality\":\"good\"}");
        assertGeschrieben(false, sample(A), sample("K-5"));
    }

    @Test
    void einEinfacherPunktTraegtKeineKomponente() {
        assertGeschrieben(true, "{\"point_key\":\"power_kw\",\"raw\":1,\"quality\":\"good\"}");
        assertGeschrieben(false, sample(A));
    }

    private void assertGeschrieben(boolean erwartet, String... samples) {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        MeasurementWriteRepository repository = mock(MeasurementWriteRepository.class);
        new MeasurementRawConsumer(mapper, repository, new WriterVerwerfMetriken(registry))
                .onMessage(measurement("[" + String.join(",", samples) + "]"));
        if (erwartet) {
            verify(repository).insert(any());
        } else {
            verify(repository, never()).insert(any());
            assertThat(registry.get(WriterVerwerfMetriken.UMSCHLAEGE).tag("strom", "measurements")
                    .tag("grund", WriterVerwerfMetriken.UNGUELTIG).counter().count())
                    .as(String.join(",", samples)).isEqualTo(1.0);
        }
    }

    private static String sample(String entity) {
        return "{\"point_key\":\"power_kw\",\"raw\":50,\"quality\":\"good\",\"entity_id\":\"" + entity + "\"}";
    }

    private static String measurement(String samples) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"00000000-0000-4000-8000-000000000004\""
                + ",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\"" + SITE
                + "\",\"device_id\":\"" + DEVICE + "\",\"catalog_version\":\"test\","
                + "\"sequence\":1,\"observed_at\":\"2026-09-18T10:00:00Z\","
                + "\"ingested_at\":\"2026-09-18T10:00:01Z\",\"source_topic\":\"ems/" + TENANT + "/"
                + SITE + "/" + DEVICE + "/v2/measurement-samples\",\"samples\":" + samples
                + ",\"dropped_samples\":0,\"gap\":false}";
    }
}
