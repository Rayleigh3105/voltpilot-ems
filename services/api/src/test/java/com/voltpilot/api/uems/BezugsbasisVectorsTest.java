package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** AP-17 NW-1: jeder Vektor derselben Datei wie TS und Python; exakte Dezimaltexte, kein Docker. */
class BezugsbasisVectorsTest {
    private static final ObjectMapper M = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static JsonNode read(String file) throws Exception { return M.readTree(V2.resolve(file).toFile()); }
    private static <T> List<T> list(JsonNode n, Class<T[]> type) throws Exception { return Arrays.asList(M.treeToValue(n, type)); }
    private static BezugsbasisRegeln.VergleichEingang vergleich(JsonNode n) throws Exception {
        return M.treeToValue(n, BezugsbasisRegeln.VergleichEingang.class);
    }
    private static Object rechnen(JsonNode fall) throws Exception {
        var e = fall.get("eingang");
        return switch (fall.get("operation").asText()) {
            case "referenzperiode" -> BezugsbasisRegeln.referenzperiode(e.get("text").asText(), e.get("laufender_monat").asText());
            case "basiswert" -> BezugsbasisRegeln.basiswert(list(e.get("grundlage"), BezugsbasisRegeln.Paar[].class));
            case "modell" -> BezugsbasisRegeln.modell(e.get("methode").asText(), list(e.get("reihe"), BezugsbasisRegeln.Reihe[].class));
            case "abhaengigkeit" -> BezugsbasisRegeln.abhaengigkeit(list(e.get("x1"), String[].class), list(e.get("x2"), String[].class));
            case "vergleich" -> BezugsbasisRegeln.vergleich(vergleich(e));
            case "roh_und_bereinigt" -> BezugsbasisRegeln.rohUndBereinigt(e.at("/roh/gemessen").asText(), e.at("/roh/vorher").asText(),
                    e.at("/roh/variable").asText(), e.at("/roh/variable_vorher").asText(), vergleich(e.get("bereinigt")));
            case "methoden_paar" -> BezugsbasisRegeln.methodenPaar(vergleich(e.get("modell")), vergleich(e.get("verhaeltnis")));
            case "zeitraum" -> BezugsbasisRegeln.zeitraum(M.treeToValue(e, BezugsbasisRegeln.ZeitraumEingang.class));
            case "roh" -> BezugsbasisRegeln.roh(e.get("aktuell").asText(), e.get("vorher").asText());
            case "runden" -> BezugsbasisRegeln.runden(e.get("wert").asText(), e.get("stellen").asInt());
            case "frist" -> BezugsbasisRegeln.frist(M.treeToValue(e, BezugsbasisRegeln.FristEingang.class));
            default -> throw new AssertionError("Ungeprüfte Operation: " + fall.get("operation"));
        };
    }
    @TestFactory Stream<DynamicTest> jederVektor() throws Exception {
        return StreamSupport.stream(read("bezugsbasis-vectors.json").get("cases").spliterator(), false).map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(),
            () -> assertThat(M.<JsonNode>valueToTree(rechnen(fall))).isEqualTo(fall.get("erwartet"))));
    }
    @Test void schemaStartwerteVokabular() throws Exception {
        var data = read("bezugsbasis-vectors.json");
        assertThat(UemsSchemaLaeufer.verstoesse(data, read("bezugsbasis.schema.json"))).isEmpty();
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.STARTWERTE)).isEqualTo(data.get("startwerte"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.METHODEN)).isEqualTo(data.at("/vokabulare/methode"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.URTEILE)).isEqualTo(data.at("/vokabulare/urteil"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.GRUENDE)).isEqualTo(data.at("/vokabulare/grund"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.DATENLAGE)).isEqualTo(data.at("/vokabulare/datenlage"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.RICHTUNGEN)).isEqualTo(data.at("/vokabulare/richtung"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.ANPASSUNGSGRUENDE)).isEqualTo(data.at("/vokabulare/anpassungsgrund"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.FAKTOR_ARTEN)).isEqualTo(data.at("/vokabulare/faktor_art"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.BASIS_ZUSTAENDE)).isEqualTo(data.at("/vokabulare/basis_zustand"));
        assertThat(M.<JsonNode>valueToTree(BezugsbasisRegeln.FREIGABE_STATUS)).isEqualTo(data.at("/vokabulare/freigabe_status"));
        assertThat(StreamSupport.stream(data.get("cases").spliterator(), false).map(c -> c.get("name").asText()).distinct().count()).isEqualTo(data.get("cases").size());
    }
    @Test void schemaLehntZusatzUndFloatAb() throws Exception {
        for (var key : List.of("zusatz", "zaehler")) {
            var falsch = read("bezugsbasis-vectors.json");
            for (var fall : falsch.get("cases")) {
                if (!fall.get("operation").asText().equals("basiswert")) continue;
                ((ObjectNode) fall.at("/eingang/grundlage/0")).put(key, 1.5);
                break;
            }
            assertThat(UemsSchemaLaeufer.verstoesse(falsch, read("bezugsbasis.schema.json"))).isNotEmpty();
        }
    }
    @Test void rundungIstKaufmaennischNichtMathRound() {
        assertThat(Math.round(-20.5)).isEqualTo(-20);
        assertThat(BezugsbasisRegeln.runden("-2.05", 1)).isEqualTo("-2.1");
        assertThat(BezugsbasisRegeln.runden("81984.5", 0)).isEqualTo("81985");
    }
    @Test void dezemberVergleichIstDerDesLeistungsvergleichs() throws Exception {
        var vb = read("uems-referenzunternehmen.json").at("/leistungsvergleiche/0/vergleich");
        JsonNode dez = null;
        for (var fall : read("bezugsbasis-vectors.json").get("cases"))
            if (fall.get("name").asText().startsWith("R2 Dezember 2027 bereinigt")) dez = fall.get("erwartet");
        assertThat(dez).isNotNull();
        assertThat(List.of(new java.math.BigDecimal(dez.get("erwartet").asText()).compareTo(vb.get("erwartet").decimalValue()),
                new java.math.BigDecimal(dez.get("delta_prozent").asText()).compareTo(vb.get("delta_prozent").decimalValue()),
                new java.math.BigDecimal(dez.get("band_prozent").asText()).compareTo(vb.get("band_prozent").decimalValue()))).containsOnly(0);
        assertThat(dez.get("urteil").asText()).isEqualTo(vb.get("urteil").asText());
    }
}
