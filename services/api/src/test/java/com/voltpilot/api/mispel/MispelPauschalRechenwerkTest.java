package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.MispelPauschalRechenwerk.Ergebnis;
import com.voltpilot.api.mispel.MispelPauschalRechenwerk.Rumpfjahr;
import com.voltpilot.api.mispel.MispelPauschalRechenwerk.Viertelstunde;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.file.Files;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * MiSpeL MP-25: das Java-Rechenwerk rechnet jeden Fall von {@code docs/contracts/v2/mispel-pauschal-vectors.json} exakt
 * nach — jede Viertelstunde, jedes (Rumpf-)Jahr, ungerundet, in Katalog-Reihenfolge — und alle 49 Zellen der Tabellen 1
 * und 2 (A2 S. 12). Im Gleichlauf mit dem Python-Zwilling ({@code services/optimization/tests/
 * test_mispel_pauschal_rechenwerk.py}): beide lesen dieselbe Datei. Rein: ohne Spring, ohne DB.
 */
class MispelPauschalRechenwerkTest {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    private static final JsonNode DOC = lies();

    private static JsonNode lies() {
        try {
            return MAPPER.readTree(Files.readString(MispelPauschalVectorsTest.VECTORS));
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static Stream<String> faelle() {
        List<String> namen = new ArrayList<>();
        DOC.get("faelle").forEach(f -> namen.add(f.get("name").asText()));
        return namen.stream();
    }

    private static JsonNode fall(String name) {
        for (JsonNode f : DOC.get("faelle")) {
            if (f.get("name").asText().equals(name)) {
                return f;
            }
        }
        throw new IllegalArgumentException(name);
    }

    static Bruch exakt(JsonNode w) {
        if (!w.isTextual()) {
            return Bruch.von(w.decimalValue());
        }
        String[] teile = w.asText().split("/");
        return new Bruch(new BigInteger(teile[0]), new BigInteger(teile[1]));
    }

    /** Die Eingänge eines Falls: Zählerwerte als BigDecimal, AW¼ als „AW¼ &gt; 0“ (das wertet (P12)¼ aus), SP¼ als Preis. */
    static List<Viertelstunde> viertelstunden(JsonNode fall) {
        List<Viertelstunde> out = new ArrayList<>();
        for (JsonNode q : fall.get("viertelstunden")) {
            Map<String, BigDecimal> z = new LinkedHashMap<>();
            Map<String, Boolean> aw = new LinkedHashMap<>();
            q.fields().forEachRemaining(e -> {
                if (e.getKey().startsWith("AW")) {
                    aw.put(e.getKey(), e.getValue().decimalValue().signum() > 0);
                } else if (e.getKey().startsWith("Z")) {
                    z.put(e.getKey(), e.getValue().decimalValue());
                }
            });
            out.add(new Viertelstunde(OffsetDateTime.parse(q.get("beginn").asText()), z, aw,
                    q.get("SP¼").decimalValue()));
        }
        return out;
    }

    static Map<String, BigDecimal> stammdaten(JsonNode s) {
        if (s == null || s.isNull()) {
            return null;
        }
        Map<String, BigDecimal> out = new LinkedHashMap<>();
        s.fields().forEachRemaining(e -> out.put(e.getKey(), e.getValue().decimalValue()));
        return out;
    }

    static Set<String> ungefoerdert(JsonNode fall) {
        Set<String> out = new LinkedHashSet<>();
        if (fall.has("ungefoerdert")) {
            fall.get("ungefoerdert").forEach(u -> out.add(u.asText()));
        }
        return out;
    }

    static Ergebnis rechne(JsonNode fall) {
        List<Rumpfjahr> rumpfjahre = null;
        if (fall.hasNonNull("rumpfjahre")) {
            rumpfjahre = new ArrayList<>();
            for (JsonNode r : fall.get("rumpfjahre")) {
                rumpfjahre.add(new Rumpfjahr(LocalDate.parse(r.get("von").asText()), LocalDate.parse(r.get("bis").asText()),
                        stammdaten(r.get("stammdaten"))));
            }
        }
        return MispelPauschalRechenwerk.rechne(fall.get("formelsatz").asText(), viertelstunden(fall),
                stammdaten(fall.get("stammdaten")), rumpfjahre, ungefoerdert(fall));
    }

    private static void gleich(String wo, Map<String, Bruch> ist, JsonNode soll) {
        List<String> nummern = new ArrayList<>();
        soll.fieldNames().forEachRemaining(n -> {
            if (!n.equals("beginn")) {
                nummern.add(n);
            }
        });
        assertThat(ist.keySet()).as(wo + ": Formeln in Katalog-Reihenfolge").containsExactlyElementsOf(nummern);
        for (String nr : nummern) {
            Bruch b = ist.get(nr);
            assertThat(b).as(wo + " " + nr).isNotNull();
            assertThat(b.compareTo(exakt(soll.get(nr)))).as(wo + " " + nr + " = " + b + ", soll " + soll.get(nr))
                    .isZero();
        }
    }

    @Test
    void vierzehnFaelle() {
        assertThat(faelle()).hasSize(14);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("faelle")
    void jederFallExakt(String name) {
        JsonNode fall = fall(name);
        JsonNode erwartet = fall.get("erwartet");
        Ergebnis e = rechne(fall);
        assertThat(e.viertelstunden()).hasSize(erwartet.get("viertelstunden").size());
        for (int i = 0; i < e.viertelstunden().size(); i++) {
            JsonNode s = erwartet.get("viertelstunden").get(i);
            assertThat(e.viertelstunden().get(i).beginn()).isEqualTo(OffsetDateTime.parse(s.get("beginn").asText()));
            gleich(name + " " + s.get("beginn").asText(), e.viertelstunden().get(i).werte(), s);
        }
        List<String> jahre = new ArrayList<>();
        erwartet.get("jahre").fieldNames().forEachRemaining(jahre::add);
        assertThat(e.jahre().keySet()).as(name + ": Jahre").containsExactlyElementsOf(jahre);
        for (String j : jahre) {
            gleich(name + " " + j, e.jahre().get(j), erwartet.get("jahre").get(j));
        }
    }

    /** Der Katalog im Code ist der Katalog der Datei: Eingänge, Stammdaten, Formeln je Ebene in Katalog-Folge, ∑J. */
    @Test
    void katalogWieVektoren() {
        Map<String, JsonNode> katalog = new HashMap<>();
        DOC.get("formeln").forEach(f -> katalog.put(f.get("nr").asText(), f));
        List<String> saetze = new ArrayList<>();
        DOC.get("formelsaetze").fieldNames().forEachRemaining(saetze::add);
        assertThat(MispelPauschalRechenwerk.FORMELSAETZE).containsExactlyElementsOf(saetze);
        for (String fs : saetze) {
            JsonNode satz = DOC.get("formelsaetze").get(fs);
            assertThat(MispelPauschalRechenwerk.eingaenge(fs)).as(fs).containsExactlyElementsOf(texte(satz.get("eingaenge")));
            assertThat(MispelPauschalRechenwerk.stammdaten(fs)).as(fs)
                    .containsExactlyElementsOf(texte(satz.get("stammdaten")));
            for (String ebene : List.of("viertelstunde", "jahr", "rumpfjahr")) {
                List<String> soll = texte(satz.get("formeln")).stream()
                        .filter(nr -> katalog.get(nr).get("ebene").asText().equals(ebene)).toList();
                assertThat(MispelPauschalRechenwerk.formeln(fs, ebene)).as(fs + " " + ebene).containsExactlyElementsOf(soll);
            }
            MispelPauschalRechenwerk.summen(fs).forEach((nr, von) -> {
                JsonNode quelle = katalog.get(von);
                String ersetzt = quelle == null || !quelle.has("ersetzt") ? von : quelle.get("ersetzt").asText();
                assertThat(katalog.get(nr).get("summe").get("von").asText()).as(fs + " " + nr).isEqualTo(ersetzt);
            });
        }
    }

    private static List<String> texte(JsonNode a) {
        List<String> out = new ArrayList<>();
        a.forEach(x -> out.add(x.asText()));
        return out;
    }

    @Test
    void tabellenEinsUndZwei() {
        assertThat(DOC.get("pauschalgrenzen")).hasSize(49);
        for (JsonNode z : DOC.get("pauschalgrenzen")) {
            String fs = z.get("formelsatz").asText();
            Map<String, Bruch> leer = new LinkedHashMap<>();
            MispelPauschalRechenwerk.summen(fs).keySet().forEach(nr -> leer.put(nr, Bruch.NULL));
            Map<String, Bruch> j = MispelPauschalRechenwerk.jahr(fs, leer, stammdaten(z.get("stammdaten")), null);
            z.get("erwartet").fields().forEachRemaining(e -> assertThat(j.get(e.getKey()).compareTo(exakt(e.getValue())))
                    .as(z.get("name").asText() + " " + e.getKey()).isZero());
        }
    }

    // ------------------------------------------------------------------ Rumpfjahre tagesscharf

    @ParameterizedTest(name = "{0} bis {1}: {2} Sommertage")
    @CsvSource({"2028-01-01,2028-03-31,0", "2028-03-31,2028-04-01,1", "2028-04-01,2028-09-30,183",
            "2028-09-30,2028-10-01,1", "2027-05-17,2027-12-31,137", "2027-01-01,2027-05-16,46",
            "2027-01-01,2027-12-31,183", "2027-10-01,2027-12-31,0"})
    void sommertage(String von, String bis, int tage) {
        assertThat(MispelPauschalRechenwerk.sommertage(LocalDate.parse(von), LocalDate.parse(bis))).isEqualTo(tage);
    }

    /** Gleiche Stammdaten in allen Rumpfjahren: ∑ (P1)R = (P1) und ∑ (P3)R = (P3) — tagesscharf, ohne Rest. */
    @ParameterizedTest(name = "{0}")
    @CsvSource({"2027-05-16", "2028-03-31", "2028-07-04", "2028-09-30", "2028-12-30"})
    void rumpfjahreTeilenDieGrenzenOhneRest(String aenderung) {
        LocalDate tag = LocalDate.parse(aenderung);
        Map<String, BigDecimal> s = Map.of("Pinst", BigDecimal.valueOf(8), "SKinst", BigDecimal.TEN);
        Map<String, Bruch> leer = Map.of("(P7)", Bruch.NULL, "(P9)", Bruch.NULL, "(P14)", Bruch.NULL);
        Bruch p1 = Bruch.NULL;
        Bruch p3 = Bruch.NULL;
        for (Rumpfjahr r : List.of(new Rumpfjahr(LocalDate.of(tag.getYear(), 1, 1), tag, s),
                new Rumpfjahr(tag.plusDays(1), LocalDate.of(tag.getYear(), 12, 31), s))) {
            Map<String, Bruch> j = MispelPauschalRechenwerk.jahr("P1", leer, s, r);
            p1 = p1.plus(j.get("(P1)R"));
            p3 = p3.plus(j.get("(P3)R"));
        }
        assertThat(p1.text()).isEqualTo("4000");
        assertThat(p3.text()).isEqualTo("320");
    }

    // ------------------------------------------------------------------ Eingangsprüfungen

    private static final Map<String, BigDecimal> P1 = Map.of("Pinst", BigDecimal.valueOf(8), "SKinst", BigDecimal.TEN);

    private static Viertelstunde qh(Map<String, BigDecimal> z, Map<String, Boolean> aw, BigDecimal sp) {
        return new Viertelstunde(OffsetDateTime.parse("2027-06-01T12:00:00+02:00"), z, aw, sp);
    }

    private static final Map<String, BigDecimal> Z = Map.of("Z1NB¼", BigDecimal.ONE, "Z1NE¼", BigDecimal.TWO);

    @Test
    void negativerSpotpreisIstKeinFehler() {
        Ergebnis e = MispelPauschalRechenwerk.rechne("P1", List.of(qh(Z, Map.of("AW¼", true), BigDecimal.valueOf(-1))),
                P1, null, Set.of());
        assertThat(e.viertelstunden().get(0).werte().get("(P5)¼").text()).isEqualTo("0");
        assertThat(e.viertelstunden().get(0).werte().get("(P13)¼").text()).isEqualTo("2");
    }

    @Test
    void unbekanntIstKeineNull() {
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1",
                List.of(qh(Map.of("Z1NB¼", BigDecimal.ONE), Map.of("AW¼", true), BigDecimal.ONE)), P1, null, Set.of()))
                .hasMessageContaining("Z1NE¼: kein Wert — unbekannt ist keine Null");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(qh(Z, Map.of(), BigDecimal.ONE)), P1,
                null, Set.of())).hasMessageContaining("AW¼: kein Wert");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(qh(Z, Map.of("AW¼", true), null)), P1,
                null, Set.of())).hasMessageContaining("SP¼: kein Wert");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(qh(Map.of("Z1NB¼", BigDecimal.ONE,
                "Z1NE¼", BigDecimal.valueOf(-1)), Map.of("AW¼", true), BigDecimal.ONE)), P1, null, Set.of()))
                .hasMessageContaining("nie negativ");
    }

    @Test
    void stammdatenGeprueft() {
        assertThatThrownBy(() -> MispelPauschalRechenwerk.stammdatenPruefen("P1",
                Map.of("Pinst", BigDecimal.ONE, "SKinst", BigDecimal.ZERO))).hasMessageContaining("SKinst = 0");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.stammdatenPruefen("P2", P1))
                .hasMessageContaining("kennt die Stammdaten [SKinst]");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.stammdatenPruefen("P4", Map.of("Pinst", BigDecimal.valueOf(9),
                "SKinst", BigDecimal.TEN, "Painst", BigDecimal.valueOf(8), "Pbinst", new BigDecimal("0.8"))))
                .hasMessageContaining("Painst + Pbinst");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.stammdatenPruefen("A1", P1))
                .hasMessageContaining("nicht im Umfang");
    }

    @Test
    void p4VarianteNurBeiUebereinstimmendenAwZeiten() {
        Map<String, BigDecimal> s = Map.of("Pinst", BigDecimal.TEN, "SKinst", BigDecimal.TEN, "Painst",
                BigDecimal.valueOf(8), "Pbinst", BigDecimal.TWO);
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P4-Variante",
                List.of(qh(Z, Map.of("AWa¼", true, "AWb¼", false), BigDecimal.ONE)), s, null, Set.of()))
                .hasMessageContaining("übereinstimmende AW>0-Zeiten");
    }

    @Test
    void rumpfjahreGeprueft() {
        Rumpfjahr r = new Rumpfjahr(LocalDate.of(2027, 1, 1), LocalDate.of(2027, 5, 31), P1);
        Viertelstunde q = qh(Z, Map.of("AW¼", true), BigDecimal.ONE);
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(q), null, List.of(r), Set.of()))
                .hasMessageContaining("liegt in keinem Rumpfjahr");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(q), null, List.of(r,
                new Rumpfjahr(LocalDate.of(2027, 5, 31), LocalDate.of(2027, 12, 31), P1)), Set.of()))
                .hasMessageContaining("überlappen");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(q), null, List.of(
                new Rumpfjahr(LocalDate.of(2027, 6, 1), LocalDate.of(2028, 1, 31), P1)), Set.of()))
                .hasMessageContaining("einem Kalenderjahr");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(q), P1, List.of(r), Set.of()))
                .hasMessageContaining("nicht beides");
    }

    // ------------------------------------------------------------------ Abwandlungen zu P2 und P3

    /** Regel abwandlungen (A2 S. 34, S. 43, S. 49): Saldierungsseite des Basisfalls, Förderseite von P4. */
    @ParameterizedTest(name = "P4 in Abwandlung zu {0}")
    @CsvSource({"P1,(P2)P1", "P2,(P2)P2", "P3,(P2)P1 (P2)P2 (P2)P3"})
    void p4InAbwandlungMitDerRechengroesseDesBasisfalls(String basisfall, String groessen) {
        Map<String, BigDecimal> s = new LinkedHashMap<>(Map.of("Pinst", BigDecimal.valueOf(8), "SKinst", BigDecimal.TEN,
                "Painst", BigDecimal.valueOf(6), "Pbinst", BigDecimal.TWO));
        if (basisfall.equals("P2")) {
            s.remove("SKinst");
        }
        Map<String, BigDecimal> z = Map.of("Z1NB¼", BigDecimal.valueOf(1500), "Z1NE¼", BigDecimal.valueOf(6000));
        Map<String, Bruch> j = MispelPauschalRechenwerk.rechne("P4", List.of(qh(z, Map.of("AWa¼", true, "AWb¼", true),
                BigDecimal.valueOf(3))), s, null, Set.of(), basisfall).jahre().get("2027");
        assertThat(j.keySet().stream().filter(nr -> nr.startsWith("(P2)")).toList())
                .containsExactly(groessen.split(" "));
        Map<String, BigDecimal> sb = new LinkedHashMap<>(s);
        sb.keySet().retainAll(MispelPauschalRechenwerk.stammdaten(basisfall));
        Map<String, Bruch> basis = MispelPauschalRechenwerk.rechne(basisfall, List.of(qh(z, Map.of("AW¼", true),
                BigDecimal.valueOf(3))), sb, null, Set.of()).jahre().get("2027");
        for (String nr : List.of("(P1)", "(P3)", "(P4)", "(P7)", "(P8)", "(P9)", "(P10)", "(P11)")) {
            assertThat(j.get(nr).compareTo(basis.get(nr))).as(nr).isZero();
        }
        assertThat(j.get("(P16a)").plus(j.get("(P16b)")).compareTo(basis.get("(P15)"))).isZero();
    }

    @Test
    void basisfallNurFuerAbwandlungen() {
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(), P1, null, Set.of(), "P2"))
                .hasMessageContaining("Abwandlung");
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P5", List.of(), P1, null, Set.of(), "P4"))
                .hasMessageContaining("Abwandlung");
    }

    @Test
    void ungefoerdertNurAwEingaengeDesFormelsatzes() {
        assertThatThrownBy(() -> MispelPauschalRechenwerk.rechne("P1", List.of(qh(Z, Map.of("AW¼", true),
                BigDecimal.ONE)), P1, null, Set.of("AWb¼"))).hasMessageContaining("ungefördert");
    }
}
