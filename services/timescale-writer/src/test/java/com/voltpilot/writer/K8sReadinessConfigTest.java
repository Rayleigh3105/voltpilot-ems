package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

/**
 * The container/Kubernetes contract of the shipped application.yml
 * (docs/k8s-readiness.md). Pure unit test - no Docker, no Spring context.
 *
 * <p>These four properties are what a manifest is allowed to assume, and every
 * one of them is invisible in normal development: without {@code
 * server.shutdown: graceful} a rolling deploy cuts in-flight requests, without
 * the probe groups {@code /health/liveness} and {@code /health/readiness}
 * simply 404, and a liveness probe pointed at the aggregate {@code /health}
 * would restart the pod for an unreachable database. A silent edit here breaks
 * the deployment, not the tests - hence this guard.
 */
class K8sReadinessConfigTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> applicationYml() {
        try (InputStream in =
                K8sReadinessConfigTest.class.getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml on the classpath").isNotNull();
            return new Yaml().loadAll(in).iterator().next() instanceof Map<?, ?> map
                    ? (Map<String, Object>) map
                    : Map.of();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> root, String... path) {
        Object node = root;
        for (String key : path) {
            if (!(node instanceof Map<?, ?> map)) {
                return null;
            }
            node = ((Map<String, Object>) map).get(key);
        }
        return node;
    }

    @Test
    void shutdownIsGracefulSoARollingDeployDoesNotCutInFlightWork() {
        Map<String, Object> yml = applicationYml();
        assertThat(at(yml, "server", "shutdown")).isEqualTo("graceful");
        // The ceiling must stay below the pod's terminationGracePeriodSeconds
        // so the JVM always leaves on its own instead of being SIGKILLed.
        assertThat(String.valueOf(at(yml, "spring", "lifecycle", "timeout-per-shutdown-phase")))
                .contains("SHUTDOWN_TIMEOUT")
                .contains("20s");
    }

    @Test
    void actuatorExposesTheSeparateLivenessAndReadinessProbes() {
        Map<String, Object> yml = applicationYml();
        // base-path "/" is what puts them at /health/liveness + /health/readiness.
        assertThat(at(yml, "management", "endpoints", "web", "base-path")).isEqualTo("/");
        assertThat(String.valueOf(at(yml, "management", "endpoints", "web", "exposure", "include")))
                .contains("health");
        assertThat(at(yml, "management", "endpoint", "health", "probes", "enabled"))
                .isEqualTo(true);
    }

    @Test
    void theConnectionPoolSizeIsAnEnvKnobWithTheUnchangedDefault() {
        // A multi-replica deployment sizes the pool per replica against the
        // DB's max_connections; the default stays Hikari's 10 so nothing
        // changes for the single-container deployment.
        assertThat(String.valueOf(
                        at(applicationYml(), "spring", "datasource", "hikari", "maximum-pool-size")))
                .isEqualTo("${DB_POOL_MAX_SIZE:10}");
    }
}
