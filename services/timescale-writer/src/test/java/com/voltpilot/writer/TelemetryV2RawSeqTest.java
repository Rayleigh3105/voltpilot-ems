package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;

/**
 * UEMS AP-07 IP-5 hands the box's {@code seq} on in {@code telemetry-v2.raw} (additive, see
 * {@code docs/contracts/v2/telemetry-v2-raw.event.schema.json}). This writer does not read it yet
 * (sequence evaluation is IP-7/IP-9) and must keep writing such a record: its consumer parses with
 * the Spring ObjectMapper, which ignores an unknown field. A record without {@code seq} (an older
 * ingest, or a box that sends none) stays exactly as before.
 */
class TelemetryV2RawSeqTest {

    /** The mapper Spring Boot auto-configures (FAIL_ON_UNKNOWN_PROPERTIES off). */
    private final ObjectMapper spring = Jackson2ObjectMapperBuilder.json().build();

    private static String record(String seq) {
        return "{\"schema_version\":\"1.0\",\"event_id\":\"b167d268-ac18-4fde-8bc3-1660b0109e1f\","
                + "\"tenant_id\":\"00000000-0000-0000-0000-000000000001\","
                + "\"site_id\":\"00000000-0000-0000-0000-000000000002\","
                + "\"device_id\":\"00000000-0000-0000-0000-000000000003\","
                + "\"observed_at\":\"2026-07-18T11:30:05Z\",\"ingested_at\":\"2026-07-18T11:31:00Z\","
                + "\"source_topic\":\"ems/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002"
                + "/00000000-0000-0000-0000-000000000003/v2/telemetry\"," + seq
                + "\"entities\":{\"7b2f4e10-8d3c-4e5f-b0a1-2c3d4e5f6071\":{\"channels\":{\"power_kw\":-49.7}}}}";
    }

    @Test
    void aRecordWithSeqIsWrittenLikeOneWithout() {
        for (String seq : new String[] {"\"seq\":4711,", ""}) {
            TelemetryV2WriteRepository repository = mock(TelemetryV2WriteRepository.class);
            new TelemetryV2RawConsumer(spring, repository).onMessage(record(seq));
            ArgumentCaptor<TelemetryV2RawEvent> event = ArgumentCaptor.forClass(TelemetryV2RawEvent.class);
            verify(repository).insert(event.capture());
            assertThat(event.getValue().entities().size()).as(seq).isEqualTo(1);
        }
    }
}
