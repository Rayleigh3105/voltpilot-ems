package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Die Abhängigkeits-Regel G4 (UEMS AP-17 IP-11a) und die Sätze des Variablen-Vorschlags gegen
 * {@code docs/contracts/v2/variablen-vorschlag-vectors.json}. Der TS-Zwilling
 * {@code frontend/portal/src/variablenAbhaengigkeit.test.ts} fährt dieselbe Datei. Rein — kein Testcontainers.
 */
class VariablenAbhaengigkeitVectorsTest {

    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "variablen-vorschlag-vectors.json");

    private static JsonNode vektoren() throws Exception {
        return new ObjectMapper().readTree(Files.readString(VECTORS));
    }

    private static List<String> texte(JsonNode array) {
        List<String> aus = new ArrayList<>();
        array.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    @TestFactory
    List<DynamicTest> jederFall() throws Exception {
        List<DynamicTest> aus = new ArrayList<>();
        for (JsonNode f : vektoren().path("faelle")) {
            aus.add(DynamicTest.dynamicTest(f.path("name").asText(), () -> {
                List<VariablenAbhaengigkeit.Paar> paare = new ArrayList<>();
                for (int i = 0; i < f.path("x").size(); i++) {
                    paare.add(new VariablenAbhaengigkeit.Paar(f.path("x").get(i).decimalValue(),
                            f.path("y").get(i).decimalValue()));
                }
                VariablenAbhaengigkeit.Ergebnis e = VariablenAbhaengigkeit.pruefe(paare);
                assertThat(e.ergebnis()).isEqualTo(f.path("ergebnis").asText());
                assertThat(e.paare()).isEqualTo(f.path("paare").asInt());
                assertThat(e.grund()).isEqualTo(f.path("grund").isNull() ? null : f.path("grund").asText());
                if (f.path("r").isNull()) {
                    assertThat(e.r()).isNull();
                } else {
                    assertThat(e.r()).isCloseTo(f.path("r").asDouble(), org.assertj.core.data.Offset.offset(1e-12));
                    assertThat(VariablenAbhaengigkeit.rText(e.r())).isEqualTo(f.path("r_text").asText());
                }
                if (f.has("satz")) {
                    assertThat(VariablenAbhaengigkeit.abhaengigSatz(f.path("kandidat").asText(),
                            f.path("variable_1").asText(), e.r())).isEqualTo(f.path("satz").asText());
                }
            }));
        }
        return aus;
    }

    @Test
    void schwelleVokabularUndSaetzeSindDieDerDatei() throws Exception {
        JsonNode v = vektoren();
        assertThat(VariablenAbhaengigkeit.SCHWELLE).isEqualByComparingTo(v.path("schwelle").decimalValue());
        assertThat(VariablenAbhaengigkeit.MINDEST_PAARE).isEqualTo(v.path("mindest_paare").asInt());
        assertThat(VariablenAbhaengigkeit.ERGEBNISSE).containsExactlyElementsOf(texte(v.path("ergebnisse")));
        assertThat(VariablenAbhaengigkeit.GRUENDE).containsExactlyElementsOf(texte(v.path("gruende")));
        assertThat(VariablenVorschlag.VORSCHLAEGE).containsExactlyElementsOf(texte(v.path("vorschlaege")));
        assertThat(VariablenVorschlag.BEZUEGE).containsExactlyElementsOf(texte(v.path("bezuege")));
        JsonNode s = v.path("saetze");
        assertThat(VariablenVorschlag.OHNE_ZAHL).isEqualTo(s.path("ohne_zahl").asText());
        assertThat(VariablenVorschlag.KEIN_EINSATZ).isEqualTo(s.path("kein_einsatz").asText());
        assertThat(VariablenVorschlag.STATISCHER_FAKTOR).isEqualTo(s.path("statischer_faktor").asText());
        assertThat(VariablenAbhaengigkeit.abhaengigSatz("{kandidat}", "{variable_1}", 0.5).replace("0,500", "{r}"))
                .isEqualTo(s.path("abhaengig").asText());
    }

    /** Die Monatspaare nehmen nur Monate, in denen BEIDE einen Wert haben — nie ergänzt. */
    @Test
    void paareNurAusMonatenMitBeidenWerten() {
        java.util.Map<String, BigDecimal> x = new java.util.LinkedHashMap<>();
        java.util.Map<String, BigDecimal> y = new java.util.LinkedHashMap<>();
        x.put("2026-11", new BigDecimal("318000"));
        x.put("2026-12", null);
        x.put("2027-01", new BigDecimal("298000"));
        y.put("2026-11", new BigDecimal("5112"));
        y.put("2026-12", new BigDecimal("4149"));
        assertThat(VariablenVorschlag.paare(x, y))
                .containsExactly(new VariablenAbhaengigkeit.Paar(new BigDecimal("318000"), new BigDecimal("5112")));
    }

    @Test
    void referenzperiodeStrengGelesen() {
        java.time.YearMonth laufend = java.time.YearMonth.of(2027, 11);
        assertThat(VariablenVorschlag.referenzperiode(null, laufend))
                .containsExactly(java.time.YearMonth.of(2026, 11), java.time.YearMonth.of(2027, 10));
        assertThat(VariablenVorschlag.referenzperiode("2026-11/2027-10", laufend))
                .containsExactly(java.time.YearMonth.of(2026, 11), java.time.YearMonth.of(2027, 10));
        for (String falsch : List.of("2027-10/2026-11", "2026-13/2027-01", "2026-11", "2016-01/2026-01", "26-11/27-10")) {
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> VariablenVorschlag.referenzperiode(falsch, laufend))
                    .as(falsch).isInstanceOf(KennzahlAbgelehnt.class);
        }
    }
}
