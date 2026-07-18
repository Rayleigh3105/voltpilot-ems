package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Unit proof of the mqtt-telemetry-2.0 ENVELOPE validation - always runs (no
 * Docker). The happy/sad paths are driven by the CONTRACT FIXTURES in
 * docs/contracts/v2/examples/ (the E0 fixture discipline: the runtime
 * validator IS the executable contract check), plus the rejection cases JSON
 * Schema alone cannot express here (topic identity, topic shape).
 */
class TelemetryV2ValidatorTest {

    private static final Path FIXTURES = Path.of("../../docs/contracts/v2/examples");

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC =
            "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/telemetry";

    private final TelemetryV2Validator validator = new TelemetryV2Validator(new ObjectMapper());
    private final Instant now = Instant.parse("2026-07-18T11:31:00Z");

    private static String fixture(String name) {
        try {
            return Files.readString(FIXTURES.resolve(name));
        } catch (Exception e) {
            throw new IllegalStateException("contract fixture missing: " + name, e);
        }
    }

    @Test
    void acceptsTheValidContractFixturesAndMapsTheEvent() {
        TelemetryV2RawEvent event = validator.toEvent(TOPIC,
                fixture("mqtt-telemetry-2.0.valid.three-entities.json"), now);

        assertThat(event.schema_version()).isEqualTo("1.0");
        assertThat(event.tenant_id().toString()).isEqualTo(TENANT);
        assertThat(event.site_id().toString()).isEqualTo(SITE);
        assertThat(event.device_id().toString()).isEqualTo(DEVICE);
        assertThat(event.observed_at()).isEqualTo(Instant.parse("2026-07-18T11:30:05Z"));
        assertThat(event.ingested_at()).isEqualTo(now);
        assertThat(event.source_topic()).isEqualTo(TOPIC);
        assertThat(event.kafkaKey()).isEqualTo(TENANT + ":" + SITE);
        // The entities block is carried through unchanged.
        assertThat(event.entities().size()).isEqualTo(3);
        assertThat(event.entities().get("5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f")
                .get("channels").get("battery_power_kw").asDouble()).isEqualTo(12.4);
        assertThat(event.entities().get("6a1e3d0f-7c2b-4d4e-af90-1b2c3d4e5f60")
                .get("ts").asText()).isEqualTo("2026-07-18T11:30:02Z");

        assertThat(validator.toEvent(TOPIC,
                fixture("mqtt-telemetry-2.0.valid.single-entity.json"), now)
                .entities().size()).isEqualTo(1);
    }

    @Test
    void rejectsTheInvalidContractFixture() {
        // A string channel value - the schema's counter-example.
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                fixture("mqtt-telemetry-2.0.invalid.string-channel.json"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("finite number");
    }

    @Test
    void rejectsWrongSchemaVersionAndV1Payloads() {
        String v1 = fixture("mqtt-telemetry-2.0.valid.single-entity.json")
                .replace("\"2.0\"", "\"1.0\"");
        assertThatThrownBy(() -> validator.toEvent(TOPIC, v1, now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("schema_version");
    }

    @Test
    void rejectsTopicIdentityMismatchAndWrongTopicShape() {
        String payload = fixture("mqtt-telemetry-2.0.valid.single-entity.json");
        String foreign = "ems/" + TENANT + "/" + SITE
                + "/99999999-9999-9999-9999-999999999999/v2/telemetry";
        assertThatThrownBy(() -> validator.toEvent(foreign, payload, now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("identity");
        // The v1 topic shape is never a v2 message.
        String v1Topic = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry";
        assertThatThrownBy(() -> validator.toEvent(v1Topic, payload, now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("topic shape");
    }

    @Test
    void rejectsStructuralViolations() {
        String base = "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + TENANT
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"ts\":\"2026-07-18T11:30:05Z\",\"entities\":%s}";

        assertThatThrownBy(() -> validator.toEvent(TOPIC, base.formatted("{}"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("non-empty");
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                base.formatted("{\"bad/id\":{\"channels\":{\"power_kw\":1}}}"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("topic-safe");
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                base.formatted("{\"e1\":{\"channels\":{}}}"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("channels");
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                base.formatted("{\"e1\":{\"channels\":{\"Bad-Name\":1}}}"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("channel name");
        assertThatThrownBy(() -> validator.toEvent(TOPIC,
                base.formatted("{\"e1\":{\"ts\":\"gestern\",\"channels\":{\"power_kw\":1}}}"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("RFC 3339");
        assertThatThrownBy(() -> validator.toEvent(TOPIC, "not json", now))
                .isInstanceOf(InvalidTelemetryException.class);
    }
}
