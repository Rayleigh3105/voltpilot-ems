package com.voltpilot.api.verbraucher;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * MiSpeL MP-41c (BK-41c-3 = A): die geteilten Vektoren
 * {@code docs/contracts/v2/mispel-steuerart-sofort-vectors.json} gegen die
 * Projektion, wie {@code VerbraucherService} sie fuer eine OCPP-Saeule faehrt.
 *
 * <p>Der Optimierer haelt das Zurueckspeisen an, wenn die Projektion die
 * Steuerart „sofort“ nennt - dann zeigt die Wallbox-Karte „Schnell“. Sein
 * Zwilling ({@code fahrzeugspeicher.steuerart_sofort}) liest dieselbe Datei;
 * wer die Projektion aendert, faehrt beide. Rein, ohne Docker.
 */
class SteuerartSofortVektorenTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void dieProjektionNenntSofortGenauWieDieVektoren() throws Exception {
        JsonNode vektoren = MAPPER.readTree(Path.of("..", "..", "docs", "contracts", "v2",
                "mispel-steuerart-sofort-vectors.json").toFile());
        List<JsonNode> faelle = new ArrayList<>();
        vektoren.get("faelle").forEach(faelle::add);
        assertThat(faelle).hasSizeGreaterThanOrEqualTo(15);
        for (JsonNode fall : faelle) {
            String name = fall.get("name").asText();
            Steuerart standard = SteuerartProjektion.anlagenStandard(text(fall, "anlage"), null);
            Steuerart lane = SteuerartProjektion.saeulenSteuerart(text(fall, "saeule"), null, standard);
            Steuerart s = SteuerartProjektion.projiziere(fall.get("policy"), true, lane);
            JsonNode erwartet = fall.get("erwartet");
            assertThat(s.quelle()).as(name).isEqualTo(erwartet.get("quelle").asText());
            assertThat(SteuerartProjektion.QUELLE_SOFORT.equals(s.quelle())).as(name)
                    .isEqualTo(erwartet.get("sofort").asBoolean());
        }
    }

    private static String text(JsonNode fall, String feld) {
        JsonNode n = fall.get(feld);
        return n == null || n.isNull() ? null : n.asText();
    }
}
