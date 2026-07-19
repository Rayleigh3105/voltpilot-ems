package com.voltpilot.api.flows;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * flowc sidecar access ({@code voltpilot.flows.compiler.*}). The compiler is
 * the {@code flowc-serve} Node sidecar on the INTERNAL compose network (no auth
 * of its own - all auth/tenancy lives here in the api); {@code base-url}
 * defaults to the compose service name. Activation itself stays gated by the
 * separate {@code voltpilot.flows.activation.enabled} flag (default OFF).
 */
@ConfigurationProperties(prefix = "voltpilot.flows.compiler")
public record FlowCompilerProperties(String baseUrl, Duration timeout) {

    public FlowCompilerProperties {
        if (baseUrl == null || baseUrl.isBlank()) {
            baseUrl = "http://flowc:8099";
        }
        if (timeout == null) {
            timeout = Duration.ofSeconds(15);
        }
    }
}
