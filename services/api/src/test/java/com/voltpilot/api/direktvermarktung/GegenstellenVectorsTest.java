package com.voltpilot.api.direktvermarktung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die gemeinsamen Vektoren für {@code zugang.vpn.gegenstellen}
 * ({@code catalog/direktvermarkter/vectors/gegenstellen.json}): Muster-Gültigkeit und Abgleich-Semantik
 * müssen in Java ({@link ZugangsdateiOeffner}) und Python ({@code tools/profilelib.py}, geprüft von
 * {@code tests/test_profiles.py}) dasselbe sagen - eine Datei, nie zwei driftende Antworten.
 */
class GegenstellenVectorsTest {

    private static final Path VECTORS = Path.of("../../catalog/direktvermarkter/vectors/gegenstellen.json");

    @Test
    void musterGueltigkeitFolgtDenVektoren() throws Exception {
        JsonNode doc = new ObjectMapper().readTree(Files.readString(VECTORS));
        assertThat(doc.path("muster")).isNotEmpty();
        for (JsonNode fall : doc.path("muster")) {
            assertThat(ZugangsdateiOeffner.istGueltigesMuster(fall.path("muster").asText()))
                    .as("muster %s", fall.path("muster").asText())
                    .isEqualTo(fall.path("gueltig").asBoolean());
        }
    }

    @Test
    void abgleichFolgtDenVektoren() throws Exception {
        JsonNode doc = new ObjectMapper().readTree(Files.readString(VECTORS));
        assertThat(doc.path("abgleich")).isNotEmpty();
        for (JsonNode fall : doc.path("abgleich")) {
            List<String> muster = new ArrayList<>();
            fall.path("muster").forEach(m -> muster.add(m.asText()));
            // Eine leere Liste heißt "keine Schranke" - alles erlaubt (so steht luox heute da, F1 offen).
            assertThat(ZugangsdateiOeffner.gegenstelleErlaubt(fall.path("host").asText(), muster))
                    .as("host %s gegen %s", fall.path("host").asText(), muster)
                    .isEqualTo(fall.path("erlaubt").asBoolean());
        }
    }
}
