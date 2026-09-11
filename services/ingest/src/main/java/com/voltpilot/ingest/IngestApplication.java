package com.voltpilot.ingest;

import java.time.Clock;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

/**
 * Voltpilot-EMS Ingest service.
 *
 * <p>Responsibility (architecture section 8): consume MQTT (EMQX), validate,
 * publish to Redpanda. Stateless. First hop of the MVP data path
 * {@code EMQX -> Ingest -> Redpanda -> Writer -> TimescaleDB}.
 *
 * <p>Inbound payloads follow {@code docs/contracts/mqtt-telemetry.schema.json};
 * emitted events follow {@code docs/contracts/telemetry-raw.event.schema.json}.
 * The subscription (QoS1 on {@code ems/+/+/+/telemetry}), validation and the
 * Redpanda producer are wired in {@link MqttIngestConfig} /
 * {@link TelemetryIngestHandler}.
 */
@SpringBootApplication
public class IngestApplication {

    public static void main(String[] args) {
        SpringApplication.run(IngestApplication.class, args);
    }

    /** System UTC clock; stamped as {@code ingested_at} and injectable in tests. */
    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }

    /**
     * The measurement-time plausibility (UEMS AP-07 E13) from its ONE named
     * configuration {@code voltpilot.datenannahme} in application.yml.
     */
    @Bean
    public Messzeitregel messzeitregel(
            @Value("${voltpilot.datenannahme.zukunft-hoechstens-s}") long zukunftHoechstensS,
            @Value("${voltpilot.datenannahme.vergangenheit-hoechstens-s}") long vergangenheitHoechstensS) {
        return new Messzeitregel(zukunftHoechstensS, vergangenheitHoechstensS);
    }
}
