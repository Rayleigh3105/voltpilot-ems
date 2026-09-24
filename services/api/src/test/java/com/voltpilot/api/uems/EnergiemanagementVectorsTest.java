package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/** AP-19 NW-1: jeder Vektor derselben Datei wie TS und Python; die Uhr kommt von außen, kein Docker. */
class EnergiemanagementVectorsTest {
    private static final ObjectMapper M = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static JsonNode read(String file) throws Exception { return M.readTree(V2.resolve(file).toFile()); }
    private static Object rechnen(JsonNode fall) throws Exception {
        var e = fall.get("eingang");
        return switch (fall.get("operation").asText()) {
            case "ueberpruefung" -> EnergiemanagementRegeln.ueberpruefung(M.treeToValue(e, EnergiemanagementRegeln.UeberpruefungEingang.class));
            case "wiedervorlage" -> EnergiemanagementRegeln.wiedervorlage(M.treeToValue(e, EnergiemanagementRegeln.WiedervorlageEingang.class));
            case "anwendungsbereich_vergleich" -> EnergiemanagementRegeln.anwendungsbereichVergleich(M.treeToValue(e, EnergiemanagementRegeln.VergleichEingang.class));
            case "verzeichnis_zeile" -> EnergiemanagementRegeln.verzeichnisZeile(M.treeToValue(e, EnergiemanagementRegeln.VerzeichnisEingang.class));
            case "pruefsumme" -> EnergiemanagementRegeln.pruefsumme(e.get("kopie"));
            case "satz" -> EnergiemanagementRegeln.satz(e.get("schluessel").asText(),
                    M.convertValue(e.get("werte"), new TypeReference<Map<String, String>>() {}));
            default -> throw new AssertionError("Ungeprüfte Operation: " + fall.get("operation"));
        };
    }
    private static Stream<JsonNode> faelle() throws Exception {
        return StreamSupport.stream(read("energiemanagement-vectors.json").get("cases").spliterator(), false);
    }
    @TestFactory Stream<DynamicTest> jederVektor() throws Exception {
        return faelle().map(fall -> DynamicTest.dynamicTest(fall.get("name").asText(),
            () -> assertThat(M.<JsonNode>valueToTree(rechnen(fall))).isEqualTo(fall.get("erwartet"))));
    }
    @Test void schemaStartwerteVokabularWoerterSaetze() throws Exception {
        var data = read("energiemanagement-vectors.json");
        assertThat(UemsSchemaLaeufer.verstoesse(data, read("energiemanagement.schema.json"))).isEmpty();
        assertThat(M.<JsonNode>valueToTree(EnergiemanagementRegeln.STARTWERTE)).isEqualTo(data.get("startwerte"));
        assertThat(M.<JsonNode>valueToTree(EnergiemanagementRegeln.VOKABULARE)).isEqualTo(data.get("vokabulare"));
        assertThat(M.<JsonNode>valueToTree(EnergiemanagementRegeln.DOKUMENT_ART_KLASSE)).isEqualTo(data.get("dokument_art_klasse"));
        assertThat(M.<JsonNode>valueToTree(EnergiemanagementRegeln.LEITUNGS_PFLICHT)).isEqualTo(data.get("leitungs_pflicht"));
        assertThat(M.<JsonNode>valueToTree(EnergiemanagementRegeln.WOERTER)).isEqualTo(data.get("woerter"));
        assertThat(M.<JsonNode>valueToTree(EnergiemanagementRegeln.SAETZE)).isEqualTo(data.get("saetze"));
        assertThat(faelle().map(c -> c.get("name").asText()).distinct().count()).isEqualTo(data.get("cases").size());
    }
    @Test void schemaLehntZusatzAb() throws Exception {
        var falsch = read("energiemanagement-vectors.json");
        for (var fall : falsch.get("cases")) {
            if (!fall.get("operation").asText().equals("wiedervorlage")) continue;
            ((ObjectNode) fall.get("eingang")).put("zusatz", 1.5);
            break;
        }
        assertThat(UemsSchemaLaeufer.verstoesse(falsch, read("energiemanagement.schema.json"))).isNotEmpty();
    }
    /** §8 IP-2: „Datum von außen, keine Uhr“ — jede Frist rechnet gegen den Eingang {@code abruf}. */
    @Test void datumVonAussenKeineUhr() throws Exception {
        String java = Files.readString(Path.of("src/main/java/com/voltpilot/api/uems/EnergiemanagementRegeln.java"));
        assertThat(Pattern.compile("\\.now\\(|\\bClock\\b|currentTimeMillis|nanoTime").matcher(java).find()).isFalse();
        var r1 = faelle().filter(c -> c.get("name").asText().startsWith("R1 D-0001 seit 64 Tagen fällig")).findFirst().orElseThrow();
        var e = M.treeToValue(((ObjectNode) r1.get("eingang").deepCopy()).put("abruf", "2029-02-13"), EnergiemanagementRegeln.UeberpruefungEingang.class);
        assertThat(EnergiemanagementRegeln.ueberpruefung(e)).containsEntry("tage", 65);
    }
    @Test void pflichtfaelleDerParagrafAchtZeile() throws Exception {
        var namen = faelle().map(c -> c.get("name").asText()).toList();
        assertThat(namen).anyMatch(n -> n.startsWith("R1 D-0001 seit 64 Tagen fällig"))
                .anyMatch(n -> n.startsWith("R12 BB-0002 seit 457 Tagen"))
                .anyMatch(n -> n.startsWith("R2 nur Strom → Gas nicht im Betrachtungsumfang"));
        assertThat(EnergiemanagementRegeln.STARTWERTE.ueberpruefung_monate()).isEqualTo(12);
    }
    /** IP-1-Befund: die Referenzdatei schreibt −5.0 in ihren Stand — die Prüfsumme gilt für −5 (bericht.md A1). */
    @Test void kanonischeZahlformDerReferenzdatei() throws Exception {
        var stand = read("uems-referenzunternehmen.json").get("managementbewertungen").get(0).get("staende").get(0);
        assertThat(stand.get("abzug").toString()).contains("-5.0");
        assertThat(EnergiemanagementRegeln.pruefsumme(stand.get("abzug"))).containsEntry("pruefsumme", stand.get("pruefsumme").asText());
    }
}
