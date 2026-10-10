package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung des Strukturänderungs-Läufers (UEMS AP-12 IP-9) — der Teil, den der Testcontainers-Lauf
 * ({@code UemsStrukturAenderungTest} ruft {@code lauf} von Hand) nie anfasst: er hängt an SEINEM Flag und an dem der
 * Berichts-Naht, bekommt die Bean {@link BerichtKaskade}, ist ausgeliefert AN und im Testlauf AUS — nichts läuft ungefragt
 * im Hintergrund eines Tests mit.
 */
class StrukturAenderungWiringTest {

    private static final String SCHALTER = StrukturAenderungLaeufer.SCHALTER;
    private static final String BERICHTE = BerichtKaskade.SCHALTER;

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }

        @Bean
        BerichtAbzugBildung berichtAbzugBildung() {
            return mock(BerichtAbzugBildung.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, BerichtKaskade.class, BerichteNaht.Keine.class,
                    StrukturAenderungLaeufer.class, StrukturAenderungSchedulingConfig.class);

    @Test
    void derLaeuferBekommtDieBerichtsNaht() {
        runner.withPropertyValues(SCHALTER + "=true", BERICHTE + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(StrukturAenderungLaeufer.class);
            assertThat(context).hasSingleBean(StrukturAenderungSchedulingConfig.class);
            assertThat(context.getBean(StrukturAenderungLaeufer.class)).extracting("naht")
                    .isSameAs(context.getBean(BerichtKaskade.class));
        });
    }

    /** Der Not-Aus nimmt den Läufer und seinen Thread-Pool — nie die Naht, die die Kaskade braucht. */
    @Test
    void derNotAusNimmtDenLaeuferNieDieNaht() {
        runner.withPropertyValues(SCHALTER + "=false", BERICHTE + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(StrukturAenderungLaeufer.class);
            assertThat(context).doesNotHaveBean(StrukturAenderungSchedulingConfig.class);
            assertThat(context.getBean(BerichteNaht.class)).isInstanceOf(BerichtKaskade.class);
        });
    }

    /** Sind die Berichte zurückgebaut ({@link BerichteNaht.Keine}), läuft er nicht — sonst schriebe er Urteile ins Leere. */
    @Test
    void ohneBerichtsNahtLaeuftErNicht() {
        runner.withPropertyValues(SCHALTER + "=true", BERICHTE + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(StrukturAenderungLaeufer.class);
            assertThat(context).doesNotHaveBean(StrukturAenderungSchedulingConfig.class);
            assertThat(context.getBean(BerichteNaht.class)).isInstanceOf(BerichteNaht.Keine.class);
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void ausgeliefertAn_imTestlaufAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Map<String, Object> berichte = (Map<String, Object>) ((Map<String, Object>) ((Map<String, Object>) yml
                .get("voltpilot")).get("uems")).get("berichte");
        assertThat(((Map<String, Object>) berichte.get("struktur")).get("enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_BERICHTE_STRUKTUR_ENABLED:true}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
        // Im surefire-Lauf steht die Eigenschaft wirklich auf aus (außerhalb, etwa in der IDE, fehlt sie).
        assertThat(System.getProperty(SCHALTER, "false")).isEqualTo("false");

        for (Class<?> k : new Class<?>[] {StrukturAenderungLaeufer.class, StrukturAenderungSchedulingConfig.class}) {
            ConditionalOnProperty an = k.getAnnotation(ConditionalOnProperty.class);
            assertThat(an.name()).as(k.getSimpleName()).containsExactly(SCHALTER, BERICHTE);
            assertThat(an.havingValue()).isEqualTo("true");
            assertThat(an.matchIfMissing()).isTrue();
        }
        assertThat(StrukturAenderungLaeufer.class.getMethod("takt").getAnnotation(Scheduled.class)).isNotNull();
    }

    /** Die leere Naht kennt auch in Pfad 2 keinen Bericht. */
    @Test
    void dieLeereNahtKenntAuchInPfadZweiKeinenBericht() throws Exception {
        assertThat(new BerichteNaht.Keine().betroffene(null, (BerichteNaht.StrukturBetroffen) null)).isEmpty();
    }
}
