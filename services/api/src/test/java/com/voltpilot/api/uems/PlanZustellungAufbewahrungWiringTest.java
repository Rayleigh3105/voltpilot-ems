package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

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
import org.yaml.snakeyaml.Yaml;

/**
 * Die Verdrahtung der Frist für {@code plan_zustellung} (AP-15 IP-11) — der Teil, den der
 * Testcontainers-Lauf nie anfasst: der tägliche Takt (Vorgabe AN in {@code application.yml}, AUS im
 * Testlauf) und die Frist von 35 Tagen.
 */
class PlanZustellungAufbewahrungWiringTest {

    private static final String SCHALTER = "voltpilot.uems.plan-zustellung.enabled";

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory().setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, PlanZustellungAufbewahrung.class,
                    PlanZustellungAufbewahrungLaeufer.class, PlanZustellungAufbewahrungSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitDerAufbewahrung() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(PlanZustellungAufbewahrungLaeufer.class);
            assertThat(context).hasSingleBean(PlanZustellungAufbewahrungSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie die Aufbewahrung selbst. */
    @Test
    void derNotAusNimmtDenTaktNieDieAufbewahrung() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(PlanZustellungAufbewahrungLaeufer.class);
            assertThat(context).doesNotHaveBean(PlanZustellungAufbewahrungSchedulingConfig.class);
            assertThat(context).hasSingleBean(PlanZustellungAufbewahrung.class);
        });
    }

    @Test
    void eineFristUnterEinemTagStartetNicht() {
        runner.withPropertyValues("voltpilot.uems.plan-zustellung.aufbewahrung-tage=0")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnMit35TagenUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (var in = Files.newInputStream(Path.of("src/main/resources/application.yml"))) {
            yml = new Yaml().load(in);
        }
        Map<String, Object> p = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml.get("voltpilot"))
                .get("uems")).get("plan-zustellung");
        assertThat(p.get("enabled")).isEqualTo("${VOLTPILOT_UEMS_PLAN_ZUSTELLUNG_ENABLED:true}");
        assertThat(p.get("aufbewahrung-tage")).isEqualTo("${VOLTPILOT_UEMS_PLAN_ZUSTELLUNG_AUFBEWAHRUNG_TAGE:35}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }
}
