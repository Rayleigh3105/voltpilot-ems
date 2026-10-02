package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.UemsSchemaLaeufer;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * MiSpeL MP-24: Leser der Vektor-Datei {@code docs/contracts/v2/mispel-pauschal-vectors.json}.
 *
 * <p>Prüft die Datei gegen ihr Schema und die Regeln L1–L10 aus {@code mispel-pauschal.md} — im
 * Gleichlauf mit dem Python-Leser {@code services/optimization/tests/test_mispel_pauschal_vectors.py}.
 * Kein Rechenwerk: die Formeln (P1)–(P22)R rechnet erst MP-25 gegen dieselben Fälle; hier wird nur
 * festgehalten, dass jeder Fall vollständig, zeitlich richtig zugeordnet, in seinen Summen (∑J) stimmig,
 * exakt geschrieben und mit den gerundeten Zahlen der BNetzA verträglich ist. Rein: ohne Spring, ohne DB.
 */
class MispelPauschalVectorsTest {

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    static final Path VECTORS = V2.resolve("mispel-pauschal-vectors.json");
    private static final Path SCHEMA = V2.resolve("mispel-pauschal.schema.json");
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");
    private static final Map<String, String> AW_DER = Map.of("(P12)¼", "AW¼", "(P12a)¼", "AWa¼", "(P12b)¼", "AWb¼");

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

