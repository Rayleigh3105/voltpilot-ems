package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.writer.KafkaConsumerLag.PartitionOffsets;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.io.InputStream;
import java.util.List;
import java.util.Map;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaAdmin;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung des Kafka-Lag-Sammlers - der Teil, den weder der reine
 * Scrape-Test noch der Testcontainers-Test anfassen. Dieselbe Klasse Fehler wie
 * bei {@code BrokerAuthzReloader} (zwei Konstruktoren, kein {@code @Autowired}
 * -> Boot-Absturz, waehrend alle Tests gruen bleiben): {@link
 * KafkaLagMetricsCollector} hat ebenfalls zwei Konstruktoren.
 */
class KafkaLagMetricsWiringTest {

    @Configuration(proxyBeanMethods = false)
    static class CollectorNachbarn {
        @Bean
        MeterRegistry meterRegistry() {
            return new SimpleMeterRegistry();
        }

        @Bean
        KafkaLagProbe kafkaLagProbe() {
            return () -> List.<PartitionOffsets>of();
        }
    }

    private final ApplicationContextRunner collectorRunner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(CollectorNachbarn.class, KafkaLagMetricsCollector.class);

    @Test
    void springCanBuildTheCollectorDespiteItsTwoConstructors() {
        collectorRunner.withPropertyValues("voltpilot.metrics.kafka-lag.enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(KafkaLagMetricsCollector.class);
                });
    }

    @Test
    void theKillSwitchRemovesTheCollector() {
        collectorRunner.withPropertyValues("voltpilot.metrics.kafka-lag.enabled=false")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).doesNotHaveBean(KafkaLagMetricsCollector.class);
                });
    }

    @Configuration(proxyBeanMethods = false)
    static class KafkaAdminNachbar {
        @Bean
        KafkaAdmin kafkaAdmin() {
            // Konstruktion baut KEINE Verbindung auf - der Admin verbindet lazy.
            return new KafkaAdmin(Map.of(
                    AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092"));
        }
    }

    @Test
    void theConfigBuildsTheAdminProbeFromTheKafkaAdmin() {
        new ApplicationContextRunner()
                .withInitializer(ctx -> ctx.getBeanFactory()
                        .setConversionService(ApplicationConversionService.getSharedInstance()))
                .withConfiguration(AutoConfigurations.of(
                        PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(KafkaAdminNachbar.class, KafkaLagMetricsConfig.class)
                .withPropertyValues("voltpilot.metrics.kafka-lag.enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(AdminKafkaLagProbe.class);
                });
    }

    @Test
    void theConfigIsAbsentWhenDisabled() {
        new ApplicationContextRunner()
                .withInitializer(ctx -> ctx.getBeanFactory()
                        .setConversionService(ApplicationConversionService.getSharedInstance()))
                .withConfiguration(AutoConfigurations.of(
                        PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(KafkaAdminNachbar.class, KafkaLagMetricsConfig.class)
                .withPropertyValues("voltpilot.metrics.kafka-lag.enabled=false")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).doesNotHaveBean(AdminKafkaLagProbe.class);
                    assertThat(context).doesNotHaveBean(KafkaLagMetricsConfig.class);
                });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN - an der echten {@code application.yml}
     * geprueft (der Testlauf schaltet den Sammler global aus, sonst liefe der
     * Poll gegen einen toten Broker in zwischengespeicherten Kontexten). Eine
     * Alarmquelle, die daran haengt, dass jemand eine Umgebungsvariable setzt,
     * ist keine.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theShippedDefaultIsOnBecauseAnAlarmSourceMustNotNeedAnEnvVar() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Object node = yml;
        for (String key : new String[] {"voltpilot", "metrics", "kafka-lag", "enabled"}) {
            node = ((Map<String, Object>) node).get(key);
        }
        assertThat(node).isEqualTo("${VOLTPILOT_METRICS_KAFKA_LAG_ENABLED:true}");
    }

    /**
     * /metrics ist im Scrape-Set - der Prometheus-Endpunkt ist exponiert und auf
     * /metrics umgehaengt (wie beim api).
     */
    @Test
    @SuppressWarnings("unchecked")
    void thePrometheusEndpointIsExposedAndRemappedToMetrics() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Map<String, Object> web = (Map<String, Object>) nested(yml, "management", "endpoints", "web");
        Map<String, Object> exposure = (Map<String, Object>) ((Map<String, Object>) web).get("exposure");
        assertThat(exposure.get("include").toString()).contains("prometheus");
        Map<String, Object> mapping = (Map<String, Object>) web.get("path-mapping");
        assertThat(mapping).containsEntry("prometheus", "metrics");
    }

    @SuppressWarnings("unchecked")
    private static Object nested(Map<String, Object> root, String... keys) {
        Object node = root;
        for (String key : keys) {
            node = ((Map<String, Object>) node).get(key);
        }
        return node;
    }
}
