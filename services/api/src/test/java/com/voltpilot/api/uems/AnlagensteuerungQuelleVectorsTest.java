package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.erzeuger.AnlagensteuerungQuelle;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * UEMS EZ-21: Treiber und Pin der Anlagensteuerung aus {@code anlagensteuerung-quelle-vectors.json} — dieselben Fälle,
 * aus denen der Go-Applier die Quelle ableitet ({@code componentapply/plant_controller_test.go}) und an die die
 * Palette sich bindet ({@code nodered/measurements/anlagensteuerung-quelle.test.js}). Der Pin ist der Java-Zwilling
 * von {@code sources.DeterministicID}; der Treiber hält {@code $defs/anlagensteuerung_driver}.
 */
class AnlagensteuerungQuelleVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VERTRAEGE = Path.of("../../docs/contracts/v2");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VERTRAEGE.resolve("anlagensteuerung-quelle-vectors.json")));
    }

    private static JsonNode treiberSchema() throws Exception {
        JsonNode schema = MAPPER.readTree(Files.readString(VERTRAEGE.resolve("edge-entity.schema.json")));
        var wurzel = MAPPER.createObjectNode();
        wurzel.put("$ref", "#/$defs/anlagensteuerung_driver");
        wurzel.set("$defs", schema.path("$defs"));
        return wurzel;
    }

    @Test
    void dasVokabularIstDasDesCodes() throws Exception {
        JsonNode v = vektoren();
        assertThat(v.path("faehigkeit").asText()).isEqualTo(AnlagensteuerungQuelle.FAEHIGKEIT);
        assertThat(v.path("rolle").asText()).isEqualTo(AnlagensteuerungQuelle.ROLLE);
        assertThat(v.path("kommunikation").asText()).isEqualTo(AnlagensteuerungQuelle.KOMMUNIKATION);
        assertThat(v.path("lesetakt_s").asInt()).isEqualTo(AnlagensteuerungQuelle.LESETAKT_S);
        assertThat(EdgeSupports.NAMES).contains(AnlagensteuerungQuelle.FAEHIGKEIT);
    }

    @TestFactory
    Stream<DynamicTest> treiberUndPinAusDerDatenquelle() throws Exception {
        JsonNode schema = treiberSchema();
        return java.util.stream.StreamSupport.stream(vektoren().path("faelle").spliterator(), false)
                .map(f -> DynamicTest.dynamicTest(f.path("name").asText(), () -> {
                    var t = AnlagensteuerungQuelle.transport(AnlagensteuerungQuelle.KOMMUNIKATION,
                            f.path("adresse").asText(), f.path("unit_id").asInt()).orElseThrow();
                    assertThat(AnlagensteuerungQuelle.kennung(t)).isEqualTo(f.path("edge_source_id").asText());
                    JsonNode treiber = AnlagensteuerungQuelle.treiber(MAPPER, t, f.path("kennzeichen").asText());
                    assertThat(treiber).isEqualTo(f.path("driver"));
                    assertThat(UemsSchemaLaeufer.verstoesse(treiber, schema)).isEmpty();
                }));
    }

    @Test
    void ohneLesbarenTransportKeinTreiber() {
        assertThat(AnlagensteuerungQuelle.transport("sunspec_modbus", "192.168.4.165:503", 1)).isEmpty();
        assertThat(AnlagensteuerungQuelle.transport("modbus_tcp", "192.168.4.165:503", 256)).isEmpty();
        assertThat(AnlagensteuerungQuelle.transport("modbus_tcp", "192.168.4.165:503", null)).isEmpty();
        assertThat(AnlagensteuerungQuelle.transport("modbus_tcp", "[fd00::10", 1)).isEmpty();
        assertThat(AnlagensteuerungQuelle.transport("modbus_tcp", null, 1)).isEmpty();
    }

    @Test
    void dasSchemaLehntEinenTreiberMitMarkeOderOhneGeraeteIdAb() throws Exception {
        JsonNode schema = treiberSchema();
        var t = new AnlagensteuerungQuelle.Transport("192.168.4.165", 503, 1);
        var mitMarke = AnlagensteuerungQuelle.treiber(MAPPER, t, "DQ-1");
        mitMarke.put("brand", "wago");
        assertThat(UemsSchemaLaeufer.verstoesse(mitMarke, schema)).as("der Läufer beißt").isNotEmpty();
        var ohneId = AnlagensteuerungQuelle.treiber(MAPPER, t, "DQ-1");
        ((com.fasterxml.jackson.databind.node.ObjectNode) ohneId.path("connection")).remove("unit_id");
        assertThat(UemsSchemaLaeufer.verstoesse(ohneId, schema)).isNotEmpty();
    }
}
