package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** AP-18 NW-1: jeder Vektor derselben Datei wie TS und Python; exakte Dezimaltexte, kein Docker. */
class VerbesserungVectorsTest {
    private static final ObjectMapper M = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static JsonNode read(String file) throws Exception { return M.readTree(V2.resolve(file).toFile()); }
    private static Object rechnen(JsonNode fall) throws Exception {
        var e = fall.get("eingang");
        return switch (fall.get("operation").asText()) {
            case "wirkung" -> VerbesserungRegeln.wirkung(M.treeToValue(e, VerbesserungRegeln.WirkungEingang.class));
            case "zielstand" -> VerbesserungRegeln.zielstand(M.treeToValue(e, VerbesserungRegeln.ZielstandEingang.class));
            case "frist" -> VerbesserungRegeln.frist(M.treeToValue(e, VerbesserungRegeln.FristEingang.class));
            case "satz" -> VerbesserungRegeln.satz(e.get("schluessel").asText(),
                    M.convertValue(e.get("werte"), new TypeReference<Map<String, String>>() {}));
            default -> throw new AssertionError("Ungeprüfte Operation: " + fall.get("operation"));
        };
    }
    @TestFactory Stream<DynamicTest> jederVektor() throws Exception {
        return StreamSupport.stream(read("verbesserung-vectors.json").get("cases").spliterator(), false).map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(),
            () -> assertThat(M.<JsonNode>valueToTree(rechnen(fall))).isEqualTo(fall.get("erwartet"))));
    }
    @Test void schemaStartwerteVokabularSaetze() throws Exception {
        var data = read("verbesserung-vectors.json");
        assertThat(UemsSchemaLaeufer.verstoesse(data, read("verbesserung.schema.json"))).isEmpty();
        assertThat(M.<JsonNode>valueToTree(VerbesserungRegeln.STARTWERTE)).isEqualTo(data.get("startwerte"));
        assertThat(M.<JsonNode>valueToTree(VerbesserungRegeln.VOKABULARE)).isEqualTo(data.get("vokabulare"));
        assertThat(M.<JsonNode>valueToTree(VerbesserungRegeln.SAETZE)).isEqualTo(data.get("saetze"));
        assertThat(StreamSupport.stream(data.get("cases").spliterator(), false).map(c -> c.get("name").asText()).distinct().count()).isEqualTo(data.get("cases").size());
    }
    @Test void schemaLehntZusatzUndFloatAb() throws Exception {
        var falsch = read("verbesserung-vectors.json");
        for (var fall : falsch.get("cases")) {
            if (!fall.get("operation").asText().equals("wirkung")) continue;
            ((ObjectNode) fall.get("eingang")).put("zusatz", 1.5);
            break;
        }
        assertThat(UemsSchemaLaeufer.verstoesse(falsch, read("verbesserung.schema.json"))).isNotEmpty();
    }
    /** WK3/Z3: die Summe entsteht in {@code BezugsbasisRegeln#zeitraum} — hier wird nirgends durch die Zahl der Monate geteilt. */
    @Test void nirgendsEinMittelDerMonatsDelta() throws Exception {
        String java = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/VerbesserungRegeln.java"));
        assertThat(Pattern.compile("(?i)\\bmittel\\w*\\(|average|\\.mean\\(|\\.divide\\(|/\\s*\\w+\\.size\\(\\)").matcher(java).find()).isFalse();
        assertThat(java).contains("BezugsbasisRegeln.zeitraum(").contains("BezugsbasisRegeln.vergleich(");
    }
    @Test void pflichtfaelleDerParagrafAchtZeile() throws Exception {
        var namen = StreamSupport.stream(read("verbesserung-vectors.json").get("cases").spliterator(), false).map(c -> c.get("name").asText()).toList();
        assertThat(namen).anyMatch(n -> n.startsWith("R5 Februar bis Oktober 2028: 2,4 % weniger, 8 von 12, März ausgeschlossen"))
                .anyMatch(n -> n.startsWith("R6 Januar 2028 Umsetzungsmonat nicht gezählt"))
                .anyMatch(n -> n.startsWith("R10 11 von 12 → kein Vorschlag"));
        assertThat(List.of(VerbesserungRegeln.STARTWERTE.nachher_monate(), VerbesserungRegeln.STARTWERTE.abweichung_frist_tage())).containsExactly(12, 30);
    }
}
