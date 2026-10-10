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
 * Die Spring-Verdrahtung des Lücken-Melders (UEMS AP-07 IP-9) — der Teil, den weder die reinen
 * Regeln ({@link LueckenRegelnTest}) noch der Testcontainers-Lauf ({@code UemsLueckenMelderTest}
 * ruft {@code lauf} von Hand) je anfasst. Vorgabe AN in {@code application.yml}, AUS im Testlauf
 * ({@code pom.xml}) — derselbe Block {@code voltpilot.uems.*} wie Verdichtung und Endgültigkeit.
 */
class LueckenWiringTest {

    private static final String SCHALTER = "voltpilot.uems.luecken.enabled";

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
            .withUserConfiguration(Nachbarn.class, LueckenMelder.class, LueckenLaeufer.class,
                    LueckenSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitDemMelder() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(LueckenLaeufer.class);
            assertThat(context).hasSingleBean(LueckenMelder.class);
            assertThat(context).hasSingleBean(LueckenSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie den Melder selbst. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenThreadPoolNieDenMelder() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(LueckenLaeufer.class);
            assertThat(context).doesNotHaveBean(LueckenSchedulingConfig.class);
            assertThat(context).hasSingleBean(LueckenMelder.class);
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
        Map<String, Object> uems = (Map<String, Object>) at(yml, "voltpilot", "uems");
        assertThat(uems).as("ein Block für alle UEMS-Läufe")
                .containsKeys("viertelstunde", "endgueltigkeit", "luecken");
        assertThat(at(yml, "voltpilot", "uems", "luecken", "enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_LUECKEN_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "uems", "luecken", "interval-ms"))
                .as("fünf Minuten = die Herzschlag-Toleranz")
                .isEqualTo("${VOLTPILOT_UEMS_LUECKEN_INTERVAL_MS:300000}");
        assertThat(LueckenRegeln.HERZSCHLAG_TOLERANZ_S * 1000).isEqualTo(300_000L);

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
