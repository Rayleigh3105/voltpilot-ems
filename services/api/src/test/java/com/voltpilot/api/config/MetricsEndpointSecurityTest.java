package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.voltpilot.api.zugriff.ZugriffKontextLader;
import com.voltpilot.api.zugriff.ZugriffRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.servlet.Filter;
import org.junit.jupiter.api.BeforeEach;
import org.mockito.Mockito;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
 * Der Scrape-Endpunkt muss einem ANONYMEN Aufrufer antworten - und sonst nichts.
 *
 * <p>Prometheus scrapt ohne Token, der Endpunkt braucht also dieselbe Art Loch,
 * die schon die Kubernetes-Probes brauchten. Genau dort lag ein echter
 * Cluster-Ausfall (02.08.2026): {@code /health} war freigegeben, die tatsächlich
 * bedienten Pfade {@code /health/liveness} und {@code /health/readiness} fielen
 * auf {@code .anyRequest().authenticated()} durch und antworteten <b>401</b>.
 * Ein Metrik-Endpunkt scheitert leiser - kein Pod startet neu, es kommen
 * schlicht nie Daten an und jeder Alarm bleibt für immer still. Deshalb fährt
 * dieser Test die ECHTE Filterkette, wie {@link HealthProbeSecurityTest}.
 *
 * <p>Er prüft ausserdem die zweite Hälfte, die genauso zählt: dass dabei
 * <b>keine andere Route mit aufgegangen ist</b>.
 *
 * <p>Bootet die echte {@code application.yml} (das Umhängen des
 * {@code prometheus}-Endpunkts auf {@code /metrics} steht dort und ist Teil des
 * Vertrags) mit der echten {@link SecurityConfig} und OIDC AN - der
 * fail-secure-Produktionszustand -, aber ohne Persistenz, also ohne Docker und
 * ohne Datenbank.
 */
// ⚠ OHNE DIESE ZEILE IST DER TEST WERTLOS - und zwar auf die tueckische Art:
// @SpringBootTest setzt management.defaults.metrics.export.enabled=false (damit
// Tests nichts an echte Metrik-Backends schicken), der Prometheus-Endpunkt
// entsteht dann gar nicht erst und /metrics antwortet 404. Das sieht aus wie ein
// Konfigurationsfehler in der application.yml, ist aber eine reine TEST-Vorgabe
// - wer sie nicht kennt, "repariert" die Produktionskonfiguration. Nur mit
// @AutoConfigureObservability prueft dieser Test wirklich den Pfad, den ein
// Scraper spaeter benutzt.
@AutoConfigureObservability
@SpringBootTest(classes = MetricsEndpointSecurityTest.MetricsOnlyApp.class,
        properties = {
            "voltpilot.security.oidc.enabled=true",
            // Der Sammler braucht die Datenbank; hier geht es nur um Pfad und
            // Filterkette, also bleibt er aus (und mit ihm der Scheduler).
            "voltpilot.metrics.fleet.enabled=false"
        })
class MetricsEndpointSecurityTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = {
        DataSourceAutoConfiguration.class,
        DataSourceTransactionManagerAutoConfiguration.class,
        JdbcTemplateAutoConfiguration.class,
        FlywayAutoConfiguration.class
    })
    @Import(SecurityConfig.class)
    static class MetricsOnlyApp {

        /**
         * Der ZugriffFilter der Kette (UEMS AP-03 IP-4) braucht seinen Lader; ein anonymer Aufrufer erreicht das
         * Repository nie, darum steht eine Attrappe für die Datenbank.
         */
        @Bean
        ZugriffKontextLader zugriffKontextLader() {
            return new ZugriffKontextLader(Mockito.mock(ZugriffRepository.class), new SimpleMeterRegistry());
        }
    }

    @Autowired
    private WebApplicationContext context;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        // Die echte springSecurityFilterChain, OHNE Test-Authentifizierung: der
        // ganze Punkt ist, dass ein tokenloser Scraper durchkommt.
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
    }

    @Test
    void theScrapeEndpointAnswersAnonymouslyAtSlashMetrics() throws Exception {
        MvcResult result = mockMvc.perform(get("/metrics")).andReturn();

        assertThat(result.getResponse().getStatus())
                .as("anonymer GET /metrics")
                .isEqualTo(HttpStatus.OK.value());
        // Und es ist wirklich der Prometheus-Endpunkt (das Umhängen in der
        // application.yml greift), nicht irgendeine andere Antwort mit 200.
        assertThat(result.getResponse().getContentAsString())
                .contains("# TYPE")
                .contains("jvm_");
    }

    @Test
    void openingTheScrapeEndpointDoesNotOpenTheApi() throws Exception {
        assertThat(mockMvc.perform(get("/api/v1/sites")).andReturn().getResponse().getStatus())
                .isEqualTo(HttpStatus.UNAUTHORIZED.value());
    }

    /**
     * Die Freigabe ist ein EXAKTER Pfad, kein Platzhalter - dieselbe Disziplin
     * wie bei den Probe-Pfaden. Keiner dieser Nachbarn darf anonym antworten:
     * {@code /metrics/...} wäre der Unterbaum, den ein {@code /metrics/**}
     * mitgeöffnet hätte, {@code /prometheus} der nicht mehr bediente Vorgänger,
     * und {@code /env}/{@code /beans}/{@code /configprops} sind Actuator-
     * Endpunkte, die Geheimnisse ausgeben, wenn sie je jemand exponiert.
     */
    @ParameterizedTest
    @ValueSource(strings = {"/metrics/jvm.memory.used", "/prometheus", "/env", "/beans",
            "/configprops", "/actuator/prometheus", "/api/v1/admin/tenants"})
    void nothingElseBecameAnonymouslyReadable(String path) throws Exception {
        assertThat(mockMvc.perform(get(path)).andReturn().getResponse().getStatus())
                .as("anonymer GET %s", path)
                .isNotEqualTo(HttpStatus.OK.value());
    }

    /**
     * Und der Schreibweg bleibt zu: die Freigabe ist auf {@code GET} beschränkt.
     */
    @Test
    void theScrapeEndpointIsReadOnlyForAnonymousCallers() throws Exception {
        assertThat(mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                                .post("/metrics"))
                        .andReturn().getResponse().getStatus())
                .isNotEqualTo(HttpStatus.OK.value());
    }
}
