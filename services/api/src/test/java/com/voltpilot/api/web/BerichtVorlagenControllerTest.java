package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BerichtRegeln;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * Die Berichtsvorlagen (UEMS AP-12 IP-5, V2): drei byte-gleiche Kopien — Vertrag, API-Ressource, Portal — und die Route
 * liefert die Ressource Byte für Byte. Rein — ohne Spring-Kontext, ohne Datenbank.
 */
class BerichtVorlagenControllerTest {

    private static final Path VERTRAG = Path.of("..", "..", "docs", "contracts", "v2", "bericht-vorlagen.json");
    private static final Path API = Path.of("src", "main", "resources", "berichte", "bericht-vorlagen.json");
    private static final Path PORTAL = Path.of("..", "..", "frontend", "portal", "src", "berichte", "bericht-vorlagen.json");

    @Test
    void dieApiRessourceIstDerVertragByteFuerByte() throws Exception {
        assertThat(Files.readAllBytes(API)).as("beide zusammen ändern").isEqualTo(Files.readAllBytes(VERTRAG));
    }

    @Test
    void diePortalKopieIstByteGleich() throws Exception {
        assertThat(Files.readAllBytes(PORTAL)).as("die Portal-Kopie ist byte-gleich — alle drei zusammen ändern")
                .isEqualTo(Files.readAllBytes(API));
    }

    @Test
    void dieRouteLiefertDieRessourceByteFuerByte() throws Exception {
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new BerichtVorlagenController()).build();
        MvcResult r = mvc.perform(get("/api/v1/bericht-vorlagen")).andExpect(status().isOk()).andReturn();
        assertThat(MediaType.parseMediaType(r.getResponse().getContentType()).isCompatibleWith(MediaType.APPLICATION_JSON))
                .isTrue();
        assertThat(r.getResponse().getContentAsByteArray()).isEqualTo(Files.readAllBytes(API));
    }

    @Test
    void dieRessourceNenntGenauDieVorlagenDerRegeln() throws Exception {
        JsonNode datei = new ObjectMapper().readTree(Files.readAllBytes(API));
        List<String> schluessel = new ArrayList<>();
        for (JsonNode v : datei.path("vorlagen")) {
            BerichtRegeln.Vorlage regel = BerichtRegeln.vorlage(v.path("schluessel").asText());
            assertThat(regel).as(v.path("schluessel").asText()).isNotNull();
            assertThat(v.path("fassung").asInt()).isEqualTo(regel.fassung());
            schluessel.add(regel.schluessel());
        }
        assertThat(schluessel).containsExactlyElementsOf(BerichtRegeln.VORLAGEN.keySet());
    }
}
