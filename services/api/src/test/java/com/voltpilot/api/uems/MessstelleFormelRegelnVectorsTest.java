package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.MessstelleFormelRegeln.GroesseUrteil;
import com.voltpilot.api.uems.MessstelleFormelRegeln.SummeUrteil;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Summand;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Term;
import com.voltpilot.api.uems.MessstelleFormelRegeln.ZyklusUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings der FORMEL (UEMS AP-10): {@link MessstelleFormelRegeln} zieht aus
 * JEDEM Fall der EINEN geteilten Vektor-Datei ({@code docs/contracts/v2/messstelle-formel-vectors.json})
 * dasselbe Urteil wie der TS-Zwilling ({@code frontend/portal/src/uemsMessstelleFormel.test.ts}).
 * Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class MessstelleFormelRegelnVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "messstelle-formel-vectors.json");

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static List<JsonNode> faelle(String familie) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        vectors().path("cases").path(familie).forEach(out::add);
        assertThat(out).as("Fälle der Familie " + familie).isNotEmpty();
        return out;
    }

    // ------------------------------------------------ die Regeln in der Datei

    @Test
    void dieRegelnStehenInDerDatei() throws Exception {
        JsonNode v = vectors();
        assertThat(v.path("summe_nachkommastellen").asInt())
                .isEqualTo(MessstelleFormelRegeln.SUMME_NACHKOMMASTELLEN);

        List<String> fehlerDatei = new ArrayList<>();
        v.path("fehler").forEach(f -> fehlerDatei.add(
                f.path("code").asText() + "/" + f.path("status").asInt() + "/" + f.path("geprueft_von").asText()));
        List<String> fehlerKlasse = new ArrayList<>();
        for (MessstelleFormelRegeln.Fehler f : MessstelleFormelRegeln.Fehler.values()) {
            fehlerKlasse.add(f.code() + "/" + f.status() + "/" + f.geprueftVon());
        }
        assertThat(fehlerDatei).isEqualTo(fehlerKlasse);

        List<String> einheitenDatei = new ArrayList<>();
        v.path("einheiten_normierung").fields().forEachRemaining(
                e -> einheitenDatei.add(e.getKey() + "=" + texte(e.getValue())));
        assertThat(einheitenDatei).isEqualTo(MessstelleFormelRegeln.EINHEITEN_NORMIERUNG.entrySet().stream()
                .map(e -> e.getKey() + "=" + e.getValue())
                .toList());
    }

    // ---------------------------------------------------------- Größe ableiten

    @TestFactory
    List<DynamicTest> groesse() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle("groesse")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<Term> terme = new ArrayList<>();
                c.at("/input/terme").forEach(t -> terme.add(new Term(
                        t.path("groesse").asText(), t.path("richtung").asText(),
                        t.path("einheit").asText(), t.path("wertart").asText(), t.path("vorzeichen").asText())));
                GroesseUrteil u = MessstelleFormelRegeln.formelGroesse(terme);
                ObjectNode out = MAPPER.createObjectNode();
                out.put("fehler", u.fehler() == null ? null : u.fehler().code());
                out.put("grund", u.grund());
                if (u.hauptgroesse() == null) {
                    out.putNull("hauptgroesse");
                } else {
                    Groesse g = u.hauptgroesse();
                    ObjectNode h = out.putObject("hauptgroesse");
                    h.put("groesse", g.groesse());
                    h.put("richtung", g.richtung());
                    h.put("einheit", g.einheit());
                    h.put("wertart", g.wertart());
                }
                assertThat(out).as(c.path("why").asText()).isEqualTo(c.path("expected"));
            }));
        }
        return tests;
    }

    // ---------------------------------------------------------------- Zyklus

    @TestFactory
    List<DynamicTest> zyklus() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle("zyklus")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<String> verweise = texte(c.at("/input/verweise"));
                Map<String, List<String>> bestehende = new LinkedHashMap<>();
                c.at("/input/bestehende").fields().forEachRemaining(
                        e -> bestehende.put(e.getKey(), texte(e.getValue())));
                ZyklusUrteil u = MessstelleFormelRegeln.zyklus(
                        c.at("/input/kennzeichen").asText(), verweise, bestehende);
                ObjectNode out = MAPPER.createObjectNode();
                out.put("zyklus", u.zyklus());
                out.set("kette", MAPPER.valueToTree(u.kette()));
                assertThat(out).as(c.path("why").asText()).isEqualTo(c.path("expected"));
            }));
        }
        return tests;
    }

    // --------------------------------------------------------- Gewichtete Summe

    @TestFactory
    List<DynamicTest> summe() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle("summe")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<Summand> terme = new ArrayList<>();
                c.at("/input/terme").forEach(t -> terme.add(new Summand(
                        t.path("vorzeichen").asText(), t.path("faktor").asDouble(),
                        t.path("wert").isNull() ? null : t.path("wert").asDouble(),
                        t.path("einheit").asText())));
                SummeUrteil u = MessstelleFormelRegeln.gewichteteSumme(
                        c.at("/input/ziel_einheit").asText(), terme);
                JsonNode expected = c.path("expected");
                // Zahlenvergleich statt Knoten-Gleichheit (int/double der JSON-Zahl).
                if (expected.path("wert").isNull()) {
                    assertThat(u.wert()).as("wert null: " + c.path("why").asText()).isNull();
                } else {
                    assertThat(u.wert()).as(c.path("why").asText())
                            .isCloseTo(expected.path("wert").asDouble(), within(1e-9));
                }
                assertThat(u.unvollstaendig()).isEqualTo(expected.path("unvollstaendig").asBoolean());
                List<Integer> fehlende = new ArrayList<>();
                expected.path("fehlende").forEach(n -> fehlende.add(n.asInt()));
                assertThat(u.fehlende()).isEqualTo(fehlende);
            }));
        }
        return tests;
    }

    // --------------------------------------- AP-08 „gilt als Erzeugung"-Haken

    @TestFactory
    List<DynamicTest> haken() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle("haken")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                String katalogRichtung = in.path("katalog_richtung").isNull()
                        ? null : in.path("katalog_richtung").asText();
                boolean haken = in.path("gilt_als_erzeugung").asBoolean();
                boolean erlaubt = MessstelleFormelRegeln.erzeugungsHakenErlaubt(katalogRichtung);
                String richtung = MessstelleFormelRegeln.richtungMitErzeugungsHaken(katalogRichtung, haken);
                ObjectNode out = MAPPER.createObjectNode();
                out.put("erlaubt", erlaubt);
                out.put("richtung", richtung);
                assertThat(out).as(c.path("why").asText()).isEqualTo(c.path("expected"));
            }));
        }
        return tests;
    }

    private static List<String> texte(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }
}
