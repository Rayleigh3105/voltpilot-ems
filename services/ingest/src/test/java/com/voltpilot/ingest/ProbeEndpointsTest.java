package com.voltpilot.ingest;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
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

    @Test
    void theAggregateHealthStaysWhereTheComposeHealthcheckExpectsIt() throws Exception {
        // The compose healthcheck greps this exact route/shape; k8s uses the
        // two probe routes above instead (the aggregate includes external
        // systems, and restarting a pod never fixes those).
        HttpResponse<String> health = get("/health");
        assertThat(health.statusCode()).isEqualTo(200);
        assertThat(health.body()).contains("\"status\":\"UP\"");
    }
}
