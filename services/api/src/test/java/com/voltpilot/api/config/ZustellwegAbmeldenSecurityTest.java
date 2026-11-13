package com.voltpilot.api.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.voltpilot.api.versand.ZustellwegService;
import com.voltpilot.api.web.ZustellwegController;
import com.voltpilot.api.zugriff.ZugriffKontextLader;
import com.voltpilot.api.zugriff.ZugriffRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import jakarta.servlet.Filter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.DataSourceTransactionManagerAutoConfiguration;
import org.springframework.boot.jdbc.autoconfigure.JdbcTemplateAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/**
 * Kunden-Alarmierung P2 (KA-1 A): „Abmelden“ unter jeder Mail ist ohne Anmeldung erreichbar - mit OIDC an, wie in
 * Produktion. Freigegeben ist genau dieser POST; ein GET auf denselben Pfad (ein Link-Prüfer) und die übrigen
 * Zustellweg-Routen bleiben hinter der Anmeldung.
 */
@SpringBootTest(classes = ZustellwegAbmeldenSecurityTest.AbmeldenApp.class,
        properties = {"voltpilot.security.oidc.enabled=true"})
class ZustellwegAbmeldenSecurityTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = {
        DataSourceAutoConfiguration.class,
        DataSourceTransactionManagerAutoConfiguration.class,
        JdbcTemplateAutoConfiguration.class,
        FlywayAutoConfiguration.class
    })
    @Import(SecurityConfig.class)
    static class AbmeldenApp {

        @Bean
        ZugriffKontextLader zugriffKontextLader() {
            return new ZugriffKontextLader(Mockito.mock(ZugriffRepository.class), new SimpleMeterRegistry(), true);
        }

        @Bean
        ZustellwegService zustellwegService() {
            return Mockito.mock(ZustellwegService.class);
        }

        @Bean
        ZustellwegController zustellwegController(ZustellwegService zustellwege) {
            return new ZustellwegController(zustellwege);
        }
    }

    @Autowired
    private WebApplicationContext context;

    @Autowired
    private ZustellwegService zustellwege;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        Mockito.reset(zustellwege);
        mockMvc = MockMvcBuilders.webAppContextSetup(context)
                .addFilters(context.getBean("springSecurityFilterChain", Filter.class))
                .build();
    }

    @Test
    void abmeldenGehtOhneAnmeldung() throws Exception {
        when(zustellwege.abmelden("schluessel")).thenReturn(true);

        int status = mockMvc.perform(post("/api/v1/zustellwege/abmelden").contentType(MediaType.APPLICATION_JSON)
                .content("{\"token\":\"schluessel\"}")).andReturn().getResponse().getStatus();

        assertThat(status).isEqualTo(204);
        verify(zustellwege).abmelden("schluessel");
    }

    @Test
    void einUnbekannterSchluesselIst410UndOhneSchluessel400() throws Exception {
        when(zustellwege.abmelden("weg")).thenReturn(false);

        assertThat(mockMvc.perform(post("/api/v1/zustellwege/abmelden").contentType(MediaType.APPLICATION_JSON)
                .content("{\"token\":\"weg\"}")).andReturn().getResponse().getStatus()).isEqualTo(410);
        assertThat(mockMvc.perform(post("/api/v1/zustellwege/abmelden").contentType(MediaType.APPLICATION_JSON)
                .content("{}")).andReturn().getResponse().getStatus()).isEqualTo(400);
    }

    @Test
    void nurDieserPostIstOffen() throws Exception {
        assertThat(mockMvc.perform(get("/api/v1/zustellwege/abmelden").param("token", "schluessel"))
                .andReturn().getResponse().getStatus()).isEqualTo(401);
        assertThat(mockMvc.perform(put("/api/v1/zustellwege/email/aktiv").contentType(MediaType.APPLICATION_JSON)
                .content("{\"aktiv\":false}")).andReturn().getResponse().getStatus()).isEqualTo(401);
        verifyNoInteractions(zustellwege);
    }
}
