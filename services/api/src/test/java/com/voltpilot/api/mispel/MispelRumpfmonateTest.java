package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.MispelRumpfmonate.Aenderung;
import com.voltpilot.api.mispel.MispelRumpfmonate.Rumpfmonat;
import com.voltpilot.api.mispel.MispelRumpfmonate.Stand;
import com.voltpilot.api.mispel.MispelRumpfmonate.Teilung;
import java.nio.file.Files;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * MiSpeL MP-21: die Erkennungsfälle {@code rumpfmonate} der Vektor-Datei gegen {@link MispelRumpfmonate} — Regel L9 in
 * {@code mispel-abgrenzung.md}, im Gleichlauf mit {@code test_mispel_abgrenzung_rechenwerk.py}. Rein: ohne Spring, ohne DB.
 */
class MispelRumpfmonateTest {

    private static final JsonNode DOC;

    static {
        try {
            DOC = new ObjectMapper().readTree(Files.readString(MispelAbgrenzungVectorsTest.VECTORS));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static List<Stand> staende(JsonNode fall) {
        List<Stand> out = new ArrayList<>();
        for (JsonNode s : fall.get("staende")) {
            out.add(new Stand(LocalDate.parse(s.get("ab").asText()), text(s, "anlass"), text(s, "formelsatz"),
                    text(s, "basisfall"), texte(s.get("zaehler")), texte(s.get("werte"))));
        }
        return out;
    }

    private static String text(JsonNode n, String feld) {
        return n.hasNonNull(feld) ? n.get(feld).asText() : null;
    }

    private static Map<String, String> texte(JsonNode n) {
        Map<String, String> out = new LinkedHashMap<>();
        if (n != null) {
            n.fields().forEachRemaining(e -> out.put(e.getKey(), e.getValue().asText()));
        }
        return out;
    }

    @TestFactory
    Stream<DynamicTest> l9ErkennungsfaelleWieDieVektoren() {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : DOC.get("rumpfmonate")) {
            tests.add(DynamicTest.dynamicTest(fall.get("name").asText(), () -> {
                YearMonth monat = YearMonth.parse(fall.get("monat").asText());
                JsonNode soll = fall.get("erwartet");
                if (soll.has("ablehnung")) {
                    assertThatThrownBy(() -> MispelRumpfmonate.teilen(monat, staende(fall)))
                            .isInstanceOfSatisfying(MispelAbgrenzungAbgelehnt.class,
                                    e -> assertThat(e.code()).isEqualTo(soll.get("ablehnung").asText()));
                    return;
                }
                Teilung t = MispelRumpfmonate.teilen(monat, staende(fall));
                List<Map<String, Object>> ist = new ArrayList<>();
                for (Rumpfmonat r : t.rumpfmonate()) {
                    ist.add(Map.of("schluessel", r.schluessel(), "von", r.von().toString(), "bis", r.bis().toString(),
                            "formelsatz", r.stand().formelsatz(), "basisfall", r.stand().basisfall(),
                            "werte", r.stand().werte()));
                    assertThat(r.rumpf()).isEqualTo(r.schluessel().contains("/"));
                }
                List<Map<String, Object>> erwartet = new ArrayList<>();
                for (JsonNode r : soll.get("rumpfmonate")) {
                    erwartet.add(Map.of("schluessel", r.get("schluessel").asText(), "von", r.get("von").asText(),
                            "bis", r.get("bis").asText(), "formelsatz", r.get("formelsatz").asText(),
                            "basisfall", r.get("basisfall").asText(), "werte", texte(r.get("werte"))));
                }
                assertThat(ist).isEqualTo(erwartet);
                List<Map<String, Object>> aIst = new ArrayList<>();
                for (Aenderung a : t.aenderungen()) {
                    aIst.add(Map.of("tag", a.tag().toString(), "anlass", a.anlass(), "wirkung", a.wirkung(),
                            "bestimmungsrelevant", a.bestimmungsrelevant()));
                }
                List<Map<String, Object>> aSoll = new ArrayList<>();
                for (JsonNode a : soll.get("aenderungen")) {
                    List<String> wirkung = new ArrayList<>();
                    a.get("wirkung").forEach(w -> wirkung.add(w.asText()));
                    aSoll.add(Map.of("tag", a.get("tag").asText(), "anlass", a.get("anlass").asText(), "wirkung",
                            wirkung, "bestimmungsrelevant", a.get("bestimmungsrelevant").asBoolean()));
                }
                assertThat(aIst).isEqualTo(aSoll);
                if (fall.has("rechenfall")) {
                    rechenfallPasst(fall.get("rechenfall").asText(), t);
                }
            }));
        }
        return tests.stream();
    }

    /** Die erkannten Rumpfmonate sind genau die Zeiträume, mit denen der Rechenfall rechnet. */
    private static void rechenfallPasst(String name, Teilung t) {
        JsonNode fall = null;
        for (JsonNode f : DOC.get("faelle")) {
            if (f.get("name").asText().equals(name)) {
                fall = f;
            }
        }
        assertThat(fall).as("Rechenfall " + name).isNotNull();
        List<String> soll = new ArrayList<>();
        for (Rumpfmonat r : t.rumpfmonate()) {
            soll.add(r.schluessel() + " " + r.von().atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant() + " "
                    + r.bis().atStartOfDay(MispelAbgrenzungRechenwerk.BERLIN).toInstant());
        }
        List<String> ist = new ArrayList<>();
        for (JsonNode z : fall.get("zeitraeume")) {
            ist.add(z.get("schluessel").asText() + " " + OffsetDateTime.parse(z.get("von").asText()).toInstant() + " "
                    + OffsetDateTime.parse(z.get("bis").asText()).toInstant());
        }
        assertThat(ist).isEqualTo(soll);
    }

    @Test
    void jederAnlassAusDerFestlegungStehtImSchema() throws Exception {
        JsonNode schema = new ObjectMapper().readTree(Files.readString(
                MispelAbgrenzungVectorsTest.V2.resolve("mispel-abgrenzung.schema.json")));
        List<String> enumWerte = new ArrayList<>();
        schema.get("$defs").get("anlass").get("enum").forEach(a -> enumWerte.add(a.asText()));
        assertThat(enumWerte).containsExactlyInAnyOrderElementsOf(MispelRumpfmonate.ANLAESSE);
    }

    @Test
    void unbekannterAnlassUndDoppelterTagWerdenAbgelehnt() {
        assertThatThrownBy(() -> new Stand(LocalDate.of(2027, 6, 15), "lieferantenwechsel", null, null, null, null))
                .isInstanceOfSatisfying(MispelAbgrenzungAbgelehnt.class,
                        e -> assertThat(e.code()).isEqualTo("vorgaben_ungueltig"));
        Stand a = new Stand(LocalDate.of(2027, 6, 15), null, "A11", "A2", Map.of("Z1", "MS-01"), null);
        Stand b = new Stand(LocalDate.of(2027, 6, 15), null, "A11", "A3", Map.of("Z1", "MS-01"), null);
        assertThatThrownBy(() -> MispelRumpfmonate.teilen(YearMonth.of(2027, 6), List.of(a, b)))
                .isInstanceOfSatisfying(MispelAbgrenzungAbgelehnt.class,
                        e -> assertThat(e.code()).isEqualTo("vorgaben_ungueltig"));
    }
}
