package com.voltpilot.api.simulation;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.consumers.ReplanClient;
import com.voltpilot.api.optimizer.WhatIfClient;
import java.net.URI;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the two proxies onto the optimization image's on-demand solve service:
 * the async Ersparnis-Simulation ({@link SimulationClient}) and the
 * synchronous admin what-if re-optimize ({@link WhatIfClient}). They share one
 * base-url + one transport ON PURPOSE - both are "solve something the 15-min
 * tick loop did not ask for" on the same internal container, so a second
 * config key would only be a second thing to keep in sync across both composes.
 *
 * <p>The transport is resolved via {@link ObjectProvider} so tests drop in a
 * fake {@link SimulationHttp} bean and the REAL client/controller code runs
 * offline (the MastrConfig pattern).
 */
@Configuration
@EnableConfigurationProperties(SimulationProperties.class)
public class SimulationConfig {

    /**
     * The shared transport. Deliberately NOT a {@code @Bean}: it is resolved
     * from an {@link ObjectProvider} (so a test's fake wins), and a bean that
     * looked itself up through a provider of its own type would be a circular
     * self-reference. Bean creation is single-threaded at startup, so the
     * plain lazy field is enough to keep both clients on ONE HttpClient.
     */
    private SimulationHttp http;

    private SimulationHttp http(SimulationProperties props,
            ObjectProvider<SimulationHttp> httpProvider) {
        if (http == null) {
            http = httpProvider.getIfAvailable(() -> new JdkSimulationHttp(props.timeout()));
        }
        return http;
    }

    @Bean
    public SimulationClient simulationClient(SimulationProperties props,
            ObjectProvider<SimulationHttp> httpProvider, ObjectMapper json) {
        return new SimulationClient(http(props, httpProvider), URI.create(props.baseUrl()), json);
    }

    @Bean
    public WhatIfClient whatIfClient(SimulationProperties props,
            ObjectProvider<SimulationHttp> httpProvider, ObjectMapper json) {
        return new WhatIfClient(http(props, httpProvider), URI.create(props.baseUrl()), json);
    }

    /** The D8 event-replan client (Verbrauchssteuerung Inkrement 4) - the third sibling. */
    @Bean
    public ReplanClient replanClient(SimulationProperties props,
            ObjectProvider<SimulationHttp> httpProvider) {
        return new ReplanClient(http(props, httpProvider), props.baseUrl());
    }
}
