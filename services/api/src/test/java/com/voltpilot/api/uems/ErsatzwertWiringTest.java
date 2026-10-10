package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
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
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung des Ersatzwert-Laufs (UEMS AP-08 IP-13) — der Teil, den weder die reinen Regeln noch
 * der Testcontainers-Lauf ({@code UemsErsatzwertMethodenTest} ruft {@code lauf} von Hand) je anfasst. Vorgabe
 * AN in {@code application.yml}, AUS im Testlauf ({@code pom.xml}) — derselbe Block {@code voltpilot.uems.*}.
 */
class ErsatzwertWiringTest {

    private static final String SCHALTER = "voltpilot.uems.ersatzwert.enabled";

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }

        @Bean
        MeasurementCatalog measurementCatalog() {
            return new MeasurementCatalog(new ObjectMapper());
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, SpaetankunftMelder.class, ViertelstundeVerdichter.class,
                    ErsatzwertLauf.class, ErsatzwertLaeufer.class, ErsatzwertSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitDemLauf() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(ErsatzwertLaeufer.class);
            assertThat(context).hasSingleBean(ErsatzwertLauf.class);
            assertThat(context).hasSingleBean(ErsatzwertSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie den Lauf selbst. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenThreadPoolNieDenLauf() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(ErsatzwertLaeufer.class);
            assertThat(context).doesNotHaveBean(ErsatzwertSchedulingConfig.class);
            assertThat(context).hasSingleBean(ErsatzwertLauf.class);
        });
    }

    /** Die AUSGELIEFERTE Vorgabe ist AN, neben den anderen Läufen — und im Testlauf AUS. */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Map<String, Object> ersatzwert = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml
                .get("voltpilot")).get("uems")).get("ersatzwert");
        assertThat(ersatzwert.get("enabled")).isEqualTo("${VOLTPILOT_UEMS_ERSATZWERT_ENABLED:true}");
        assertThat(ersatzwert.get("interval-ms")).isEqualTo("${VOLTPILOT_UEMS_ERSATZWERT_INTERVAL_MS:300000}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }
}
