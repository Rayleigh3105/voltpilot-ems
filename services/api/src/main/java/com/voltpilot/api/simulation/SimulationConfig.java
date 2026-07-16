package com.voltpilot.api.simulation;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the simulation proxy. The transport is resolved via
 * {@link ObjectProvider} so tests drop in a fake {@link SimulationHttp} bean
 * and the REAL client/controller code runs offline (the MastrConfig pattern).
 */
@Configuration
@EnableConfigurationProperties(SimulationProperties.class)
public class SimulationConfig {

    @Bean
    public SimulationClient simulationClient(SimulationProperties props,
            ObjectProvider<SimulationHttp> httpProvider, ObjectMapper json) {
        SimulationHttp http = httpProvider.getIfAvailable(() -> new JdkSimulationHttp(props.timeout()));
        return new SimulationClient(http, URI.create(props.baseUrl()), json);
    }
}
