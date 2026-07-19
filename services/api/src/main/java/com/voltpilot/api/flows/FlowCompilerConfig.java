package com.voltpilot.api.flows;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the {@link FlowCompiler} onto the flowc sidecar. The transport is
 * resolved via {@link ObjectProvider} so tests drop in a fake
 * {@link FlowCompilerHttp} bean and the REAL client/activation code runs
 * offline (the SimulationConfig/MastrConfig pattern). The bean is always
 * present - E2's compiler exists now - so {@link FlowActivationService}'s
 * "Compiler folgt" stop is only reachable via its null-provider test seam;
 * activation stays gated by {@code voltpilot.flows.activation.enabled}.
 */
@Configuration
@EnableConfigurationProperties(FlowCompilerProperties.class)
public class FlowCompilerConfig {

    @Bean
    public FlowCompiler flowCompiler(FlowCompilerProperties props,
            ObjectProvider<FlowCompilerHttp> httpProvider, ObjectMapper json) {
        FlowCompilerHttp http = httpProvider.getIfAvailable(
                () -> new JdkFlowCompilerHttp(props.timeout()));
        return new FlowCompilerClient(http, URI.create(props.baseUrl()), json);
    }
}
