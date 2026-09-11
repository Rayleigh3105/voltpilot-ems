package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Unit proof of the mqtt-telemetry-2.0 ENVELOPE validation - always runs (no
 * Docker). The happy/sad paths are driven by the CONTRACT FIXTURES in
 * docs/contracts/v2/examples/ (the E0 fixture discipline: the runtime
 * validator IS the executable contract check), plus the rejection cases JSON
 * Schema alone cannot express here (topic identity, topic shape). UEMS AP-07
 * IP-5: the envelope is refused as a whole, a bad value (one channel) drops
 * only itself, and {@code seq} is forwarded unchanged.
 */
class TelemetryV2ValidatorTest {

    private static final Path FIXTURES = Path.of("../../docs/contracts/v2/examples");

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC =
            "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/v2/telemetry";

    private final TelemetryV2Validator validator =
            new TelemetryV2Validator(new ObjectMapper(), Messzeitregel.E13);
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
        var annahme = validator.annehmen(TOPIC,
                fixture("mqtt-telemetry-2.0.valid.three-entities.json"), now);
        TelemetryV2RawEvent event = annahme.weiter();

        assertThat(annahme.ablehnungen()).isEmpty();
        assertThat(event.schema_version()).isEqualTo("1.0");
        assertThat(event.tenant_id().toString()).isEqualTo(TENANT);
        assertThat(event.site_id().toString()).isEqualTo(SITE);
        assertThat(event.device_id().toString()).isEqualTo(DEVICE);
        assertThat(event.observed_at()).isEqualTo(Instant.parse("2026-07-18T11:30:05Z"));
        assertThat(event.ingested_at()).isEqualTo(now);
        assertThat(event.source_topic()).isEqualTo(TOPIC);
        assertThat(event.kafkaKey()).isEqualTo(TENANT + ":" + SITE);
        // The box's seq travels unchanged (AP-07 IP-5, mqtt-telemetry-2.0.md §5).
        assertThat(event.seq()).isEqualTo(4711L);
        assertThat(annahme.absender().sequenz()).isEqualTo(4711L);
        // The entities block is carried through unchanged.
        assertThat(event.entities().size()).isEqualTo(3);
        assertThat(event.entities().get("5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f")
                .get("channels").get("battery_power_kw").asDouble()).isEqualTo(12.4);
        assertThat(event.entities().get("6a1e3d0f-7c2b-4d4e-af90-1b2c3d4e5f60")
                .get("ts").asText()).isEqualTo("2026-07-18T11:30:02Z");

