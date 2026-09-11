package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des UEMS-Referenzunternehmens „Kunststoffwerk Ahrenberg GmbH“
 * (AP-00 §8 IP-2): die EINE geteilte Vektor-Datei
 * {@code docs/contracts/v2/uems-referenzunternehmen.json} hält die Form ihres
 * Schemas und die Invarianten des Fachmodells — und der TS-Zwilling
 * ({@code frontend/portal/src/uemsReferenzunternehmen.test.ts}) fährt DIESELBE
 * Datei mit DENSELBEN Prüfungen.
 *
 * <p>Die Datei ist die einzige Quelle: hier steht kein abgeschriebener Wert.
 * Die Abnahme-Zahlen (21 Messstellen, 3 Anlagen, 3 Boxen, 2 Standorte,
 * 5 Gebäude) sind bewusst als Zahl gepinnt — sie sind der Umfang, den AP-00
 * §4.4 zusagt.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class UemsReferenzunternehmenVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt
    // zwei Ebenen darüber.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.json");
    private static final Path SCHEMA =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-referenzunternehmen.schema.json");

    /** Ende einer offenen Gültigkeit — „bis auf Weiteres“. */
    private static final OffsetDateTime OFFEN = OffsetDateTime.parse("9999-12-31T00:00:00+00:00");

    private static JsonNode daten() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static JsonNode schema() throws Exception {
        return MAPPER.readTree(Files.readString(SCHEMA));
    }

    // ---------------------------------------------------------------- Form

    /**
     * Die Datei hält ihr eigenes Schema. Das Projekt hat keine
     * Schema-Bibliothek (siehe {@code services/api/pom.xml}), deshalb prüft der
     * kleine {@link UemsSchemaLaeufer} über die Teilmenge von draft 2020-12, die
     * das Schema benutzt. Der TS-Zwilling läuft byte-gleich denselben Läufer.
     */
    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(daten(), schema()))
                .as("Schema-Verstöße")
                .isEmpty();
    }

    @Test
    void derUmfangDesReferenzunternehmensStimmt() throws Exception {
        JsonNode d = daten();
        OffsetDateTime jetzt = zeit(d.at("/unternehmen/momentaufnahme").asText());

        assertThat(d.get("standorte")).as("Standorte").hasSize(2);
        assertThat(d.get("gebaeude")).as("Gebäude").hasSize(5);
        assertThat(d.get("bereiche")).as("Bereiche").hasSize(7);
        assertThat(d.get("prozesse")).as("Prozesse").hasSize(6);
        assertThat(d.get("netzanschluesse")).as("Netzanschlüsse").hasSize(3);
        assertThat(d.get("anlagen")).as("Anlagen").hasSize(3);
        assertThat(d.get("datenquellen")).as("Datenquellen").hasSize(7);
        assertThat(d.get("geraete")).as("Geräte").hasSize(10);
        assertThat(d.get("messstellen")).as("Messstellen").hasSize(21);

        // Boxen, Komponenten und Kostenstellen tragen auch Objekte, die erst
        // NACH der Momentaufnahme entstehen (Nachfolger-Box E-2′, Energiekarte
        // EK-7, die Aufteilung der Kostenstelle 9000). AP-00 §4.4 zählt den
        // Stand zur Momentaufnahme.
        assertThat(imBetrieb(d.get("boxen"), jetzt, "in_betrieb_ab", "ausgebaut_am"))
                .as("Boxen zur Momentaufnahme").hasSize(3);
        assertThat(imBetrieb(d.get("komponenten"), jetzt, "in_betrieb_ab", "in_betrieb_bis"))
                .as("Komponenten zur Momentaufnahme").hasSize(15);
        assertThat(imBetrieb(d.get("kostenstellen"), jetzt, "gueltig_ab", "gueltig_bis"))
                .as("Kostenstellen zur Momentaufnahme").hasSize(5);

        long gemessen = kinder(d.get("messstellen")).stream()
                .filter(m -> "gemessen".equals(m.get("art").asText())).count();
        long berechnet = kinder(d.get("messstellen")).stream()
                .filter(m -> "berechnet".equals(m.get("art").asText())).count();
        assertThat(gemessen).as("gemessene Messstellen (16 elektrisch + MS-21 Gas)").isEqualTo(17);
        assertThat(berechnet).as("berechnete Messstellen").isEqualTo(4);
    }

    // --------------------------------------------------------- Kennzeichen

    @Test
    void jedesKennzeichenIstEindeutig() throws Exception {
        Map<String, String> gesehen = new LinkedHashMap<>();
        List<String> fehler = new ArrayList<>();
        kennzeichenRegister(daten(), gesehen, fehler);
        assertThat(fehler).as("doppelte Kennzeichen").isEmpty();
        assertThat(gesehen).as("Kennzeichen insgesamt").isNotEmpty();
    }

    @TestFactory
    List<DynamicTest> jederVerweisZeigtAufEinExistierendesKennzeichen() throws Exception {
        JsonNode d = daten();
        Map<String, String> reg = new LinkedHashMap<>();
        kennzeichenRegister(d, reg, new ArrayList<>());

        List<DynamicTest> tests = new ArrayList<>();
        for (Verweis v : verweise(d)) {
            tests.add(DynamicTest.dynamicTest(v.beschreibung() + " -> " + v.ziel(), () -> {
                assertThat(reg).as(v.beschreibung()).containsKey(v.ziel());
                assertThat(reg.get(v.ziel())).as(v.beschreibung() + ": falsche Gattung")
                        .isIn((Object[]) v.gattungen());
            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    // --------------------------------------------------------- Invarianten

    /**
     * AP-00 §4.5 Regel 1, verfeinert durch AP-04 E1: Bezug und Abgabe sind zwei
     * Messstellen desselben physischen Zählers (MS-01/MS-02 an AN-1). Deshalb
     * gilt: je Anlage und Richtung GENAU EIN Hauptzähler, und alle Hauptzähler
     * einer Anlage hängen an DERSELBEN Komponente.
     */
    @Test
    void genauEinHauptzaehlerJeAnlageUndRichtung() throws Exception {
        JsonNode d = daten();
        OffsetDateTime jetzt = zeit(d.at("/unternehmen/momentaufnahme").asText());
        Map<String, List<JsonNode>> haupt = new LinkedHashMap<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            for (JsonNode st : kinder(m.get("elektrische_stellung"))) {
                if ("Hauptzähler".equals(st.get("stellung").asText()) && gilt(st, jetzt)) {
                    haupt.computeIfAbsent(st.get("anlage").asText(), k -> new ArrayList<>()).add(m);
                }
            }
        }
        for (JsonNode a : kinder(d.get("anlagen"))) {
            String an = a.get("kennzeichen").asText();
            List<JsonNode> ms = haupt.getOrDefault(an, List.of());
            assertThat(ms).as(an + ": Hauptzähler").isNotEmpty();

            Set<String> richtungen = new LinkedHashSet<>();
            for (JsonNode m : ms) {
                String r = m.at("/hauptgroesse/richtung").asText();
                assertThat(richtungen.add(r))
                        .as(an + ": zwei Hauptzähler mit Richtung " + r).isTrue();
            }
            Set<String> komponenten = new LinkedHashSet<>();
            for (JsonNode m : ms) {
                for (JsonNode q : kinder(m.get("fuehrende_quelle"))) {
                    if (gilt(q, jetzt)) {
                        komponenten.add(q.get("komponente").asText());
                    }
                }
            }
            assertThat(komponenten)
                    .as(an + ": alle Hauptzähler auf EINEM physischen Zähler").hasSizeLessThan(2);
        }
    }

    /** AP-00 §4.5 Regel 3: die Anteile eines Zeitpunkts ergeben 100 %. */
    @TestFactory
    List<DynamicTest> kostenstellenAnteileErgeben100Prozent() throws Exception {
        JsonNode d = daten();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            for (OffsetDateTime t : stichzeitpunkte(m.get("kostenstellen_anteile"))) {
                tests.add(DynamicTest.dynamicTest(kz + " @ " + t, () -> {
                    double summe = 0;
                    for (JsonNode k : kinder(m.get("kostenstellen_anteile"))) {
                        if (gilt(k, t)) {
                            summe += k.get("anteil_prozent").asDouble();
                        }
                    }
                    assertThat(summe).as(kz + ": Summe der Anteile").isEqualTo(100.0);
                }));
            }
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * AP-00 §4.5 Regel 2: eine GEMESSENE Messstelle hat je Zeitpunkt genau
     * einen Ort. Eine BERECHNETE hat höchstens einen — MS-20 „Prozess
     * Spritzguss gesamt“ läuft über zwei Gebäude und trägt deshalb keinen
     * (AP-00 §4.4 selbst).
     */
    @TestFactory
    List<DynamicTest> jedeMessstelleHatGenauEinenOrt() throws Exception {
        JsonNode d = daten();
        OffsetDateTime jetzt = zeit(d.at("/unternehmen/momentaufnahme").asText());
        Map<String, List<JsonNode>> orte = zuordnungenNach(d, "messstelle_ort");

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            tests.add(DynamicTest.dynamicTest(kz, () -> {
                List<JsonNode> zs = orte.getOrDefault(kz, List.of());
                assertThat(ueberlappungen(zs)).as(kz + ": Ort-Zeiträume überlappen").isEmpty();

                List<JsonNode> jetztGueltig =
                        zs.stream().filter(z -> gilt(z, jetzt)).toList();
                if ("gemessen".equals(m.get("art").asText())) {
                    assertThat(jetztGueltig).as(kz + ": Orte zur Momentaufnahme").hasSize(1);
                } else {
                    assertThat(jetztGueltig).as(kz + ": Orte zur Momentaufnahme").hasSizeLessThan(2);
                }

                JsonNode ort = m.get("ort");
                if (jetztGueltig.isEmpty()) {
                    assertThat(ort.get("art").asText())
                            .as(kz + ": ohne Zuordnung darf kein Ort behauptet werden")
                            .isEqualTo("keiner");
                } else {
                    assertThat(ort.get("kennzeichen").asText())
                            .as(kz + ": Ort-Feld gegen die Zuordnung")
                            .isEqualTo(jetztGueltig.get(0).get("nach").asText());
                }
            }));
        }
        return tests;
    }

    /** AP-00 §4.5 Regel 2: je Größe und Zeitpunkt höchstens eine führende Quelle. */
    @TestFactory
    List<DynamicTest> hoechstensEineFuehrendeQuelleJeZeitpunkt() throws Exception {
        JsonNode d = daten();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            Map<String, JsonNode> gruppen = new LinkedHashMap<>();
            gruppen.put("Hauptgröße", m.get("fuehrende_quelle"));
            for (JsonNode ng : kinder(m.get("nebengroessen"))) {
                gruppen.put("Nebengröße " + ng.get("groesse").asText(), ng.get("fuehrende_quelle"));
            }
            gruppen.forEach((name, qs) -> tests.add(DynamicTest.dynamicTest(kz + " · " + name, () ->
                    assertThat(ueberlappungen(kinder(qs)))
                            .as(kz + " " + name + ": zwei führende Quellen gleichzeitig").isEmpty())));
        }
        return tests;
    }

    /**
     * AP-06 E1: je Datenquelle und Zeitpunkt GENAU EINE zuständige Box — die
     * Zeiträume stoßen auf die Minute aneinander, ohne Lücke und ohne
     * Überlappung, und der letzte bleibt offen.
     */
    @TestFactory
    List<DynamicTest> jedeDatenquelleHatJeZeitpunktGenauEineBox() throws Exception {
        JsonNode d = daten();
        Map<String, List<JsonNode>> nachQuelle = zuordnungenNach(d, "datenquelle_box");

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode q : kinder(d.get("datenquellen"))) {
            String kz = q.get("kennzeichen").asText();
            tests.add(DynamicTest.dynamicTest(kz, () -> {
                List<JsonNode> zs = new ArrayList<>(nachQuelle.getOrDefault(kz, List.of()));
                assertThat(zs).as(kz + ": zuständige Box").isNotEmpty();
                zs.sort(Comparator.comparing(z -> zeit(z.get("gueltig_ab").asText())));
                for (int i = 0; i < zs.size() - 1; i++) {
                    assertThat(ende(zs.get(i)))
                            .as(kz + ": Lücke oder Überlappung der Zuständigkeit")
                            .isEqualTo(zeit(zs.get(i + 1).get("gueltig_ab").asText()));
                }
                assertThat(ende(zs.get(zs.size() - 1)))
                        .as(kz + ": die letzte Zuständigkeit bleibt offen").isEqualTo(OFFEN);
            }));
        }
        return tests;
    }

    /** AP-06 E3: je Anlage genau eine führende Box, die zur Momentaufnahme läuft. */
    @TestFactory
    List<DynamicTest> jedeAnlageHatGenauEineFuehrendeBox() throws Exception {
        JsonNode d = daten();
        OffsetDateTime jetzt = zeit(d.at("/unternehmen/momentaufnahme").asText());
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode a : kinder(d.get("anlagen"))) {
            String an = a.get("kennzeichen").asText();
            tests.add(DynamicTest.dynamicTest(an, () -> {
                List<JsonNode> fuehrend = kinder(d.get("boxen")).stream()
                        .filter(b -> an.equals(text(b, "fuehrend_fuer")))
                        .filter(b -> laeuft(b, jetzt, "in_betrieb_ab", "ausgebaut_am"))
                        .toList();
                assertThat(fuehrend).as(an + ": führende Boxen zur Momentaufnahme").hasSize(1);
            }));
        }
        return tests;
    }

    /**
     * AP-04 E12: „Unterzähler von“ verweist auf eine Messstelle DERSELBEN
     * Anlage, nie auf sich selbst.
     */
    @Test
    void unterzaehlerVerweisenInDerselbenAnlage() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> ms = new LinkedHashMap<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            ms.put(m.get("kennzeichen").asText(), m);
        }
        List<String> fehler = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            for (JsonNode st : kinder(m.get("elektrische_stellung"))) {
                String eltern = text(st, "unterzaehler_von");
                boolean istUnterzaehler = "Unterzähler".equals(st.get("stellung").asText());
                if (!istUnterzaehler) {
                    if (eltern != null) {
                        fehler.add(kz + ": „Unterzähler von“ ohne Stellung „Unterzähler“");
                    }
                    continue;
                }
                if (eltern == null) {
                    fehler.add(kz + ": Stellung „Unterzähler“ ohne übergeordnete Messstelle");
                    continue;
                }
                if (eltern.equals(kz)) {
                    fehler.add(kz + ": Unterzähler von sich selbst");
                    continue;
                }
                OffsetDateTime ab = zeit(st.get("gueltig_ab").asText());
                boolean gleicheAnlage = kinder(ms.get(eltern).get("elektrische_stellung")).stream()
                        .anyMatch(e -> gilt(e, ab)
                                && e.get("anlage").asText().equals(st.get("anlage").asText()));
                if (!gleicheAnlage) {
                    fehler.add(kz + " · " + st.get("anlage").asText()
                            + ": " + eltern + " gehört zu dieser Zeit nicht zu derselben Anlage");
                }
            }
        }
        assertThat(fehler).as("elektrischer Baum").isEmpty();
    }

    /** Eine Quellenbindung nennt Gerät und Einbau, die wirklich zur Komponente gehören. */
    @Test
    void dieHerkunftJederQuelleIstInSichStimmig() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> komp = new LinkedHashMap<>();
        for (JsonNode k : kinder(d.get("komponenten"))) {
            komp.put(k.get("kennzeichen").asText(), k);
        }
        Map<String, Set<String>> einbauten = new LinkedHashMap<>();
        for (JsonNode g : kinder(d.get("geraete"))) {
            Set<String> e = new LinkedHashSet<>();
            for (JsonNode i : kinder(g.get("einbauten"))) {
                e.add(i.get("kennzeichen").asText());
            }
            einbauten.put(g.get("kennzeichen").asText(), e);
        }
        List<String> fehler = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            for (JsonNode q : alleQuellen(m)) {
                String k = q.get("komponente").asText();
                String g = q.get("geraet").asText();
                if (!g.equals(komp.get(k).get("geraet").asText())) {
                    fehler.add(kz + ": " + k + " hängt an " + komp.get(k).get("geraet").asText()
                            + ", die Quelle nennt " + g);
                }
                if (!einbauten.get(g).contains(q.get("einbau").asText())) {
                    fehler.add(kz + ": Einbau " + q.get("einbau").asText() + " gehört nicht zu " + g);
                }
            }
        }
        assertThat(fehler).as("Herkunftskette").isEmpty();
    }

    @Test
    void dieZeitachseIstChronologisch() throws Exception {
        List<OffsetDateTime> zp = new ArrayList<>();
        for (JsonNode z : kinder(daten().get("zeitachse"))) {
            zp.add(zeit(z.get("zeitpunkt").asText()));
        }
        assertThat(zp).as("Zeitachse").isSortedAccordingTo(Comparator.naturalOrder());
        assertThat(zp).isNotEmpty();
    }

    @TestFactory
    List<DynamicTest> zuordnungsIntervalleUeberlappenNie() throws Exception {
        JsonNode d = daten();
        Map<String, List<JsonNode>> nachSchluessel = new LinkedHashMap<>();
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            nachSchluessel
                    .computeIfAbsent(z.get("art").asText() + " · " + z.get("von").asText(),
                            k -> new ArrayList<>())
                    .add(z);
        }
        List<DynamicTest> tests = new ArrayList<>();
        nachSchluessel.forEach((name, zs) -> tests.add(DynamicTest.dynamicTest(name, () ->
                assertThat(ueberlappungen(zs)).as(name).isEmpty())));

        // Auch die Gültigkeiten, die AN einem Objekt hängen, überlappen nie.
        for (JsonNode o : kinder(d.get("standorte"))) {
            tests.add(flaechenTest("Standort " + o.get("kennzeichen").asText(), o));
        }
        for (JsonNode o : kinder(d.get("gebaeude"))) {
            tests.add(flaechenTest("Gebäude " + o.get("kennzeichen").asText(), o));
        }
        for (JsonNode g : kinder(d.get("geraete"))) {
            tests.add(DynamicTest.dynamicTest("Einbauten " + g.get("kennzeichen").asText(), () ->
                    assertThat(ueberlappungen(kinder(g.get("einbauten")))).isEmpty()));
        }
        for (JsonNode k : kinder(d.get("komponenten"))) {
            tests.add(DynamicTest.dynamicTest("Wandler " + k.get("kennzeichen").asText(), () ->
                    assertThat(ueberlappungen(kinder(k.get("wandler")))).isEmpty()));
        }
        for (JsonNode m : kinder(d.get("messstellen"))) {
            tests.add(DynamicTest.dynamicTest("Stellung " + m.get("kennzeichen").asText(), () ->
                    assertThat(ueberlappungen(kinder(m.get("elektrische_stellung")))).isEmpty()));
        }
        return tests;
    }

    /**
     * Ehrlichkeit der Zahlen: eine Messstelle OHNE führende Quelle behauptet
     * keine Kadenz in Sekunden, und ein fehlender Wert ist {@code null}, nie 0.
     */
    @Test
    void eineMessstelleOhneQuelleBehauptetKeineKadenz() throws Exception {
        List<String> fehler = new ArrayList<>();
        for (JsonNode m : kinder(daten().get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            boolean hatQuelle = !kinder(m.get("fuehrende_quelle")).isEmpty();
            boolean hatKadenz = m.hasNonNull("kadenz_s");
            if (!hatQuelle && hatKadenz) {
                fehler.add(kz + ": Kadenz in Sekunden ohne führende Quelle");
            }
            if (hatQuelle && !hatKadenz) {
                fehler.add(kz + ": führende Quelle ohne Kadenz");
            }
            if ("berechnet".equals(m.get("art").asText()) && !m.hasNonNull("formel")) {
                fehler.add(kz + ": berechnet ohne Formel");
            }
        }
        assertThat(fehler).as("Ehrlichkeit der Kadenz").isEmpty();
    }

    // ------------------------------------------------------------- Helfer

    private static DynamicTest flaechenTest(String name, JsonNode objekt) {
        return DynamicTest.dynamicTest("Flächen " + name, () ->
                assertThat(ueberlappungen(kinder(objekt.get("bezugsflaechen")))).isEmpty());
    }

    private static List<JsonNode> kinder(JsonNode array) {
        List<JsonNode> out = new ArrayList<>();
        if (array != null && array.isArray()) {
            array.forEach(out::add);
        }
        return out;
    }

    private static List<JsonNode> alleQuellen(JsonNode messstelle) {
        List<JsonNode> out = new ArrayList<>(kinder(messstelle.get("fuehrende_quelle")));
        for (JsonNode ng : kinder(messstelle.get("nebengroessen"))) {
            out.addAll(kinder(ng.get("fuehrende_quelle")));
        }
        return out;
    }

    private static String text(JsonNode o, String feld) {
        return o.hasNonNull(feld) ? o.get(feld).asText() : null;
    }

    private static OffsetDateTime zeit(String s) {
        return OffsetDateTime.parse(s);
    }

    private static OffsetDateTime ende(JsonNode o) {
        return o.hasNonNull("gueltig_bis") ? zeit(o.get("gueltig_bis").asText()) : OFFEN;
    }

    private static boolean gilt(JsonNode o, OffsetDateTime t) {
        OffsetDateTime ab = zeit(o.get("gueltig_ab").asText());
        return !t.isBefore(ab) && t.isBefore(ende(o));
    }

    private static boolean laeuft(JsonNode o, OffsetDateTime t, String abFeld, String bisFeld) {
        OffsetDateTime ab = zeit(o.get(abFeld).asText());
        OffsetDateTime bis = o.hasNonNull(bisFeld) ? zeit(o.get(bisFeld).asText()) : OFFEN;
        return !t.isBefore(ab) && t.isBefore(bis);
    }

    private static List<JsonNode> imBetrieb(JsonNode array, OffsetDateTime t,
            String abFeld, String bisFeld) {
        return kinder(array).stream().filter(o -> laeuft(o, t, abFeld, bisFeld)).toList();
    }

    /** Alle Zeitpunkte, an denen sich in einer Liste von Gültigkeiten etwas ändert. */
    private static List<OffsetDateTime> stichzeitpunkte(JsonNode array) {
        Set<OffsetDateTime> out = new LinkedHashSet<>();
        for (JsonNode o : kinder(array)) {
            out.add(zeit(o.get("gueltig_ab").asText()));
        }
        return new ArrayList<>(out);
    }

    /** Paare von Gültigkeiten, deren Zeiträume sich überschneiden. */
    private static List<String> ueberlappungen(List<JsonNode> objekte) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < objekte.size(); i++) {
            for (int j = i + 1; j < objekte.size(); j++) {
                JsonNode a = objekte.get(i);
                JsonNode b = objekte.get(j);
                OffsetDateTime aAb = zeit(a.get("gueltig_ab").asText());
                OffsetDateTime bAb = zeit(b.get("gueltig_ab").asText());
                if (aAb.isBefore(ende(b)) && bAb.isBefore(ende(a))) {
                    out.add(a.toString() + " ∩ " + b.toString());
                }
            }
        }
        return out;
    }

    private static Map<String, List<JsonNode>> zuordnungenNach(JsonNode d, String art)
            throws Exception {
        Map<String, List<JsonNode>> out = new LinkedHashMap<>();
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            if (art.equals(z.get("art").asText())) {
                out.computeIfAbsent(z.get("von").asText(), k -> new ArrayList<>()).add(z);
            }
        }
        return out;
    }

    private static void kennzeichenRegister(JsonNode d, Map<String, String> reg,
            List<String> fehler) {
        merke(reg, fehler, "unternehmen", d.at("/unternehmen/kennzeichen").asText());
        for (String s : List.of("standorte", "gebaeude", "bereiche", "prozesse", "kostenstellen",
                "netzanschluesse", "anlagen", "boxen", "datenquellen", "geraete", "komponenten",
                "messstellen", "bezugsgroessen")) {
            for (JsonNode o : kinder(d.get(s))) {
                merke(reg, fehler, s, o.get("kennzeichen").asText());
            }
        }
        for (JsonNode p : kinder(d.get("personen"))) {
            merke(reg, fehler, "personen", p.get("kuerzel").asText());
        }
        for (JsonNode g : kinder(d.get("geraete"))) {
            for (JsonNode e : kinder(g.get("einbauten"))) {
                String kz = e.get("kennzeichen").asText();
                if (!kz.equals(g.get("kennzeichen").asText())) {
                    merke(reg, fehler, "einbauten", kz);
                }
            }
        }
    }

    private static void merke(Map<String, String> reg, List<String> fehler, String gattung,
            String kz) {
        String alt = reg.put(kz, gattung);
        if (alt != null) {
            fehler.add(kz + " kommt in " + alt + " UND " + gattung + " vor");
        }
    }

    private record Verweis(String beschreibung, String ziel, String... gattungen) {}

    private static List<Verweis> verweise(JsonNode d) {
        List<Verweis> out = new ArrayList<>();
        for (JsonNode g : kinder(d.get("gebaeude"))) {
            out.add(new Verweis(g.get("kennzeichen").asText() + ".standort",
                    g.get("standort").asText(), "standorte"));
        }
        for (JsonNode b : kinder(d.get("bereiche"))) {
            out.add(new Verweis(b.get("kennzeichen").asText() + ".eltern",
                    b.get("eltern").asText(), "gebaeude", "standorte"));
        }
        for (JsonNode n : kinder(d.get("netzanschluesse"))) {
            out.add(new Verweis(n.get("kennzeichen").asText() + ".standort",
                    n.get("standort").asText(), "standorte"));
        }
        for (JsonNode a : kinder(d.get("anlagen"))) {
            String kz = a.get("kennzeichen").asText();
            out.add(new Verweis(kz + ".standort", a.get("standort").asText(), "standorte"));
            out.add(new Verweis(kz + ".netzanschluss", a.get("netzanschluss").asText(),
                    "netzanschluesse"));
            for (JsonNode g : kinder(a.get("versorgt_gebaeude"))) {
                out.add(new Verweis(kz + ".versorgt_gebaeude", g.asText(), "gebaeude"));
            }
        }
        for (JsonNode b : kinder(d.get("boxen"))) {
            String kz = b.get("kennzeichen").asText();
            out.add(new Verweis(kz + ".heimat_anlage", b.get("heimat_anlage").asText(), "anlagen"));
            if (b.hasNonNull("fuehrend_fuer")) {
                out.add(new Verweis(kz + ".fuehrend_fuer", b.get("fuehrend_fuer").asText(),
                        "anlagen"));
            }
            if (b.hasNonNull("ort")) {
                out.add(new Verweis(kz + ".ort", b.get("ort").asText(),
                        "bereiche", "gebaeude", "standorte"));
            }
            if (b.hasNonNull("vorgaenger")) {
                out.add(new Verweis(kz + ".vorgaenger", b.get("vorgaenger").asText(), "boxen"));
            }
        }
        for (JsonNode q : kinder(d.get("datenquellen"))) {
            out.add(new Verweis(q.get("kennzeichen").asText() + ".anlage",
                    q.get("anlage").asText(), "anlagen"));
        }
        for (JsonNode g : kinder(d.get("geraete"))) {
            out.add(new Verweis(g.get("kennzeichen").asText() + ".datenquelle",
                    g.get("datenquelle").asText(), "datenquellen"));
        }
        for (JsonNode k : kinder(d.get("komponenten"))) {
            String kz = k.get("kennzeichen").asText();
            out.add(new Verweis(kz + ".anlage", k.get("anlage").asText(), "anlagen"));
            out.add(new Verweis(kz + ".geraet", k.get("geraet").asText(), "geraete"));
            if (k.hasNonNull("ort")) {
                out.add(new Verweis(kz + ".ort", k.get("ort").asText(),
                        "bereiche", "gebaeude", "standorte"));
            }
        }
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            if (m.at("/ort/kennzeichen").isTextual()) {
                out.add(new Verweis(kz + ".ort", m.at("/ort/kennzeichen").asText(),
                        "standorte", "gebaeude", "bereiche", "unternehmen"));
            }
            for (JsonNode p : kinder(m.get("prozesse"))) {
                out.add(new Verweis(kz + ".prozess", p.asText(), "prozesse"));
            }
            for (JsonNode k : kinder(m.get("kostenstellen_anteile"))) {
                out.add(new Verweis(kz + ".kostenstelle", k.get("kostenstelle").asText(),
                        "kostenstellen"));
            }
            for (JsonNode st : kinder(m.get("elektrische_stellung"))) {
                out.add(new Verweis(kz + ".stellung.anlage", st.get("anlage").asText(), "anlagen"));
                if (st.hasNonNull("unterzaehler_von")) {
                    out.add(new Verweis(kz + ".unterzaehler_von",
                            st.get("unterzaehler_von").asText(), "messstellen"));
                }
            }
            for (JsonNode q : alleQuellen(m)) {
                out.add(new Verweis(kz + ".quelle.komponente", q.get("komponente").asText(),
                        "komponenten"));
                out.add(new Verweis(kz + ".quelle.geraet", q.get("geraet").asText(), "geraete"));
            }
        }
        for (JsonNode p : kinder(d.get("personen"))) {
            String kz = p.get("kuerzel").asText();
            for (JsonNode s : kinder(p.get("standorte"))) {
                out.add(new Verweis(kz + ".standort", s.asText(), "standorte"));
            }
            if (p.hasNonNull("unterstuetzung")) {
                out.add(new Verweis(kz + ".gewaehrt_von",
                        p.at("/unterstuetzung/gewaehrt_von").asText(), "personen"));
            }
        }
        for (JsonNode b : kinder(d.get("bezugsgroessen"))) {
            if ("prozess".equals(b.get("geltung_art").asText()) && b.hasNonNull("geltung")) {
                out.add(new Verweis(b.get("kennzeichen").asText() + ".geltung",
                        b.get("geltung").asText(), "prozesse"));
            }
        }
        Map<String, String[]> vonGattung = Map.of(
                "anlage_standort", new String[] {"anlagen"},
                "messstelle_ort", new String[] {"messstellen"},
                "datenquelle_box", new String[] {"datenquellen"});
        Map<String, String[]> nachGattung = Map.of(
                "anlage_standort", new String[] {"standorte"},
                "messstelle_ort", new String[] {"standorte", "gebaeude", "bereiche", "unternehmen"},
                "datenquelle_box", new String[] {"boxen"});
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            String art = z.get("art").asText();
            out.add(new Verweis(art + ".von", z.get("von").asText(), vonGattung.get(art)));
            out.add(new Verweis(art + ".nach", z.get("nach").asText(), nachGattung.get(art)));
        }
        return out;
    }
}