    private static String nummer(String nr) {
        return nr.substring(1, nr.indexOf(')'));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<String> formeln(String satz, String... ebenen) {
        Set<String> e = Set.of(ebenen);
        return texte(SAETZE.get(satz).get("formeln")).stream()
                .filter(nr -> e.contains(FORMELN.get(nr).get("ebene").asText()))
                .toList();
    }

    private static List<String> schluessel(JsonNode objekt) {
        List<String> out = new ArrayList<>();
        objekt.fieldNames().forEachRemaining(out::add);
        return out;
    }

    private static LocalDate tag(JsonNode qh) {
        return OffsetDateTime.parse(qh.get("beginn").asText()).atZoneSameInstant(BERLIN).toLocalDate();
    }

    private static BigDecimal zahl(JsonNode n) {
        return n.decimalValue();
    }

    /** L8: Dezimalzahl, wo der Wert ein endlicher Dezimalbruch ist, sonst gekürzter Bruch als Text. */
    private static Bruch exakt(JsonNode w) {
        if (!w.isTextual()) {
            return Bruch.von(w.decimalValue());
        }
        String[] teile = w.asText().split("/");
        BigInteger z = new BigInteger(teile[0]);
        BigInteger n = new BigInteger(teile[1]);
        Bruch b = new Bruch(z, n);
        assertThat(b.zaehler()).as("%s ist gekürzt", w.asText()).isEqualTo(z);
        assertThat(b.nenner()).as("%s ist gekürzt", w.asText()).isEqualTo(n);
        assertThat(b.alsDezimal()).as("%s ist kein endlicher Dezimalbruch", w.asText()).isNull();
        return b;
    }

    /** Ein (Rumpf-)Jahr: Tage [von, bis] und seine Stammdaten. */
    private record Zeitraum(LocalDate von, LocalDate bis, JsonNode stammdaten) {}

    private static Map<String, Zeitraum> zeitraeume(JsonNode fall) {
        Map<String, Zeitraum> out = new LinkedHashMap<>();
        if (fall.has("rumpfjahre")) {
            for (JsonNode r : fall.get("rumpfjahre")) {
                out.put(r.get("schluessel").asText(), new Zeitraum(LocalDate.parse(r.get("von").asText()),
                        LocalDate.parse(r.get("bis").asText()), r.get("stammdaten")));
            }
            return out;
        }
        Set<Integer> jahre = new TreeSet<>();
        fall.get("viertelstunden").forEach(qh -> jahre.add(tag(qh).getYear()));
        for (int j : jahre) {
            out.put(String.valueOf(j), new Zeitraum(LocalDate.of(j, 1, 1), LocalDate.of(j, 12, 31), fall.get("stammdaten")));
        }
        return out;
    }

    private static String schluesselVon(JsonNode fall, JsonNode qh) {
        LocalDate t = tag(qh);
        List<String> treffer = new ArrayList<>();
        zeitraeume(fall).forEach((k, z) -> {
            if (!t.isBefore(z.von()) && !t.isAfter(z.bis())) {
                treffer.add(k);
            }
        });
        assertThat(treffer).as("%s liegt in genau einem (Rumpf-)Jahr", qh.get("beginn")).hasSize(1);
        return treffer.get(0);
    }

    private static Map<String, String> ersetzt(String satz) {
        Map<String, String> out = new HashMap<>();
        for (String nr : texte(SAETZE.get(satz).get("formeln"))) {
            if (FORMELN.get(nr).has("ersetzt")) {
                out.put(FORMELN.get(nr).get("ersetzt").asText(), nr);
            }
        }
        return out;
    }

    private static List<String> ungefoerdert(JsonNode fall) {
        return fall.has("ungefoerdert") ? texte(fall.get("ungefoerdert")) : List.of();
    }

    @Test
    void l1Schema() {
        assertThat(UemsSchemaLaeufer.verstoesse(DOC, lies(SCHEMA))).isEmpty();
    }

    @Test
    void l2Katalog() {
        assertThat(FORMELN).as("Formelnummer doppelt").hasSize(DOC.get("formeln").size());
        // Anlage 2 S. 28–32: jeder Basisfall trägt die Nummern (P1) bis (P15), je einmal.
        List<String> p1BisP15 = IntStream.rangeClosed(1, 15).mapToObj(i -> "P" + i).toList();
        for (String satz : List.of("P1", "P2", "P5")) {
            List<String> nummern = texte(SAETZE.get(satz).get("formeln")).stream()
                    .filter(nr -> !FORMELN.get(nr).get("ebene").asText().equals("rumpfjahr"))
                    .map(MispelPauschalVectorsTest::nummer)
                    .toList();
            assertThat(nummern).as(satz).isEqualTo(p1BisP15);
        }
        // zusammen sind (P1) bis (P22) vollständig (A2 S. 28–55)
        Set<String> alle = new HashSet<>();
        FORMELN.keySet().stream().filter(nr -> nr.startsWith("(P"))
                .forEach(nr -> alle.add(nummer(nr).replaceAll("[ab]$", "")));
        assertThat(alle).isEqualTo(new HashSet<>(IntStream.rangeClosed(1, 22).mapToObj(i -> "P" + i).toList()));
        List<String> ordnung = new ArrayList<>(FORMELN.keySet());
        Set<String> eingaenge = new HashSet<>();
        SAETZE.forEach(s -> eingaenge.addAll(texte(s.get("eingaenge"))));
        SAETZE.fieldNames().forEachRemaining(name -> {
            List<String> liste = texte(SAETZE.get(name).get("formeln"));
            assertThat(liste).as("%s: Katalog-Reihenfolge", name)
                    .isEqualTo(ordnung.stream().filter(liste::contains).toList());
            for (String nr : liste) {
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
            if (f.has("ersetzt")) {
                String alt = f.get("ersetzt").asText();
                assertThat(nummer(alt)).as(nr).isEqualTo(nummer(nr));
                assertThat(FORMELN.get(alt).get("ebene")).as(nr).isEqualTo(f.get("ebene"));
                for (String name : texte(f.get("formelsaetze"))) {
                    assertThat(texte(SAETZE.get(name).get("formeln"))).as("%s führt %s neben %s", name, alt, nr)
                            .doesNotContain(alt);
                }
            }
        });
    }

    @Test
    void l3NamenEindeutig() {
        List<String> namen = new ArrayList<>(DOC.get("faelle").findValuesAsText("name"));
        namen.addAll(DOC.get("pauschalgrenzen").findValuesAsText("name"));
        assertThat(new HashSet<>(namen)).hasSize(namen.size());
    }

    @TestFactory
    Stream<DynamicTest> faelle() {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : DOC.get("faelle")) {
            String name = fall.get("name").asText();
            tests.add(DynamicTest.dynamicTest(name + " L3 Eingänge und Stammdaten", () -> l3Eingaenge(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L4 Raster", () -> l4Raster(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L5 Jahresgrenzen", () -> l5Grenzen(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L6 vollständig", () -> l6Vollstaendig(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L7 Summen", () -> l7Summen(fall)));
            tests.add(DynamicTest.dynamicTest(name + " L8 Zahlform", () -> l8Zahlform(fall)));
            if (fall.has("rumpfjahre")) {
                tests.add(DynamicTest.dynamicTest(name + " L9 Rumpfjahr-Tage", () -> l9RumpfjahrTage(fall)));
            }
            if (fall.has("bnetza")) {
                tests.add(DynamicTest.dynamicTest(name + " L10 BNetzA", () -> l10Bnetza(fall)));
            }
        }
        for (JsonNode zelle : DOC.get("pauschalgrenzen")) {
            tests.add(DynamicTest.dynamicTest(zelle.get("name").asText() + " L3 L6 L8 L10", () -> pauschalgrenze(zelle)));
        }
        return tests.stream();
    }

    private static void pruefeStammdaten(String satz, JsonNode sd, String wo) {
        assertThat(new HashSet<>(schluessel(sd))).as(wo).isEqualTo(new HashSet<>(texte(SAETZE.get(satz).get("stammdaten"))));
        if (sd.has("SKinst")) {
            assertThat(zahl(sd.get("SKinst")).signum()).as("%s: SKinst > 0, sonst kein Stromspeicher", wo).isPositive();
        }
        if (sd.has("Painst")) { // A2 S. 36: (P1) bezieht sich auf die Summe der Solaranlagen
            assertThat(zahl(sd.get("Pinst"))).as(wo)
                    .isEqualByComparingTo(zahl(sd.get("Painst")).add(zahl(sd.get("Pbinst"))));
        }
    }

    private static void l3Eingaenge(JsonNode fall) {
        String satz = fall.get("formelsatz").asText();
        List<String> ungefoerdert = ungefoerdert(fall);
        assertThat(texte(SAETZE.get(satz).get("eingaenge"))).as("ungefördert nennt nur AW-Eingänge des Formelsatzes")
                .containsAll(ungefoerdert);
        Set<String> soll = new HashSet<>(texte(SAETZE.get(satz).get("eingaenge")));
        ungefoerdert.forEach(soll::remove);
        soll.add("beginn");
        for (JsonNode qh : fall.get("viertelstunden")) {
            assertThat(new HashSet<>(schluessel(qh))).as(qh.get("beginn").asText()).isEqualTo(soll);
            if (satz.equals("P4-Variante")) { // A2 S. 41: jederzeit übereinstimmende AW>0-Zeiten
                assertThat(zahl(qh.get("AWa¼")).signum() > 0).as(qh.get("beginn").asText())
                        .isEqualTo(zahl(qh.get("AWb¼")).signum() > 0);
            }
        }
        assertThat(fall.has("stammdaten")).as("Stammdaten am Fall oder je Rumpfjahr").isNotEqualTo(fall.has("rumpfjahre"));
        zeitraeume(fall).forEach((k, z) -> pruefeStammdaten(satz, z.stammdaten(), fall.get("name").asText() + " " + k));
    }

    private static void l4Raster(JsonNode fall) {
        List<OffsetDateTime> beginne = new ArrayList<>();
        fall.get("viertelstunden").forEach(qh -> beginne.add(OffsetDateTime.parse(qh.get("beginn").asText())));
        for (int i = 0; i < beginne.size(); i++) {
            assertThat(beginne.get(i).getMinute() % 15).as(beginne.get(i).toString()).isZero();
            if (i > 0) {
                assertThat(beginne.get(i)).as("streng aufsteigend").isAfter(beginne.get(i - 1));
            }
        }
        List<String> erwartet = new ArrayList<>();
        fall.get("erwartet").get("viertelstunden").forEach(e -> erwartet.add(e.get("beginn").asText()));
        List<String> eingang = new ArrayList<>();
        fall.get("viertelstunden").forEach(qh -> eingang.add(qh.get("beginn").asText()));
        assertThat(erwartet).isEqualTo(eingang);
        if (fall.has("rumpfjahre")) {
            JsonNode rj = fall.get("rumpfjahre");
            for (int i = 0; i < rj.size(); i++) {
                LocalDate von = LocalDate.parse(rj.get(i).get("von").asText());
                assertThat(von).isBeforeOrEqualTo(LocalDate.parse(rj.get(i).get("bis").asText()));
                if (i > 0) { // der Änderungstag zählt zum Rumpfjahr davor (A2 S. 53)
                    assertThat(von).isEqualTo(LocalDate.parse(rj.get(i - 1).get("bis").asText()).plusDays(1));
                }
            }
        }
    }

    private static void l5Grenzen(JsonNode fall) {
        Map<String, Zeitraum> z = zeitraeume(fall);
        z.forEach((k, zr) -> assertThat(zr.von().getYear()).as("%s liegt in einem Kalenderjahr", k).isEqualTo(zr.bis().getYear()));
        if (fall.has("rumpfjahre")) {
            for (JsonNode r : fall.get("rumpfjahre")) {
                assertThat(r.get("schluessel").asText()).isEqualTo(r.get("von").asText() + "/" + r.get("bis").asText());
            }
        }
        Set<String> erwartet = new HashSet<>();
        fall.get("viertelstunden").forEach(qh -> erwartet.add(schluesselVon(fall, qh)));
        assertThat(new HashSet<>(schluessel(fall.get("erwartet").get("jahre")))).isEqualTo(erwartet).isEqualTo(z.keySet());
    }

    private static void l6Vollstaendig(JsonNode fall) {
        String satz = fall.get("formelsatz").asText();
        List<String> soll = fall.has("rumpfjahre") ? formeln(satz, "jahr", "rumpfjahr") : formeln(satz, "jahr");
        fall.get("erwartet").get("jahre").fields()
                .forEachRemaining(e -> assertThat(schluessel(e.getValue())).as(e.getKey()).isEqualTo(soll));
        List<String> viertel = formeln(satz, "viertelstunde");
        for (JsonNode e : fall.get("erwartet").get("viertelstunden")) {
            assertThat(schluessel(e).stream().filter(k -> !k.equals("beginn")).toList())
                    .as(e.get("beginn").asText()).isEqualTo(viertel);
        }
    }

    private static void l7Summen(JsonNode fall) {
        String satz = fall.get("formelsatz").asText();
        Map<String, String> statt = ersetzt(satz);
        Map<String, JsonNode> werte = new HashMap<>();
        fall.get("erwartet").get("viertelstunden").forEach(e -> werte.put(e.get("beginn").asText(), e));
        JsonNode jahre = fall.get("erwartet").get("jahre");
        for (String nr : formeln(satz, "jahr")) {
            JsonNode summe = FORMELN.get(nr).get("summe");
            if (summe == null) {
                continue;
            }
            String von = statt.getOrDefault(summe.get("von").asText(), summe.get("von").asText());
            Map<String, Bruch> summen = new HashMap<>();
            jahre.fieldNames().forEachRemaining(k -> summen.put(k, Bruch.NULL));
            for (JsonNode qh : fall.get("viertelstunden")) {
                JsonNode quelle = qh.has(von) ? qh : werte.get(qh.get("beginn").asText());
                summen.merge(schluesselVon(fall, qh), exakt(quelle.get(von)), Bruch::plus);
            }
            summen.forEach((k, s) -> assertThat(exakt(jahre.get(k).get(nr))).as("%s %s", k, nr).isEqualTo(s));
        }
        // die 0/1-Werte folgen ihren Eingängen; ungeförderte Anlagen tragen 1 (A2 S. 40, S. 50)
        List<String> ungefoerdert = ungefoerdert(fall);
        for (JsonNode qh : fall.get("viertelstunden")) {
            JsonNode e = werte.get(qh.get("beginn").asText());
            String wo = qh.get("beginn").asText();
            assertThat(e.get("(P5)¼").intValue()).as(wo).isEqualTo(zahl(qh.get("SP¼")).signum() >= 0 ? 1 : 0);
            AW_DER.forEach((nr, aw) -> {
                if (e.has(nr)) {
                    String quelle = satz.equals("P4-Variante") ? "AWa¼" : aw;
                    int soll = ungefoerdert.contains(quelle) || zahl(qh.get(quelle)).signum() > 0 ? 1 : 0;
                    assertThat(e.get(nr).intValue()).as("%s %s", wo, nr).isEqualTo(soll);
                }
            });
        }
    }

    private static void l8Zahlform(JsonNode fall) {
        for (JsonNode e : fall.get("erwartet").get("viertelstunden")) {
            e.fields().forEachRemaining(f -> {
                if (!f.getKey().equals("beginn")) {
                    exakt(f.getValue());
                }
            });
        }
        fall.get("erwartet").get("jahre").forEach(j -> j.forEach(MispelPauschalVectorsTest::exakt));
    }

    private static long sommertage(LocalDate von, LocalDate bis) {
        return von.datesUntil(bis.plusDays(1)).filter(t -> t.getMonthValue() >= 4 && t.getMonthValue() <= 9).count();
    }

    private static void l9RumpfjahrTage(JsonNode fall) {
        for (JsonNode r : fall.get("rumpfjahre")) {
            LocalDate von = LocalDate.parse(r.get("von").asText());
            LocalDate bis = LocalDate.parse(r.get("bis").asText());
            JsonNode jahr = fall.get("erwartet").get("jahre").get(r.get("schluessel").asText());
            int j = von.getYear();
            assertThat(sommertage(LocalDate.of(j, 1, 1), LocalDate.of(j, 12, 31))).isEqualTo(183);
            assertThat(jahr.get("(P17)").longValue()).isEqualTo(183);
            assertThat(jahr.get("(P20)").longValue()).isEqualTo(ChronoUnit.DAYS.between(LocalDate.of(j, 1, 1), LocalDate.of(j + 1, 1, 1)));
            assertThat(jahr.get("(P19)R").longValue()).isEqualTo(sommertage(von, bis));
            assertThat(jahr.get("(P22)R").longValue()).isEqualTo(ChronoUnit.DAYS.between(von, bis) + 1);
        }
    }

    /** L10: kaufmännisch (halbe Einheit aufwärts) auf die Stellen, die die BNetzA druckt. */
    private static BigDecimal gerundet(Bruch wert, BigDecimal gedruckt) {
        return new BigDecimal(wert.zaehler()).divide(new BigDecimal(wert.nenner()), Math.max(0, gedruckt.scale()), RoundingMode.HALF_UP);
    }

    private static void l10Bnetza(JsonNode fall) {
        fall.get("bnetza").fields().forEachRemaining(k -> k.getValue().fields().forEachRemaining(w -> {
            Bruch exakt = exakt(fall.get("erwartet").get("jahre").get(k.getKey()).get(w.getKey()));
            assertThat(gerundet(exakt, zahl(w.getValue()))).as("%s %s", k.getKey(), w.getKey())
                    .isEqualByComparingTo(zahl(w.getValue()));
        }));
    }

    private static void pauschalgrenze(JsonNode zelle) {
        String satz = zelle.get("formelsatz").asText();
        pruefeStammdaten(satz, zelle.get("stammdaten"), zelle.get("name").asText());
        List<String> grenzen = formeln(satz, "jahr").stream()
                .filter(nr -> Set.of("P1", "P2", "P3", "P4").contains(nummer(nr)))
                .toList();
        assertThat(schluessel(zelle.get("erwartet"))).isEqualTo(grenzen);
        Map<String, Bruch> werte = new HashMap<>();
        zelle.get("erwartet").fields().forEachRemaining(f -> werte.put(f.getKey(), exakt(f.getValue())));
        zelle.get("bnetza").fields().forEachRemaining(w -> assertThat(gerundet(werte.get(w.getKey()), zahl(w.getValue())))
                .as(w.getKey()).isEqualByComparingTo(zahl(w.getValue())));
        Bruch pinst = Bruch.von(zahl(zelle.get("stammdaten").get("Pinst")));
        zelle.get("bnetza_je_kwp").fields().forEachRemaining(w -> assertThat(
                gerundet(werte.get(w.getKey()).durch(pinst), zahl(w.getValue())))
                .as("%s je kWp", w.getKey()).isEqualByComparingTo(zahl(w.getValue())));
    }

    @Test
    void tabelle1Vollstaendig() {
        // A2 S. 12: sieben Solarleistungen × sieben Speicherkapazitäten
        Set<String> zellen = new HashSet<>();
        DOC.get("pauschalgrenzen").forEach(z -> zellen.add(
                z.get("stammdaten").get("Pinst").asInt() + "/" + z.get("stammdaten").get("SKinst").asInt()));
        Set<String> soll = new HashSet<>();
        for (int p : List.of(1, 4, 6, 8, 10, 15, 30)) {
            for (int s : List.of(45, 30, 15, 10, 8, 6, 4)) {
                soll.add(p + "/" + s);
            }
        }
        assertThat(zellen).isEqualTo(soll);
    }
}
