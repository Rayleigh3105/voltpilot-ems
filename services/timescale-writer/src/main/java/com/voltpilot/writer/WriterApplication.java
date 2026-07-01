package com.voltpilot.writer;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Voltpilot-EMS TimescaleDB-Writer.
 *
 * <p>Responsibility (architecture section 8): read {@code telemetry.raw} from
 * Redpanda and write into the TimescaleDB {@code telemetry} hypertable.
 * Stateless. Final hop of the MVP data path
 * {@code EMQX -> Ingest -> Redpanda -> Writer -> TimescaleDB}.
 *
 * <p>Consumes the frozen {@code docs/contracts/telemetry-raw.event.schema.json}
 * event (see {@link TelemetryRawConsumer}) and inserts one hypertable row per
 * event, tenant-scoped through Postgres RLS (see {@link TelemetryWriteRepository}).
 * At-least-once: an insert failure re-throws so the offset is not committed and
 * Kafka redelivers; the insert is idempotent on {@code (device_id, time)}.
 */
@SpringBootApplication
public class WriterApplication {

    public static void main(String[] args) {
        SpringApplication.run(WriterApplication.class, args);
    }
}