        TelemetryV2RawEvent single = validator.annehmen(TOPIC,
                fixture("mqtt-telemetry-2.0.valid.single-entity.json"), now).weiter();
        assertThat(single.entities().size()).isEqualTo(1);
        // A box without seq: absent stays absent, never 0.
        assertThat(single.seq()).isNull();
    }

    @Test
    void rejectsTheInvalidContractFixture() {
        // A string channel value - the schema's counter-example: that value is refused, and as
        // it was the only one, nothing is forwarded.
        var annahme = validator.annehmen(TOPIC,
                fixture("mqtt-telemetry-2.0.invalid.string-channel.json"), now);
        assertThat(annahme.weiter()).isNull();
        assertThat(annahme.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.SCHEMA_VERLETZT, 1, null));
    }

    @Test
    void rejectsWrongSchemaVersionAndV1Payloads() {
        String v1 = fixture("mqtt-telemetry-2.0.valid.single-entity.json")
                .replace("\"2.0\"", "\"1.0\"");
        assertThatThrownBy(() -> validator.annehmen(TOPIC, v1, now))
                .isInstanceOfSatisfying(UmschlagAbgewiesen.class,
                        e -> assertThat(e.grund()).isEqualTo(Grund.FASSUNG_UNBEKANNT))
                .hasMessageContaining("schema_version");
    }

    @Test
    void rejectsTopicIdentityMismatchAndWrongTopicShape() {
        String payload = fixture("mqtt-telemetry-2.0.valid.single-entity.json");
        String foreign = "ems/" + TENANT + "/" + SITE
                + "/99999999-9999-9999-9999-999999999999/v2/telemetry";
        assertThatThrownBy(() -> validator.annehmen(foreign, payload, now))
                .isInstanceOfSatisfying(UmschlagAbgewiesen.class,
                        e -> assertThat(e.grund()).isEqualTo(Grund.KENNUNG_ABWEICHEND))
                .hasMessageContaining("identity");
        // The v1 topic shape is never a v2 message.
        String v1Topic = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry";
        assertThatThrownBy(() -> validator.annehmen(v1Topic, payload, now))
                .isInstanceOf(UmschlagAbgewiesen.class)
                .hasMessageContaining("topic shape");
    }

    @Test
    void rejectsStructuralViolations() {
        String base = "{\"schema_version\":\"2.0\",\"tenant_id\":\"" + TENANT
                + "\",\"site_id\":\"" + SITE + "\",\"device_id\":\"" + DEVICE
                + "\",\"ts\":\"2026-07-18T11:30:05Z\",\"entities\":%s}";

        // The envelope itself.
        assertThatThrownBy(() -> validator.annehmen(TOPIC, base.formatted("{}"), now))
                .isInstanceOf(UmschlagAbgewiesen.class)
                .hasMessageContaining("non-empty");
        assertThatThrownBy(() -> validator.annehmen(TOPIC, "not json", now))
                .isInstanceOfSatisfying(UmschlagAbgewiesen.class,
                        e -> assertThat(e.grund()).isEqualTo(Grund.SCHEMA_VERLETZT));
        assertThatThrownBy(() -> validator.annehmen(TOPIC,
                base.formatted("{\"e1\":{\"channels\":{\"power_kw\":1}}}").replace("\"ts\"", "\"seq\":-1,\"ts\""),
                now)).isInstanceOf(UmschlagAbgewiesen.class).hasMessageContaining("seq");
        // One entity or one channel: only that is refused.
        for (String entities : List.of(
                "{\"bad/id\":{\"channels\":{\"power_kw\":1}}}",
                "{\"e1\":{\"channels\":{}}}",
                "{\"e1\":{\"channels\":{\"Bad-Name\":1}}}",
                "{\"e1\":{\"ts\":\"gestern\",\"channels\":{\"power_kw\":1}}}")) {
            var annahme = validator.annehmen(TOPIC, base.formatted(entities), now);
            assertThat(annahme.weiter()).as(entities).isNull();
            assertThat(annahme.ablehnungen()).as(entities).containsExactly(
                    new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.SCHEMA_VERLETZT, 1, null));
        }
        var teils = validator.annehmen(TOPIC, base.formatted(
                "{\"e1\":{\"channels\":{\"power_kw\":1,\"Bad-Name\":2,\"soc_pct\":\"5\"}},"
                        + "\"e2\":{\"ts\":\"gestern\",\"channels\":{\"a\":1,\"b\":2}}}"), now);
        assertThat(teils.weiter().entities().size()).isEqualTo(1);
        assertThat(teils.weiter().entities().get("e1").get("channels").size()).isEqualTo(1);
        assertThat(teils.weiter().entities().get("e1").get("channels").get("power_kw").asInt()).isEqualTo(1);
        assertThat(teils.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.REJECTED, Grund.SCHEMA_VERLETZT, 4, null));
    }

    /** E13 per entity (it carries the time); an implausible top-level ts drops every entity. */
    @Test
    void theMeasurementTimeRuleAppliesPerEntity() {
        String payload = fixture("mqtt-telemetry-2.0.valid.three-entities.json");
        // Entity 6a1e… carries its own ts 11:30:02; the top-level ts is 11:30:05.
        var nachFuenfMinuten = validator.annehmen(TOPIC,
                payload.replace("\"ts\": \"2026-07-18T11:30:02Z\"", "\"ts\": \"2026-07-18T11:36:02Z\""), now);
        assertThat(nachFuenfMinuten.weiter().entities().size()).isEqualTo(2);
        assertThat(nachFuenfMinuten.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.CLOCK_AHEAD, null, 1, 302L));

        var uhrVor = validator.annehmen(TOPIC, payload, Instant.parse("2026-07-18T11:15:05Z"));
        assertThat(uhrVor.weiter()).isNull();
        assertThat(uhrVor.ablehnungen()).containsExactly(
                new Ablehnungen.Ablehnung(Ereignisart.CLOCK_AHEAD, null, 5, 900L));
    }
}
