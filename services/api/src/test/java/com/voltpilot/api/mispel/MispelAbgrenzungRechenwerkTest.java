package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Ergebnis;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Viertelstunde;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Zeitraum;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.file.Files;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * MiSpeL MP-8: das Java-Rechenwerk rechnet jeden Fall von {@code docs/contracts/v2/mispel-abgrenzung-vectors.json}
 * exakt nach — jede Viertelstunde, jeden (Rumpf-)Monat, jedes Jahr, ungerundet, {@code null} genau beim Nenner null.
 * Im Gleichlauf mit dem Python-Zwilling ({@code services/optimization/tests/test_mispel_abgrenzung_rechenwerk.py}):
 * beide lesen dieselbe Datei. Rein: ohne Spring, ohne DB.
 */
class MispelAbgrenzungRechenwerkTest {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    private static final JsonNode DOC = lies();

    private static JsonNode lies() {
        try {
            return MAPPER.readTree(Files.readString(MispelAbgrenzungVectorsTest.VECTORS));
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

    /** Die Eingänge eines Falls: Zählerwerte als BigDecimal, AW¼ als „AW¼ &gt; 0“ (das wertet (24)¼ aus, A1 S. 38). */
    static List<Viertelstunde> viertelstunden(JsonNode fall) {
        List<Viertelstunde> out = new ArrayList<>();
        for (JsonNode q : fall.get("viertelstunden")) {
            Map<String, BigDecimal> z = new LinkedHashMap<>();
            Map<String, Boolean> aw = new LinkedHashMap<>();
            q.fields().forEachRemaining(e -> {
                if (e.getKey().equals("beginn")) {
                    return;
                }
                if (e.getKey().startsWith("AW")) {
                    aw.put(e.getKey(), e.getValue().decimalValue().signum() > 0);
                } else {
                    z.put(e.getKey(), e.getValue().decimalValue());
                }
            });
            out.add(new Viertelstunde(OffsetDateTime.parse(q.get("beginn").asText()), z, aw));
        }
        return out;
    }

    private static Map<String, BigDecimal> stammdaten(JsonNode s) {
        if (s == null || s.isNull()) {
            return null;
        }
        Map<String, BigDecimal> out = new LinkedHashMap<>();
        s.fields().forEachRemaining(e -> out.put(e.getKey(), e.getValue().decimalValue()));
        return out;
    }

    static Ergebnis rechne(JsonNode fall) {
        List<Zeitraum> raeume = null;
        if (fall.hasNonNull("zeitraeume")) {
            raeume = new ArrayList<>();
            for (JsonNode z : fall.get("zeitraeume")) {
                raeume.add(new Zeitraum(z.get("schluessel").asText(), OffsetDateTime.parse(z.get("von").asText()),
                        OffsetDateTime.parse(z.get("bis").asText()), stammdaten(z.get("stammdaten"))));
            }
        }
        return MispelAbgrenzungRechenwerk.rechne(fall.get("formelsatz").asText(), viertelstunden(fall),
                stammdaten(fall.get("stammdaten")), raeume, Set.of());
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
            JsonNode s = soll.get(nr);
            Bruch b = ist.get(nr);
            if (s.isNull()) {
                assertThat(b).as(wo + " " + nr + " nicht bestimmbar").isNull();
            } else {
                assertThat(b).as(wo + " " + nr).isNotNull();
                assertThat(b.compareTo(Bruch.von(s.decimalValue()))).as(wo + " " + nr + " = " + b + ", soll "
                        + s.decimalValue().toPlainString()).isZero();
            }
        }
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("faelle")
    void jederFallExakt(String name) {
        JsonNode fall = fall(name);
        JsonNode erwartet = fall.get("erwartet");
        Ergebnis e = rechne(fall);

        // A10 und A11 haben keine Viertelstundenformeln — ihre Fälle tragen dann keine Liste.
        JsonNode qh = erwartet.has("viertelstunden") ? erwartet.get("viertelstunden") : MAPPER.createArrayNode();
        assertThat(e.viertelstunden()).as(name + ": Viertelstunden").hasSize(qh.size());
        for (int i = 0; i < qh.size(); i++) {
            assertThat(e.viertelstunden().get(i).beginn().toInstant())
                    .isEqualTo(OffsetDateTime.parse(qh.get(i).get("beginn").asText()).toInstant());
            gleich(name + " Viertelstunde " + qh.get(i).get("beginn").asText(), e.viertelstunden().get(i).werte(),
                    qh.get(i));
        }
        List<String> monate = new ArrayList<>();
        erwartet.get("monate").fieldNames().forEachRemaining(monate::add);
        assertThat(e.monate().keySet()).as(name + ": (Rumpf-)Monate").containsExactlyElementsOf(monate);
        for (String m : monate) {
            gleich(name + " Monat " + m, e.monate().get(m), erwartet.get("monate").get(m));
        }
        List<String> jahre = new ArrayList<>();
        erwartet.get("jahre").fieldNames().forEachRemaining(jahre::add);
        assertThat(e.jahre().keySet()).as(name + ": Jahre").containsExactlyElementsOf(jahre);
        for (String j : jahre) {
            gleich(name + " Jahr " + j, e.jahre().get(j), erwartet.get("jahre").get(j));
        }
    }

    @Test
    void alleEinundzwanzigFaelleLaufen() {
        assertThat(faelle().count()).isEqualTo(21);
        assertThat(faelle().map(n -> fall(n).get("formelsatz").asText()).distinct())
                .containsExactlyInAnyOrderElementsOf(MispelAbgrenzungRechenwerk.FORMELSAETZE);
    }

    /** MP-32: 20 kWh geladen, 30 kWh zurückgespeist → 10 kWh Fremdtankstrom (A1 S. 16, Formeln (12)/(13) S. 35). */
    @Test
    void fremdtankstromPruefnachweis() {
        Map<String, Bruch> m = rechne(fall("a2-fremdtankstrom-20-geladen-30-rueckgespeist")).monate().get("2027-04");
        assertThat(m.get("(5)")).isEqualTo(Bruch.von(20));
        assertThat(m.get("(6)")).isEqualTo(Bruch.von(30));
        assertThat(m.get("(12)")).isEqualTo(Bruch.von(10));
        assertThat(m.get("(13)")).isEqualTo(m.get("(11)").minus(m.get("(12)")));
        assertThat(m.get("(14)A2,A3,A4")).isEqualTo(Bruch.von(new BigDecimal("0.85")));
        assertThat(m.get("(19)A2,A3")).isEqualTo(Bruch.NULL);
        assertThat(m).doesNotContainKeys("(14)A1", "(17)A1", "(18)", "(19)A1,A4");
    }

    /** A1 S. 30: A3 ergibt eine geringere umlagereduzierende Strommenge als A4 — genau um (19)A1,A4. */
    @Test
    void a3HoechstensSovielWieA4() {
        Map<String, Bruch> a3 = rechne(fall("a3-speicher-und-ladepunkt-ohne-verlustprivileg")).monate().get("2027-06");
        Map<String, Bruch> a4 = rechne(fall("a4-gesonderte-messung-speicherverluste")).monate().get("2027-06");
        assertThat(a4.get("(20)").minus(a3.get("(20)"))).isEqualTo(a4.get("(19)A1,A4"));
        assertThat(a4.get("(19)A1,A4").signum()).isPositive();
        assertThat(MispelAbgrenzungRechenwerk.zaehlerEingaenge("A4")).contains("Z3V¼", "Z3E¼");
        assertThat(MispelAbgrenzungRechenwerk.summen("A4")).contains("(7)A4", "(8)A4");
    }

    @Test
    void unbekanntIstKeineNullUndNegativGibtEsNicht() {
        OffsetDateTime t = OffsetDateTime.parse("2027-03-10T12:00:00+01:00");
        Map<String, BigDecimal> z = new LinkedHashMap<>(Map.of("Z1NB¼", BigDecimal.ONE));
        assertThatThrownBy(() -> MispelAbgrenzungRechenwerk.rechne("A10",
                List.of(new Viertelstunde(t, z, Map.of())), null, null, Set.of()))
                .hasMessageContaining("Z1NE¼: kein Wert — unbekannt ist keine Null");
        z.put("Z1NE¼", new BigDecimal("-0.5"));
        assertThatThrownBy(() -> MispelAbgrenzungRechenwerk.rechne("A10",
                List.of(new Viertelstunde(t, z, Map.of())), null, null, Set.of()))
                .hasMessageContaining("nie negativ (A1 S. 32)");
    }

    @Test
    void a5VarianteNurBeiGleichenAwZeiten() {
        Viertelstunde q = new Viertelstunde(OffsetDateTime.parse("2027-03-10T12:00:00+01:00"),
                Map.of("Z1NB¼", BigDecimal.ZERO, "Z1NE¼", BigDecimal.TEN, "Z2V¼", BigDecimal.ZERO, "Z2E¼", BigDecimal.ZERO),
                Map.of("AWa¼", true, "AWb¼", false));
        assertThatThrownBy(() -> MispelAbgrenzungRechenwerk.rechne("A5-Variante", List.of(q),
                Map.of("Painst", BigDecimal.ONE, "Pbinst", BigDecimal.ONE), null, Set.of()))
                .hasMessageContaining("A1 S. 52");
    }

    @Test
    void einDrittelBleibtEinDrittel() {
        Bruch drittel = new Bruch(BigInteger.ONE, BigInteger.valueOf(3));
        assertThat(drittel.text()).isEqualTo("1/3");
        assertThat(drittel.alsDezimal()).isNull();
        assertThat(Bruch.von(new BigDecimal("0.750")).text()).isEqualTo("0.75");
        assertThat(drittel.plus(drittel).plus(drittel)).isEqualTo(Bruch.EINS);
    }
}
