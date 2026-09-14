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
 * Die Spring-Verdrahtung der Korrektur-Kaskade (UEMS AP-08 IP-17) — der Teil, den der Testcontainers-Lauf
 * ({@code UemsKorrekturKaskadeTest} ruft {@code lauf} von Hand) nie anfasst. Vorgabe AN in {@code application.yml}, AUS
 * im Testlauf ({@code pom.xml}); die beiden Nähte (Kennzahlen AP-11, Berichte AP-12) sind als LEERE Beans da.
 */
class KorrekturKaskadeWiringTest {

    private static final String SCHALTER = "voltpilot.uems.kaskade.enabled";

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

        @Bean
        ViertelstundeVerdichter viertelstundeVerdichter() {
            return mock(ViertelstundeVerdichter.class);
        }

        @Bean
        ErsatzwertLauf ersatzwertLauf() {
            return mock(ErsatzwertLauf.class);
        }

        @Bean
        BerechnetePeriodenLauf berechnetePeriodenLauf() {
            return mock(BerechnetePeriodenLauf.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, KennzahlenNaht.Keine.class, BerichteNaht.Keine.class,
                    KorrekturKaskade.class, KorrekturKaskadeLaeufer.class, KorrekturKaskadeSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitDerKaskadeUndDenLeerenNaehten() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(KorrekturKaskadeLaeufer.class);
            assertThat(context).hasSingleBean(KorrekturKaskade.class);
            assertThat(context).hasSingleBean(KorrekturKaskadeSchedulingConfig.class);
            assertThat(context.getBean(KennzahlenNaht.class)).isInstanceOf(KennzahlenNaht.Keine.class);
            assertThat(context.getBean(BerichteNaht.class)).isInstanceOf(BerichteNaht.Keine.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie die Kaskade selbst. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenThreadPoolNieDieKaskade() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(KorrekturKaskadeLaeufer.class);
            assertThat(context).doesNotHaveBean(KorrekturKaskadeSchedulingConfig.class);
            assertThat(context).hasSingleBean(KorrekturKaskade.class);
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
        Map<String, Object> kaskade = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml
                .get("voltpilot")).get("uems")).get("kaskade");
        assertThat(kaskade.get("enabled")).isEqualTo("${VOLTPILOT_UEMS_KASKADE_ENABLED:true}");
        assertThat(kaskade.get("interval-ms")).isEqualTo("${VOLTPILOT_UEMS_KASKADE_INTERVAL_MS:300000}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }

    /** Die Naht der Berichte kennt ohne AP-12 keinen Bericht — und die Grenze steht in der Kaskade, nicht in ihr. */
    @Test
    void ohneAp12GibtEsKeinenBericht() throws Exception {
        assertThat(new BerichteNaht.Keine().betroffene(null, null)).isEmpty();
    }
}
