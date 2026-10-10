package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.time.Duration;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.assertj.AssertableApplicationContext;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.yaml.snakeyaml.Yaml;

/**
 * Die Spring-Verdrahtung des Umstiegs der Funktionen (UEMS AP-01 IP-2) — der Teil, den der
 * Testcontainers-Lauf ({@code FunktionBestandApiTest} stößt {@code lauf()} von Hand an) nie anfasst:
 * am echten {@link ApplicationReadyEvent} läuft er NACH der Standort-Übernahme (zugesagt über
 * {@code @Order}, auch wenn diese abgeschaltet ist), sein Not-Aus nimmt nur den Start-Lauf, keiner
 * seiner Dienste kennt einen Publisher, und die ausgelieferte Vorgabe ist AN (die
 * OTA-Listener-Falle, siehe {@link BestandsuebernahmeWiringTest}).
 */
class FunktionBestandWiringTest {

    private static final String STANDORTE = "voltpilot.uems.bestandsuebernahme.enabled";
    private static final String SCHALTER = "voltpilot.uems.funktion-bestand.enabled";

    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        static final BestandsuebernahmeService STANDORT_DIENST = mock(BestandsuebernahmeService.class);
        static final FunktionBestandService DIENST = mock(FunktionBestandService.class);

        @Bean("adminJdbcTemplate")
        JdbcTemplate adminJdbcTemplate() {
            JdbcTemplate jdbc = mock(JdbcTemplate.class);
            when(jdbc.queryForList(any(String.class), any(Class.class))).thenReturn(List.of(UUID.randomUUID()));
            return jdbc;
        }

        @Bean
        BestandsuebernahmeService bestandsuebernahmeService() {
            return STANDORT_DIENST;
        }

        @Bean
        FunktionBestandService funktionBestandService() {
            return DIENST;
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, BestandsuebernahmeLaeufer.class, FunktionBestandLaeufer.class);

    @BeforeEach
    void zuruecksetzen() {
        reset(Nachbarn.STANDORT_DIENST, Nachbarn.DIENST);
        when(Nachbarn.STANDORT_DIENST.uebernehmen())
                .thenReturn(new BestandsuebernahmeService.Ergebnis(null, null, 0, 0));
        when(Nachbarn.DIENST.uebernehmen()).thenReturn(new FunktionBestandService.Ergebnis(0, 0, 0, 0));
    }

    @Test
    void derUmstiegLaeuftNachDerStandortUebernahme() {
        runner.withPropertyValues(STANDORTE + "=true", SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            start(context);
            InOrder reihenfolge = inOrder(Nachbarn.STANDORT_DIENST, Nachbarn.DIENST);
            reihenfolge.verify(Nachbarn.STANDORT_DIENST).uebernehmen();
            reihenfolge.verify(Nachbarn.DIENST).uebernehmen();
        });
    }

    /** Die Standorte abgeschaltet: der Umstieg läuft trotzdem (über die schon vorhandenen Standorte). */
    @Test
    void derUmstiegLaeuftAuchBeiAbgeschalteterStandortUebernahme() {
        runner.withPropertyValues(STANDORTE + "=false", SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            start(context);
            verifyNoInteractions(Nachbarn.STANDORT_DIENST);
            verify(Nachbarn.DIENST).uebernehmen();
        });
    }

    /** Der Not-Aus nimmt den Start-Lauf, nie den Dienst. */
    @Test
    void derNotAusNimmtDenStartLaufNieDenDienst() {
        runner.withPropertyValues(STANDORTE + "=true", SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(FunktionBestandService.class);
            start(context);
            verify(Nachbarn.STANDORT_DIENST).uebernehmen();
            verifyNoInteractions(Nachbarn.DIENST);
        });
    }

    /** Ein scheiternder Umstieg hält den Start nicht auf. */
    @Test
    void einFehlerImUmstiegHaeltDenStartNichtAuf() {
        when(Nachbarn.DIENST.uebernehmen()).thenThrow(new IllegalStateException("kaputt"));
        runner.withPropertyValues(STANDORTE + "=true", SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            start(context);
            assertThat(context.getBean(FunktionBestandLaeufer.class).lauf().fehler()).isOne();
        });
    }

    /** Wie die Standort-Übernahme: der Umstieg KANN nichts an eine Box schicken. */
    @Test
    void keinDienstDesUmstiegsKenntEinenPublisher() {
        for (Class<?> c : List.of(FunktionBestandLaeufer.class, FunktionBestandService.class,
                FunktionBestandFakten.class, FunktionRepository.class, FunktionTeilnahmeRepository.class)) {
            for (Constructor<?> k : c.getDeclaredConstructors()) {
                for (Class<?> p : k.getParameterTypes()) {
                    assertThat(p.getSimpleName()).as("%s hängt an %s", c.getSimpleName(), p.getName())
                            .doesNotContain("Publisher").doesNotContain("Mqtt");
                }
            }
        }
    }

    /** Der echte Start: Spring sortiert die Hörer von {@link ApplicationReadyEvent} nach {@code @Order}. */
    private static void start(AssertableApplicationContext context) {
        context.publishEvent(new ApplicationReadyEvent(new SpringApplication(), new String[0],
                context.getSourceApplicationContext(), Duration.ZERO));
    }

    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        Object knoten = yml;
        for (String schluessel : new String[] {"voltpilot", "uems", "funktion-bestand", "enabled"}) {
            knoten = ((Map<String, Object>) knoten).get(schluessel);
        }
        assertThat(knoten).isEqualTo("${VOLTPILOT_UEMS_FUNKTION_BESTAND_ENABLED:true}");
        assertThat(Files.readString(Path.of("pom.xml"))).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }
}
