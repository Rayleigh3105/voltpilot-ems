package com.voltpilot.ingest;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Voltpilot-EMS Ingest service.
 *
 * <p>Responsibility (architecture section 8): consume MQTT (EMQX), validate,
 * publish to Redpanda. Stateless. First hop of the MVP data path
 * {@code EMQX -> Ingest -> Redpanda -> Writer -> TimescaleDB}.
 *
 * <p>MVP skeleton: the MQTT subscription and Redpanda producer are declared as
 * dependencies but not yet wired. Inbound payloads follow
 * {@code docs/contracts/mqtt-telemetry.schema.json}; emitted events follow
 * {@code docs/contracts/telemetry-raw.event.schema.json}.
 */
@SpringBootApplication
public class IngestApplication {

    public static void main(String[] args) {
        SpringApplication.run(IngestApplication.class, args);
    }
}
