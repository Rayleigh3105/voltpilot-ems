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

/** Jeder Vektor derselben Datei wie TS und Python; exakte Dezimaltexte, kein Docker. */
class BewertungVectorsTest {
    private static final ObjectMapper M = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static JsonNode read(String file) throws Exception { return M.readTree(V2.resolve(file).toFile()); }
    private static String text(JsonNode n) { return n.isNull() ? null : n.asText(); }
    private static <T> List<T> list(JsonNode n, Class<T[]> type) throws Exception { return Arrays.asList(M.treeToValue(n, type)); }
    private static Object rechnen(JsonNode fall) throws Exception {
        var e = fall.get("eingang");
        return switch (fall.get("operation").asText()) {
            case "nenner" -> BewertungRegeln.nenner(list(e.get("anlagen"), BewertungRegeln.Anlage[].class));
            case "menge" -> BewertungRegeln.menge(list(e.get("messstellen"), BewertungRegeln.Messstelle[].class), e.get("traeger").asText());
            case "rangliste" -> BewertungRegeln.rangliste(M.treeToValue(e, BewertungRegeln.RanglisteEingang.class));
            case "abdeckung" -> BewertungRegeln.abdeckung(M.treeToValue(e, BewertungRegeln.AbdeckungEingang.class));
            case "prozess_summe_passt" -> BewertungRegeln.prozessSummePasst(list(e.get("gemessen"), String[].class), list(e.get("summen"), BewertungRegeln.ProzessSumme[].class));
            case "toleranz" -> BewertungRegeln.toleranz(text(e.get("fuehrend")), text(e.get("vergleich")), e.get("toleranz").asText());
            default -> throw new AssertionError("Ungeprüfte Operation: " + fall.get("operation"));
        };
    }
    @TestFactory Stream<DynamicTest> jederVektor() throws Exception {
        return StreamSupport.stream(read("bewertung-vectors.json").get("cases").spliterator(), false).map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(),
            () -> assertThat(M.<JsonNode>valueToTree(rechnen(fall))).isEqualTo(fall.get("erwartet"))));
    }
    @Test void schemaStartwerteVokabular() throws Exception {
        var data = read("bewertung-vectors.json");
        assertThat(UemsSchemaLaeufer.verstoesse(data, read("bewertung.schema.json"))).isEmpty();
        assertThat(M.<JsonNode>valueToTree(BewertungRegeln.STARTWERTE)).isEqualTo(data.get("startwerte"));
        assertThat(M.<JsonNode>valueToTree(BewertungRegeln.TRAEGER)).isEqualTo(data.at("/vokabulare/traeger"));
        assertThat(M.<JsonNode>valueToTree(BewertungRegeln.URTEILE)).isEqualTo(data.at("/vokabulare/urteil"));
        assertThat(M.<JsonNode>valueToTree(BewertungRegeln.ABDECKUNG)).isEqualTo(data.at("/vokabulare/abdeckung"));
        assertThat(M.<JsonNode>valueToTree(BewertungRegeln.EINSTUFUNGEN)).isEqualTo(data.at("/vokabulare/einstufung"));
        assertThat(StreamSupport.stream(data.get("cases").spliterator(), false).map(c -> c.get("name").asText()).distinct().count()).isEqualTo(data.get("cases").size());
    }
    @Test void schemaLehntZusatzUndFloatAb() throws Exception {
        for (var key : List.of("zusatz", "zufluss")) {
            var falsch = read("bewertung-vectors.json");
            ((ObjectNode) falsch.at("/cases/0/eingang/anlagen/0")).put(key, 1.5);
            assertThat(UemsSchemaLaeufer.verstoesse(falsch, read("bewertung.schema.json"))).isNotEmpty();
        }
    }
}
