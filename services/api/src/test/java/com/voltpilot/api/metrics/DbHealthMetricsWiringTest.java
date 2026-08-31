package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.repo.DbHealthMetricsRepository;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.io.InputStream;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.SchedulingConfiguration;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung des Datenhaltungs-Sammlers - der Teil, den weder der
 * reine Scrape-Test noch der Testcontainers-Test je anfassen, weil beide die
 * Klasse direkt bauen. Dieselbe Klasse Fehler wie bei {@code BrokerAuthzReloader}
 * (zwei Konstruktoren, kein {@code @Autowired} -> Boot-Absturz, waehrend alle
 * Tests gruen bleiben); {@link DbHealthMetricsCollector} hat ebenfalls zwei
 * Konstruktoren, also gilt hier derselbe Waechter.
 */
class DbHealthMetricsWiringTest {

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {
        @Bean
        MeterRegistry meterRegistry() {
            return new SimpleMeterRegistry();
        }

        @Bean
        DbHealthMetricsRepository dbHealthMetricsRepository() {
            // Kein Datenbankzugriff in diesem Test - es geht um die Verdrahtung.
            return new DbHealthMetricsRepository(new JdbcTemplate());
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, DbHealthMetricsCollector.class,
                    DbMetricsSchedulingConfig.class);

    @Test
    void springCanBuildTheCollectorDespiteItsTwoConstructors() {
        runner.withPropertyValues("voltpilot.metrics.db.enabled=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(DbHealthMetricsCollector.class);
            assertThat(context).hasSingleBean(DbMetricsSchedulingConfig.class);
        });
    }

    @Test
    void theKillSwitchRemovesTheCollectorAndItsScheduler() {
        runner.withPropertyValues("voltpilot.metrics.db.enabled=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(DbHealthMetricsCollector.class);
            assertThat(context).doesNotHaveBean(DbMetricsSchedulingConfig.class);
        });
    }

    @Test
    void aSecondSchedulingConfigurationDoesNotDoubleTheGrounding() {
        // Neben MetricsSchedulingConfig (Flotten-Sammler) ist dies ein ZWEITES
        // @EnableScheduling; in Produktion sind beide an. Zwei importieren
        // dieselbe SchedulingConfiguration - genau EIN Grundgeruest im Kontext.
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(DbMetricsSchedulingConfig.class, MetricsSchedulingConfig.class)
                .withPropertyValues(
                        "voltpilot.metrics.db.enabled=true",
                        "voltpilot.metrics.fleet.enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(DbMetricsSchedulingConfig.class);
                    assertThat(context).hasSingleBean(MetricsSchedulingConfig.class);
                    assertThat(context).hasSingleBean(SchedulingConfiguration.class);
                });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN - an der echten {@code application.yml}
     * geprueft, nicht an einem Kontext (der Testlauf schaltet den Sammler global
     * aus, sonst liefe der getaktete Job in zwischengespeicherten Kontexten gegen
     * gestoppte Container). Eine Alarmquelle, die daran haengt, dass jemand eine
     * Umgebungsvariable setzt, ist keine Alarmquelle.
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
        for (String key : new String[] {"voltpilot", "metrics", "db", "enabled"}) {
            node = ((Map<String, Object>) node).get(key);
        }
        assertThat(node).isEqualTo("${VOLTPILOT_METRICS_DB_ENABLED:true}");
    }
}
