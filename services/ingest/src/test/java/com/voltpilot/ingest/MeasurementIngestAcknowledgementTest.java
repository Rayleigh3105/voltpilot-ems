package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.integration.acks.SimpleAcknowledgment;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.messaging.support.GenericMessage;

class MeasurementIngestAcknowledgementTest {
    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE
            + "/v2/measurement-samples";

    @SuppressWarnings("unchecked")
    @Test
    void mqttIsAcknowledgedOnlyAfterDurableKafkaCompletion() {
        KafkaTemplate<String, String> kafka = mock(KafkaTemplate.class);
        SimpleAcknowledgment acknowledgement = mock(SimpleAcknowledgment.class);
        var handler = handler(kafka);
        CompletableFuture<SendResult<String, String>> failed = new CompletableFuture<>();
        failed.completeExceptionally(new IllegalStateException("redpanda unavailable"));
        when(kafka.send(anyString(), anyString(), anyString())).thenReturn(failed);

        assertThatThrownBy(() -> handler.handle(new GenericMessage<>(payload()), TOPIC, acknowledgement))
                .isInstanceOf(IllegalStateException.class);
        verify(acknowledgement, never()).acknowledge();

        when(kafka.send(anyString(), anyString(), anyString()))
                .thenReturn(CompletableFuture.completedFuture(mock(SendResult.class)));
        handler.handle(new GenericMessage<>(payload()), TOPIC, acknowledgement);
        verify(acknowledgement).acknowledge();
    }

    @SuppressWarnings("unchecked")
    @Test
    void wideDecimalStringRawReachesKafkaWithoutNumericCoercion() {
        KafkaTemplate<String, String> kafka = mock(KafkaTemplate.class);
        when(kafka.send(anyString(), anyString(), anyString()))
                .thenReturn(CompletableFuture.completedFuture(mock(SendResult.class)));
        handler(kafka).handle(new GenericMessage<>(payload(
                "\"ocpp.1_6.metervalues.energy.active.import.register.context[sample-periodic]"
                        + ".format[raw].phase[none].location[outlet].unit[wh]\"",
                "\"9007199254740993\"")), TOPIC, null);

        ArgumentCaptor<String> event = ArgumentCaptor.forClass(String.class);
        verify(kafka).send(eq("measurements.raw"), anyString(), event.capture());
        assertThat(event.getValue()).contains("\"raw\":\"9007199254740993\"");
        assertThat(event.getValue()).doesNotContain("\"decoded\"");
    }

    private static MeasurementIngestHandler handler(KafkaTemplate<String, String> kafka) {
        ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
        return new MeasurementIngestHandler(new MeasurementSamplesValidator(mapper, Messzeitregel.E13),
                mapper, kafka, "measurements.raw", new EventsRawProducer(mapper, kafka, "events.raw",
                        mock(EventsTopicPruefung.class), new io.micrometer.core.instrument.simple.SimpleMeterRegistry()),
                Clock.fixed(Instant.parse("2026-08-25T12:00:01Z"), ZoneOffset.UTC));
    }

    private static String payload() {
        return payload("false");
    }

    private static String payload(String raw) {
        return payload("\"goe.api_v2.alw\"", raw);
    }

    private static String payload(String pointKey, String raw) {
        return "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + TENANT
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":4,"
                + "\"observed_at\":\"2026-08-25T12:00:00Z\",\"samples\":[{"
                + "\"point_key\":" + pointKey + ",\"raw\":" + raw + ",\"quality\":\"good\"}]}";
    }
}
