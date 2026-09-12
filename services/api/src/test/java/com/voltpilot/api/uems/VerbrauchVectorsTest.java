package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.VerbrauchRegeln.Ereignis;
import com.voltpilot.api.uems.VerbrauchRegeln.Ergebnis;
import com.voltpilot.api.uems.VerbrauchRegeln.Rohwert;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings der VERBRAUCHSBILDUNG (UEMS AP-08 IP-1):
 * {@link VerbrauchRegeln} zieht aus JEDEM Fall der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/verbrauch-vectors.json}) dasselbe Ergebnis wie der
 * Python-Zwilling ({@code services/optimization/voltpilot_optimization/verbrauch.py},
 * Test {@code services/optimization/tests/test_verbrauch.py}).
 *
 * <p>Die Datei wird PER PFAD gelesen — wer sie verschiebt, bricht diesen Test absichtlich.
 * Verglichen wird EXAKT: Menge, Mittel/Min/Max, integrierte Energie, Zustand, erhalten,
 * erwartet, Abdeckung, Kennzeichen (Text und Reihenfolge) und die Stundenzahl der Periode.
 *
 * <p>Die Entfaltung der Abschnitte zu Rohwerten lebt hier im Test, weil sie die FORM der
 * Vektor-Datei liest; {@link VerbrauchRegeln} bekommt die Rohwerte fertig, so wie ein
 * Produktionsweg sie aus der Messwert-Tabelle bekäme. Der Python-Zwilling hält sie in
 * {@code verbrauch.rohwerte} — dieselbe Regel, derselbe Wortlaut.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class VerbrauchVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    static final Path VECTORS = V2.resolve("verbrauch-vectors.json");
    private static final Path SCHEMA = V2.resolve("verbrauch.schema.json");
    private static final Path PROSA = V2.resolve("verbrauch.md");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path PYTHON_ZWILLING =
            Path.of("..", "..", "services", "optimization", "voltpilot_optimization", "verbrauch.py");

    static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    // ---------------------------------------------------------------------------- Form

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA)))
                .as("Schema-Verstöße")
                .isEmpty();
    }

    /** Die Vektor-Datei verweist auf die EINE Beispielwelt, nicht auf eine zweite. */
    @Test
    void dieBeispielweltIstDasReferenzunternehmen() throws Exception {
        assertThat(lies(VECTORS).path("referenzunternehmen").asText()).isEqualTo("./uems-referenzunternehmen.json");
        assertThat(Files.exists(REFERENZ)).isTrue();
    }

    /** Prosa und Python-Zwilling liegen, wo die Datei sie nennt — sonst ist der Gleichlauf nur behauptet. */
    @Test
    void prosaUndPythonZwillingLiegen() {
        assertThat(Files.exists(PROSA)).as("verbrauch.md").isTrue();
        assertThat(Files.exists(PYTHON_ZWILLING)).as("Python-Zwilling").isTrue();
    }

    /**
     * 23 Fälle — der vollständige Referenzfallkatalog AP-08 §7 — plus F24, den AP-08 IP-3 für die
     * Zusammensetzung von Momentanwerten handgerechnet hat. {@code minItems} prüft der Läufer, die
     * genaue Zahl steht hier.
     */
    @Test
    void dreiundzwanzigFaelleUndF24MitEindeutigenNamen() throws Exception {
        List<String> namen = new ArrayList<>();
        lies(VECTORS).path("cases").forEach(c -> namen.add(c.path("name").asText()));
        assertThat(namen).hasSize(24).doesNotHaveDuplicates();
        assertThat(namen.get(23)).startsWith("f24-");
    }

    /** Die Schwellen stehen in der Datei; die Klasse schreibt sie nicht für sich allein fest. */
    @Test
    void dieRegelnStehenInDerDatei() throws Exception {
        JsonNode regeln = lies(VECTORS).path("regeln");
        assertThat(regeln.path("luecke_faktor").asInt()).isEqualTo(VerbrauchRegeln.LUECKE_FAKTOR);
        assertThat(regeln.path("integration_halten_faktor").asInt()).isEqualTo(VerbrauchRegeln.HALTEN_FAKTOR);
        assertThat(regeln.path("vergleich_nachkommastellen").asInt()).isEqualTo(VerbrauchRegeln.NACHKOMMASTELLEN);
        assertThat(lies(VECTORS).path("zeitzone").asText()).isEqualTo(VerbrauchRegeln.ANZEIGE_ZEITZONE.getId());
    }

    /**
     * Die Lückenschwelle ist DIESELBE wie im schon gemergten Zustandsvertrag — zwei Zahlen
     * für dieselbe Aussage wären genau die Drift, die diese Datei verhindern soll.
     */
    @Test
    void dieLueckenschwelleIstDieDesZustandsvertrags() {
        assertThat(VerbrauchRegeln.LUECKE_FAKTOR).isEqualTo(ZustandAbleitung.LUECKE_FAKTOR);
    }

    /** Jede bewusste Abweichung von der Vorlage steht IN der Datei, mit Grund. */
    @Test
    void jedeAbweichungVonDerVorlageIstBenannt() throws Exception {
        JsonNode abweichungen = lies(VECTORS).path("_abweichungen");
        assertThat(abweichungen.isArray()).isTrue();
        abweichungen.forEach(a -> {
            assertThat(a.path("fall").asText()).isNotBlank();
            assertThat(a.path("grund").asText()).isNotBlank();
        });
    }

    // ---------------------------------------------------------------------- Die Vektoren

    /**
     * Jede Erwartung jedes Falls: die Regel rechnet genau das, was in der Datei steht.
     * Ein Fall, der bricht, meldet sein {@code why} — den Grund, warum es ihn gibt.
     */
    @TestFactory
    List<DynamicTest> vektoren() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : lies(VECTORS).path("cases")) {
            for (JsonNode erwartung : fall.path("expected")) {
                String name = fall.path("name").asText() + " :: " + erwartung.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> pruefe(fall, erwartung)));
            }
        }
        assertThat(tests).as("Erwartungen über alle Fälle").hasSizeGreaterThanOrEqualTo(23);
        return tests;
    }

    private void pruefe(JsonNode fall, JsonNode erwartung) {
        JsonNode reihe = reihe(fall, erwartung);
        String why = fall.path("why").asText();
        Instant von = VerbrauchRegeln.zeit(erwartung.path("von").asText());
        Instant bis = VerbrauchRegeln.zeit(erwartung.path("bis").asText());
        Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());

        List<Ereignis> ereignisse = new ArrayList<>(ereignisse(reihe.path("ereignisse")));
        ereignisse.addAll(ereignisse(erwartung.path("ereignisse_zusatz")));

        Ergebnis ist = VerbrauchRegeln.ergebnis(
                reihe.path("wertart").asText(),
                rohwerte(reihe),
                von,
                bis,
                kadenz,
                ereignisse,
                dezimal(reihe.path("faktor"), BigDecimal.ONE),
                dezimal(reihe.path("wertebereich_modul"), null),
                dezimal(reihe.path("hoechstzuwachs_je_kadenz"), null),
                reihe.path("integrieren").asBoolean(false));

        zahl(why + " · menge", erwartung.path("menge"), ist.menge());
        zahl(why + " · mittel", erwartung.path("mittel"), ist.mittel());
        zahl(why + " · min", erwartung.path("min"), ist.min());
        zahl(why + " · max", erwartung.path("max"), ist.max());
        zahl(why + " · energie_kwh", erwartung.path("energie_kwh"), ist.energieKwh());

        if (erwartung.has("zustand")) {
            assertThat(ist.zustand()).as(why + " · zustand").isEqualTo(erwartung.path("zustand").asText());
        }
        if (erwartung.has("erhalten")) {
            assertThat(ist.erhalten()).as(why + " · erhalten").isEqualTo(erwartung.path("erhalten").asInt());
        }
        if (erwartung.has("erwartet")) {
            assertThat(ist.erwartet()).as(why + " · erwartet").isEqualTo(erwartung.path("erwartet").asInt());
        }
        if (erwartung.has("abdeckung_prozent")) {
            JsonNode soll = erwartung.path("abdeckung_prozent");
            assertThat(ist.abdeckungProzent())
                    .as(why + " · abdeckung_prozent")
                    .isEqualTo(soll.isNull() ? null : soll.asInt());
        }
        if (erwartung.has("kennzeichen")) {
            List<String> soll = new ArrayList<>();
            erwartung.path("kennzeichen").forEach(k -> soll.add(k.asText()));
            assertThat(ist.kennzeichen()).as(why + " · kennzeichen").isEqualTo(soll);
        }
        if (erwartung.has("stunden")) {
            assertThat(VerbrauchRegeln.stunden(von, bis))
                    .as(why + " · stunden")
                    .isEqualTo(erwartung.path("stunden").asLong());
        }
    }

    static void zahl(String was, JsonNode soll, BigDecimal ist) {
        if (soll.isMissingNode()) {
            return;
        }
        if (soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        assertThat(ist).as(was).usingComparator(BigDecimal::compareTo).isEqualTo(soll.decimalValue());
    }

    // ------------------------------------------------------------ Die Vektor-Form lesen

    static JsonNode reihe(JsonNode fall, JsonNode erwartung) {
        JsonNode eingang = fall.path("input");
        if (eingang.has("reihe")) {
            return eingang.path("reihe");
        }
        return eingang.path("reihen").path(erwartung.path("reihe").asText());
    }

    /**
     * Die Rohwerte einer Reihe: Abschnitte {@code {von, bis, kadenz_s, stand_von,
     * zuwachs_je_kadenz}} (BEIDE Grenzen inklusive) werden entfaltet, einzelne Werte
     * {@code {t, v, q}} übernommen; {@code luecken} entfernen anschließend Werte in
     * {@code [von, bis)}.
     */
    /**
     * Z6 (AP-08 IP-4) — die EINE Überlauf-Entscheidung {@link VerbrauchRegeln#ueberlauf} steht genau
     * dort, wo eine Erwartung des Falls „Überlauf HH:MM" nennt: an jedem fallenden Nachbarn guter
     * Werte jeder Zählerstand-Reihe (eine Gerätegrenze dazwischen ist Z4). F7: 767 ≤ 1 667 ist ein
     * Überlauf, 53 179 nicht. Ohne Wertebereich oder ohne Höchstzuwachs wird nie einer geraten (E4).
     * Der Python-Zwilling und die Writer-Erkennung prüfen dieselbe Ableitung aus derselben Datei.
     */
    @Test
    void dieUeberlaufEntscheidungStehtGenauDortWoDieErwartungEinenUeberlaufNennt() throws Exception {
        int ueberlaeufe = 0;
        int ruecksetzungen = 0;
        for (JsonNode fall : lies(VECTORS).path("cases")) {
            JsonNode reihe = fall.path("input").path("reihe");
            if (!"zaehlerstand".equals(fall.path("familie").asText()) || reihe.isMissingNode()) {
                continue;
            }
            List<Rohwert> gute = rohwerte(reihe).stream().filter(Rohwert::gut).toList();
            List<Instant> grenzen = ereignisse(reihe.path("ereignisse")).stream()
                    .filter(e -> Ereignis.GERAETEGRENZE.equals(e.art())).map(Ereignis::zeit).toList();
            List<String> genannt = new ArrayList<>();
            fall.path("expected").forEach(e -> e.path("kennzeichen").forEach(k -> {
                if (k.asText().startsWith("Überlauf ")) {
                    genannt.add(k.asText().split(" ")[1]);
                }
            }));
            Duration kadenz = Duration.ofSeconds(reihe.path("kadenz_s").asLong());
            BigDecimal modul = dezimal(reihe.path("wertebereich_modul"), null);
            BigDecimal hoechst = dezimal(reihe.path("hoechstzuwachs_je_kadenz"), null);
            for (int i = 0; i + 1 < gute.size(); i++) {
                Rohwert vorher = gute.get(i);
                Rohwert nachher = gute.get(i + 1);
                if (nachher.wert().compareTo(vorher.wert()) >= 0 || grenzen.stream()
                        .anyMatch(g -> g.isAfter(vorher.zeit()) && !g.isAfter(nachher.zeit()))) {
                    continue;
                }
                String uhr = java.time.format.DateTimeFormatter.ofPattern("HH:mm")
                        .format(nachher.zeit().atZone(VerbrauchRegeln.ANZEIGE_ZEITZONE));
                BigDecimal ueber = VerbrauchRegeln.ueberlauf(vorher, nachher, kadenz, modul, hoechst);
                assertThat(ueber != null).as(fall.path("name").asText() + " " + uhr)
                        .isEqualTo(genannt.contains(uhr));
                if (ueber != null) {
                    assertThat(ueber).isEqualByComparingTo(modul.subtract(vorher.wert()).add(nachher.wert()));
                    ueberlaeufe++;
                } else {
                    ruecksetzungen++;
                }
                assertThat(VerbrauchRegeln.ueberlauf(vorher, nachher, kadenz, null, hoechst)).isNull();
                assertThat(VerbrauchRegeln.ueberlauf(vorher, nachher, kadenz, modul, null)).isNull();
            }
        }
        assertThat(ueberlaeufe).as("F7 10:03").isPositive();
        assertThat(ruecksetzungen).as("F6, F7 10:20, F12").isPositive();
    }

    static List<Rohwert> rohwerte(JsonNode reihe) {
        List<Rohwert> out = new ArrayList<>();
        for (JsonNode a : reihe.path("rohwerte")) {
            boolean gut = !"bad".equals(a.path("q").asText("good"));
            if (a.has("t")) {
                out.add(new Rohwert(VerbrauchRegeln.zeit(a.path("t").asText()), a.path("v").decimalValue(), gut));
                continue;
            }
            Instant von = VerbrauchRegeln.zeit(a.path("von").asText());
            Instant bis = VerbrauchRegeln.zeit(a.path("bis").asText());
            Duration schritt = Duration.ofSeconds(a.path("kadenz_s").asLong());
            BigDecimal stand = dezimal(a.path("stand_von"), BigDecimal.ZERO);
            BigDecimal zuwachs = dezimal(a.path("zuwachs_je_kadenz"), BigDecimal.ZERO);
            Instant t = von;
            long i = 0;
            while (!t.isAfter(bis)) {
                out.add(new Rohwert(t, stand.add(zuwachs.multiply(BigDecimal.valueOf(i))), gut));
                t = t.plus(schritt);
                i++;
            }
        }
        for (JsonNode l : reihe.path("luecken")) {
            Instant von = VerbrauchRegeln.zeit(l.path("von").asText());
            Instant bis = VerbrauchRegeln.zeit(l.path("bis").asText());
            out = new ArrayList<>(out.stream()
                    .filter(r -> r.zeit().isBefore(von) || !r.zeit().isBefore(bis))
                    .toList());
        }
        out.sort(Comparator.comparing(Rohwert::zeit));
        return out;
    }

    static List<Ereignis> ereignisse(JsonNode array) {
        List<Ereignis> out = new ArrayList<>();
        array.forEach(e -> out.add(new Ereignis(
                e.path("art").asText(),
                VerbrauchRegeln.zeit(e.path("t").asText()),
                // Die Uhrzeit, wie die Meldung sie trägt: Stunde und Minute des Zeitpunkts.
                e.path("t").asText().substring(11, 16),
                dezimal(e.path("endstand"), null),
                dezimal(e.path("anfangsstand"), null),
                e.path("verlust_s").asLong(Ereignis.VERLUST_VORGABE))));
        return out;
    }

    /** Jede Zahl über ihre Textform - so erbt die Rechnung keine Binärbruch-Fehler. */
    static BigDecimal dezimal(JsonNode n, BigDecimal vorgabe) {
        if (n.isMissingNode() || n.isNull()) {
            return vorgabe;
        }
        return n.isTextual() ? new BigDecimal(n.asText()) : n.decimalValue();
    }
}
