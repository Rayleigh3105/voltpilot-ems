package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * Unit coverage of the contract validation/normalization (no Spring, no Docker;
 * always runs). Proves the mapping onto {@code telemetry.raw} and that the
 * documented rejection cases become {@link InvalidTelemetryException} (log+skip).
 */
class TelemetryValidatorTest {

    private static final String TENANT = "00000000-0000-0000-0000-000000000001";
    private static final String SITE = "00000000-0000-0000-0000-000000000002";
    private static final String DEVICE = "00000000-0000-0000-0000-000000000003";
    private static final String TOPIC = "ems/" + TENANT + "/" + SITE + "/" + DEVICE + "/telemetry";

    private final TelemetryValidator validator = new TelemetryValidator(new ObjectMapper());
    private final Instant now = Instant.parse("2026-07-01T09:00:00Z");

    private static String payload(String tenant, String site, String device, String version) {
        return "{"
                + "\"schema_version\":\"" + version + "\","
                + "\"tenant_id\":\"" + tenant + "\","
                + "\"site_id\":\"" + site + "\","
                + "\"device_id\":\"" + device + "\","
                + "\"ts\":\"2026-07-01T08:58:45.827Z\","
                + "\"seq\":24,"
                + "\"measurements\":{\"power_kw\":2.29,\"soc_pct\":55.1,\"pv_power_kw\":16.9,"
                + "\"load_kw\":9.58,\"grid_limit_kw\":50}"
                + "}";
    }

    @Test
    void mapsValidPayloadOntoTheRawEvent() {
        TelemetryRawEvent e = validator.toEvent(TOPIC, payload(TENANT, SITE, DEVICE, "1.0"), now);

        assertThat(e.schema_version()).isEqualTo("1.0");
        assertThat(e.event_id()).isNotNull();
        assertThat(e.tenant_id().toString()).isEqualTo(TENANT);
        assertThat(e.site_id().toString()).isEqualTo(SITE);
        assertThat(e.device_id().toString()).isEqualTo(DEVICE);
        assertThat(e.observed_at()).isEqualTo(Instant.parse("2026-07-01T08:58:45.827Z"));
        assertThat(e.ingested_at()).isEqualTo(now);
        assertThat(e.source_topic()).isEqualTo(TOPIC);
        assertThat(e.measurements().get("grid_limit_kw").asDouble()).isEqualTo(50.0);
        assertThat(e.kafkaKey()).isEqualTo(TENANT + ":" + SITE);
    }

    @Test
    void rejectsUnsupportedSchemaVersion() {
        assertThatThrownBy(() -> validator.toEvent(TOPIC, payload(TENANT, SITE, DEVICE, "2.0"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("schema_version");
    }

    @Test
    void rejectsTopicPayloadIdentityMismatch() {
        // Payload claims a different device than the topic it arrived on.
        String otherDevice = "00000000-0000-0000-0000-0000000000ff";
        assertThatThrownBy(() -> validator.toEvent(TOPIC, payload(TENANT, SITE, otherDevice, "1.0"), now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("does not match");
    }

    @Test
    void rejectsNonUuidIdentifier() {
        String bad = payload(TENANT, SITE, DEVICE, "1.0").replace(DEVICE, "not-a-uuid");
        assertThatThrownBy(() -> validator.toEvent(
                        "ems/" + TENANT + "/" + SITE + "/not-a-uuid/telemetry", bad, now))
                .isInstanceOf(InvalidTelemetryException.class);
    }

    @Test
    void rejectsMissingMeasurements() {
        String bad = "{\"schema_version\":\"1.0\",\"tenant_id\":\"" + TENANT + "\",\"site_id\":\""
                + SITE + "\",\"device_id\":\"" + DEVICE + "\",\"ts\":\"2026-07-01T08:58:45Z\"}";
        assertThatThrownBy(() -> validator.toEvent(TOPIC, bad, now))
                .isInstanceOf(InvalidTelemetryException.class)
                .hasMessageContaining("measurements");
    }

    @Test
    void rejectsGarbageJson() {
        assertThatThrownBy(() -> validator.toEvent(TOPIC, "not json at all", now))
                .isInstanceOf(InvalidTelemetryException.class);
    }
}
