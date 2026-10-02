package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.FoerderwegRegeln.Ablehnung;
import com.voltpilot.api.mispel.FoerderwegRegeln.Angaben;
import com.voltpilot.api.mispel.FoerderwegRegeln.Antrag;
import com.voltpilot.api.mispel.FoerderwegRegeln.Foerderweg;
import com.voltpilot.api.mispel.FoerderwegRegeln.Vorher;
import com.voltpilot.api.repo.MispelMarktdatenRepository;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Die reinen Regeln des Förderwegs (MiSpeL MP-5) gegen {@code docs/contracts/v2/mispel-foerderweg-vectors.json} —
 * ohne Spring und Datenbank. Die Formelsätze stehen zusätzlich gegen den Vertrag MP-4.
 */
class FoerderwegRegelnTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode vektoren() throws Exception {
        return JSON.readTree(V2.resolve("mispel-foerderweg-vectors.json").toFile());
    }

    @Test
    void dieFuenfWerteStehenWieImVertrag() throws Exception {
        JsonNode werte = vektoren().get("werte");
        assertThat(werte).hasSize(Foerderweg.values().length);
        for (JsonNode w : werte) {
            Foerderweg f = Foerderweg.von(w.get("wert").asText()).orElseThrow();
            assertThat(f.begriff()).as(f.wert()).isEqualTo(w.get("begriff").asText());
            assertThat(f.netzladenMoeglich()).as(f.wert()).isEqualTo(w.get("netzladen_moeglich").asBoolean());
            assertThat(f.plantKind()).as(f.wert()).isEqualTo(w.get("plant_kind").isNull() ? null
                    : w.get("plant_kind").asText());
            assertThat(f.rechtsgrundlage()).as(f.wert()).isNotBlank();
        }
    }

    @Test
    void dieFormelsaetzeSindDieDesVertragsMp4() throws Exception {
        JsonNode v = vektoren();
        List<String> hier = new ArrayList<>();
        v.get("formelsaetze").forEach(n -> hier.add(n.asText()));
        List<String> mp4 = new ArrayList<>();
        JSON.readTree(V2.resolve("mispel-abgrenzung-vectors.json").toFile()).get("formelsaetze").fieldNames()
                .forEachRemaining(mp4::add);
        assertThat(FoerderwegRegeln.FORMELSAETZE).containsExactlyElementsOf(hier).containsExactlyInAnyOrderElementsOf(mp4);
        Map<String, List<String>> paare = new LinkedHashMap<>();
        v.get("vereinfacht_statt").fields().forEachRemaining(e -> {
            List<String> statt = new ArrayList<>();
            e.getValue().forEach(n -> statt.add(n.asText()));
            paare.put(e.getKey(), statt);
        });
        assertThat(FoerderwegRegeln.VEREINFACHT_STATT).isEqualTo(paare);
    }

    @Test
    void dieAwRegelnSindDieDerUenbVeroeffentlichungen() throws Exception {
        List<String> hier = new ArrayList<>();
        vektoren().get("aw_regeln").forEach(n -> hier.add(n.get("wert").asText()));
        assertThat(FoerderwegRegeln.AW_REGELN).containsExactlyElementsOf(hier)
                .containsExactlyInAnyOrderElementsOf(MispelMarktdatenRepository.REGELN);
    }

    @Test
    void derBestandFolgtDenHeutigenSchaltern() throws Exception {
        for (JsonNode b : vektoren().get("bestand")) {
            Angaben a = FoerderwegRegeln.ausBestand(b.get("netzladen_erlaubt").asBoolean(), b.get("plant_kind").asText());
            assertThat(a.foerderweg().wert()).as(b.toString()).isEqualTo(b.get("foerderweg").asText());
            assertThat(a.formelsatz()).isNull();
            assertThat(a.awRegel()).isNull();
            // Bitgenau: der Spiegel des Bestands-Förderwegs ist der Schalter, der ihn ergab.
            assertThat(FoerderwegRegeln.netzladenNachher(a.foerderweg(), null, b.get("netzladen_erlaubt").asBoolean()))
                    .isEqualTo(b.get("netzladen_erlaubt").asBoolean());
            String pk = a.foerderweg().plantKind() != null ? a.foerderweg().plantKind() : b.get("plant_kind").asText();
            assertThat(pk).isEqualTo(b.get("plant_kind").asText());
        }
    }

    @Test
    void netzladenNachDerNeuenFassung() throws Exception {
        for (JsonNode n : vektoren().get("netzladen_nachher")) {
            Foerderweg f = Foerderweg.von(n.get("foerderweg").asText()).orElseThrow();
            Boolean angabe = n.get("angabe").isNull() ? null : n.get("angabe").asBoolean();
            assertThat(FoerderwegRegeln.netzladenNachher(f, angabe, n.get("bisher").asBoolean())).as(n.toString())
                    .isEqualTo(n.get("nachher").asBoolean());
        }
    }

    @Test
    void dieBindungEndetAmJahresende() {
        assertThat(FoerderwegRegeln.gebundenBis("A10", LocalDate.of(2026, 11, 3))).isEqualTo(LocalDate.of(2026, 12, 31));
        assertThat(FoerderwegRegeln.gebundenBis(null, LocalDate.of(2026, 11, 3))).isNull();
        assertThat(FoerderwegRegeln.wahlPaar("A1", "A11")).isTrue();
        assertThat(FoerderwegRegeln.wahlPaar("A10", "A11")).isFalse();
        assertThat(FoerderwegRegeln.wahlPaar("A1", "A5")).isFalse();
        assertThat(FoerderwegRegeln.wahlPaar("A4", "A3")).isTrue();
        assertThat(FoerderwegRegeln.wahlPaar("A2", "A11")).isTrue();
        assertThat(FoerderwegRegeln.wahlPaar("A2", "A3")).isFalse();
        assertThat(FoerderwegRegeln.wahlPaar("A2", "A10")).isFalse();
    }

    @TestFactory
    List<DynamicTest> jederFallUrteiltWieImVertrag() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode f : vektoren().get("faelle")) {
            tests.add(DynamicTest.dynamicTest(f.get("name").asText(), () -> {
                JsonNode v = f.get("vorher");
                JsonNode a = f.get("antrag");
                Vorher vorher = new Vorher(new Angaben(weg(v), text(v, "formelsatz"), v.get("einverstaendnis").asBoolean(),
                        text(v, "aw_regel")), v.get("bestand").asBoolean(), tag(v, "letzte_fassung_ab"));
                Antrag antrag = new Antrag(new Angaben(weg(a), text(a, "formelsatz"), a.get("einverstaendnis").asBoolean(),
                        text(a, "aw_regel")),
                        tag(a, "gueltig_ab"), a.get("netzladen").isNull() ? null : a.get("netzladen").asBoolean(),
                        a.get("erstmalige_zuordnung").asBoolean(), a.get("messkonzept_geaendert").asBoolean());
                Ablehnung urteil = FoerderwegRegeln.pruefen(antrag, vorher, tag(f, "heute"), tag(f, "pauschaloption_ab"));
                String erwartet = text(f, "erwartet");
                assertThat(urteil == null ? null : urteil.code()).as(f.get("zeigt").asText()).isEqualTo(erwartet);
                if (urteil != null) {
                    assertThat(urteil.fakten()).containsKey("fundstelle");
                    assertThat(Arrays.asList(400, 409, 422)).contains(urteil.status());
                }
            }));
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(20);
        return tests;
    }

    private static Foerderweg weg(JsonNode n) {
        return Foerderweg.von(n.get("foerderweg").asText()).orElseThrow();
    }

    private static String text(JsonNode n, String feld) {
        return n.get(feld) == null || n.get(feld).isNull() ? null : n.get(feld).asText();
    }

    private static LocalDate tag(JsonNode n, String feld) {
        String t = text(n, feld);
        return t == null ? null : LocalDate.parse(t);
    }
}
