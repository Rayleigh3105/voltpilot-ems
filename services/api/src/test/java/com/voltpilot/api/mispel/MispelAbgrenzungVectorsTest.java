package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.UemsSchemaLaeufer;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * MiSpeL MP-4: Leser der Vektor-Datei {@code docs/contracts/v2/mispel-abgrenzung-vectors.json}.
 *
 * <p>Prüft die Datei gegen ihr Schema und die Regeln L1–L8 aus {@code mispel-abgrenzung.md} — im
 * Gleichlauf mit dem Python-Leser {@code services/optimization/tests/test_mispel_abgrenzung_vectors.py}.
 * Kein Rechenwerk: die Formeln (1)–(33) rechnet erst MP-8 (Java) bzw. MP-9 (Python) gegen dieselben
 * Fälle; hier wird nur festgehalten, dass jeder Fall vollständig, zeitlich richtig zugeordnet und in
 * seinen Summen (∑M, ∑J) und Quotienten mit Nenner null in sich stimmig ist. Rein: ohne Spring, ohne DB.
 */
class MispelAbgrenzungVectorsTest {

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    static final Path VECTORS = V2.resolve("mispel-abgrenzung-vectors.json");
    private static final Path SCHEMA = V2.resolve("mispel-abgrenzung.schema.json");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final DateTimeFormatter MONAT = DateTimeFormatter.ofPattern("yyyy-MM");
    // Anlage 1 S. 33–39: A1 trägt jede Formelnummer (1) bis (33) außer (7)A4 und (8)A4.
    private static final Set<Integer> A1_NUMMERN = Set.copyOf(
            IntStream.rangeClosed(1, 33).filter(n -> n != 7 && n != 8).boxed().toList());

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    private static final JsonNode DOC = lies(VECTORS);
    private static final JsonNode SAETZE = DOC.get("formelsaetze");
    private static final Map<String, JsonNode> FORMELN = new LinkedHashMap<>();

    static {
        DOC.get("formeln").forEach(f -> FORMELN.put(f.get("nr").asText(), f));
    }

    private static JsonNode lies(Path p) {
        try {
            return MAPPER.readTree(Files.readString(p));
        } catch (Exception e) {
            throw new IllegalStateException(p.toString(), e);
        }
    }

