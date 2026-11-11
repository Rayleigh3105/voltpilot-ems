package com.voltpilot.api.erzeugungsanlage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.UemsSchemaLaeufer;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Messkonzept-Katalog (Schritt S0, {@code docs/contracts/v2/messkonzept-katalog.md}) hält, was seine Prosa
 * verspricht: Form nach Schema, Formeln nur über Zähler und Richtungen des eigenen Konzepts, je EA genau eine Regel
 * für die Einspeisung, eine vollständige und symmetrische Matrix gleich ihrer Regel - und die Formeln rechnen die
 * Fälle der Vektoren. Der kleine Ausdrucksleser hier ist KEIN Zwilling für das Produkt (S0 rechnet nichts im
 * Produkt), er hält nur die Daten fest. Rein: kein Spring-Kontext, keine Datenbank.
 */
class MesskonzeptKatalogVectorsTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Pattern ZAEHLERMENGE = Pattern.compile("^(?:(T[1-9])\\.)?(Z[1-9])([BL])$");
    private static final Pattern LEISTUNG = Pattern.compile("^(?:(T[1-9])\\.)?P_EA([1-9])$");

    private static JsonNode read(String datei) throws Exception {
        return M.readTree(V2.resolve(datei).toFile());
    }

    private static JsonNode katalog() throws Exception {
        return read("messkonzept-katalog.json");
    }

    private static Map<String, JsonNode> konzepte() throws Exception {
        Map<String, JsonNode> aus = new HashMap<>();
        for (JsonNode k : katalog().get("konzepte")) {
            assertThat(aus.put(k.get("kennung").asText(), k)).as("Kennung doppelt: " + k.get("kennung")).isNull();
        }
        return aus;
    }

    @Test
    void derKatalogHaeltSeinSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(katalog(), read("messkonzept-katalog.schema.json"))).isEmpty();
    }

    @Test
    void dasSchemaLehntEinUnbekanntesFeldUndEineFremdeRolleAb() throws Exception {
        JsonNode schema = read("messkonzept-katalog.schema.json");
        var falsch = katalog().deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) falsch.get("konzepte").get(0)).put("schaltbild", "x");
        assertThat(UemsSchemaLaeufer.verstoesse(falsch, schema)).isNotEmpty();
        var rolle = katalog().deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) rolle.get("konzepte").get(0).get("zaehler").get(0))
                .put("rolle", "speicher");
        assertThat(UemsSchemaLaeufer.verstoesse(rolle, schema)).isNotEmpty();
    }

    @Test
    void derUmfangIstBlattAUndBSamtParallel() throws Exception {
        assertThat(konzepte().keySet()).containsExactlyInAnyOrder("A1", "A2", "A3", "B1", "B2", "B2a", "B3", "B4");
        assertThat(katalog().at("/parallel/teile_aus")).extracting(JsonNode::asText)
                .containsExactlyInAnyOrder("A1", "A2", "A3", "B1", "B2", "B2a", "B3", "B4");
        Set<String> quellen = new HashSet<>();
        katalog().get("quellen").forEach(q -> quellen.add(q.get("kennung").asText()));
        for (JsonNode k : konzepte().values()) {
            k.get("quellen").forEach(f -> assertThat(quellen).contains(f.get("quelle").asText()));
            k.get("bedingungen").forEach(b -> assertThat(quellen).contains(b.at("/quelle/quelle").asText()));
        }
    }

    @Test
    void jedesFeldNutztNurSeinVokabular() throws Exception {
        JsonNode v = katalog().get("vokabulare");
        for (JsonNode k : konzepte().values()) {
            assertThat(texte(v.get("verteilungen"))).contains(k.get("verteilung").asText());
            assertThat(texte(v.get("verbraucher"))).contains(k.get("verbraucher").asText());
            for (JsonNode z : k.get("zaehler")) {
                assertThat(texte(v.get("rollen"))).contains(z.get("rolle").asText());
                assertThat(texte(v.get("richtungen"))).containsAll(texte(z.get("richtungen")));
            }
            for (JsonNode r : k.get("regeln")) {
                assertThat(texte(v.get("groessen"))).contains(r.get("groesse").asText());
            }
            for (JsonNode b : k.get("bedingungen")) {
                assertThat(texte(v.get("bedingungen"))).contains(b.get("art").asText());
                b.path("grenzen").forEach(g -> assertThat(texte(v.get("energietraeger")))
                        .containsAll(texte(g.get("energietraeger"))));
            }
        }
    }

    @Test
    void jedesKonzeptIstInSichStimmig() throws Exception {
        for (JsonNode k : konzepte().values()) {
            String id = k.get("kennung").asText();
            int anzahl = k.get("erzeugungsanlagen").asInt();
            assertThat(anzahl).as(id).isEqualTo(id.startsWith("A") ? 1 : 2);
            assertThat(k.get("blatt").asText()).as(id).isEqualTo(id.substring(0, 1));
            // Genau ein Zweirichtungszähler am Netz, Pflicht.
            List<JsonNode> netz = new ArrayList<>();
            Map<String, Set<String>> richtungen = new HashMap<>();
            for (JsonNode z : k.get("zaehler")) {
                String rolle = z.get("rolle").asText();
                assertThat(richtungen.put(z.get("kennung").asText(), new HashSet<>(texte(z.get("richtungen")))))
                        .as(id + " Zähler doppelt").isNull();
                for (JsonNode ea : z.get("misst")) {
                    assertThat(eaNummer(ea.asText())).as(id).isBetween(1, anzahl);
                }
                switch (rolle) {
                    case "netz" -> {
                        netz.add(z);
                        assertThat(texte(z.get("richtungen"))).as(id).containsExactly("bezug", "lieferung");
                        assertThat(z.get("wahlfrei").asBoolean()).as(id).isFalse();
                    }
                    case "erzeugung" -> {
                        assertThat(z.get("misst")).as(id + " Erzeugungszähler ohne EA").isNotEmpty();
                        assertThat(texte(z.get("richtungen"))).as(id).containsExactly("lieferung");
                    }
                    case "kaskade" -> {
                        assertThat(z.has("zweig")).as(id + " Kaskade ohne Zweig").isTrue();
                        assertThat(id).isEqualTo("B4");
                    }
                    default -> throw new AssertionError(rolle);
                }
                if (!"kaskade".equals(rolle)) {
                    assertThat(z.has("zweig")).as(id + " nur die Kaskade hat einen Zweig").isFalse();
                }
            }
            assertThat(netz).as(id + " genau ein Netzzähler").hasSize(1);
            // Volleinspeisung: der Netzzähler misst alle EA und es gibt keine Verbraucher und keinen Speicher.
            boolean voll = "keine".equals(k.get("verbraucher").asText());
            assertThat(netz.get(0).get("misst").size()).as(id).isEqualTo(voll ? anzahl : 0);
            assertThat(k.get("speicher_erlaubt").asBoolean()).as(id + " Speicher nur mit Verbrauchern").isEqualTo(!voll);
            // Regeln: genau ein Bezug ohne EA, je EA genau eine Einspeisung, höchstens ein Selbstverbrauch.
            Map<String, Integer> zahl = new HashMap<>();
            for (JsonNode r : k.get("regeln")) {
                String g = r.get("groesse").asText();
                JsonNode ea = r.get("ea");
                if ("bezug".equals(g)) {
                    assertThat(ea.isNull()).as(id + " Bezug gilt für das ganze Konzept").isTrue();
                } else {
                    assertThat(eaNummer(ea.asText())).as(id).isBetween(1, anzahl);
                }
                zahl.merge(g + "/" + (ea.isNull() ? "-" : ea.asText()), 1, Integer::sum);
                for (String name : namen(r.get("formel").asText())) {
                    pruefeName(id, name, richtungen, anzahl, k.get("verteilung").asText(), null);
                }
            }
            assertThat(zahl.get("bezug/-")).as(id).isEqualTo(1);
            for (int i = 1; i <= anzahl; i++) {
                assertThat(zahl.get("einspeisung/EA" + i)).as(id + " Einspeisung EA" + i).isEqualTo(1);
            }
            zahl.forEach((schluessel, n) -> assertThat(n).as(id + " " + schluessel).isEqualTo(1));
            // Nur die Regel nach Erzeugung braucht einen Rechenzeitraum.
            assertThat(k.has("rechenzeitraum")).as(id)
                    .isEqualTo("nach_erzeugung".equals(k.get("verteilung").asText()));
            // Jedes Konzept für zwei EA verweist auf die Matrix.
            boolean matrix = false;
            for (JsonNode b : k.get("bedingungen")) {
                matrix |= "matrix".equals(b.get("art").asText());
            }
            assertThat(matrix).as(id).isEqualTo(anzahl == 2);
        }
    }

    @Test
    void dieMatrixIstVollstaendigSymmetrischUndGleichIhrerRegel() throws Exception {
        JsonNode matrix = katalog().get("matrix");
        List<String> klassen = new ArrayList<>();
        matrix.get("klassen").forEach(k -> klassen.add(k.get("kennung").asText()));
        assertThat(klassen).containsExactly("eeg_bis_2012_i", "eeg_2012_ii_ohne_mim", "eeg_2012_ii_mim", "ab_eeg_2014");
        Map<String, JsonNode> zeilen = new HashMap<>();
        for (JsonNode z : matrix.get("zeilen")) {
            String schluessel = z.get("ea1").asText() + "|" + z.get("ea2").asText();
            assertThat(zeilen.put(schluessel, z)).as("Zeile doppelt " + schluessel).isNull();
            for (JsonNode mk : z.get("konzepte")) {
                assertThat(konzepte()).containsKey(mk.asText());
            }
        }
        assertThat(zeilen).hasSize(11);
        for (String a : klassen) {
            for (String b : klassen) {
                JsonNode z = zeilen.getOrDefault(a + "|" + b, zeilen.get(b + "|" + a));
                assertThat(z).as("Paar fehlt " + a + "/" + b).isNotNull();
                JsonNode gespiegelt = zeilen.get(b + "|" + a);
                if (gespiegelt != null) {
                    assertThat(gespiegelt.get("konzepte")).as(a + "/" + b).isEqualTo(z.get("konzepte"));
                }
                boolean genauEineMim = "eeg_2012_ii_mim".equals(a) ^ "eeg_2012_ii_mim".equals(b);
                List<String> erwartet = genauEineMim ? List.of("B4") : List.of("B1", "B2", "B2a", "B3");
                assertThat(texte(z.get("konzepte"))).as(a + "/" + b).containsExactlyElementsOf(erwartet);
                boolean vorbehalt = !genauEineMim && ("eeg_bis_2012_i".equals(a) || "eeg_bis_2012_i".equals(b));
                assertThat(z.get("vorbehalt_b2a").asBoolean()).as(a + "/" + b).isEqualTo(vorbehalt);
            }
        }
    }

    @TestFactory
    Stream<DynamicTest> jederRechenfall() throws Exception {
        Map<String, JsonNode> konzepte = konzepte();
        return faelle("rechenfaelle").map(fall -> DynamicTest.dynamicTest(fall.get("fall").asText(), () -> {
            JsonNode k = konzepte.get(fall.get("konzept").asText());
            Map<String, Double> werte = zahlen(fall.get("werte"), zahlen(fall.get("leistung"), new HashMap<>()));
            Map<String, Map<String, Double>> ergebnis = rechne(k.get("regeln"), werte, "", Map.of());
            vergleiche(fall.get("erwartet"), ergebnis);
        }));
    }

    @TestFactory
    Stream<DynamicTest> jederZeitraumfall() throws Exception {
        Map<String, JsonNode> konzepte = konzepte();
        return faelle("zeitraumfaelle").map(fall -> DynamicTest.dynamicTest(fall.get("fall").asText(), () -> {
            JsonNode k = konzepte.get(fall.get("konzept").asText());
            assertThat(k.at("/rechenzeitraum/vorgabe").asText()).isEqualTo("monat");
            String groesse = fall.get("groesse").asText();
            Map<String, Double> summiert = new HashMap<>();
            Map<String, Double> zeitraum = new HashMap<>();
            for (JsonNode vs : fall.get("viertelstunden")) {
                Map<String, Double> werte = zahlen(vs, new HashMap<>());
                werte.forEach((n, w) -> zeitraum.merge(n, w, Double::sum));
                rechne(k.get("regeln"), werte, "", Map.of()).getOrDefault(groesse, Map.of())
                        .forEach((ea, w) -> summiert.merge(ea, w, Double::sum));
            }
            Map<String, Double> ueber = rechne(k.get("regeln"), zeitraum, "", Map.of()).get(groesse);
            fall.get("erwartet_je_viertelstunde_summiert").fields().forEachRemaining(e ->
                    assertThat(summiert.get(e.getKey())).as(e.getKey()).isCloseTo(e.getValue().asDouble(), within(1e-9)));
            fall.get("erwartet_ueber_zeitraum").fields().forEachRemaining(e ->
                    assertThat(ueber.get(e.getKey())).as(e.getKey()).isCloseTo(e.getValue().asDouble(), within(1e-9)));
            assertThat(summiert).isNotEqualTo(ueber);
        }));
    }

    @TestFactory
    Stream<DynamicTest> jederParallelfall() throws Exception {
        Map<String, JsonNode> konzepte = konzepte();
        JsonNode parallel = katalog().get("parallel");
        return faelle("parallelfaelle").map(fall -> DynamicTest.dynamicTest(fall.get("fall").asText(), () -> {
            Map<String, Double> werte = zahlen(fall.get("werte"), zahlen(fall.get("leistung"), new HashMap<>()));
            Map<String, Map<String, Double>> ergebnis = new HashMap<>();
            Set<String> eas = new HashSet<>();
            assertThat(fall.get("teile").size()).isBetween(parallel.get("teile_min").asInt(), parallel.get("teile_max").asInt());
            for (JsonNode teil : fall.get("teile")) {
                String konzept = teil.get("konzept").asText();
                assertThat(texte(parallel.get("teile_aus"))).contains(konzept);
                Map<String, String> abbild = new HashMap<>();
                teil.get("ea").fields().forEachRemaining(e -> abbild.put(e.getKey(), e.getValue().asText()));
                abbild.values().forEach(ea -> assertThat(eas.add(ea)).as("EA in zwei Teilen: " + ea).isTrue());
                Map<String, Map<String, Double>> teilErgebnis =
                        rechne(konzepte.get(konzept).get("regeln"), werte, teil.get("teil").asText() + ".", abbild);
                teilErgebnis.forEach((g, je) -> {
                    if (!"bezug".equals(g)) {
                        ergebnis.computeIfAbsent(g, x -> new HashMap<>()).putAll(je);
                    }
                });
            }
            ergebnis.putAll(rechne(parallel.get("regeln"), werte, "", Map.of()));
            vergleiche(fall.get("erwartet"), ergebnis);
        }));
    }

    @TestFactory
    Stream<DynamicTest> jederKlassenfall() throws Exception {
        JsonNode klassen = katalog().at("/matrix/klassen");
        return faelle("klassenfaelle").map(fall -> DynamicTest.dynamicTest(fall.get("fall").asText(), () -> {
            String klasse = klasse(klassen, datum(fall.get("inbetriebnahme")), zahl(fall.get("leistung_kwp")));
            assertThat(klasse).isEqualTo(fall.get("klasse").isNull() ? null : fall.get("klasse").asText());
        }));
    }

    @TestFactory
    Stream<DynamicTest> jederMatrixfall() throws Exception {
        JsonNode matrix = katalog().get("matrix");
        return faelle("matrixfaelle").map(fall -> DynamicTest.dynamicTest(fall.get("fall").asText(), () -> {
            String a = klasse(matrix.get("klassen"), datum(fall.at("/ea1/inbetriebnahme")), zahl(fall.at("/ea1/leistung_kwp")));
            String b = klasse(matrix.get("klassen"), datum(fall.at("/ea2/inbetriebnahme")), zahl(fall.at("/ea2/leistung_kwp")));
            JsonNode zeile = null;
            JsonNode gespiegelt = null;
            for (JsonNode z : matrix.get("zeilen")) {
                if (z.get("ea1").asText().equals(a) && z.get("ea2").asText().equals(b)) {
                    zeile = z;
                } else if (z.get("ea1").asText().equals(b) && z.get("ea2").asText().equals(a)) {
                    gespiegelt = z;
                }
            }
            zeile = zeile != null ? zeile : gespiegelt;
            assertThat(zeile).as(a + "/" + b).isNotNull();
            assertThat(zeile.get("konzepte")).isEqualTo(fall.get("konzepte"));
            assertThat(zeile.get("vorbehalt_b2a")).isEqualTo(fall.get("vorbehalt_b2a"));
        }));
    }

    @Test
    void derLeserRechnetPunktVorStrichUndKlammern() {
        Map<String, Double> w = Map.of("Z1L", 10.0, "Z2L", 4.0, "P_EA1", 1.0, "P_EA2", 3.0);
        assertThat(new Ausdruck("Z1L - Z2L - 1", w).wert()).isEqualTo(5.0);
        assertThat(new Ausdruck("Z1L * P_EA1 / (P_EA1 + P_EA2)", w).wert()).isEqualTo(2.5);
        assertThat(new Ausdruck("(Z1L - Z2L) * P_EA2 / (P_EA1 + P_EA2)", w).wert()).isEqualTo(4.5);
    }

    // --- Hilfen ---------------------------------------------------------------------------------------------------

    private static Stream<JsonNode> faelle(String block) throws Exception {
        return StreamSupport.stream(read("messkonzept-katalog-vectors.json").get(block).spliterator(), false);
    }

    /** Die Regeln eines Konzepts über die Werte; {@code teil} setzt den Namensraum, {@code abbild} benennt die EA um. */
    private static Map<String, Map<String, Double>> rechne(JsonNode regeln, Map<String, Double> werte, String teil,
            Map<String, String> abbild) {
        Map<String, Double> lokal = new HashMap<>();
        werte.forEach((n, w) -> {
            if (teil.isEmpty()) {
                lokal.put(n, w);
            } else if (n.startsWith(teil)) {
                lokal.put(n.substring(teil.length()), w);
            }
        });
        Map<String, Map<String, Double>> aus = new HashMap<>();
        for (JsonNode r : regeln) {
            String g = r.get("groesse").asText();
            double wert = new Ausdruck(r.get("formel").asText(), teil.isEmpty() ? werte : lokal).wert();
            if (r.get("ea").isNull()) {
                aus.computeIfAbsent(g, x -> new HashMap<>()).put("-", wert);
            } else {
                String ea = abbild.getOrDefault(r.get("ea").asText(), r.get("ea").asText());
                aus.computeIfAbsent(g, x -> new HashMap<>()).put(ea, wert);
            }
        }
        return aus;
    }

    private static void vergleiche(JsonNode erwartet, Map<String, Map<String, Double>> ergebnis) {
        assertThat(ergebnis.get("bezug").get("-")).as("Bezug").isCloseTo(erwartet.get("bezug").asDouble(), within(1e-9));
        for (String g : List.of("einspeisung", "selbstverbrauch")) {
            JsonNode je = erwartet.path(g);
            Map<String, Double> ist = ergebnis.getOrDefault(g, Map.of());
            Set<String> erwarteteEa = new TreeSet<>();
            je.fieldNames().forEachRemaining(erwarteteEa::add);
            if (je.isMissingNode()) {
                continue;
            }
            assertThat(new TreeSet<>(ist.keySet())).as(g).isEqualTo(erwarteteEa);
            je.fields().forEachRemaining(e -> assertThat(ist.get(e.getKey())).as(g + " " + e.getKey())
                    .isCloseTo(e.getValue().asDouble(), within(1e-9)));
        }
    }

    private static void pruefeName(String id, String name, Map<String, Set<String>> richtungen, int anzahl,
            String verteilung, String teil) {
        Matcher z = ZAEHLERMENGE.matcher(name);
        Matcher p = LEISTUNG.matcher(name);
        if (z.matches()) {
            assertThat(z.group(1)).as(id + " " + name).isEqualTo(teil);
            Set<String> r = richtungen.get(z.group(2));
            assertThat(r).as(id + ": " + name + " nennt einen fremden Zähler").isNotNull();
            assertThat(r).as(id + ": " + name + " nennt eine Richtung, die der Zähler nicht misst")
                    .contains("B".equals(z.group(3)) ? "bezug" : "lieferung");
        } else if (p.matches()) {
            assertThat(verteilung).as(id + ": " + name + " nur nach Leistung").isEqualTo("nach_leistung");
            assertThat(Integer.parseInt(p.group(2))).as(id + " " + name).isBetween(1, anzahl);
        } else {
            throw new AssertionError(id + ": unbekannter Name " + name);
        }
    }

    private static Set<String> namen(String formel) {
        Set<String> aus = new LinkedHashSet<>();
        Matcher m = Pattern.compile("[A-Za-z][A-Za-z0-9_.]*").matcher(formel);
        while (m.find()) {
            aus.add(m.group());
        }
        return aus;
    }

    /** Die Klasse der Matrix aus den Zuordnungsdaten des Katalogs; null ohne Grundlage. */
    private static String klasse(JsonNode klassen, LocalDate inbetriebnahme, Double kwp) {
        if (inbetriebnahme == null) {
            return null;
        }
        String treffer = null;
        for (JsonNode k : klassen) {
            JsonNode z = k.get("zuordnung");
            if (z.has("inbetriebnahme_vor") && !inbetriebnahme.isBefore(LocalDate.parse(z.get("inbetriebnahme_vor").asText()))) {
                continue;
            }
            if (z.has("inbetriebnahme_ab") && inbetriebnahme.isBefore(LocalDate.parse(z.get("inbetriebnahme_ab").asText()))) {
                continue;
            }
            if (z.has("inbetriebnahme_bis") && inbetriebnahme.isAfter(LocalDate.parse(z.get("inbetriebnahme_bis").asText()))) {
                continue;
            }
            boolean leistungZaehlt = z.has("leistung_kwp_ausserhalb")
                    || (z.has("leistung_kwp_ueber") && !z.get("leistung_kwp_ueber").isNull())
                    || (z.has("leistung_kwp_bis") && !z.get("leistung_kwp_bis").isNull());
            if (leistungZaehlt && kwp == null) {
                return null;
            }
            if (z.has("leistung_kwp_ausserhalb")) {
                double unten = z.get("leistung_kwp_ausserhalb").get(0).asDouble();
                double oben = z.get("leistung_kwp_ausserhalb").get(1).asDouble();
                if (kwp > unten && kwp <= oben) {
                    continue;
                }
            }
            if (z.hasNonNull("leistung_kwp_ueber") && kwp <= z.get("leistung_kwp_ueber").asDouble()) {
                continue;
            }
            if (z.hasNonNull("leistung_kwp_bis") && kwp > z.get("leistung_kwp_bis").asDouble()) {
                continue;
            }
            assertThat(treffer).as("zwei Klassen für " + inbetriebnahme + " / " + kwp).isNull();
            treffer = k.get("kennung").asText();
        }
        assertThat(treffer).as("keine Klasse für " + inbetriebnahme + " / " + kwp).isNotNull();
        return treffer;
    }

    private static Map<String, Double> zahlen(JsonNode objekt, Map<String, Double> aus) {
        objekt.fields().forEachRemaining(e -> aus.put(e.getKey(), e.getValue().asDouble()));
        return aus;
    }

    private static LocalDate datum(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : LocalDate.parse(n.asText());
    }

    private static Double zahl(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asDouble();
    }

    private static int eaNummer(String ea) {
        return Integer.parseInt(ea.substring(2));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(n -> aus.add(n.asText()));
        return aus;
    }

    /** Rekursiver Abstieg über die Grammatik aus messkonzept-katalog.md §5; ein unbekannter Name ist ein Fehler. */
    private static final class Ausdruck {
        private final String text;
        private final Map<String, Double> werte;
        private int pos;

        Ausdruck(String text, Map<String, Double> werte) {
            this.text = text;
            this.werte = werte;
        }

        double wert() {
            double v = summe();
            leer();
            assertThat(pos).as("Rest in „" + text + "“").isEqualTo(text.length());
            return v;
        }

        private double summe() {
            double v = produkt();
            while (true) {
                leer();
                if (zeichen('+')) {
                    v += produkt();
                } else if (zeichen('-')) {
                    v -= produkt();
                } else {
                    return v;
                }
            }
        }

        private double produkt() {
            double v = faktor();
            while (true) {
                leer();
                if (zeichen('*')) {
                    v *= faktor();
                } else if (zeichen('/')) {
                    v /= faktor();
                } else {
                    return v;
                }
            }
        }

        private double faktor() {
            leer();
            if (zeichen('(')) {
                double v = summe();
                leer();
                assertThat(zeichen(')')).as("Klammer zu in „" + text + "“").isTrue();
                return v;
            }
            int start = pos;
            if (pos < text.length() && Character.isDigit(text.charAt(pos))) {
                while (pos < text.length() && (Character.isDigit(text.charAt(pos)) || text.charAt(pos) == '.')) {
                    pos++;
                }
                return Double.parseDouble(text.substring(start, pos));
            }
            while (pos < text.length() && (Character.isLetterOrDigit(text.charAt(pos)) || text.charAt(pos) == '_'
                    || text.charAt(pos) == '.')) {
                pos++;
            }
            String name = text.substring(start, pos);
            assertThat(name).as("Name erwartet in „" + text + "“ bei " + start).isNotEmpty();
            assertThat(werte).as("Wert fehlt für " + name).containsKey(name);
            return werte.get(name);
        }

        private boolean zeichen(char c) {
            if (pos < text.length() && text.charAt(pos) == c) {
                pos++;
                return true;
            }
            return false;
        }

        private void leer() {
            while (pos < text.length() && text.charAt(pos) == ' ') {
                pos++;
            }
        }
    }
}
