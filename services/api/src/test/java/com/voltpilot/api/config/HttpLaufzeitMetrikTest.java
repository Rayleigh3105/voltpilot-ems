package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;

/**
 * Die Serverzeit je Route steht in {@code /metrics} als Histogramm (Scout vp-anlagen-cockpit-perf, Rang 7).
 *
 * <p>Ohne die festen Obergrenzen in {@code application.yml} (Schlüssel {@code
 * management.metrics.distribution.slo.http.server.requests}) liefert Spring Boot je Route nur Zähler, Summe
 * und Maximum; die Frage "wie viele Aufrufe von {@code /api/v1/overview} dauerten länger als eine Sekunde" ist
 * dann in Prod nicht zu beantworten. Der Test fährt einen ECHTEN Servlet-Container (die Messung sitzt im
 * Servlet-Filter, den {@code MockMvc} nicht durchläuft), ruft eine Route auf und liest {@code /metrics}.
 */
@AutoConfigureObservability
@SpringBootTest(classes = MetricsEndpointSecurityTest.MetricsOnlyApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "voltpilot.security.oidc.enabled=true",
            "voltpilot.metrics.fleet.enabled=false"
        })
class HttpLaufzeitMetrikTest {

    @Autowired
    private TestRestTemplate http;

    @Test
    void jedeRouteTraegtDieFestenZeitgrenzen() {
        http.getForEntity("/health", String.class);

        String metrics = http.getForEntity("/metrics", String.class).getBody();

        assertThat(metrics).isNotNull();
        for (String grenze : new String[] {"0.05", "0.1", "0.25", "0.5", "1.0", "2.5", "5.0", "10.0", "+Inf"}) {
            assertThat(metrics)
                    .as("Zeitgrenze le=%s für die aufgerufene Route", grenze)
                    .containsPattern("http_server_requests_seconds_bucket\\{[^}]*uri=\"/health\"[^}]*le=\""
                            + java.util.regex.Pattern.quote(grenze) + "\"");
        }
    }
}
