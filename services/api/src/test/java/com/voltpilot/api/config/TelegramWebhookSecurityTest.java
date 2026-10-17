package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.voltpilot.api.versand.ZustellwegService;
import com.voltpilot.api.web.TelegramWebhookController;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import com.voltpilot.api.zugriff.ZugriffRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.servlet.Filter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.JdbcTemplateAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Die Go-Live-Prüfung (Alerting Scheibe 6) fand eine Lücke: {@code POST
 * /api/v1/zustellwege/telegram/webhook} fehlte in {@link SecurityConfig#secured}, fiel also auf
 * {@code .anyRequest().authenticated()} zurück und hätte Telegrams Server mit 401 abgewiesen - eine
 * Verbindung wäre nie zustande gekommen. {@link com.voltpilot.api.web.TelegramWebhookControllerTest}
 * prüft nur den Controller allein (ohne Filterkette) und hätte diese Lücke NICHT gefunden; dieser
 * Test fährt wie {@link HealthProbeSecurityTest} die ECHTE Kette mit OIDC AN (dem
 * Produktions-Normalfall) und ohne Datenbank.
 */
@SpringBootTest(classes = TelegramWebhookSecurityTest.WebhookOnlyApp.class,
        properties = {"voltpilot.security.oidc.enabled=true", "voltpilot.telegram.webhook-secret=s3cr3t-aus-der-umgebung"})
class TelegramWebhookSecurityTest {

    private static final String HEADER = "X-Telegram-Bot-Api-Secret-Token";
    private static final String GEHEIMNIS = "s3cr3t-aus-der-umgebung";

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = {
        DataSourceAutoConfiguration.class,
        DataSourceTransactionManagerAutoConfiguration.class,
        JdbcTemplateAutoConfiguration.class,
        FlywayAutoConfiguration.class
    })
    @Import(SecurityConfig.class)
    static class WebhookOnlyApp {

        @Bean
        ZugriffKontextLader zugriffKontextLader() {
            return new ZugriffKontextLader(Mockito.mock(ZugriffRepository.class), new SimpleMeterRegistry(), true);
        }

        @Bean
        ZustellwegService zustellwegService() {
            return Mockito.mock(ZustellwegService.class);
        }

        @Bean
        TelegramWebhookController telegramWebhookController(ZustellwegService zustellwege,
                @Value("${voltpilot.telegram.webhook-secret:}") String webhookSecret) {
            return new TelegramWebhookController(zustellwege, webhookSecret);
        }
    }

    @Autowired
    private WebApplicationContext context;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
    }

    @Test
    void telegramsAufrufOhneHeaderKommtDurchDieKetteUndWirdVomControllerVerboten() throws Exception {
        int status = mockMvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andReturn().getResponse().getStatus();

        // Entscheidend: NICHT 401 - die Kette lässt die Route ohne Anmeldung durch
        // (sonst bekäme Telegrams Server den Verbindungsaufbau nie zustande); der
        // Controller selbst weist den fehlenden secret_token mit 403 ab.
        assertThat(status).isEqualTo(HttpStatus.FORBIDDEN.value());
    }

    @Test
    void einFalscherSecretTokenWirdDurchDieEchteKetteEbenfallsVerboten() throws Exception {
        int status = mockMvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .header(HEADER, "falsch")
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andReturn().getResponse().getStatus();

        assertThat(status).isEqualTo(HttpStatus.FORBIDDEN.value());
    }

    @Test
    void derRichtigeSecretTokenKommtDurchDieEchteKetteBisZumController() throws Exception {
        int status = mockMvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .header(HEADER, GEHEIMNIS)
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andReturn().getResponse().getStatus();

        assertThat(status).isEqualTo(HttpStatus.OK.value());
    }

    @Test
    void dieFreigabeDerWebhookRouteOeffnetNichtDenRestDerApi() throws Exception {
        int status = mockMvc.perform(post("/api/v1/sites")).andReturn().getResponse().getStatus();

        assertThat(status).isEqualTo(HttpStatus.UNAUTHORIZED.value());
    }
}
