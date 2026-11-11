package com.voltpilot.api.erzeuger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.forecast.ForecastModelService;
import com.voltpilot.api.optimizer.OptimizerDiagnosticsService;
import com.voltpilot.api.repo.HistoryRepository;
import com.voltpilot.api.uems.AnteilVerlustRepository;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung des Vorgaben-Läufers (UEMS EZ-7) — der Teil, den weder die reine Ableitung
 * ({@link VorgabenAbleitungTest}) noch der Testcontainers-Lauf ({@code VorgabenDbTest} ruft {@code lauf} von Hand)
 * anfasst. Vorgabe AN in {@code application.yml}, AUS im Testlauf ({@code pom.xml}).
 */
class VorgabenWiringTest {

    private static final String SCHALTER = "voltpilot.erzeuger.vorgaben.enabled";

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }

        @Bean
        VorgabenLaufRepository vorgabenLaufRepository() {
            return mock(VorgabenLaufRepository.class);
        }

        @Bean
        PlatformTransactionManager transaktionen() {
            return mock(PlatformTransactionManager.class);
        }

        @Bean
        ObjectMapper objectMapper() {
            return new ObjectMapper();
        }

        @Bean
        ForecastModelService modelle() {
            return mock(ForecastModelService.class);
        }

        @Bean
        AnteilVerlustRepository prognosen() {
            return mock(AnteilVerlustRepository.class);
        }

        @Bean
        OptimizerDiagnosticsService preise() {
            return mock(OptimizerDiagnosticsService.class);
        }

        @Bean
        HistoryRepository boerse() {
            return mock(HistoryRepository.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, VorgabenLaeufer.class, VorgabenSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSich() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(VorgabenLaeufer.class);
            assertThat(context).hasSingleBean(VorgabenSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenThreadPool() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(VorgabenLaeufer.class);
            assertThat(context).doesNotHaveBean(VorgabenSchedulingConfig.class);
        });
    }

    /** Die AUSGELIEFERTE Vorgabe ist AN, im Minutentakt — und im Testlauf AUS. */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "erzeuger", "vorgaben", "enabled"))
                .isEqualTo("${VOLTPILOT_ERZEUGER_VORGABEN_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "erzeuger", "vorgaben", "interval-ms"))
                .isEqualTo("${VOLTPILOT_ERZEUGER_VORGABEN_INTERVAL_MS:60000}");
        String pom = Files.readString(Path.of("pom.xml"));
        assertThat(pom).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> yml, String... pfad) {
        Object knoten = yml;
        for (String schluessel : pfad) {
            assertThat(knoten).as(String.join(".", pfad)).isInstanceOf(Map.class);
            knoten = ((Map<String, Object>) knoten).get(schluessel);
        }
        return knoten;
    }
}
