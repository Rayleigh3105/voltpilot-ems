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
 * Die Spring-Verdrahtung des VERDICHTUNGS-TAKTS der Viertelstundenwerte (UEMS AP-07 IP-12) — der
 * Teil, den weder die reinen Regeln ({@link ViertelstundeRegelnTest}) noch der Testcontainers-Lauf
 * ({@code UemsViertelstundeMigrationTest} ruft {@code lauf()} von Hand) je anfasst.
 *
 * <p>Genau diese Lücke hat in diesem Projekt schon Produktion gekostet: ein Schalter, der in der
 * AUSGELIEFERTEN Datei falsch vorbelegt ist, ist grün im Testlauf und wirkungslos im Cluster (die
 * dokumentierte OTA-Listener-Falle). Also: Vorgabe AN in {@code application.yml}, AUS im Testlauf
 * ({@code pom.xml}).
 */
class ViertelstundeWiringTest {

    private static final String SCHALTER = "voltpilot.uems.viertelstunde.enabled";

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
            .withUserConfiguration(Nachbarn.class, ViertelstundeVerdichter.class,
                    ViertelstundeLaeufer.class, ViertelstundeSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitSeinemVerdichter() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(ViertelstundeLaeufer.class);
            assertThat(context).hasSingleBean(ViertelstundeVerdichter.class);
            assertThat(context).hasSingleBean(ViertelstundeSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie den Verdichter. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenThreadPoolNieDenVerdichter() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(ViertelstundeLaeufer.class);
            assertThat(context).doesNotHaveBean(ViertelstundeSchedulingConfig.class);
            assertThat(context).hasSingleBean(ViertelstundeVerdichter.class);
        });
    }

    /** Die AUSGELIEFERTE Vorgabe ist AN — und im Testlauf AUS (die @Scheduled-Falle). */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "uems", "viertelstunde", "enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_VIERTELSTUNDE_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "uems", "viertelstunde", "interval-ms"))
                .isEqualTo("${VOLTPILOT_UEMS_VIERTELSTUNDE_INTERVAL_MS:300000}");

        String pom = Files.readString(Path.of("pom.xml"));
        assertThat(pom).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }

    @SuppressWarnings("unchecked")
    private static Object at(Map<String, Object> yml, String... pfad) {
        Object knoten = yml;
        for (String schluessel : pfad) {
            knoten = ((Map<String, Object>) knoten).get(schluessel);
        }
        return knoten;
    }
}
