package com.voltpilot.ingest;

/**
 * Thrown when an inbound MQTT telemetry message violates
 * {@code docs/contracts/mqtt-telemetry.schema.json} (or the topic/payload
 * identities disagree). Ingest treats these as poison messages: it logs and
 * skips them rather than crashing (the QoS1 delivery is already acknowledged).
 */
public class InvalidTelemetryException extends RuntimeException {
    public InvalidTelemetryException(String message) {
        super(message);
    }
}
