package com.voltpilot.api.metrics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.voltpilot.api.config.SecurityConfig;
import com.voltpilot.api.repo.UemsMetricsRepository;
import com.voltpilot.api.zugriff.ZugriffRepository;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.servlet.Filter;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * AP-14 IP-9: <b>was ein Scraper wirklich bekommt</b> — ein anonymes {@code GET /metrics} über die
 * echte Filterkette und den Haus-Endpunkt, und darin der GESAMTE UEMS-Export.
 *
 * <p>Die Zusage, die hier und nur hier fällt: <b>in KEINER {@code voltpilot_uems_*}-Zeile steht ein
 * Kundenname, eine Mailadresse, eine Seriennummer oder eine Anschrift.</b> Der Sammler bekommt dafür
 * absichtlich eine Attrappe, die genau solche Zeichenketten anbietet — er darf nur die interne
 * Kennung weitergeben. {@code UemsMetricsScrapeTest} prüft die Namen an der Registry,
 * {@code MetricsEndpointSecurityTest} den anonymen Pfad; erst beides zusammen mit dieser Zeile ist
 * der Vertrag, auf den IP-10 seinen {@code ServiceMonitor} stellt.
 *
 * <p>Ohne Datenbank: die Repository-Schicht ist eine Attrappe.
 */
@AutoConfigureObservability
@SpringBootTest(classes = UemsMetricsEndpointE2eTest.ScrapeApp.class,
        properties = {
            "voltpilot.security.oidc.enabled=true",
            // Ausdruecklich AN: der Testlauf schaltet den Sammler global aus (surefire, pom.xml).
            // Hier ist er der Gegenstand der Pruefung.
            "voltpilot.metrics.uems.enabled=true",
            // Der Takt wird nicht gebraucht - der Test sammelt selbst.
            "voltpilot.metrics.uems.initial-delay-ms=3600000",
            // Der Testlauf schaltet ALLE UEMS-Laeufer global aus (surefire); hier stehen die
            // Schalter ausdruecklich, weil genau ihr Stand die Zustands-Zeile bestimmt. Gestartet
            // wird davon nichts: diese Minimal-Anwendung importiert keinen einzigen Laeufer.
            "voltpilot.uems.luecken.enabled=true",
            "voltpilot.uems.kaskade.enabled=true",
            "voltpilot.uems.bestandsuebernahme.enabled=true",
            // Ein abgeschalteter Laeufer muss auch ueber HTTP als "aus" erkennbar sein.
            "voltpilot.uems.zeilentexte.enabled=false"
        })
class UemsMetricsEndpointE2eTest {

    private static final UUID MESSKUNDE = UUID.fromString("71000000-0000-0000-0000-0000000009e5");

