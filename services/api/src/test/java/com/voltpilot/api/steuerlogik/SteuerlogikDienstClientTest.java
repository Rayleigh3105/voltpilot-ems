package com.voltpilot.api.steuerlogik;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.flows.FlowCompilerHttp;
import com.voltpilot.api.flows.FlowDeployment;
import java.io.IOException;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Die Brücke zum Logik-Dienst: Antworten 200/422/sonst, und die Form des gepinnten Artefakts des Dienstes. */
class SteuerlogikDienstClientTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    static final Path ARTEFAKT = Path.of("../../docs/contracts/v2/examples/flow-artifact.valid.steuerlogik.json");
    private static final UUID LOGIK = UUID.fromString("5e1f0c2a-7b3d-4e8f-9a1b-2c3d4e5f6a7b");

    private final List<String> anfragen = new ArrayList<>();

    private SteuerlogikDienstClient client(int status, String body) {
        return new SteuerlogikDienstClient((uri, json) -> {
            anfragen.add(uri + " " + json);
            return new FlowCompilerHttp.Response(status, body);
        }, URI.create("http://logik-dienst:8101"), JSON);
    }

    private static SteuerlogikDienst.Auftrag auftrag() {
        return new SteuerlogikDienst.Auftrag("logic: 1", LOGIK, 1, Instant.parse("2026-11-14T12:00:00Z"),
                new SteuerlogikDienst.Ort("Europe/Berlin", new BigDecimal("48.1"), new BigDecimal("11.6")));
    }

    @Test
    void gebautesArtefaktKommtMitBerichtZurueck() throws Exception {
        JsonNode artefakt = JSON.readTree(Files.readString(ARTEFAKT));
        ObjectNode body = JSON.createObjectNode();
        body.set("artifact", artefakt);
        body.putObject("bericht").put("name", "Wärmepumpe").put("sperrt", false);
        SteuerlogikDienst.Artefakt a = client(200, body.toString()).artefakt(auftrag());
        assertThat(a.artefakt()).isEqualTo(artefakt);
        assertThat(a.bericht().path("name").asText()).isEqualTo("Wärmepumpe");
        JsonNode anfrage = JSON.readTree(anfragen.get(0).substring(anfragen.get(0).indexOf(' ') + 1));
        assertThat(anfragen.get(0)).startsWith("http://logik-dienst:8101/artefakt ");
        assertThat(anfrage.path("flow_id").asText()).isEqualTo(LOGIK.toString());
        assertThat(anfrage.path("site").path("timezone").asText()).isEqualTo("Europe/Berlin");
        assertThat(anfrage.path("site").path("latitude").decimalValue()).isEqualByComparingTo("48.1");
    }

    @Test
    void dasGepinnteArtefaktDesDienstesHatDieFormDesSatzes() throws Exception {
        JsonNode artefakt = JSON.readTree(Files.readString(ARTEFAKT));
        FlowDeployment.requireArtifactShape(artefakt);
        assertThat(artefakt.path("bundle").path("logic").isTextual())
                .as("die Logik reist als Text: der Hash schützt die Reihenfolge der Zustände").isTrue();
        ObjectNode kaputt = artefakt.deepCopy();
        ((ObjectNode) kaputt.path("bundle")).putArray("tab_ids").add("x");
        assertThatThrownBy(() -> FlowDeployment.requireArtifactShape(kaputt))
                .isInstanceOf(IllegalArgumentException.class);
        ObjectNode ohneText = artefakt.deepCopy();
        ((ObjectNode) ohneText.path("bundle")).putObject("logic");
        assertThatThrownBy(() -> FlowDeployment.requireArtifactShape(ohneText))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void fremdeIdentitaetImArtefaktIstKeinErfolg() throws Exception {
        ObjectNode artefakt = (ObjectNode) JSON.readTree(Files.readString(ARTEFAKT));
        artefakt.put("flow_version", 2);
        ObjectNode body = JSON.createObjectNode();
        body.set("artifact", artefakt);
        assertThatThrownBy(() -> client(200, body.toString()).artefakt(auftrag()))
                .isInstanceOfSatisfying(SteuerlogikDienstException.class,
                        e -> assertThat(e.grund()).isEqualTo(SteuerlogikDienstException.NICHT_ERREICHBAR));
    }

    @Test
    void ablehnungenDesDienstes() {
        assertThatThrownBy(() -> client(422, "{\"message\":\"Logik nicht lesbar: Zeile 3\"}").artefakt(auftrag()))
                .isInstanceOfSatisfying(SteuerlogikDienstException.class, e -> {
                    assertThat(e.grund()).isEqualTo(SteuerlogikDienstException.UNLESBAR);
                    assertThat(e.getMessage()).isEqualTo("Logik nicht lesbar: Zeile 3");
                    assertThat(e.bericht()).isNull();
                });
        assertThatThrownBy(() -> client(422, "{\"message\":\"Die Prüfung sperrt die Logik\",\"bericht\":{\"sperrt\":true}}")
                .artefakt(auftrag()))
                .isInstanceOfSatisfying(SteuerlogikDienstException.class, e -> {
                    assertThat(e.grund()).isEqualTo(SteuerlogikDienstException.GESPERRT);
                    assertThat(e.bericht().path("sperrt").asBoolean()).isTrue();
                });
        assertThatThrownBy(() -> client(500, "{}").artefakt(auftrag()))
                .isInstanceOfSatisfying(SteuerlogikDienstException.class,
                        e -> assertThat(e.grund()).isEqualTo(SteuerlogikDienstException.NICHT_ERREICHBAR));
        SteuerlogikDienstClient weg = new SteuerlogikDienstClient((uri, json) -> {
            throw new IOException("connection refused");
        }, URI.create("http://logik-dienst:8101"), JSON);
        assertThatThrownBy(() -> weg.artefakt(auftrag()))
                .isInstanceOfSatisfying(SteuerlogikDienstException.class,
                        e -> assertThat(e.grund()).isEqualTo(SteuerlogikDienstException.NICHT_ERREICHBAR));
    }
}
