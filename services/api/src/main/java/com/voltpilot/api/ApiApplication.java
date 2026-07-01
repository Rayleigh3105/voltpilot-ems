package com.voltpilot.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Voltpilot-EMS portal backend / API.
 *
 * <p>Responsibility (architecture section 8): REST/WS, multi-tenancy, business
 * logic. Stateless. Serves the tenant-scoped customer endpoints (sites/devices/
 * telemetry, device claiming) and the platform-admin API (tenant + user
 * management) - see {@code docs/contracts/openapi.yaml}.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class ApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(ApiApplication.class, args);
    }
}
