package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.voltpilot.api.entities.EntitiesSchedulingConfig;
import com.voltpilot.api.entities.EntityObservedRepository;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.metrics.MetricsSchedulingConfig;
import com.voltpilot.api.ota.OtaSchedulingConfig;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.templates.ComponentTemplateRepository;
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
 * Die Spring-Verdrahtung der BESTANDS-ÜBERNAHME (Einheitsmodell Stufe 2) - der
 * Teil, den weder {@link ComponentAdoptionTest} (rein) noch der
 * Testcontainers-Lauf (stößt {@code run()} von Hand an) je anfasst.
 *
 * <p>Genau diese Lücke hat in diesem Projekt schon zweimal Produktion gekostet:
 * ein fehlendes {@code @Autowired} an einem Zwei-Konstruktoren-Bean
 * ({@code BrokerAuthzReloader}) ließ die api mit „No default constructor found"
 * kreiseln - und dieser PR hatte den Fehler prompt in einer dritten Variante
 * ({@code Clock} ist keine Bohne). Und ein Schalter, der in der AUSGELIEFERTEN
 * Datei falsch vorbelegt ist, ist dieselbe Klasse: grün im Testlauf,
 * wirkungslos im Cluster.
 */
class ComponentAdoptionWiringTest {

    /** Die Nachbarn, die der Läufer im echten Kontext vorfindet. */
    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {
        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }

        @Bean
        EntityRegistryRepository entityRegistryRepository() {
            return mock(EntityRegistryRepository.class);
        }

        @Bean
        EntityObservedRepository entityObservedRepository() {
            return mock(EntityObservedRepository.class);
        }

        @Bean
        ComponentDefinitionRepository componentDefinitionRepository() {
            return mock(ComponentDefinitionRepository.class);
        }

        @Bean
        ComponentTemplateRepository componentTemplateRepository() {
            return mock(ComponentTemplateRepository.class);
        }

        @Bean
        EntityRegistryService entityRegistryService() {
            return mock(EntityRegistryService.class);
        }

        @Bean
        AssetRepository assetRepository() {
            return mock(AssetRepository.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, ComponentAdoptionService.class,
                    ComponentRebindService.class, ComponentAdoptionRunner.class,
                    ComponentsSchedulingConfig.class);

    /**
     * Fällt gegen ein fehlendes {@code @Autowired} an einem der beiden
     * Zwei-Konstruktoren-Beans - und gegen die Annahme, es gäbe eine
     * {@code Clock}-Bohne (der Fehler, den dieser PR beim ersten Lauf hatte).
     */
    @Test
    void springCanBuildTheAdoptionServiceAndItsRunnerDespiteTheTwoConstructors() {
        runner.withPropertyValues("voltpilot.components.adoption.reconcile-enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(ComponentAdoptionService.class);
                    assertThat(context).hasSingleBean(ComponentRebindService.class);
                    assertThat(context).hasSingleBean(ComponentAdoptionRunner.class);
                    assertThat(context).hasSingleBean(ComponentsSchedulingConfig.class);
                });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN - geprüft an der echten
     * {@code application.yml}, nicht an einem Kontext (der Testlauf schaltet den
     * Takt global aus, siehe {@code pom.xml}).
     *
     * <p>Darauf kommt es an: eine Übernahme, die daran hängt, dass jemand eine
     * Umgebungsvariable im gitops-Repo nachzieht, findet in Produktion nie statt
     * - das ist wörtlich die dokumentierte OTA-Listener-Falle.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theShippedDefaultsAreOnBecauseTheTakeoverMustNotNeedAnEnvVar() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "components", "adoption", "enabled"))
                .isEqualTo("${VOLTPILOT_COMPONENTS_ADOPTION_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "components", "adoption", "reconcile-enabled"))
                .isEqualTo("${VOLTPILOT_COMPONENTS_ADOPTION_RECONCILE_ENABLED:true}");
    }

    /** Der Not-Aus nimmt den Takt, nie den Dienst selbst (der Rückweg bleibt). */
    @Test
    void theKillSwitchRemovesTheSchedulerButNeverTheServiceItself() {
        runner.withPropertyValues("voltpilot.components.adoption.reconcile-enabled=false")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).doesNotHaveBean(ComponentsSchedulingConfig.class);
                    assertThat(context).hasSingleBean(ComponentAdoptionRunner.class);
                    assertThat(context).hasSingleBean(ComponentAdoptionService.class);
                });
    }

    /**
     * In Produktion sind jetzt VIER Scheduling-Konfigurationen an; in keinem
     * anderen Test war das gemeinsam der Fall. Vier {@code @EnableScheduling}
     * importieren dieselbe {@code SchedulingConfiguration}, und Spring
     * verarbeitet denselben Import genau einmal - hier belegt statt behauptet.
     */
    @Test
    void allFourSchedulingConfigurationsCanBeActiveTogether() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(ComponentsSchedulingConfig.class,
                        EntitiesSchedulingConfig.class, MetricsSchedulingConfig.class,
                        OtaSchedulingConfig.class)
                .withPropertyValues(
                        "voltpilot.components.adoption.reconcile-enabled=true",
                        "voltpilot.entities.backfill.reconcile-enabled=true",
                        "voltpilot.metrics.fleet.enabled=true",
                        "voltpilot.ota.mqtt-listener-enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(ComponentsSchedulingConfig.class);
                    assertThat(context).hasSingleBean(SchedulingConfiguration.class);
                });
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> yml, String... path) {
        Object node = yml;
        for (String key : path) {
            node = ((Map<String, Object>) node).get(key);
        }
        return node;
    }
}
