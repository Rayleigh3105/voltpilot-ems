package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.voltpilot.api.versand.ZustellwegService;
import jakarta.servlet.Filter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Der Produktions-Stand, solange Telegram nicht eingeschaltet ist: OIDC an, aber KEIN
 * {@code voltpilot.telegram.webhook-secret}. Die Route bleibt {@code permitAll} (sonst 401 statt
 * 403), der Controller weist trotzdem JEDEN Aufruf ab und verknüpft nichts - vorher kam hier ein
 * unangemeldetes {@code {}} mit 200 durch ({@code PruefumgebungAhrenbergTest#einsichtAendertNichts}).
 */
@SpringBootTest(classes = TelegramWebhookSecurityTest.WebhookOnlyApp.class,
        properties = {"voltpilot.security.oidc.enabled=true", "voltpilot.telegram.webhook-secret="})
class TelegramWebhookOhneGeheimnisSecurityTest {

    @Autowired
    private WebApplicationContext context;

    @Autowired
    private ZustellwegService zustellwege;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
    }

    @Test
    void ohneGeheimnisBekommtAuchEinStartUpdateVerboten() throws Exception {
        int leer = mockMvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andReturn().getResponse().getStatus();
        int start = mockMvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .header("X-Telegram-Bot-Api-Secret-Token", "irgendwas")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"message\":{\"text\":\"/start abc123\",\"chat\":{\"id\":42}}}"))
                .andReturn().getResponse().getStatus();

        assertThat(leer).isEqualTo(HttpStatus.FORBIDDEN.value());
        assertThat(start).isEqualTo(HttpStatus.FORBIDDEN.value());
        verifyNoInteractions(zustellwege);
    }
}