    /** Zeichenketten, die in keiner UEMS-Zeile auftauchen dürfen — auch nicht als Wert. */
    private static final List<String> VERBOTEN = List.of("ahrenberg", "kunststoffwerk", "@",
            "musterstr", "sn-", "seriennummer", "gmbh");

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = {
        DataSourceAutoConfiguration.class,
        DataSourceTransactionManagerAutoConfiguration.class,
        JdbcTemplateAutoConfiguration.class,
        FlywayAutoConfiguration.class
    })
    @Import({SecurityConfig.class, UemsLaeuferMelder.class, UemsMetricsCollector.class})
    static class ScrapeApp {

        /**
         * Eine Attrappe, die dem Sammler ausdrücklich Kundensprache ANBIETET: der Listenname trägt
         * einen Firmennamen, der Messkunde eine Mailadresse. Nichts davon darf im Export landen.
         */
        /**
         * Der ZugriffFilter der Kette (AP-03 IP-4) braucht seinen Lader; ein anonymer Scraper
         * erreicht das Repository nie, darum steht eine Attrappe für die Datenbank.
         */
        @Bean
        ZugriffKontextLader zugriffKontextLader() {
            return new ZugriffKontextLader(Mockito.mock(ZugriffRepository.class),
                    new SimpleMeterRegistry(), true);
        }

        @Bean
        UemsMetricsRepository uemsMetricsRepository() {
            return new UemsMetricsRepository(null) {
                @Override
                public List<ArbeitslisteStand> arbeitslisten() {
                    return List.of(
                            new ArbeitslisteStand("viertelstunde", 12L,
                                    Instant.now().minus(31, ChronoUnit.MINUTES)),
                            new ArbeitslisteStand("tag", 0L, null),
                            new ArbeitslisteStand("periode", 1L,
                                    Instant.now().minus(2, ChronoUnit.MINUTES)));
                }

                @Override
                public List<MesskundeEingang> messkundenEingaenge() {
                    return List.of(new MesskundeEingang(MESSKUNDE,
                            Instant.now().minus(40, ChronoUnit.MINUTES)));
                }
            };
        }
    }

    @Autowired
    private WebApplicationContext context;

    @Autowired
    private UemsMetricsCollector sammler;

    @Autowired
    private UemsLaeuferMelder melder;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
        melder.gelaufen(UemsLaeuferMelder.LUECKEN);
        melder.fehler(UemsLaeuferMelder.KASKADE);
        melder.bestandGelaufen(UemsLaeuferMelder.BESTAND_STANDORT, 3, 1);
        sammler.tick();
    }

    @Test
    void einAnonymerScrapeLiefertDieVereinbartenUemsMetrikenUeberHttp() throws Exception {
        List<String> uems = uemsZeilen();

        assertThat(uems).anyMatch(l -> l.startsWith(
                "voltpilot_uems_arbeitsliste_aeltester_eintrag_age_seconds{liste=\"viertelstunde\"}"));
        assertThat(uems).contains("voltpilot_uems_arbeitsliste_offen{liste=\"tag\"} 0.0");
        assertThat(uems).anyMatch(l -> l.startsWith(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"luecken\"}"));
        assertThat(uems).contains("voltpilot_uems_laeufer_fehler_total{laeufer=\"kaskade\"} 1.0");
        assertThat(uems).anyMatch(l -> l.startsWith(
                "voltpilot_uems_kundenbereich_letzter_messwert_age_seconds{tenant=\"" + MESSKUNDE + "\"}"));
        assertThat(uems).contains("voltpilot_uems_bestandslaeufer_total{ergebnis=\"fehler\","
                + "laeufer=\"bestand_standort\"} 1.0");
        assertThat(uems).contains(
                "voltpilot_uems_laeufer_zustand{laeufer=\"zeilentexte\",zustand=\"aus\"} 1.0");
        assertThat(uems).noneMatch(l -> l.startsWith(
                "voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer=\"zeilentexte\"}"));
    }

    @Test
    void keineEinzigeUemsZeileTraegtKundenspracheNurDieInterneKennung() throws Exception {
        List<String> uems = uemsZeilen();

        assertThat(uems).isNotEmpty();
        for (String zeile : uems) {
            String klein = zeile.toLowerCase(Locale.ROOT);
            for (String wort : VERBOTEN) {
                assertThat(klein).as("Kundensprache in %s", zeile).doesNotContain(wort);
            }
            assertThat(klein).doesNotContain("name=").doesNotContain("kunde=")
                    .doesNotContain("adresse=").doesNotContain("serial=");
        }
        assertThat(uems).anyMatch(l -> l.contains("tenant=\"" + MESSKUNDE + "\""));
    }

    private List<String> uemsZeilen() throws Exception {
        MvcResult result = mockMvc.perform(get("/metrics")).andReturn();
        assertThat(result.getResponse().getStatus()).as("anonymer GET /metrics")
                .isEqualTo(HttpStatus.OK.value());
        return result.getResponse().getContentAsString().lines()
                .filter(l -> l.startsWith("voltpilot_uems_")).toList();
    }
}
