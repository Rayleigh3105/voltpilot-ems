package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * The probe paths a Kubernetes manifest points at REALLY exist and answer
 * (docs/k8s-readiness.md) - not just as YAML but as routes.
 *
 * <p>Boots the real ingest app (the only JVM service with no datasource, so this
 * needs no container at all) and hits the three actuator routes. All three JVM
 * services carry the SAME actuator block, so proving it once proves the shape:
 * {@code base-path: /} plus {@code probes.enabled: true} is what puts liveness
 * and readiness at their own paths. Without either they would 404 and every pod
 * would be stuck NotReady - a failure that only shows on the cluster.
 *
 * <p>The MQTT/provisioning adapters are disabled here: this test is about the
 * HTTP surface, and the broker legs have their own container-backed tests.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
            "voltpilot.provisioning.enabled=false",
            "voltpilot.telemetry-v2.enabled=false",
            "spring.integration.endpoints.no-auto-startup=*"
        })
class ProbeEndpointsTest {

    @LocalServerPort int port;

    /** Whether the Redpanda topic events.raw exists - there is no Redpanda in this test. */
    @MockBean EventsTopicPruefung eventsTopic;

    private HttpResponse<String> get(String path) throws Exception {
        HttpClient client =
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        return client.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                        .timeout(Duration.ofSeconds(10))
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void livenessAndReadinessAnswerOnTheirOwnPaths() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(true);
        HttpResponse<String> liveness = get("/health/liveness");
        assertThat(liveness.statusCode())
                .as("/health/liveness must exist - a manifest probes it")
                .isEqualTo(200);
        assertThat(liveness.body()).contains("\"status\":\"UP\"");

        HttpResponse<String> readiness = get("/health/readiness");
        assertThat(readiness.statusCode())
                .as("/health/readiness must exist - a manifest probes it")
                .isEqualTo(200);
        assertThat(readiness.body()).contains("\"status\":\"UP\"");
    }

    /**
     * UEMS AP-07 IP-5: without the topic events.raw the ingest is alive but NOT ready (503), so a
     * deploy that forgot the topic never reports ready; with the topic it is.
     */
    @Test
    void readinessWaitsForTheEventsTopic() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(false);
        HttpResponse<String> nichtBereit = get("/health/readiness");
        assertThat(nichtBereit.statusCode()).isEqualTo(503);
        assertThat(nichtBereit.body()).contains("\"status\":\"DOWN\"");
        assertThat(get("/health/liveness").statusCode()).as("alive, just not ready").isEqualTo(200);

        when(eventsTopic.vorhanden()).thenReturn(true);
        HttpResponse<String> bereit = get("/health/readiness");
        assertThat(bereit.statusCode()).isEqualTo(200);
        assertThat(bereit.body()).contains("\"status\":\"UP\"");
    }

    @Test
    void theAggregateHealthStaysWhereTheComposeHealthcheckExpectsIt() throws Exception {
        when(eventsTopic.vorhanden()).thenReturn(true);
        // The compose healthcheck greps this exact route/shape; k8s uses the
        // two probe routes above instead (the aggregate includes external
        // systems, and restarting a pod never fixes those).
        HttpResponse<String> health = get("/health");
        assertThat(health.statusCode()).isEqualTo(200);
        assertThat(health.body()).contains("\"status\":\"UP\"");
    }
}
