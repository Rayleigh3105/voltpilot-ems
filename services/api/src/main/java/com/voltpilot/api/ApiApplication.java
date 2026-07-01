package com.voltpilot.api;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Voltpilot-EMS portal backend / API.
 *
 * <p>Responsibility (architecture section 8): REST/WS, multi-tenancy, business
 * logic. Stateless. This is an MVP skeleton - endpoints under
 * {@code /api/v1/**} are stubs described by {@code docs/contracts/openapi.yaml}.
 */
@SpringBootApplication
public class ApiApplication {

    public static void main(String[] args) {
        SpringApplication.run(ApiApplication.class, args);
    }
}
