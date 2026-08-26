package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class MeasurementSamplesValidatorTest {
    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE
            + "/v2/measurement-samples";
    private final MeasurementSamplesValidator validator =
            new MeasurementSamplesValidator(new ObjectMapper());

    @Test
    void committedFixturesValidateAsLabelled() throws Exception {
        var event = validator.toEvent(TOPIC, fixture("mqtt-measurement-samples.valid.json"),
                Instant.parse("2026-08-25T12:00:11Z"));
        assertThat(event.sequence()).isEqualTo(42L);
        assertThat(event.kafkaKey()).isEqualTo(TENANT + ":" + SITE + ":" + DEVICE);
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                fixture("mqtt-measurement-samples.invalid.no-raw.json"), Instant.now()))
                .isInstanceOf(InvalidTelemetryException.class);
    }

    @Test
    void identityUnknownFieldsAndScalarRawAreStrict() {
        String sample = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"}";
        String valid = payload(TENANT, sample);
        assertThat(validator.toEvent(TOPIC, valid, Instant.now()).sequence()).isEqualTo(4L);
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                payload("10000000-0000-0000-0000-000000000001", sample), Instant.now()))
                .isInstanceOf(InvalidTelemetryException.class);
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                payload(TENANT, "{\"point_key\":\"x\",\"decoded\":1,\"quality\":\"good\"}"),
                Instant.now())).isInstanceOf(InvalidTelemetryException.class);
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                valid.replace("\"samples\"", "\"unexpected\":true,\"samples\""), Instant.now()))
                .isInstanceOf(InvalidTelemetryException.class);
        assertThatThrownBy(() -> validator.toEvent(TOPIC, valid + "{}", Instant.now()))
                .isInstanceOf(InvalidTelemetryException.class);
    }

    private static String payload(String tenant, String sample) {
        return "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + tenant
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":4,"
                + "\"observed_at\":\"2026-08-25T12:00:00Z\",\"samples\":[" + sample + "]}";
    }

    private static String fixture(String name) throws Exception {
        return Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "examples", name));
    }
}
