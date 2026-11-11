package com.voltpilot.api.werkstatt;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: Die Ansicht, die der Werkstatt-Dienst meldet, besteht die
 * Formprüfung der API genau so, wie Go sie schreibt
 * ({@code docs/contracts/werkstatt-ansicht-v1.example.json}, erzeugt von
 * {@code TestAnsichtVektor}); was nicht passt, weist sie mit Grund ab.
 */
class WerkstattAnsichtVertragTest {

    private static final Path VEKTOR = Path.of("..", "..", "docs", "contracts", "werkstatt-ansicht-v1.example.json");
    private final ObjectMapper json = new ObjectMapper();
    private final DienstAnsichtService service = new DienstAnsichtService(null, json);

    @Test
    void derVektorDesDienstesBesteht() throws Exception {
        JsonNode a = service.pruefe(Files.readString(VEKTOR));
        assertThat(a.path("schema").asText()).isEqualTo(DienstAnsichtService.SCHEMA);
        assertThat(a.path("lauf").path("zustand").asText()).isEqualTo("laeuft");
        assertThat(a.path("werkbank").path("status").path("werkstatt").path("kabel").asBoolean()).isTrue();
    }

    @Test
    void wasNichtPasstWirdAbgewiesen() throws Exception {
        ObjectNode gut = (ObjectNode) json.readTree(Files.readString(VEKTOR));
        ObjectNode schema = gut.deepCopy();
        schema.put("schema", "vp-werkstatt-ansicht.v9");
        ObjectNode zustand = gut.deepCopy();
        ((ObjectNode) zustand.path("lauf")).put("zustand", "irgendwie");
        ObjectNode ohneZeit = gut.deepCopy();
        ohneZeit.remove("zeit");
        ObjectNode schluessel = gut.deepCopy();
        schluessel.put("anschluss", "-----BEGIN OPENSSH PRIVATE KEY-----");
        ObjectNode gross = gut.deepCopy();
        gross.put("anschluss", "x".repeat(DienstAnsichtService.MAX_BYTES));
        for (var f : java.util.List.of(schema, zustand, ohneZeit, schluessel, gross)) {
            assertThatThrownBy(() -> service.pruefe(f.toString())).hasMessageContaining("Ansicht ungültig");
        }
        ObjectNode ohneLauf = gut.deepCopy();
        ohneLauf.remove("lauf");
        assertThat(service.pruefe(ohneLauf.toString()).has("lauf")).isFalse();
    }
}
