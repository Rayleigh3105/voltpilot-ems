package com.voltpilot.api.geraetesuche;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Die Bereichsregel gegen die geteilten Vektoren {@code docs/contracts/lan-range-vectors.json} - dieselben Fälle wie
 * Go {@code probe/bereich_test.go}. Fälle mit Schnittstelle ({@code nur_box}) prüft nur die Box.
 */
class SuchbereichTest {

    private static JsonNode vektoren;

    @BeforeAll
    static void lade() throws Exception {
        vektoren = new ObjectMapper().readTree(
                Files.readString(Path.of("..", "..", "docs", "contracts", "lan-range-vectors.json")));
    }

    @Test
    void suchbereichAusEinerEigenenAdresse() {
        int n = 0;
        for (JsonNode c : vektoren.path("suchbereich").path("faelle")) {
            if (c.path("nur_box").asBoolean(false)) {
                continue;
            }
            Suchbereich.Urteil u = Suchbereich.suchbereich(c.path("adresse").asText());
            String name = c.path("adresse").asText();
            assertThat(u.grund()).as(name).isEqualTo(c.path("abgelehnt").textValue());
            if (u.grund() == null) {
                assertThat(u.bereich().netzText()).as(name).isEqualTo(c.path("netz").asText());
                assertThat(u.bereich().boxText()).as(name).isEqualTo(c.path("box_adresse").asText());
                assertThat(u.bereich().ausschnitt()).as(name)
                        .isEqualTo(c.path("ausschnitt").isNull() ? null : c.path("ausschnitt").asBoolean());
                // Was die Box bildet, nimmt die Cloud als gemeldetes Paar an.
                assertThat(Suchbereich.pruefe(u.bereich().netzText(), u.bereich().boxText()).grund()).as(name)
                        .isNull();
            }
            n++;
        }
        assertThat(n).isGreaterThan(15);
    }

    @Test
    void gemeldeteBereiche() {
        for (JsonNode c : vektoren.path("bereich").path("faelle")) {
            Suchbereich.Urteil u = Suchbereich.pruefe(c.path("netz").asText(), c.path("box_adresse").asText());
            assertThat(u.grund()).as(c.toString()).isEqualTo(c.path("grund").textValue());
            assertThat(u.grund() == null).isEqualTo(c.path("gueltig").asBoolean());
        }
    }

    @Test
    void zieleImBereich() {
        List<Suchbereich.Bereich> bereiche = new ArrayList<>();
        for (JsonNode b : vektoren.path("ziel").path("bereiche")) {
            bereiche.add(Suchbereich.pruefe(b.path("netz").asText(), b.path("box_adresse").asText()).bereich());
        }
        for (JsonNode c : vektoren.path("ziel").path("faelle")) {
            String grund = Suchbereich.ziel(c.path("ip").asText(), bereiche);
            assertThat(grund).as(c.toString()).isEqualTo(c.path("grund").textValue());
            assertThat(grund == null).isEqualTo(c.path("erlaubt").asBoolean());
        }
    }
}
