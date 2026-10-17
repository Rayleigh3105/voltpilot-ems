package com.voltpilot.api.web;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.voltpilot.api.versand.ZustellwegService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * POST /api/v1/zustellwege/telegram/webhook (Alerting Scheibe 6, §7): Telegram ruft diese Route ohne
 * jedes Benutzer-Token auf (Go-Live-Pruefung, siehe SecurityConfig#secured) - die einzige Absicherung
 * ist der {@code secret_token}, den Telegram beim {@code setWebhook} erhielt und auf jedem Aufruf im
 * Header {@code X-Telegram-Bot-Api-Secret-Token} zurückschickt.
 */
class TelegramWebhookControllerTest {

    private static final String GEHEIMNIS = "s3cr3t-token-aus-der-umgebung";
    private static final String HEADER = "X-Telegram-Bot-Api-Secret-Token";
    private static final String START_UPDATE = "{\"message\":{\"text\":\"/start abc123\","
            + "\"chat\":{\"id\":42}}}";

    private final ZustellwegService zustellwege = mock(ZustellwegService.class);
    private MockMvc mvc;

    @BeforeEach
    void aufbauen() {
        mvc = MockMvcBuilders
                .standaloneSetup(new TelegramWebhookController(zustellwege, GEHEIMNIS))
                .build();
    }

    @Test
    void fehlenderHeaderBekommtVerbotenStattEinerVerarbeitung() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .contentType(MediaType.APPLICATION_JSON).content(START_UPDATE))
                .andExpect(status().isForbidden());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void einFalscherHeaderBekommtVerbotenStattEinerVerarbeitung() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .header(HEADER, "irgendein-anderer-wert")
                .contentType(MediaType.APPLICATION_JSON).content(START_UPDATE))
                .andExpect(status().isForbidden());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void derRichtigeHeaderWirdAngenommenUndVerknuepftDenToken() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .header(HEADER, GEHEIMNIS)
                .contentType(MediaType.APPLICATION_JSON).content(START_UPDATE))
                .andExpect(status().isOk());

        verify(zustellwege).telegramVerbindungBestaetigen(eq("abc123"), eq("42"));
    }

    @Test
    void einUpdateOhneStartWirdOhneFehlerQuittiert() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/telegram/webhook")
                .header(HEADER, GEHEIMNIS)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"message\":{\"text\":\"hallo\",\"chat\":{\"id\":42}}}"))
                .andExpect(status().isOk());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void einLeeresGeheimnisLaesstJedenAufrufDurch() throws Exception {
        MockMvc ohneGeheimnis = MockMvcBuilders
                .standaloneSetup(new TelegramWebhookController(zustellwege, ""))
                .build();

        ohneGeheimnis.perform(post("/api/v1/zustellwege/telegram/webhook")
                .contentType(MediaType.APPLICATION_JSON).content(START_UPDATE))
                .andExpect(status().isOk());

        verify(zustellwege).telegramVerbindungBestaetigen(eq("abc123"), eq("42"));
    }
}
