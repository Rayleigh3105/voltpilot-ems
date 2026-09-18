package com.voltpilot.api.entities;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.voltpilot.api.metrics.MetricsSchedulingConfig;
import com.voltpilot.api.ota.OtaSchedulingConfig;
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
 * Die Spring-Verdrahtung der SELBSTHEILUNG - der Teil, den weder
 * {@link V2SiteBackfillRunnerTest} (baut die Klasse direkt) noch die
 * Testcontainers-Tests (stossen {@code run()} von Hand an) je anfassen.
 *
 * <p>Genau diese Lücke ist der Grund, warum es diesen Umbau überhaupt gibt: die
 * Komposition lief zwar automatisch, aber NUR beim api-Start - eine Anlage, die
 * danach entstand, wartete auf den nächsten Deploy, und kein einziger Test hätte
 * das je gemerkt. Ein Schalter, der in der ausgelieferten Datei falsch
 * vorbelegt ist, wäre dieselbe Klasse von Fehler: grün im Testlauf, wirkungslos
 * im Cluster.
 */
class V2SiteBackfillReconcileWiringTest {

    /** Die Nachbarn, die der Läufer im echten Kontext vorfindet. */
    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {
        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            // Kein Datenbankzugriff in diesem Test - es geht um die Verdrahtung.
            // Als BEAN muss es eine Attrappe sein: Springs afterPropertiesSet
            // verlangt sonst eine DataSource.
            return mock(JdbcTemplate.class);
        }

        @Bean
        EntityRegistryService entityRegistryService() {
            return mock(EntityRegistryService.class);
        }

        /**
         * Auch eine Attrappe bekommt die {@code @Autowired}-Methoden ihrer Oberklasse gespritzt:
         * {@code EntityRegistryService.uebergabe(QuellenUebergabe)} kam mit PR 859 dazu, und ohne
         * diese Bohne bricht der Minimal-Kontext beim Bauen ab. In der echten Anwendung ist die
         * Klasse ein bedingungsloser {@code @Service}.
         */
        @Bean
        com.voltpilot.api.uems.QuellenUebergabe quellenUebergabe() {
            return mock(com.voltpilot.api.uems.QuellenUebergabe.class);
        }

        @Bean
        EntityRegistryRepository entityRegistryRepository() {
            return mock(EntityRegistryRepository.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, V2SiteBackfillRunner.class,
                    EntityAutoComposer.class, EntitiesSchedulingConfig.class);

    /**
     * Fällt gegen ein fehlendes {@code @Autowired} am Produktions-Konstruktor
     * mit "No default constructor found" - der Absturz, der in diesem Projekt
     * schon einmal ausgeliefert wurde ({@code BrokerAuthzReloader}). Der Läufer
     * hat zwei Konstruktoren, also gilt hier dasselbe Risiko.
     */
    @Test
    void springCanBuildTheRunnerAndTheComposerDespiteTheTwoConstructors() {
        // Ausdrücklich EIN: der Testlauf schaltet den Takt global aus (pom.xml),
        // und eine gesetzte Eigenschaft schlägt `matchIfMissing`.
        runner.withPropertyValues("voltpilot.entities.backfill.reconcile-enabled=true")
                .run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(V2SiteBackfillRunner.class);
            assertThat(context).hasSingleBean(EntityAutoComposer.class);
            assertThat(context).hasSingleBean(EntitiesSchedulingConfig.class);
        });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN - geprüft an der echten
     * {@code application.yml}, nicht an einem Kontext (der Testlauf schaltet den
     * Takt global aus, siehe {@code pom.xml}).
     *
     * <p>Darauf kommt es an: eine Selbstheilung, die daran hängt, dass jemand
     * eine Umgebungsvariable im gitops-Repo nachzieht, ist keine Selbstheilung -
     * das ist wörtlich die dokumentierte OTA-Listener-Falle.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theShippedDefaultsAreOnBecauseSelfHealingMustNotNeedAnEnvVar() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "entities", "backfill", "enabled"))
                .isEqualTo("${VOLTPILOT_ENTITIES_BACKFILL_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "entities", "backfill", "reconcile-enabled"))
                .isEqualTo("${VOLTPILOT_ENTITIES_BACKFILL_RECONCILE_ENABLED:true}");
    }

    @Test
    void theKillSwitchRemovesTheSchedulerButNeverTheRunnerItself() {
        runner.withPropertyValues("voltpilot.entities.backfill.reconcile-enabled=false")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).doesNotHaveBean(EntitiesSchedulingConfig.class);
                    // Der Start-Lauf und die Claim-/Speicher-Auslöser bleiben -
                    // abgeschaltet wird NUR der Takt.
                    assertThat(context).hasSingleBean(V2SiteBackfillRunner.class);
                    assertThat(context).hasSingleBean(EntityAutoComposer.class);
                });
    }

    /**
     * In Produktion sind alle drei Scheduling-Konfigurationen an; in keinem Test
     * war das je gemeinsam der Fall. Drei {@code @EnableScheduling} importieren
     * dieselbe {@code SchedulingConfiguration}, und Spring verarbeitet denselben
     * Import genau einmal - hier belegt statt behauptet.
     */
    @Test
    void allThreeSchedulingConfigurationsCanBeActiveTogether() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
                .withUserConfiguration(EntitiesSchedulingConfig.class,
                        MetricsSchedulingConfig.class, OtaSchedulingConfig.class)
                .withPropertyValues(
                        "voltpilot.entities.backfill.reconcile-enabled=true",
                        "voltpilot.metrics.fleet.enabled=true",
                        "voltpilot.ota.mqtt-listener-enabled=true")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(EntitiesSchedulingConfig.class);
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
