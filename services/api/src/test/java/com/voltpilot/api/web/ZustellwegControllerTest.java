package com.voltpilot.api.web;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.voltpilot.api.versand.ZustellwegRepository;
import com.voltpilot.api.versand.ZustellwegService;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * POST /api/v1/zustellwege/push und /email (Alerting Scheibe 0/3, §6.6, §7): ein Körper ohne die Pflichtfelder
 * (Browser-{@code PushSubscription} bzw. {@code ziel}) bekommt einen sauberen 400 statt der rohen
 * {@code DataIntegrityViolationException} von {@code push_abo.endpoint} bzw. {@code zustellweg.ziel} (Befund
 * {@code PruefumgebungAhrenbergTest#einsichtAendertNichts}, leerer Körper {@code {}}). Rein - ohne Spring-Kontext,
 * ohne Datenbank.
 */
class ZustellwegControllerTest {

    private final ZustellwegService zustellwege = mock(ZustellwegService.class);
    private final Authentication auth = new UsernamePasswordAuthenticationToken("sub-test", null);
    private MockMvc mvc;

    @BeforeEach
    void aufbauen() {
        mvc = MockMvcBuilders.standaloneSetup(new ZustellwegController(zustellwege)).build();
    }

    @Test
    void einLeererKoerperBekommtEinenSauberenBadRequestStattEinerRohenDatenbankAusnahme() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/push").principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void jedesFehlendeOderLeerePflichtfeldBekommtDenselbenBadRequest() throws Exception {
        List<String> koerperOhneJeEinPflichtfeld = List.of(
                "{\"p256dh\":\"p\",\"auth\":\"a\",\"geraet\":\"g\"}",
                "{\"endpoint\":\"https://push.example/x\",\"auth\":\"a\",\"geraet\":\"g\"}",
                "{\"endpoint\":\"https://push.example/x\",\"p256dh\":\"p\",\"geraet\":\"g\"}",
                "{\"endpoint\":\"https://push.example/x\",\"p256dh\":\"p\",\"auth\":\"a\"}",
                "{\"endpoint\":\" \",\"p256dh\":\"p\",\"auth\":\"a\",\"geraet\":\"g\"}");
        for (String koerper : koerperOhneJeEinPflichtfeld) {
            mvc.perform(post("/api/v1/zustellwege/push").principal(auth)
                    .contentType(MediaType.APPLICATION_JSON).content(koerper))
                    .andExpect(status().isBadRequest());
        }

        verifyNoInteractions(zustellwege);
    }

    @Test
    void einVollstaendigerKoerperWirdAngenommenUndTraegtDenSubDesTokens() throws Exception {
        UUID id = UUID.randomUUID();
        when(zustellwege.pushAbonnieren(eq("sub-test"), eq("https://push.example/x"), eq("p"), eq("a"), eq("g"),
                any())).thenReturn(id);
        when(zustellwege.pushAboEigene("sub-test")).thenReturn(List.of(
                new ZustellwegRepository.PushAbo(id, "g", true, "warnung", Instant.now(), "https://push.example/x")));

        mvc.perform(post("/api/v1/zustellwege/push").principal(auth).contentType(MediaType.APPLICATION_JSON)
                .content("{\"endpoint\":\"https://push.example/x\",\"p256dh\":\"p\",\"auth\":\"a\",\"geraet\":\"g\"}"))
                .andExpect(status().isCreated());
    }

    @Test
    void einLeererKoerperAnDerEmailRouteBekommtEinenSauberenBadRequest() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/email").principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/v1/zustellwege/email").principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{\"ziel\":\" \"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void einZielAnDerEmailRouteWirdAngenommen() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/email").principal(auth).contentType(MediaType.APPLICATION_JSON)
                .content("{\"ziel\":\"jonas@example.test\"}"))
                .andExpect(status().isAccepted());

        verify(zustellwege).anfordern("sub-test", "jonas@example.test");
    }

    // =================================================================== B8: Push beim Abmelden

    @Test
    void pushAbmeldenRuftDieEntfernungUeberDenEndpunktAufUndAntwortetOhneInhalt() throws Exception {
        mvc.perform(delete("/api/v1/zustellwege/push").principal(auth)
                .param("endpoint", "https://push.example/geteiltes-geraet"))
                .andExpect(status().isNoContent());

        verify(zustellwege).pushAboEntfernenNachEndpoint("sub-test", "https://push.example/geteiltes-geraet");
    }

    // =================================================================== Webhook (Alerting Scheibe 6, §7)

    @Test
    void einLeererKoerperAnDerWebhookRouteBekommtEinenSauberenBadRequest() throws Exception {
        mvc.perform(post("/api/v1/zustellwege/webhook").principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/v1/zustellwege/webhook").principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{\"url\":\" \"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void eineUrlAnDerWebhookRouteWirdAngenommen() throws Exception {
        UUID id = UUID.randomUUID();
        when(zustellwege.webhookZielAnlegen(eq("sub-test"), eq("https://hooks.example/x"), any()))
                .thenReturn(new ZustellwegService.NeuesWebhookZiel(id, "geheimnis"));

        mvc.perform(post("/api/v1/zustellwege/webhook").principal(auth).contentType(MediaType.APPLICATION_JSON)
                .content("{\"url\":\"https://hooks.example/x\"}"))
                .andExpect(status().isCreated());
    }

    @Test
    void eineLeereAbSchwereAnDerWebhookEinstellungsRouteBekommtEinenSauberenBadRequest() throws Exception {
        mvc.perform(put("/api/v1/zustellwege/webhook/" + UUID.randomUUID()).principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{\"aktiv\":true,\"abSchwere\":\"\"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(zustellwege);
    }

    // =================================================================== Telegram (Alerting Scheibe 6, §7)

    @Test
    void eineLeereAbSchwereAnDerTelegramEinstellungsRouteBekommtEinenSauberenBadRequest() throws Exception {
        mvc.perform(put("/api/v1/zustellwege/telegram/" + UUID.randomUUID()).principal(auth)
                .contentType(MediaType.APPLICATION_JSON).content("{\"aktiv\":true,\"abSchwere\":\"\"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(zustellwege);
    }

    @Test
    void derStatusMeldetVerfuegbarWennEinBotEingerichtetIst() throws Exception {
        when(zustellwege.telegramVerfuegbar()).thenReturn(true);
        when(zustellwege.telegramZieleEigene("sub-test")).thenReturn(List.of());

        mvc.perform(get("/api/v1/zustellwege/telegram").principal(auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.verfuegbar").value(true))
                .andExpect(jsonPath("$.ziele").isArray());
    }

    @Test
    void derStatusMeldetNichtVerfuegbarOhneEingerichtetenBot() throws Exception {
        when(zustellwege.telegramVerfuegbar()).thenReturn(false);
        when(zustellwege.telegramZieleEigene("sub-test")).thenReturn(List.of());

        mvc.perform(get("/api/v1/zustellwege/telegram").principal(auth))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.verfuegbar").value(false));
    }
}
