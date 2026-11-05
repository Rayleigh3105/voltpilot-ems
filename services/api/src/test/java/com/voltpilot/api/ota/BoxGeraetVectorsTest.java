package com.voltpilot.api.ota;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Die Annahme von {@code update.geraet} an denselben Vektoren, an denen die Box
 * ihre Erkennung prüft (Geräte &amp; Updates G8, {@code box-geraet-vectors.json}).
 */
class BoxGeraetVectorsTest {

    private static JsonNode vektoren() throws Exception {
        Path p = Path.of("..", "..", "docs", "contracts", "v2", "box-geraet-vectors.json");
        return new ObjectMapper().readTree(Files.readString(p));
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    @Test
    @DisplayName("jeder Herzschlag-Fall wird so gespeichert, wie der Vertrag sagt")
    void herzschlagNachDenVektoren() throws Exception {
        JsonNode faelle = vektoren().get("herzschlag");
        assertThat(faelle.size()).isPositive();
        for (JsonNode f : faelle) {
            BoxGeraet.Angabe a = BoxGeraet.of(f.get("geraet"));
            JsonNode soll = f.get("gespeichert");
            assertThat(a).as(f.get("name").asText()).isNotNull();
            assertThat(a.modell()).as(f.get("name").asText()).isEqualTo(text(soll.get("modell")));
            assertThat(a.arch()).as(f.get("name").asText()).isEqualTo(text(soll.get("arch")));
            assertThat(a.loader()).as(f.get("name").asText()).isEqualTo(text(soll.get("loader")));
        }
    }

    @Test
    @DisplayName("was die Box selbst erkennt, nimmt die Cloud unverändert an")
    void erkennungUeberlebtDieAnnahme() throws Exception {
        for (JsonNode f : vektoren().get("erkennung")) {
            JsonNode erwartet = f.get("erwartet");
            if (erwartet.get("modell").isNull()) {
                continue;
            }
            String modell = erwartet.get("modell").asText();
            assertThat(BoxGeraet.modell(modell)).as(f.get("name").asText()).isEqualTo(modell);
            assertThat(BoxGeraet.arch(erwartet.get("arch").asText())).isEqualTo(erwartet.get("arch").asText());
        }
    }

    @Test
    @DisplayName("ein fehlender Block ist keine Angabe - die zuletzt gemeldete bleibt stehen")
    void fehlenderBlock() {
        assertThat(BoxGeraet.of(null)).isNull();
        assertThat(BoxGeraet.of(new ObjectMapper().createArrayNode())).isNull();
    }
}
