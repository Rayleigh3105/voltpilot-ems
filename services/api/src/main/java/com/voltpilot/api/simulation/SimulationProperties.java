package com.voltpilot.api.simulation;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Ersparnis-Simulation service access ({@code voltpilot.simulation.*}). The
 * simulation service is the optimization image's {@code simulate-serve}
 * entrypoint on the INTERNAL compose network (no auth of its own - all
 * auth/tenancy lives here in the api, the ingest JdbcDeviceDirectory trust
 * pattern); {@code base-url} defaults to the compose service name.
 */
@ConfigurationProperties(prefix = "voltpilot.simulation")
public record SimulationProperties(String baseUrl, Duration timeout) {

    public SimulationProperties {
        if (baseUrl == null || baseUrl.isBlank()) {
            baseUrl = "http://simulation:8095";
        }
        if (timeout == null) {
            timeout = Duration.ofSeconds(15);
        }
    }
}
