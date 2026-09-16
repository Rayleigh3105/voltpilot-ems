package com.voltpilot.api.unterstuetzung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.voltpilot.api.unterstuetzung.UnterstuetzungService.Lauf;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Die Spring-Verdrahtung des Unterstützungs-Takts (UEMS AP-03 IP-8) — der Teil, den der Testcontainers-Lauf nie
 * anfasst: <b>ein Schalter, der in der AUSGELIEFERTEN Datei falsch vorbelegt ist, ist grün im Testlauf und
 * wirkungslos im Cluster.</b> Also: Vorgabe AN in {@code application.yml}, AUS im Testlauf ({@code pom.xml}),
 * der Takt geht über jeden Kundenbereich, und der Not-Aus nimmt NUR den Takt.
 *
 * <p>Und das Wichtigste über diesen Schalter: er nimmt keinem Zugang seine Frist. Eine Unterstützung endet mit
 * ihrem {@code endet_am} in {@code zugriff_zeitraum} — der Takt trägt das nur ins Protokoll ein und erinnert
 * vorher. Das prüft {@code UnterstuetzungApiTest} an der Datenbank, mit dem Läufer AUS.
 */
class UnterstuetzungWiringTest {

    private static final String SCHALTER = "voltpilot.uems.unterstuetzung.enabled";
    private static final String UMSCHALTER = "voltpilot.uems.unterstuetzung.umschalter-enabled";

    /** Die Nachbarn, die der Läufer im echten Kontext vorfindet. */
    @Configuration(proxyBeanMethods = false)
    static class Nachbarn {

        static final UUID KUNDENBEREICH = UUID.randomUUID();
        static final UnterstuetzungService DIENST = mock(UnterstuetzungService.class);

        @Bean("adminJdbcTemplate")
        @SuppressWarnings("unchecked")
        JdbcTemplate adminJdbcTemplate() {
            JdbcTemplate jdbc = mock(JdbcTemplate.class);
            when(jdbc.queryForList(any(String.class), any(Class.class))).thenReturn(List.of(KUNDENBEREICH));
            return jdbc;
        }

        @Bean
        UnterstuetzungService unterstuetzungService() {
            return DIENST;
        }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(Nachbarn.class, AblaufLaeufer.class, UnterstuetzungSchedulingConfig.class);

    @Test
    void derLaeuferVerdrahtetSichUndGehtUeberJedenKundenbereich() {
        reset(Nachbarn.DIENST);
        when(Nachbarn.DIENST.lauf(any())).thenReturn(new Lauf(1, 0));
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).hasSingleBean(UnterstuetzungSchedulingConfig.class);
            Lauf l = context.getBean(AblaufLaeufer.class).lauf(Instant.parse("2026-12-16T00:00:00Z"));
            assertThat(l.abgelaufen()).isEqualTo(1);
            verify(Nachbarn.DIENST, timeout(2000)).lauf(Instant.parse("2026-12-16T00:00:00Z"));
        });
    }

    /** Der Not-Aus nimmt den Läufer UND seinen Scheduler — und damit auch den Thread-Pool. */
    @Test
    void derNotAusNimmtDenTaktUndSeinenScheduler() {
        reset(Nachbarn.DIENST);
        runner.withPropertyValues(SCHALTER + "=false").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context).doesNotHaveBean(AblaufLaeufer.class);
            assertThat(context).doesNotHaveBean(UnterstuetzungSchedulingConfig.class);
        });
    }

    /** Ein Kundenbereich, der wirft, hält den Takt nicht auf — der nächste wird trotzdem gefahren. */
    @Test
    void einKundenbereichDerWirftHaeltDenTaktNichtAuf() {
        reset(Nachbarn.DIENST);
        when(Nachbarn.DIENST.lauf(any())).thenThrow(new IllegalStateException("Datenbank weg"));
        runner.withPropertyValues(SCHALTER + "=true").run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(AblaufLaeufer.class).lauf(Instant.now())).isEqualTo(new Lauf(0, 0));
        });
    }

    /**
     * Die AUSGELIEFERTE Vorgabe ist AN — und im Testlauf AUS: sonst liefe in jedem Testkontext ein Takt über
     * jeden Kundenbereich und schriebe Protokollzeilen, die kein Test bestellt hat.
     */
    @Test
    @SuppressWarnings("unchecked")
    void dieAusgelieferteVorgabeIstAnUndDerTestlaufSchaltetSieAus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml auf dem Klassenpfad").isNotNull();
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "uems", "unterstuetzung", "enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_UNTERSTUETZUNG_ENABLED:true}");

        String pom = Files.readString(Path.of("pom.xml"));
        assertThat(pom).contains("<" + SCHALTER + ">false</" + SCHALTER + ">");
    }

    /**
     * <b>Der Mandanten-Umschalter ist AUS</b> (AP-03 W3): dieses Paket baut den sichtbaren Weg (Anfrage,
     * Notfall-Zugriff). Seit IP-15 ist die Produktionsvorgabe AUS; das lokale Profil behält die alte
     * Vorgabe ausdrücklich für Kompatibilitätsnachweise.
     * Dass er BEISST, prüft {@code UnterstuetzungApiTest} an der Datenbank.
     */
    @Test
    @SuppressWarnings("unchecked")
    void derMandantenUmschalterIstInProduktionSeitIp15Aus() throws Exception {
        Map<String, Object> yml;
        try (InputStream in = getClass().getResourceAsStream("/application.yml")) {
            yml = (Map<String, Object>) new Yaml().loadAll(in).iterator().next();
        }
        assertThat(at(yml, "voltpilot", "uems", "unterstuetzung", "umschalter-enabled"))
                .isEqualTo("${VOLTPILOT_UEMS_UNTERSTUETZUNG_UMSCHALTER_ENABLED:false}");
        assertThat(Files.readString(Path.of("pom.xml"))).as("im Testlauf NICHT übersteuert")
                .doesNotContain(UMSCHALTER);
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
