package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung der BESTANDSÜBERNAHME der Standorte (UEMS AP-02 IP-9) — der Teil,
 * den weder die reine Regel ({@link OrtsbaumAbleitungVectorsTest}) noch der
 * Testcontainers-Lauf ({@code BestandsuebernahmeApiTest} stößt {@code lauf()} von Hand an)
 * je anfasst.
 *
 * <p>Genau diese Lücke hat in diesem Projekt schon Produktion gekostet: ein Schalter, der in
 * der AUSGELIEFERTEN Datei falsch vorbelegt ist, ist grün im Testlauf und wirkungslos im
 * Cluster (die dokumentierte OTA-Listener-Falle) — eine Übernahme, die daran hängt, dass
 * jemand eine Umgebungsvariable im gitops-Repo nachzieht, findet dort nie statt. Also:
 * Vorgabe AN in {@code application.yml}, AUS im Testlauf ({@code pom.xml}), und der
 * Not-Aus nimmt nur den Start-Lauf.
 */
class BestandsuebernahmeWiringTest {

    private static final String SCHALTER = "voltpilot.uems.bestandsuebernahme.enabled";

    /** Die Nachbarn, die der Läufer im echten Kontext vorfindet. */
    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        static final BestandsuebernahmeService DIENST = mock(BestandsuebernahmeService.class);

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            JdbcTemplate jdbc = mock(JdbcTemplate.class);
            when(jdbc.queryForList(any(String.class), any(Class.class))).thenReturn(List.of());
            return jdbc;
        }

        @Bean
        BestandsuebernahmeService bestandsuebernahmeService() {
            return DIENST;
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, BestandsuebernahmeLaeufer.class);

    @Test
    void derLaeuferVerdrahtetSichUndGehtBeimStartUeberJedenKundenbereich() {
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            BestandsuebernahmeLaeufer laeufer = context.getBean(BestandsuebernahmeLaeufer.class);
            JdbcTemplate adminJdbc = context.getBean("adminJdbcTemplate", JdbcTemplate.class);
            when(adminJdbc.queryForList(any(String.class), any(Class.class)))
                    .thenReturn(List.of(UUID.randomUUID()));
            laeufer.beimStart();
            verify(Nachbarn.DIENST).uebernehmen();
        });
    }

    /** Der Not-Aus nimmt den Start-Lauf, nie den Dienst (der Rückweg bleibt). */
    @Test
    void derNotAusNimmtDenStartLaufNieDenDienst() {
        org.mockito.Mockito.reset(Nachbarn.DIENST);
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(BestandsuebernahmeLaeufer.class);
            assertThat(context).hasSingleBean(BestandsuebernahmeService.class);
            context.getBean(BestandsuebernahmeLaeufer.class).beimStart();
            verifyNoInteractions(Nachbarn.DIENST);
        });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN — und im Testlauf AUS: sonst bekämen die Testklassen
     * mit Dev-Saat ihren Standort schon beim Start des Kontexts.
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "uems", "bestandsuebernahme", "enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_BESTANDSUEBERNAHME_ENABLED:true}");

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
