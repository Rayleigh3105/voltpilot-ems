package com.voltpilot.api.geraete;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * {@link BoxLoesenRegel} gegen {@code docs/contracts/box-loesen-vectors.json} - der EINE Leser
 * dieser Vektoren (anders als Vektoren mit mehreren Lesern wie {@code speicher-steuerstand-vectors.json}
 * trägt diese Datei keine Abschnitte je Leser).
 */
class BoxLoesenRegelVectorsTest {

    private static final Path DATEI = Path.of("..", "..", "docs", "contracts", "box-loesen-vectors.json");

    @Test
    void jederVektorStimmt() throws IOException {
        JsonNode wurzel = new ObjectMapper().readTree(DATEI.toFile());
        List<String> fehler = new ArrayList<>();
        int n = 0;
        for (JsonNode v : wurzel.path("vektoren")) {
            n++;
            String name = v.path("name").asText();
            BoxBefund befund = new BoxBefund(
                    v.path("aktiv").asBoolean(),
                    zeitpunkt(v, "herzschlagAm"),
                    zeitpunkt(v, "messwertAm"),
                    zeitpunkt(v, "meldungAm"),
                    v.path("hatZustaendigkeiten").asBoolean(),
                    zeitpunkt(v, "schluesselAbgeholtAm"));
            boolean adminWeg = v.path("adminWeg").asBoolean();
            List<String> erwarteteGruende = new ArrayList<>();
            v.path("erwartet").path("gruende").forEach(g -> erwarteteGruende.add(g.asText()));
            boolean erwartetLoesbar = v.path("erwartet").path("loesbar").asBoolean();

            List<String> gruende = BoxLoesenRegel.gruende(befund, adminWeg);
            boolean loesbar = BoxLoesenRegel.loesbar(befund, adminWeg);
            if (!gruende.equals(erwarteteGruende) || loesbar != erwartetLoesbar) {
                fehler.add(name + ": erwartet loesbar=" + erwartetLoesbar + " gruende=" + erwarteteGruende
                        + ", bekommen loesbar=" + loesbar + " gruende=" + gruende);
            }
        }
        assertThat(n).as("Vektoren in der Datei").isGreaterThanOrEqualTo(9);
        assertThat(fehler).isEmpty();
    }

    @Test
    void dieReihenfolgeDerGruendeStehtFestUndIstVollstaendig() throws IOException {
        JsonNode wurzel = new ObjectMapper().readTree(DATEI.toFile());
        List<String> reihenfolge = new ArrayList<>();
        wurzel.path("gruende_reihenfolge").forEach(g -> reihenfolge.add(g.asText()));
        assertThat(reihenfolge).containsExactly("verbund", "herzschlag", "messwerte", "meldungen",
                "zustaendigkeit", "angemeldet");
        // Der Vektor "Alles zugleich" trägt jeden Grund genau einmal, in dieser Reihenfolge.
        for (JsonNode v : wurzel.path("vektoren")) {
            if ("Alles zugleich - jeder Grund einmal, in Reihenfolge".equals(v.path("name").asText())) {
                List<String> gruende = new ArrayList<>();
                v.path("erwartet").path("gruende").forEach(g -> gruende.add(g.asText()));
                assertThat(gruende).containsExactlyElementsOf(reihenfolge);
                return;
            }
        }
        throw new AssertionError("Vektor 'Alles zugleich' fehlt");
    }

    private static Instant zeitpunkt(JsonNode v, String feld) {
        JsonNode f = v.get(feld);
        if (f == null || f.isNull()) {
            return null;
        }
        return Instant.parse(f.asText());
    }
}
