package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.voltpilot.api.config.SecurityConfig;
import com.voltpilot.api.repo.FleetMetricsRepository;
import jakarta.servlet.Filter;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * <b>Was ein Scraper wirklich bekommt</b> - der eine Handgriff, den Prometheus
 * später tut, in einem Test: ein ANONYMES {@code GET /metrics} gegen die echte
 * Filterkette, und im ANTWORT-RUMPF stehen die vereinbarten Metriknamen.
 *
 * <p>Die beiden Nachbartests decken je eine Hälfte ab und lassen genau dazwischen
 * eine Lücke: {@code MetricsEndpointSecurityTest} beweist, dass der Pfad anonym
 * antwortet, kennt aber den Sammler nicht (sein Rumpf trägt nur JVM-Metriken);
 * {@code FleetMetricsScrapeTest} beweist die Namen, aber an einer direkt gebauten
 * Registry ohne HTTP und ohne Security. Beides zusammen ist erst der Vertrag -
 * dass Pfad, Freigabe, Endpunkt-Umhängung, Autokonfiguration und Sammler
 * GEMEINSAM funktionieren. Genau danach hat Teil 2 (die Alarm-Regeln) gefragt,
 * bevor er seinen ServiceMonitor auf diesen Pfad stellt.
 *
 * <p>Ohne Datenbank: die Repository-Schicht ist eine Attrappe, geprüft wird der
 * Weg vom Sammler bis in den HTTP-Rumpf.
 */
@AutoConfigureObservability
@SpringBootTest(classes = FleetMetricsEndpointE2eTest.ScrapeApp.class,
        properties = {
            "voltpilot.security.oidc.enabled=true",
            // Der Takt wird hier nicht gebraucht - der Test sammelt selbst, damit
            // er nicht auf einen Zeitgeber wartet.
            "voltpilot.metrics.fleet.initial-delay-ms=3600000"
        })
class FleetMetricsEndpointE2eTest {

    private static final UUID SITE = UUID.fromString("44440000-0000-0000-0000-000000000004");
    private static final UUID TENANT = UUID.fromString("aaaa0000-0000-0000-0000-00000000000a");

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = {
        DataSourceAutoConfiguration.class,
        DataSourceTransactionManagerAutoConfiguration.class,
        JdbcTemplateAutoConfiguration.class,
        FlywayAutoConfiguration.class
    })
    @Import({SecurityConfig.class, FleetMetricsCollector.class})
    static class ScrapeApp {

        /** Eine Flotte aus einer gesunden Anlage in einer bepreisten Zone. */
        @Bean
        FleetMetricsRepository fleetMetricsRepository() {
            return new FleetMetricsRepository(null) {
                @Override
                public List<SiteRow> sites() {
                    return List.of(new SiteRow(SITE, TENANT, "DE-LU"));
                }

                @Override
                public Map<UUID, Instant> lastPlanPerSite(Instant from) {
                    return Map.of(SITE, Instant.now().minus(Duration.ofMinutes(30)));
                }

                @Override
                public Set<UUID> sitesThatEverPlanned() {
                    return Set.of(SITE);
                }

                @Override
                public Map<UUID, Instant> lastTelemetryPerSite() {
                    return Map.of(SITE, Instant.now().minus(Duration.ofMinutes(2)));
                }

                @Override
                public Map<String, List<Instant>> pricedSlotsPerZone(Instant from, Instant to) {
                    Instant slot = FleetMetrics.floorToSlot(Instant.now());
                    return Map.of("DE-LU", List.of(slot, slot.plus(FleetMetrics.SLOT)));
                }
            };
        }
    }

    @Autowired
    private WebApplicationContext context;

    @Autowired
    private FleetMetricsCollector collector;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
        collector.tick();
    }

    @Test
    void anAnonymousScrapeReturnsTheContractMetricsOverHttp() throws Exception {
        MvcResult result = mockMvc.perform(get("/metrics")).andReturn();

        assertThat(result.getResponse().getStatus())
                .as("anonymer GET /metrics")
                .isEqualTo(HttpStatus.OK.value());

        String body = result.getResponse().getContentAsString();
        assertThat(body)
                .contains(FleetMetricsCollector.PLAN_AGE
                        + "{site=\"" + SITE + "\",tenant=\"" + TENANT + "\"}")
                .contains(FleetMetricsCollector.TELEMETRY_AGE
                        + "{site=\"" + SITE + "\",tenant=\"" + TENANT + "\"}")
                .contains(FleetMetricsCollector.PRICED_SLOTS + "{zone=\"DE-LU\"} 2.0")
                .contains(FleetMetricsCollector.PLAN_STATE)
                .contains(FleetMetricsCollector.TELEMETRY_STATE)
                .contains(FleetMetricsCollector.SITES + " 1.0");

        // Die Namen tragen kein angehaengtes Suffix - was hier steht, ist exakt
        // das, worauf die Alarm-Regeln zeigen.
        assertThat(body).doesNotContain("voltpilot_sites_total");
    }
}
