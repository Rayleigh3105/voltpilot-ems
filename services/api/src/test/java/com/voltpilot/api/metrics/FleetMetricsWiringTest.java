package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.ota.OtaSchedulingConfig;
import com.voltpilot.api.repo.FleetMetricsRepository;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.SchedulingConfiguration;

/**
 * Die Spring-Verdrahtung des Sammlers - der Teil, den weder die reinen Tests noch
 * die Testcontainers-Tests je anfassen, weil beide die Klasse direkt bauen.
 *
 * <p>Genau diese Lücke hat in diesem Projekt schon einmal Produktion umgeworfen:
 * {@code BrokerAuthzReloader} hatte zwei Konstruktoren und keine Markierung,
 * Spring konnte keinen wählen, suchte einen parameterlosen und der ganze
 * api-Kontext lief beim Start im Kreis - während alle Tests grün blieben, weil
 * sie die Klasse direkt instanziierten. {@link FleetMetricsCollector} hat
 * ebenfalls zwei Konstruktoren (Produktion + Test-Naht mit Uhr), also gilt hier
 * dasselbe Risiko und derselbe Wächter.
 *
 * <p>Dazu die zweite Zusage, die sonst NUR in Produktion geprüft würde: dass ein
 * ZWEITES {@code @EnableScheduling} neben {@code OtaSchedulingConfig}
 * unbedenklich ist. Kein Test schaltet den OTA-Schalter ein
 * ({@code OtaRolloutApiTest} setzt ihn ausdrücklich auf {@code false}), beide
 * Konfigurationen wären also erst im Cluster zum ersten Mal gemeinsam aktiv -
 * und ein Fehler dort wäre ein Boot-Absturz, kein roter Test.
 */
class FleetMetricsWiringTest {

    /** Die Nachbarn, die der Sammler im echten Kontext vorfindet. */
    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {
        @Bean
        MeterRegistry meterRegistry() {
            return new SimpleMeterRegistry();
        }

        @Bean
        FleetMetricsRepository fleetMetricsRepository() {
            // Kein Datenbankzugriff in diesem Test - es geht um die Verdrahtung.
            return new FleetMetricsRepository(new JdbcTemplate());
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, FleetMetricsCollector.class,
                    MetricsSchedulingConfig.class);

    @Test
    void springCanBuildTheCollectorDespiteItsTwoConstructors() {
        // Faellt gegen ein fehlendes @Autowired am Produktions-Konstruktor mit
        // "No default constructor found" - genau der Absturz, der schon einmal
        // ausgeliefert wurde.
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(FleetMetricsCollector.class);
            assertThat(context).hasSingleBean(MetricsSchedulingConfig.class);
        });
    }

    @Test
    void theCollectorIsOnByDefaultBecauseAnAlarmSourceMustNotNeedAnEnvVar() {
        // Ohne gesetzte Eigenschaft greift matchIfMissing - ein Deployment, das die
        // Variable nicht kennt, bekommt trotzdem Metriken. Das ist Absicht: der
        // Vorfall, wegen dem es sie gibt, blieb 17 Stunden unbemerkt.
        runner.run(context -> assertThat(context).hasSingleBean(FleetMetricsCollector.class));
    }

    @Test
    void theKillSwitchRemovesTheCollectorAndItsScheduler() {
        runner.withPropertyValues("voltpilot.metrics.fleet.enabled=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(FleetMetricsCollector.class);
            // Und mit ihm der Scheduler-Thread-Pool - die Zusage von
            // MetricsSchedulingConfig.
            assertThat(context).doesNotHaveBean(MetricsSchedulingConfig.class);
        });
    }

    @Test
    void bothSchedulingConfigurationsCanBeActiveTogether() {
        // In Produktion sind beide Schalter an; in keinem Test war das je der Fall.
        // Zwei @EnableScheduling importieren dieselbe SchedulingConfiguration, und
        // Spring verarbeitet denselben Import genau einmal - hier belegt statt
        // behauptet.
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(MetricsSchedulingConfig.class, OtaSchedulingConfig.class)
                .withPropertyValues(
                        "voltpilot.metrics.fleet.enabled=true",
                        "voltpilot.ota.mqtt-listener-enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(MetricsSchedulingConfig.class);
                    assertThat(context).hasSingleBean(OtaSchedulingConfig.class);
                    // Der Beweis, dass der Import nicht doppelt landet: genau EIN
                    // Scheduling-Grundgeruest im Kontext.
                    assertThat(context).hasSingleBean(SchedulingConfiguration.class);
                });
    }
}
