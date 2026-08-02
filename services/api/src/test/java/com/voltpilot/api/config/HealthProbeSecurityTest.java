package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import jakarta.servlet.Filter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * The Kubernetes probe endpoints must answer an ANONYMOUS caller.
 *
 * <p>Regression guard for a live cluster outage (2026-08-02): the {@code secured}
 * chain permitted only the bare {@code /health}, but the management base-path is
 * the root, so Spring serves the probe groups at {@code /health/liveness} and
 * {@code /health/readiness} - both fell through to
 * {@code .anyRequest().authenticated()} and answered <b>401</b>, so the kubelet's
 * startup probe never passed and every api pod restart-looped. The compose
 * healthcheck asks for the bare {@code /health}, which is why the VM deployment
 * never showed it, and {@code K8sReadinessConfigTest} only pins the YAML - it
 * cannot see the filter chain. Hence this test drives the REAL chain.
 *
 * <p>Boots the real {@code application.yml} (the management base-path sitting at
 * the root is half the bug) with the real {@link SecurityConfig} and OIDC ON -
 * the fail-secure production default - but without the persistence layer, so it
 * needs neither Docker nor a database.
 */
@SpringBootTest(classes = HealthProbeSecurityTest.ProbeOnlyApp.class,
        properties = "voltpilot.security.oidc.enabled=true")
class HealthProbeSecurityTest {

    /**
     * A minimal app: the real security wiring plus web/actuator autoconfiguration,
     * with JDBC/Flyway excluded - nothing here talks to a database, and the health
     * aggregate must not need one either.
     */
    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = {
        DataSourceAutoConfiguration.class,
        DataSourceTransactionManagerAutoConfiguration.class,
        JdbcTemplateAutoConfiguration.class,
        FlywayAutoConfiguration.class
    })
    @Import(SecurityConfig.class)
    static class ProbeOnlyApp {
    }

    @Autowired
    private WebApplicationContext context;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        // The real springSecurityFilterChain, with NO test authentication applied:
        // the whole point is that an unauthenticated kubelet gets through.
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
    }

    @ParameterizedTest
    @ValueSource(strings = {"/health", "/health/liveness", "/health/readiness"})
    void probesAnswerAnonymouslyAndAreNeverRejectedAsUnauthorized(String path) throws Exception {
        int status = mockMvc.perform(get(path)).andReturn().getResponse().getStatus();

        // A DOWN state may legitimately answer 503 - what must never happen is the
        // security chain turning the probe away (401/403), which the kubelet reads
        // as a failed probe and answers with a container restart.
        assertThat(status)
                .as("anonymous GET %s", path)
                .isNotIn(HttpStatus.UNAUTHORIZED.value(), HttpStatus.FORBIDDEN.value())
                .isIn(HttpStatus.OK.value(), HttpStatus.SERVICE_UNAVAILABLE.value());
    }

    @Test
    void openingTheProbesDoesNotOpenTheApi() throws Exception {
        int status = mockMvc.perform(get("/api/v1/sites")).andReturn().getResponse().getStatus();

        assertThat(status).isEqualTo(HttpStatus.UNAUTHORIZED.value());
    }
}
