package com.voltpilot.api.components;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.components.ZaehlerbaumRegeln.ElternKandidat;
import com.voltpilot.api.components.ZaehlerbaumRegeln.HaengtAnUrteil;
import com.voltpilot.api.components.ZaehlerbaumRegeln.Zuordnung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings: {@link ZaehlerbaumRegeln#haengtAnPruefen}
 * zieht aus JEDEM Fall der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/zaehlerbaum-vectors.json}) dasselbe Urteil wie der
 * TS-Zwilling ({@code frontend/portal/src/zaehlerbaum.test.ts} fährt dieselbe
 * Datei). Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class ZaehlerbaumRegelnVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber (dem Muster von MessstelleRegelnVectorsTest folgend).
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "zaehlerbaum-vectors.json");

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static List<JsonNode> faelle() throws Exception {
        List<JsonNode> out = new ArrayList<>();
        vectors().path("cases").forEach(out::add);
        assertThat(out).isNotEmpty();
        return out;
    }

    @Test
    void mindestensZehnFaelleMitEindeutigenNamen() throws Exception {
        List<String> namen = faelle().stream().map(c -> c.path("name").asText()).toList();
        assertThat(namen).hasSizeGreaterThanOrEqualTo(10).doesNotHaveDuplicates();
    }

    private static Zuordnung zuordnung(JsonNode z) {
        return new Zuordnung(z.path("komponenteId").asText(), text(z.path("haengtAn")));
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    @TestFactory
    List<DynamicTest> haengtAnPruefen() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle()) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                JsonNode e = in.path("eltern");
                ElternKandidat eltern = e.isNull() ? null : new ElternKandidat(
                        e.path("id").asText(), e.path("anlage").asText(),
                        text(e.path("rolle")), text(e.path("entityType")));
                List<Zuordnung> baum = new ArrayList<>();
                in.path("baum").forEach(z -> baum.add(zuordnung(z)));
                HaengtAnUrteil u = ZaehlerbaumRegeln.haengtAnPruefen(
                        in.path("komponenteId").asText(), in.path("eigeneAnlage").asText(),
                        text(in.path("eigeneRolle")), eltern, baum);
                JsonNode expected = c.path("expected");
                assertThat(u.gueltig()).as(c.path("note").asText()).isEqualTo(expected.path("gueltig").asBoolean());
                assertThat(u.grund()).isEqualTo(text(expected.path("grund")));
                List<String> ketteErwartet = new ArrayList<>();
                expected.path("kette").forEach(k -> ketteErwartet.add(k.asText()));
                assertThat(u.kette()).isEqualTo(ketteErwartet);
            }));
        }
        return tests;
    }

    /** Zyklus-Schutz auch bei einer tiefen, kreisfreien Kette (kein Endlos-Lauf). */
    @Test
    void tieferBaumOhneKreisTerminiert() {
        List<Zuordnung> baum = new ArrayList<>();
        String vorher = "netz-1";
        for (int i = 0; i < 50; i++) {
            baum.add(new Zuordnung("uv-" + i, vorher));
            vorher = "uv-" + i;
        }
        ElternKandidat eltern = new ElternKandidat(vorher, "anlage-a", "consumer", "sub-meter");
        HaengtAnUrteil u = ZaehlerbaumRegeln.haengtAnPruefen("maschine-neu", "anlage-a", "consumer", eltern, baum);
        assertThat(u.gueltig()).isTrue();
    }
}
