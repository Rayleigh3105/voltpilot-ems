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
    private static final String ENTITY = "00000000-0000-0000-0000-0000000000c5";
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

    /** UEMS AP-07 IP-2: 2.0 and 2.1 side by side; the provenance fields only under 2.1. */
    @Test
    void acceptsBothVersionsAndBindsTheProvenanceFieldsTo21() {
        String sample = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"";
        String plain = sample + "}";
        String withEntity = sample + ",\"entity_id\":\"" + ENTITY + "\"}";
        // 2.0 without the new fields: exactly as before.
        assertThat(validator.toEvent(TOPIC, payload("2.0", TENANT, "", plain), Instant.now())
                .samples().get(0).has("entity_id")).isFalse();
        // 2.1 with both provenance fields.
        var event = validator.toEvent(TOPIC,
                payload("2.1", TENANT, "\"applied_revision\":1,", withEntity), Instant.now());
        assertThat(event.sequence()).isEqualTo(4L);
        // 2.1 without them (a box that does not name component or revision).
        assertThat(validator.toEvent(TOPIC, payload("2.1", TENANT, "", plain), Instant.now())
                .sequence()).isEqualTo(4L);
        // The new fields do not exist under 2.0.
        assertInvalid(payload("2.0", TENANT, "", withEntity));
        assertInvalid(payload("2.0", TENANT, "\"applied_revision\":1,", plain));
        // A foreign field stays refused in both versions, at envelope and at sample level.
        for (String version : new String[] {"2.0", "2.1"}) {
            assertInvalid(payload(version, TENANT, "\"messstelle\":\"MS-06\",", plain));
            assertInvalid(payload(version, TENANT, "", sample + ",\"messstelle\":\"MS-06\"}"));
        }
        // An unknown or non-textual schema_version is refused.
        assertInvalid(payload("2.2", TENANT, "", plain));
        assertInvalid(payload("1.0", TENANT, "", plain));
        assertInvalid(payload("2.1", TENANT, "", plain).replace("\"2.1\"", "2.1"));
        // The provenance fields keep their shape.
        assertInvalid(payload("2.1", TENANT, "\"applied_revision\":-1,", plain));
        assertInvalid(payload("2.1", TENANT, "\"applied_revision\":1.5,", plain));
        assertInvalid(payload("2.1", TENANT, "\"applied_revision\":\"1\",", plain));
        assertInvalid(payload("2.1", TENANT, "", sample + ",\"entity_id\":\"K-5\"}"));
        assertInvalid(payload("2.1", TENANT, "", sample + ",\"entity_id\":\"1-1-1-1-1\"}"));
        assertInvalid(payload("2.1", TENANT, "", sample + ",\"entity_id\":5}"));
    }

    /** No new processing (IP-5 forwards): measurements.raw stays 1.0 with the 2.0 sample fields. */
    @Test
    void a21EnvelopeProducesTheUnchangedRawEvent() {
        String sample = "{\"point_key\":\"goe.api_v2.alw\",\"raw\":false,\"quality\":\"good\"";
        var from20 = validator.toEvent(TOPIC, payload("2.0", TENANT, "", sample + "}"),
                Instant.parse("2026-08-25T12:00:01Z"));
        var from21 = validator.toEvent(TOPIC, payload("2.1", TENANT, "\"applied_revision\":1,",
                sample + ",\"entity_id\":\"" + ENTITY + "\"}"), Instant.parse("2026-08-25T12:00:01Z"));
        assertThat(from21.schema_version()).isEqualTo("1.0");
        assertThat(from21.samples()).isEqualTo(from20.samples());
        assertThat(from21.samples().get(0).has("entity_id")).isFalse();
    }

    private void assertInvalid(String payload) {
        assertThatThrownBy(() -> validator.toEvent(TOPIC, payload, Instant.now()))
                .as(payload).isInstanceOf(InvalidTelemetryException.class);
    }

    private static String payload(String tenant, String sample) {
        return payload("2.0", tenant, "", sample);
    }

    private static String payload(String version, String tenant, String extra, String sample) {
        return "{\"schema_version\":\"" + version + "\",\"tenant_id\":\"" + tenant
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"catalog_version\":\"2026.08.25.1\",\"sequence\":4,"
                + "\"observed_at\":\"2026-08-25T12:00:00Z\"," + extra + "\"samples\":[" + sample + "]}";
    }

    private static String fixture(String name) throws Exception {
        return Files.readString(Path.of("..", "..", "docs", "contracts", "v2", "examples", name));
    }
}