    private static Integer nummer(String nr) {
        if (!Character.isDigit(nr.charAt(1))) {
            return null;
        }
        return Integer.valueOf(nr.substring(1, nr.indexOf(')')).replaceAll("[ab]$", ""));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<String> formeln(String satz, String ebene) {
        return texte(SAETZE.get(satz).get("formeln")).stream()
                .filter(nr -> FORMELN.get(nr).get("ebene").asText().equals(ebene))
                .toList();
    }

    private static List<String> schluessel(JsonNode objekt) {
        List<String> out = new ArrayList<>();
        objekt.fieldNames().forEachRemaining(out::add);
        return out;
    }

    private static OffsetDateTime zeit(JsonNode s) {
        return OffsetDateTime.parse(s.asText());
    }

    /** L5: Kalendermonat nach gesetzlicher Zeit, oder der Rumpfmonat, der die Viertelstunde enthält. */
    private static String zeitraum(JsonNode fall, JsonNode qh) {
        OffsetDateTime beginn = zeit(qh.get("beginn"));
        if (!fall.has("zeitraeume")) {
            return beginn.atZoneSameInstant(BERLIN).format(MONAT);
        }
        List<String> treffer = new ArrayList<>();
        for (JsonNode z : fall.get("zeitraeume")) {
            if (!beginn.isBefore(zeit(z.get("von"))) && beginn.isBefore(zeit(z.get("bis")))) {
                treffer.add(z.get("schluessel").asText());
            }
        }
        assertThat(treffer).as("%s liegt in genau einem Zeitraum", qh.get("beginn")).hasSize(1);
        return treffer.get(0);
    }

    private static String jahr(JsonNode fall, String schluessel) {
        if (!fall.has("zeitraeume")) {
            return schluessel.substring(0, 4);
        }
        for (JsonNode z : fall.get("zeitraeume")) {
            if (z.get("schluessel").asText().equals(schluessel)) {
                return String.valueOf(zeit(z.get("von")).atZoneSameInstant(BERLIN).getYear());
            }
        }
        throw new AssertionError("Zeitraum " + schluessel + " fehlt");
    }

    private static BigDecimal zahl(JsonNode n) {
        return n.decimalValue();
    }

    @Test
    void l1Schema() {
        assertThat(UemsSchemaLaeufer.verstoesse(DOC, lies(SCHEMA))).isEmpty();
    }

    @Test
    void l2Katalog() {
        assertThat(FORMELN).as("Formelnummer doppelt").hasSize(DOC.get("formeln").size());
        Set<Integer> a1 = new HashSet<>();
        texte(SAETZE.get("A1").get("formeln")).forEach(nr -> a1.add(nummer(nr)));
        assertThat(a1).isEqualTo(A1_NUMMERN);
        Set<Integer> alle = new HashSet<>();
        FORMELN.keySet().forEach(nr -> alle.add(nummer(nr)));
        DOC.get("nicht_im_umfang").forEach(f -> alle.add(nummer(f.get("nr").asText())));
        assertThat(alle).containsAll(IntStream.rangeClosed(1, 33).boxed().toList());
        Set<String> eingaenge = new HashSet<>();
        SAETZE.forEach(s -> eingaenge.addAll(texte(s.get("eingaenge"))));
        SAETZE.fieldNames().forEachRemaining(name -> {
            for (String nr : texte(SAETZE.get(name).get("formeln"))) {
                assertThat(FORMELN).as("%s: %s im Katalog", name, nr).containsKey(nr);
                assertThat(texte(FORMELN.get(nr).get("formelsaetze"))).as("%s nennt %s", nr, name).contains(name);
            }
        });
        FORMELN.forEach((nr, f) -> {
            for (String name : texte(f.get("formelsaetze"))) {
                assertThat(texte(SAETZE.get(name).get("formeln"))).as("%s führt %s", name, nr).contains(nr);
            }
            if (f.has("summe")) {
                String von = f.get("summe").get("von").asText();
                assertThat(FORMELN.containsKey(von) || eingaenge.contains(von)).as(von).isTrue();
            }
            if (f.has("quotient")) {
                assertThat(FORMELN).containsKey(f.get("quotient").get("zaehler").asText());
                assertThat(FORMELN).containsKey(f.get("quotient").get("nenner").asText());
            }
        });
    }

    @Test
    void l3NamenEindeutig() {
        List<String> namen = DOC.get("faelle").findValuesAsText("name");
        assertThat(new HashSet<>(namen)).hasSize(namen.size());
    }

    @TestFactory
    Stream<DynamicTest> faelle() {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : DOC.get("faelle")) {
            String name = fall.get("name").asText();
            tests.add(DynamicTest.dynamicTest(name + " L3 Eingänge", () -> l3Eingaenge(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L4 Raster", () -> l4Raster(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L5 Monats- und Jahresgrenzen", () -> l5Grenzen(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L6 vollständig", () -> l6Vollstaendig(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L7 Summen", () -> l7Summen(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L8 Nenner null", () -> l8NennerNull(fall)));
        }
        return tests.stream();
    }

    private static void l3Eingaenge(JsonNode fall) {
        String satzName = fall.get("formelsatz").asText();
        JsonNode satz = SAETZE.get(satzName);
        Set<String> soll = new HashSet<>(texte(satz.get("eingaenge")));
        soll.add("beginn");
        for (JsonNode qh : fall.get("viertelstunden")) {
            assertThat(new HashSet<>(schluessel(qh))).as(qh.get("beginn").asText()).isEqualTo(soll);
            if (satzName.equals("A5-Variante")) { // A1 S. 52: jederzeit übereinstimmende AW>0-Zeiten
                assertThat(zahl(qh.get("AWa¼")).signum() > 0).as(qh.get("beginn").asText())
                        .isEqualTo(zahl(qh.get("AWb¼")).signum() > 0);
            }
        }
        boolean braucht = !satz.get("stammdaten").isEmpty();
        boolean hat = fall.has("stammdaten");
        if (!hat && fall.has("zeitraeume")) {
            hat = true;
            for (JsonNode z : fall.get("zeitraeume")) {
                hat &= z.has("stammdaten");
            }
        }
        assertThat(hat).isEqualTo(braucht);
    }

    private static void l4Raster(JsonNode fall) {
        OffsetDateTime vorher = null;
        for (JsonNode qh : fall.get("viertelstunden")) {
            OffsetDateTime b = zeit(qh.get("beginn"));
            assertThat(b.getMinute() % 15).as(b.toString()).isZero();
            if (vorher != null) {
                assertThat(b).as("streng aufsteigend").isAfter(vorher);
            }
            vorher = b;
        }
        if (fall.has("zeitraeume")) {
            for (JsonNode z : fall.get("zeitraeume")) {
                assertThat(zeit(z.get("von"))).isBefore(zeit(z.get("bis")));
            }
        }
    }

    private static void l5Grenzen(JsonNode fall) {
        Set<String> monate = new LinkedHashSet<>();
        fall.get("viertelstunden").forEach(qh -> monate.add(zeitraum(fall, qh)));
        JsonNode erw = fall.get("erwartet");
        assertThat(new HashSet<>(schluessel(erw.get("monate")))).isEqualTo(monate);
        Set<String> jahre = new HashSet<>();
        monate.forEach(m -> jahre.add(jahr(fall, m)));
        assertThat(new HashSet<>(schluessel(erw.get("jahre")))).isEqualTo(jahre);
    }

    private static void l6Vollstaendig(JsonNode fall) {
        String satz = fall.get("formelsatz").asText();
        JsonNode erw = fall.get("erwartet");
        erw.get("monate").forEach(m -> assertThat(schluessel(m)).isEqualTo(formeln(satz, "monat")));
        erw.get("jahre").forEach(j -> assertThat(schluessel(j)).isEqualTo(formeln(satz, "jahr")));
        List<String> qhFormeln = formeln(satz, "viertelstunde");
        if (qhFormeln.isEmpty()) {
            assertThat(erw.has("viertelstunden")).isFalse();
            return;
        }
        List<String> soll = new ArrayList<>(List.of("beginn"));
        soll.addAll(qhFormeln);
        JsonNode eingang = fall.get("viertelstunden");
        JsonNode qhs = erw.get("viertelstunden");
        assertThat(qhs.size()).isEqualTo(eingang.size());
        for (int i = 0; i < qhs.size(); i++) {
            assertThat(qhs.get(i).get("beginn")).isEqualTo(eingang.get(i).get("beginn"));
            assertThat(schluessel(qhs.get(i))).isEqualTo(soll);
        }
    }

    private static void l7Summen(JsonNode fall) {
        JsonNode erw = fall.get("erwartet");
        Map<String, List<Map<String, JsonNode>>> jeMonat = new HashMap<>();
        JsonNode eingang = fall.get("viertelstunden");
        for (int i = 0; i < eingang.size(); i++) {
            Map<String, JsonNode> q = new HashMap<>();
            eingang.get(i).fields().forEachRemaining(e -> q.put(e.getKey(), e.getValue()));
            if (erw.has("viertelstunden")) {
                erw.get("viertelstunden").get(i).fields().forEachRemaining(e -> q.put(e.getKey(), e.getValue()));
            }
            jeMonat.computeIfAbsent(zeitraum(fall, eingang.get(i)), k -> new ArrayList<>()).add(q);
        }
        for (String nr : texte(SAETZE.get(fall.get("formelsatz").asText()).get("formeln"))) {
            JsonNode summe = FORMELN.get(nr).get("summe");
            if (summe == null) {
                continue;
            }
            String von = summe.get("von").asText();
            if (summe.get("ueber").asText().equals("M")) {
                erw.get("monate").fields().forEachRemaining(m -> {
                    BigDecimal ist = BigDecimal.ZERO;
                    for (Map<String, JsonNode> q : jeMonat.get(m.getKey())) {
                        ist = ist.add(zahl(q.get(von)));
                    }
                    assertThat(zahl(m.getValue().get(nr))).as("%s %s", m.getKey(), nr).isEqualByComparingTo(ist);
                });
            } else {
                erw.get("jahre").fields().forEachRemaining(j -> {
                    BigDecimal ist = BigDecimal.ZERO;
                    for (String m : schluessel(erw.get("monate"))) {
                        if (jahr(fall, m).equals(j.getKey())) {
                            ist = ist.add(zahl(erw.get("monate").get(m).get(von)));
                        }
                    }
                    assertThat(zahl(j.getValue().get(nr))).as("%s %s", j.getKey(), nr).isEqualByComparingTo(ist);
                });
            }
        }
    }

    private static void l8NennerNull(JsonNode fall) {
        JsonNode erw = fall.get("erwartet");
        erw.get("monate").fields().forEachRemaining(m -> m.getValue().fields().forEachRemaining(w -> {
            JsonNode q = FORMELN.get(w.getKey()).get("quotient");
            boolean nennerNull = q != null
                    && zahl(m.getValue().get(q.get("nenner").asText())).signum() == 0;
            assertThat(w.getValue().isNull()).as("%s %s", m.getKey(), w.getKey()).isEqualTo(nennerNull);
        }));
        List<JsonNode> ohneNull = new ArrayList<>();
        erw.get("jahre").forEach(ohneNull::add);
        if (erw.has("viertelstunden")) {
            erw.get("viertelstunden").forEach(ohneNull::add);
        }
        for (JsonNode werte : ohneNull) {
            werte.forEach(w -> assertThat(w.isNull()).isFalse());
        }
    }
}
