package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

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
 * Die Spring-Verdrahtung des STUNDENTAKTS der Endgültigkeit und der Tageswerte (UEMS AP-07
 * IP-13) — der Teil, den weder die reinen Regeln ({@link TagRegelnTest}) noch der
 * Testcontainers-Lauf ({@code UemsEndgueltigkeitTagesklasseTest} ruft die Läufe von Hand) je
 * anfasst.
 *
 * <p>Genau diese Lücke hat in diesem Projekt schon Produktion gekostet: ein Schalter, der in der
 * AUSGELIEFERTEN Datei falsch vorbelegt ist, ist grün im Testlauf und wirkungslos im Cluster (die
 * dokumentierte OTA-Listener-Falle). Also: Vorgabe AN in {@code application.yml}, AUS im Testlauf
 * ({@code pom.xml}).
 */
class EndgueltigkeitWiringTest {

    private static final String SCHALTER = "voltpilot.uems.endgueltigkeit.enabled";

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            return mock(JdbcTemplate.class);
        }

        /** Tag und Monat/Jahr bilden den Träger ihrer Reihe ({@link ReihenKontext}) aus dem Katalog. */
        @Bean
        MeasurementCatalog measurementCatalog() {
            return mock(MeasurementCatalog.class);
        }

        /** Der Korrektur-Vorschlag (AP-08 IP-14) rechnet „neu“ über den Verdichtungs-Lauf und zählt mit dem Melder. */
        @Bean
        ViertelstundeVerdichter viertelstundeVerdichter() {
            return mock(ViertelstundeVerdichter.class);
        }

        @Bean
        SpaetankunftMelder spaetankunftMelder() {
            return mock(SpaetankunftMelder.class);
        }

        /** Die berechneten Messstellen (AP-10 IP-10) rechnen im selben Takt nach den gemessenen. */
        @Bean
        BerechnetePeriodenLauf berechnetePeriodenLauf() {
            return mock(BerechnetePeriodenLauf.class);
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, EndgueltigkeitLauf.class, TagVerdichter.class,
                    PeriodeVerdichter.class, KorrekturVorschlagLauf.class, AblesungLueckenLauf.class, EndgueltigkeitLaeufer.class,
                    EndgueltigkeitSchedulingConfig.class);

    @Test
    void derTaktVerdrahtetSichMitBeidenLaeufen() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(EndgueltigkeitLaeufer.class);
            assertThat(context).hasSingleBean(EndgueltigkeitLauf.class);
            assertThat(context).hasSingleBean(TagVerdichter.class);
            assertThat(context).hasSingleBean(PeriodeVerdichter.class);
            assertThat(context).hasSingleBean(AblesungLueckenLauf.class);
            assertThat(context).hasSingleBean(KorrekturVorschlagLauf.class);
            assertThat(context).hasSingleBean(EndgueltigkeitSchedulingConfig.class);
        });
    }

    /** Der Not-Aus nimmt den Takt UND seinen Thread-Pool — nie die Läufe selbst. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenThreadPoolNieDieLaeufe() {
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(EndgueltigkeitLaeufer.class);
            assertThat(context).doesNotHaveBean(EndgueltigkeitSchedulingConfig.class);
            assertThat(context).hasSingleBean(EndgueltigkeitLauf.class);
            assertThat(context).hasSingleBean(TagVerdichter.class);
            assertThat(context).hasSingleBean(PeriodeVerdichter.class);
            assertThat(context).hasSingleBean(AblesungLueckenLauf.class);
            assertThat(context).hasSingleBean(KorrekturVorschlagLauf.class);
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
        assertThat(at(yml, "voltpilot", "uems", "endgueltigkeit", "enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_ENDGUELTIGKEIT_ENABLED:true}");
        assertThat(at(yml, "voltpilot", "uems", "endgueltigkeit", "interval-ms"))
                .as("ein Lauf je Stunde, §4.6 Nr. 3")
                .isEqualTo("${VOLTPILOT_UEMS_ENDGUELTIGKEIT_INTERVAL_MS:3600000}");
        assertThat(at(yml, "voltpilot", "uems", "tag", "frist-je-lauf"))
                .isEqualTo("${VOLTPILOT_UEMS_TAG_FRIST_JE_LAUF:20000}");

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
