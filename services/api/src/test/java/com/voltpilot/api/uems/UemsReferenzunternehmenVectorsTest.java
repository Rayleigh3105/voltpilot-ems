package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Rueckwirkung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungErgebnis;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
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
 * <p>Zwei Zeitformen, je nach Entscheid: tagesgenaue Gültigkeiten (AP-02 E9 —
 * Orte, Anlage → Standort, Messstelle → Ort, Stellung, Kostenstellen, Anteile,
 * Flächen) sind Kalendertage mit dem LETZTEN gültigen Tag als {@code gueltig_bis};
 * alles auf die Minute (Quellen, Einbauten, Wandler, Datenquelle → Box) ist
 * halboffen. Jede Prüfung liest die Form, die ihre Daten haben — umgerechnet
 * wird nichts; „zur Momentaufnahme“ heißt für einen Tag: an deren Kalendertag
 * in der Zeitzone des Unternehmens.
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

    /** Die Zuordnungs-Arten, die tagesgenau gelten (AP-02 E9); alle anderen gelten auf die Minute. */
    private static final Set<String> TAGESGENAU = Set.of("ort_eltern", "anlage_standort", "messstelle_ort");

    /** Das Unternehmen als Ort (Ortsbaum-Vertrag, {@code regeln.unternehmen_kennzeichen}). */
    private static final String UNTERNEHMEN = "U";

    /** Das Abzeichen eines rückwirkenden Eintrags, wo immer die Datei es nennt. */
    private static final Pattern ABZEICHEN = Pattern.compile("rückwirkend \\([0-9]+ Tage?\\)");

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
        assertThat(d.get("messstellen")).as("Messstellen").hasSize(22);

        // Boxen, Komponenten und Kostenstellen tragen auch Objekte, die erst
        // NACH der Momentaufnahme entstehen (Nachfolger-Box E-2′, Energiekarte
        // EK-7, die Aufteilung der Kostenstelle 9000). AP-00 §4.4 zählt den
        // Stand zur Momentaufnahme.
        assertThat(imBetrieb(d.get("boxen"), jetzt, "in_betrieb_ab", "ausgebaut_am"))
                .as("Boxen zur Momentaufnahme").hasSize(3);
        assertThat(imBetrieb(d.get("komponenten"), jetzt, "in_betrieb_ab", "in_betrieb_bis"))
                .as("Komponenten zur Momentaufnahme").hasSize(15);
        LocalDate heute = tagVon(jetzt, zone(d));
        assertThat(kinder(d.get("kostenstellen")).stream().filter(k -> giltAm(k, heute)).toList())
                .as("Kostenstellen zur Momentaufnahme").hasSize(5);

        long gemessen = kinder(d.get("messstellen")).stream()
                .filter(m -> "gemessen".equals(m.get("art").asText())).count();
        long berechnet = kinder(d.get("messstellen")).stream()
                .filter(m -> "berechnet".equals(m.get("art").asText())).count();
        assertThat(gemessen).as("gemessene Messstellen (16 elektrisch + MS-21 Gas)").isEqualTo(17);
        // Fassung 1.2 (AP-10 E19): MS-22 „Lindach nicht zugeordnet“ ist der Rest der
        // Bilanz von AN-3 — ohne ihn hätte Lindach eine unsichtbare Bilanzdifferenz.
        assertThat(berechnet).as("berechnete Messstellen").isEqualTo(5);
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
        LocalDate heute = tagVon(jetzt, zone(d));
        Map<String, List<JsonNode>> haupt = new LinkedHashMap<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            for (JsonNode st : kinder(m.get("elektrische_stellung"))) {
                if ("Hauptzähler".equals(st.get("stellung").asText()) && giltAm(st, heute)) {
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

    /** AP-00 §4.5 Regel 3: die Anteile eines Tages ergeben 100 %. */
    @TestFactory
    List<DynamicTest> kostenstellenAnteileErgeben100Prozent() throws Exception {
        JsonNode d = daten();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            for (LocalDate t : stichtage(m.get("kostenstellen_anteile"))) {
                tests.add(DynamicTest.dynamicTest(kz + " @ " + t, () -> {
                    double summe = 0;
                    for (JsonNode k : kinder(m.get("kostenstellen_anteile"))) {
                        if (giltAm(k, t)) {
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
        LocalDate heute = tagVon(zeit(d.at("/unternehmen/momentaufnahme").asText()), zone(d));
        Map<String, List<JsonNode>> orte = zuordnungenNach(d, "messstelle_ort");

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            tests.add(DynamicTest.dynamicTest(kz, () -> {
                List<JsonNode> zs = orte.getOrDefault(kz, List.of());
                assertThat(ueberlappungenTage(zs)).as(kz + ": Ort-Zeiträume überlappen").isEmpty();

                List<JsonNode> jetztGueltig =
                        zs.stream().filter(z -> giltAm(z, heute)).toList();
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
     * AP-04 E3 / §4.3: Vergleichsquellen gibt es beliebig viele — aber nicht DENSELBEN
     * Messwert zweimal zur selben Zeit, und nie denselben Messwert zugleich als
     * führende Quelle derselben Größe. Der Zweck ist Pflicht (Schema).
     */
    @TestFactory
    List<DynamicTest> vergleichsquellenUeberlappenNieUndFuehrenNie() throws Exception {
        JsonNode d = daten();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            Map<String, JsonNode> gruppen = new LinkedHashMap<>();
            gruppen.put("Hauptgröße", m);
            for (JsonNode ng : kinder(m.get("nebengroessen"))) {
                gruppen.put("Nebengröße " + ng.get("groesse").asText(), ng);
            }
            gruppen.forEach((name, g) -> tests.add(DynamicTest.dynamicTest(kz + " · " + name, () -> {
                List<JsonNode> vergleich = kinder(g.get("vergleichsquellen"));
                for (JsonNode v : vergleich) {
                    List<JsonNode> derselbeMesswert = new ArrayList<>();
                    for (JsonNode x : vergleich) {
                        if (x.get("komponente").equals(v.get("komponente")) && x.get("kanal").equals(v.get("kanal"))) {
                            derselbeMesswert.add(x);
                        }
                    }
                    assertThat(ueberlappungen(derselbeMesswert)).as(kz + " " + name + ": derselbe Messwert zweimal").isEmpty();
                    for (JsonNode f : kinder(g.get("fuehrende_quelle"))) {
                        if (f.get("komponente").equals(v.get("komponente")) && f.get("kanal").equals(v.get("kanal"))) {
                            assertThat(ueberlappungen(List.of(f, v))).as(kz + " " + name + ": zugleich führend und Vergleich").isEmpty();
                        }
                    }
                }
            })));
        }
        assertThat(kinder(d.get("messstellen")).stream().mapToInt(m -> alleVergleichsquellen(m).size()).sum())
                .as("Vergleichsquellen im Referenzunternehmen").isPositive();
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
                LocalDate ab = tag(st.get("gueltig_ab").asText());
                boolean gleicheAnlage = kinder(ms.get(eltern).get("elektrische_stellung")).stream()
                        .anyMatch(e -> giltAm(e, ab)
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
            List<JsonNode> quellen = new ArrayList<>(alleQuellen(m));
            quellen.addAll(alleVergleichsquellen(m));
            for (JsonNode q : quellen) {
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
                assertThat(TAGESGENAU.contains(zs.get(0).get("art").asText())
                        ? ueberlappungenTage(zs) : ueberlappungen(zs)).as(name).isEmpty())));

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
                    assertThat(ueberlappungenTage(kinder(m.get("elektrische_stellung")))).isEmpty()));
        }
        return tests;
    }

    /**
     * Eine Änderung beendet die alte Gültigkeit und beginnt eine neue (AP-00 §4.5
     * Regel 4) — ohne Loch und ohne doppelten Tag: tagesgenau beginnt die neue am
     * Tag NACH dem letzten der alten (Ortsbaum: „neues ab beendet das laufende am
     * Vortag“), auf die Minute ist Ende der alten = Beginn der neuen. Und ein Tag
     * „bis“ liegt nie vor seinem „ab“.
     */
    @TestFactory
    List<DynamicTest> jederWechselStoesstAn() throws Exception {
        JsonNode d = daten();
        Map<String, List<JsonNode>> tage = new LinkedHashMap<>();
        Map<String, List<JsonNode>> minuten = new LinkedHashMap<>();
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            String art = z.get("art").asText();
            (TAGESGENAU.contains(art) ? tage : minuten)
                    .computeIfAbsent(art + " · " + z.get("von").asText(), k -> new ArrayList<>()).add(z);
        }
        for (String liste : List.of("standorte", "gebaeude")) {
            for (JsonNode o : kinder(d.get(liste))) {
                tage.put("Flächen " + o.get("kennzeichen").asText(), kinder(o.get("bezugsflaechen")));
            }
        }
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            tage.put("Stellung " + kz, kinder(m.get("elektrische_stellung")));
            minuten.put("Quelle " + kz, kinder(m.get("fuehrende_quelle")));
            for (JsonNode ng : kinder(m.get("nebengroessen"))) {
                minuten.put("Quelle " + kz + " · " + ng.get("groesse").asText(), kinder(ng.get("fuehrende_quelle")));
            }
        }
        for (JsonNode g : kinder(d.get("geraete"))) {
            minuten.put("Einbauten " + g.get("kennzeichen").asText(), kinder(g.get("einbauten")));
        }
        for (JsonNode k : kinder(d.get("komponenten"))) {
            minuten.put("Wandler " + k.get("kennzeichen").asText(), kinder(k.get("wandler")));
        }

        List<DynamicTest> tests = new ArrayList<>();
        tage.forEach((name, kette) -> tests.add(DynamicTest.dynamicTest(name, () -> {
            for (JsonNode o : kette) {
                assertThat(letzterTag(o)).as(name + ": „bis“ vor „ab“").isAfterOrEqualTo(tag(o.get("gueltig_ab").asText()));
            }
            List<JsonNode> s = new ArrayList<>(kette);
            s.sort(Comparator.comparing(o -> tag(o.get("gueltig_ab").asText())));
            for (int i = 0; i < s.size() - 1; i++) {
                assertThat(letzterTag(s.get(i)).plusDays(1))
                        .as(name + ": die neue beginnt am Tag nach dem letzten der alten")
                        .isEqualTo(tag(s.get(i + 1).get("gueltig_ab").asText()));
            }
        })));
        minuten.forEach((name, kette) -> tests.add(DynamicTest.dynamicTest(name, () -> {
            List<JsonNode> s = new ArrayList<>(kette);
            s.sort(Comparator.comparing(o -> zeit(o.get("gueltig_ab").asText())));
            for (int i = 0; i < s.size() - 1; i++) {
                assertThat(ende(s.get(i))).as(name + ": Ende der alten = Beginn der neuen")
                        .isEqualTo(zeit(s.get(i + 1).get("gueltig_ab").asText()));
            }
        })));
        return tests;
    }

    /**
     * Ortsbaum-Vertrag Regel 1 ({@code ziel_gab_es_noch_nicht}): eine tagesgenaue
     * Zuordnung hängt an jedem ihrer Tage an einem Ort, den es an diesem Tag gibt.
     * Ein Ort besteht, solange seine {@code ort_eltern}-Zuordnungen laufen; das
     * Unternehmen (U) besteht, seit es Kunde ist.
     */
    @TestFactory
    List<DynamicTest> keineZuordnungBeginntVorIhremZiel() throws Exception {
        JsonNode d = daten();
        ZoneId zone = zone(d);
        LocalDate unternehmenSeit = tagVon(zeit(d.at("/unternehmen/kunde_seit").asText()), zone);
        Map<String, List<JsonNode>> bestehen = zuordnungenNach(d, "ort_eltern");

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            if (!TAGESGENAU.contains(z.get("art").asText()) || !z.hasNonNull("nach")) {
                continue;
            }
            String ziel = z.get("nach").asText();
            LocalDate ab = tag(z.get("gueltig_ab").asText());
            String name = z.get("art").asText() + " · " + z.get("von").asText() + " → " + ziel + " ab " + ab;
            tests.add(DynamicTest.dynamicTest(name, () -> {
                if (UNTERNEHMEN.equals(ziel)) {
                    assertThat(ab).as(name + ": vor dem Unternehmen").isAfterOrEqualTo(unternehmenSeit);
                } else {
                    assertThat(ersterFehlenderTag(bestehen.getOrDefault(ziel, List.of()), ab, letzterTag(z)))
                            .as(name + ": an diesem Tag gab es " + ziel + " noch nicht").isNull();
                }
            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * AP-02 E2: ein rückwirkender Eintrag ist erlaubt — aber sichtbar. Wer
     * {@code eingetragen_am} trägt, liegt vor diesem Tag und trägt GENAU das
     * Abzeichen, das der Ortsbaum-Vertrag bildet (Tage = Eintragstag − gilt ab,
     * {@code a3-anbau-14-tage-nicht-15}). Die Zeitachse nennt kein anderes.
     */
    @TestFactory
    List<DynamicTest> jederRueckwirkendeEintragTraegtDasAbzeichenDesOrtsbaumVertrags() throws Exception {
        JsonNode d = daten();
        ZoneId zone = zone(d);
        Map<String, JsonNode> eintraege = new LinkedHashMap<>();
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            if (TAGESGENAU.contains(z.get("art").asText())) {
                eintraege.put(z.get("art").asText() + " · " + z.get("von").asText() + " ab "
                        + z.get("gueltig_ab").asText(), z);
            }
        }
        for (String liste : List.of("standorte", "gebaeude")) {
            for (JsonNode o : kinder(d.get(liste))) {
                for (JsonNode f : kinder(o.get("bezugsflaechen"))) {
                    eintraege.put("Fläche " + o.get("kennzeichen").asText() + " ab " + f.get("gueltig_ab").asText(), f);
                }
            }
        }
        Set<String> abzeichen = new LinkedHashSet<>();
        List<DynamicTest> tests = new ArrayList<>();
        eintraege.forEach((name, e) -> {
            if (!e.has("eingetragen_am") && !e.has("abzeichen")) {
                return;
            }
            abzeichen.add(text(e, "abzeichen"));
            tests.add(DynamicTest.dynamicTest(name, () -> {
                assertThat(e.hasNonNull("eingetragen_am") && e.hasNonNull("abzeichen"))
                        .as(name + ": Eintragstag und Abzeichen gehören zusammen").isTrue();
                RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                        tag(e.get("eingetragen_am").asText()).atStartOfDay(zone).toOffsetDateTime(),
                        tag(e.get("gueltig_ab").asText()),
                        e.hasNonNull("gueltig_bis") ? tag(e.get("gueltig_bis").asText()) : null,
                        zone, null));
                assertThat(r.art()).as(name + ": rückwirkend eingetragen").isEqualTo(Rueckwirkung.RUECKWIRKEND);
                assertThat(e.get("abzeichen").asText()).as(name).isEqualTo(r.abzeichen());
            }));
        });
        tests.add(DynamicTest.dynamicTest("Zeitachse nennt nur diese Abzeichen", () -> {
            for (JsonNode z : kinder(d.get("zeitachse"))) {
                Matcher m = ABZEICHEN.matcher(z.get("ereignis").asText());
                while (m.find()) {
                    assertThat(abzeichen).as(z.get("zeitpunkt").asText()).contains(m.group());
                }
            }
        }));
        assertThat(abzeichen).as("rückwirkende Einträge").isNotEmpty();
        return tests;
    }

    /**
     * Jeder Ort hängt zeitgültig an seinem Elternknoten (Art {@code ort_eltern}) —
     * ein Gebäude an einem Standort, ein Bereich an einem Gebäude oder direkt am
     * Standort, ein Standort an keinem (sein Bestehen). Die festen Felder
     * {@code gebaeude[].standort} und {@code bereiche[].eltern} sind der Stand zur
     * Momentaufnahme.
     */
    @TestFactory
    List<DynamicTest> jederOrtHaengtZeitgueltigAnSeinemElternknoten() throws Exception {
        JsonNode d = daten();
        LocalDate heute = tagVon(zeit(d.at("/unternehmen/momentaufnahme").asText()), zone(d));
        Map<String, List<JsonNode>> bestehen = zuordnungenNach(d, "ort_eltern");
        Map<String, String> fest = new LinkedHashMap<>();
        Map<String, Set<String>> erlaubt = new LinkedHashMap<>();
        for (JsonNode s : kinder(d.get("standorte"))) {
            fest.put(s.get("kennzeichen").asText(), null);
            erlaubt.put(s.get("kennzeichen").asText(), Set.of());
        }
        Set<String> standorte = new LinkedHashSet<>(fest.keySet());
        for (JsonNode g : kinder(d.get("gebaeude"))) {
            fest.put(g.get("kennzeichen").asText(), g.get("standort").asText());
            erlaubt.put(g.get("kennzeichen").asText(), standorte);
        }
        Set<String> gebaeudeUndStandorte = new LinkedHashSet<>(standorte);
        kinder(d.get("gebaeude")).forEach(g -> gebaeudeUndStandorte.add(g.get("kennzeichen").asText()));
        for (JsonNode b : kinder(d.get("bereiche"))) {
            fest.put(b.get("kennzeichen").asText(), b.get("eltern").asText());
            erlaubt.put(b.get("kennzeichen").asText(), gebaeudeUndStandorte);
        }

        List<DynamicTest> tests = new ArrayList<>();
        fest.forEach((ort, elternJetzt) -> tests.add(DynamicTest.dynamicTest(ort, () -> {
            List<JsonNode> zs = bestehen.getOrDefault(ort, List.of());
            assertThat(zs).as(ort + ": ohne Zuordnung an einen Elternknoten").isNotEmpty();
            for (JsonNode z : zs) {
                String nach = text(z, "nach");
                if (erlaubt.get(ort).isEmpty()) {
                    assertThat(nach).as(ort + ": ein Standort hängt an keinem Elternknoten").isNull();
                } else {
                    assertThat(erlaubt.get(ort)).as(ort + " → " + nach).contains(nach);
                }
            }
            List<JsonNode> jetzt = zs.stream().filter(z -> giltAm(z, heute)).toList();
            assertThat(jetzt).as(ort + ": zur Momentaufnahme").hasSize(1);
            assertThat(text(jetzt.get(0), "nach")).as(ort + ": festes Feld gegen die Zuordnung").isEqualTo(elternJetzt);
        })));
        return tests;
    }

    /**
     * AP-03 E6/A4 (Entscheid firstmate 11.09.2026): das Enddatum einer Unterstützung ist ein
     * Kalendertag und gilt einschließlich; nur ein Notfall-Zugriff (E8) endet auf die Minute, genau
     * 24 h nach seinem Beginn. Die Zeitachse nennt den Ablauf zu dem Zeitpunkt, den der
     * Rechte-Vertrag daraus bildet ({@link RechteAbleitung#bisZeitpunkt(String)}).
     */
    @TestFactory
    List<DynamicTest> jedeUnterstuetzungEndetMitIhremEnddatum() throws Exception {
        JsonNode d = daten();
        Set<OffsetDateTime> zeitachse = new LinkedHashSet<>();
        kinder(d.get("zeitachse")).forEach(z -> zeitachse.add(zeit(z.get("zeitpunkt").asText())));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode p : kinder(d.get("personen"))) {
            if (!"unterstuetzer".equals(p.get("art").asText())) {
                continue;
            }
            String kz = p.get("kuerzel").asText();
            tests.add(DynamicTest.dynamicTest(kz, () -> {
                String bis = text(p, "gueltig_bis");
                assertThat(bis).as(kz + ": eine Unterstützung hat immer ein Ende (E6)").isNotNull();
                boolean notfall = p.at("/unterstuetzung/art").asText().startsWith("Notfall");
                if (notfall) {
                    assertThat(zeit(bis)).as(kz + ": Notfall genau 24 h").isEqualTo(zeit(p.get("seit").asText()).plusHours(24));
                } else {
                    assertThat(bis).as(kz + ": Enddatum ist ein Kalendertag").matches("[0-9]{4}-[0-9]{2}-[0-9]{2}");
                }
                OffsetDateTime ablauf = RechteAbleitung.bisZeitpunkt(bis).atOffset(ZoneOffset.UTC);
                assertThat(zeitachse.stream().anyMatch(t -> t.isEqual(ablauf)))
                        .as(kz + ": die Zeitachse nennt den Ablauf " + ablauf).isTrue();
            }));
        }
        assertThat(tests).as("Unterstützungen im Referenzunternehmen").isNotEmpty();
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

    // ------------------------------------------------------- Fassung 1.2

    /**
     * AP-10 E19: jede BERECHNETE Messstelle nennt ihren Formel-Typ aus dem
     * geschlossenen Vokabular von {@code messstelle-formel.md} §0, jede gemessene
     * nennt keinen. Der Typ entscheidet die Richtungsregel — er darf deshalb nicht
     * fehlen und nicht geraten werden.
     */
    @Test
    void jedeBerechneteMessstelleNenntIhrenFormelTyp() throws Exception {
        Set<String> vokabular = Set.of("gewichtete_summe", "rest", "saldo");
        List<String> fehler = new ArrayList<>();
        for (JsonNode m : kinder(daten().get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            boolean berechnet = "berechnet".equals(m.get("art").asText());
            if (berechnet && !m.hasNonNull("formel_typ")) {
                fehler.add(kz + ": berechnet ohne formel_typ");
            } else if (berechnet && !vokabular.contains(m.get("formel_typ").asText())) {
                fehler.add(kz + ": formel_typ außerhalb des Vokabulars: " + m.get("formel_typ").asText());
            } else if (!berechnet && m.hasNonNull("formel_typ")) {
                fehler.add(kz + ": gemessen, trägt aber einen formel_typ");
            }
        }
        assertThat(fehler).as("Formel-Typ je berechneter Messstelle").isEmpty();
    }

    /**
     * AP-10 §4 (E1/E3): jede berechnete Messstelle der Datei rechnet aus den
     * Beispielwerten ihrer EIGENEN Eingänge genau ihren eigenen Beispielwert.
     * Diese Prüfung ist der Nachweis der Berichtigung W10: MS-09 ist 54 580 kWh,
     * weil ihre Formel aus ihren Eingängen 54 580 ergibt — die 52 600 der Fassung
     * 1.1 folgten aus keiner Rechnung. Der Speicher geht mit ZWEI Anteilen ein
     * (Laden als Abfluss, Entladen als Zufluss), nie als Saldo (E4).
     */
    @TestFactory
    List<DynamicTest> jedeBerechneteMessstelleRechnetIhrenOktoberWert() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> ms = new LinkedHashMap<>();
        kinder(d.get("messstellen")).forEach(m -> ms.put(m.get("kennzeichen").asText(), m));

        // Je berechneter Messstelle: die Summanden ihrer Formel mit Vorzeichen und
        // Faktor, wörtlich abgelesen aus dem Feld `formel` der Datei selbst.
        Map<String, List<Summand>> rechnungen = new LinkedHashMap<>();
        rechnungen.put("MS-09", List.of(
                new Summand("MS-01", 1, "oktober_2026_kwh"), new Summand("MS-03", 1, "oktober_2026_kwh"),
                new Summand("MS-04", 1, "oktober_2026_entladen_kwh"), new Summand("MS-02", -1, "oktober_2026_kwh"),
                new Summand("MS-04", -1, "oktober_2026_laden_kwh"), new Summand("MS-05", -1, "oktober_2026_kwh"),
                new Summand("MS-06", -1, "oktober_2026_kwh"), new Summand("MS-07", -1, "oktober_2026_kwh"),
                new Summand("MS-08", -1, "oktober_2026_kwh")));
        rechnungen.put("MS-15", List.of(
                new Summand("MS-10", 1, "oktober_2026_kwh"), new Summand("MS-11", -1, "oktober_2026_kwh"),
                new Summand("MS-12", -1, "oktober_2026_kwh"), new Summand("MS-13", -1, "oktober_2026_kwh"),
                new Summand("MS-14", -1, "oktober_2026_kwh")));
        rechnungen.put("MS-19", List.of(
                new Summand("MS-01", 1, "oktober_2026_kwh"), new Summand("MS-10", 1, "oktober_2026_kwh"),
                new Summand("MS-16", 1, "oktober_2026_kwh")));
        rechnungen.put("MS-20", List.of(
                new Summand("MS-06", 1, "oktober_2026_kwh"), new Summand("MS-11", 1, "oktober_2026_kwh"),
                new Summand("MS-07", 0.7, "oktober_2026_kwh")));
        rechnungen.put("MS-22", List.of(
                new Summand("MS-16", 1, "oktober_2026_kwh"), new Summand("MS-17", -1, "oktober_2026_kwh"),
                new Summand("MS-18", -1, "oktober_2026_kwh")));

        List<DynamicTest> tests = new ArrayList<>();
        rechnungen.forEach((kz, summanden) -> tests.add(DynamicTest.dynamicTest(
                kz + " · Oktober 2026", () -> {
            assertThat(ms).as("die berechnete Messstelle steht in der Datei").containsKey(kz);
            double summe = 0;
            for (Summand t : summanden) {
                JsonNode quelle = ms.get(t.messstelle()).get("beispielwerte").get(t.feld());
                assertThat(quelle).as(kz + ": Eingang " + t.messstelle() + "." + t.feld())
                        .isNotNull();
                assertThat(quelle.isNull()).as(kz + ": Eingang " + t.messstelle() + "." + t.feld()
                        + " ist leer — eine Bilanz ohne Eingang ist „keine Werte“, nie 0").isFalse();
                summe += t.faktor() * quelle.asDouble();
            }
            assertThat(summe).as(kz + ": die Formel rechnet ihren eigenen Beispielwert")
                    .isEqualTo(ms.get(kz).at("/beispielwerte/oktober_2026_kwh").asDouble());
        })));
        return tests;
    }

    /**
     * Die PLAN-ABNAHME des Captains (AP-10 F1), an der Datei nachgerechnet:
     * 100 kWh am Hauptzähler, 60 und 30 kWh an den beiden Unterzählern — also
     * 100 kWh Gesamtverbrauch des Systems und 10 kWh Bilanzdifferenz. Die Richtung
     * bleibt „Bezug“ (Bezug − Bezug), der Rest hat keinen Ort und kein Gerät.
     */
    @Test
    void diePlanAbnahmeDesWerksLindachRechnetAmTagDerAbnahme() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> ms = new LinkedHashMap<>();
        kinder(d.get("messstellen")).forEach(m -> ms.put(m.get("kennzeichen").asText(), m));
        String feld = "/beispielwerte/tag_2026_10_18_kwh";

        double haupt = ms.get("MS-16").at(feld).asDouble();
        double u1 = ms.get("MS-17").at(feld).asDouble();
        double u2 = ms.get("MS-18").at(feld).asDouble();
        double rest = ms.get("MS-22").at(feld).asDouble();

        assertThat(haupt - u1 - u2).as("Bilanzdifferenz am 18.10.2026").isEqualTo(rest);
        assertThat(haupt).as("Gesamtverbrauch des Systems = Zufluss am Hauptzähler")
                .isEqualTo(u1 + u2 + rest);
        assertThat(ms.get("MS-22").at("/hauptgroesse/richtung").asText())
                .as("Bezug − Bezug bleibt Bezug (AP-10 E1)").isEqualTo("Bezug");
        assertThat(ms.get("MS-22").at("/ort/art").asText())
                .as("ein Rest über zwei Gebäude trägt keinen Ort").isEqualTo("keiner");
        assertThat(kinder(ms.get("MS-22").get("fuehrende_quelle")))
                .as("ein Rest hat kein Gerät").isEmpty();

        // Die drei Eingänge sind genau die Stellung, aus der der Rest abgeleitet wird.
        assertThat(ms.get("MS-16").at("/elektrische_stellung/0/stellung").asText()).isEqualTo("Hauptzähler");
        for (String kz : List.of("MS-17", "MS-18")) {
            assertThat(ms.get(kz).at("/elektrische_stellung/0/stellung").asText()).isEqualTo("Unterzähler");
            assertThat(ms.get(kz).at("/elektrische_stellung/0/unterzaehler_von").asText()).isEqualTo("MS-16");
        }
    }

    /**
     * AP-10 W8: ein Kostenstellen-Anteil gilt nie über das Bestehen seiner
     * Kostenstelle hinaus. Läuft die Kostenstelle aus, endet der Anteil mit ihr —
     * danach ist die Messstelle ehrlich „nicht verteilt“, nie still umgehängt.
     */
    @TestFactory
    List<DynamicTest> keinAnteilGiltLaengerAlsSeineKostenstelle() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> kostenstellen = new LinkedHashMap<>();
        kinder(d.get("kostenstellen")).forEach(k -> kostenstellen.put(k.get("kennzeichen").asText(), k));

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            for (JsonNode a : kinder(m.get("kostenstellen_anteile"))) {
                String ziel = a.get("kostenstelle").asText();
                tests.add(DynamicTest.dynamicTest(kz + " -> " + ziel, () -> {
                    JsonNode k = kostenstellen.get(ziel);
                    assertThat(k).as(kz + ": Kostenstelle " + ziel).isNotNull();
                    assertThat(tag(a.get("gueltig_ab").asText()))
                            .as(kz + " -> " + ziel + ": der Anteil beginnt vor der Kostenstelle")
                            .isAfterOrEqualTo(tag(k.get("gueltig_ab").asText()));
                    assertThat(letzterTag(a))
                            .as(kz + " -> " + ziel + ": der Anteil gilt länger als die Kostenstelle")
                            .isBeforeOrEqualTo(letzterTag(k));
                }));
            }
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * AP-09 W5: eine Ablesung ist ein STAND zu einem Zeitpunkt. Die Stände steigen
     * (ein Rücksprung wäre ein Zählerwechsel, nie eine negative Menge), die ERSTE
     * Ablesung schließt keinen Zeitraum und trägt deshalb keine Monatszuordnung,
     * und ein zugeordneter Monat wird von seinem Ablesezeitraum tatsächlich berührt —
     * zwischen zwei Ablesungen wird nichts interpoliert.
     */
    @TestFactory
    List<DynamicTest> dieAblesungenSindEineLueckenloseKetteVonStaenden() throws Exception {
        JsonNode d = daten();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            String kz = m.get("kennzeichen").asText();
            List<JsonNode> ablesungen = kinder(m.get("ablesungen"));
            if (ablesungen.isEmpty()) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest("Ablesungen " + kz, () -> {
                assertThat(kinder(m.get("fuehrende_quelle")))
                        .as(kz + ": eine abgelesene Messstelle hat keinen Kanal").isEmpty();
                for (int i = 0; i < ablesungen.size(); i++) {
                    JsonNode a = ablesungen.get(i);
                    assertThat(a.get("einheit").asText())
                            .as(kz + ": die Ablesung misst die Hauptgröße")
                            .isEqualTo(m.at("/hauptgroesse/einheit").asText());
                    if (i == 0) {
                        assertThat(a.get("zuordnung_monat").isNull())
                                .as(kz + ": die erste Ablesung schließt keinen Zeitraum und ordnet keinen Monat zu")
                                .isTrue();
                        continue;
                    }
                    JsonNode vor = ablesungen.get(i - 1);
                    assertThat(zeit(a.get("zeitpunkt").asText()))
                            .as(kz + ": die Ablesungen stehen in der Reihenfolge ihrer Zeitpunkte")
                            .isAfter(zeit(vor.get("zeitpunkt").asText()));
                    assertThat(a.get("stand").asDouble())
                            .as(kz + ": ein kleinerer Stand ist ein Zählerwechsel, nie eine negative Menge")
                            .isGreaterThanOrEqualTo(vor.get("stand").asDouble());
                    if (a.hasNonNull("zuordnung_monat")) {
                        ZoneId zone = zone(d);
                        LocalDate von = tagVon(zeit(vor.get("zeitpunkt").asText()), zone);
                        LocalDate bis = tagVon(zeit(a.get("zeitpunkt").asText()), zone);
                        String monat = a.get("zuordnung_monat").asText();
                        assertThat(monat.compareTo(von.toString().substring(0, 7)) >= 0
                                        && monat.compareTo(bis.toString().substring(0, 7)) <= 0)
                                .as(kz + ": der zugeordnete Monat " + monat
                                        + " wird vom Ablesezeitraum berührt").isTrue();
                    }
                }
            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * AP-09 E1/E4/E7 (W5): die Kennungen einer Bezugsgröße stehen im GESCHLOSSENEN
     * Vokabular des Bezugsdaten-Vertrags, nicht in einer eigenen Schreibweise. Der
     * freie Text der Fassung 1.1 („kg Granulat“) bleibt daneben stehen; der Stoff
     * wandert nicht in die Einheit. Und eine Größe, die an einer Messstelle hängt,
     * nennt genau eine — keine andere trägt das Feld.
     */
    @Test
    void jedeBezugsgroesseNutztDasGeschlosseneVokabularDesBezugsdatenVertrags() throws Exception {
        JsonNode vertrag = MAPPER.readTree(Files.readString(
                Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json")));
        Set<String> einheiten = new LinkedHashSet<>();
        vertrag.get("einheiten").forEach(g -> g.forEach(e -> einheiten.add(e.asText())));
        Set<String> perioden = new LinkedHashSet<>();
        vertrag.at("/vokabulare/periode_art").forEach(e -> perioden.add(e.asText()));
        Set<String> wertarten = new LinkedHashSet<>();
        vertrag.at("/vokabulare/wertart").forEach(e -> wertarten.add(e.asText()));
        Set<String> geltungsarten = new LinkedHashSet<>();
        vertrag.at("/vokabulare/geltung_art").forEach(e -> geltungsarten.add(e.asText()));
        // Die Fassung 1.1 kennt zusätzlich „ort“ für eine Größe, die an vielen Orten
        // hängt (BZ-4 Bezugsfläche) — sie bleibt unverändert gültig.
        geltungsarten.add("ort");

        List<String> fehler = new ArrayList<>();
        for (JsonNode b : kinder(daten().get("bezugsgroessen"))) {
            String kz = b.get("kennzeichen").asText();
            if (b.hasNonNull("einheit_code") && !einheiten.contains(b.get("einheit_code").asText())) {
                fehler.add(kz + ": einheit_code außerhalb des Vokabulars: " + b.get("einheit_code").asText());
            }
            if (!b.hasNonNull("einheit_code")) {
                fehler.add(kz + ": ohne einheit_code");
            } else if (!b.get("einheit").asText().startsWith(b.get("einheit_code").asText())) {
                fehler.add(kz + ": einheit_code passt nicht zum Text „" + b.get("einheit").asText() + "“");
            }
            if (b.hasNonNull("periode_code") && !perioden.contains(b.get("periode_code").asText())) {
                fehler.add(kz + ": periode_code außerhalb des Vokabulars: " + b.get("periode_code").asText());
            }
            if (!b.hasNonNull("wertart") || !wertarten.contains(b.get("wertart").asText())) {
                fehler.add(kz + ": wertart fehlt oder steht außerhalb des Vokabulars");
            }
            // Ein Stammdatum gilt zeitlich; es hat keine Periode, und ein Periodenwert
            // hat immer eine — „null“ heißt hier „keine“, nie „unbekannt“.
            boolean stammdatum = "stammdatum".equals(b.path("wertart").asText());
            if (stammdatum == b.hasNonNull("periode_code")) {
                fehler.add(kz + ": Wertart und periode_code passen nicht zusammen");
            }
            if (!geltungsarten.contains(b.get("geltung_art").asText())) {
                fehler.add(kz + ": geltung_art außerhalb des Vokabulars: " + b.get("geltung_art").asText());
            }
            if ("messstelle".equals(b.get("geltung_art").asText()) != b.hasNonNull("messstelle")) {
                fehler.add(kz + ": das Feld `messstelle` gehört genau zur geltung_art „messstelle“");
            }
        }
        assertThat(fehler).as("Bezugsgrößen gegen das Vokabular des Bezugsdaten-Vertrags").isEmpty();
    }

    /** Ein Summand einer Formel: welche Messstelle, mit welchem Faktor, aus welchem Beispielwert. */
    private record Summand(String messstelle, double faktor, String feld) {}

    // ------------------------------------------------------------- Helfer

    private static DynamicTest flaechenTest(String name, JsonNode objekt) {
        return DynamicTest.dynamicTest("Flächen " + name, () ->
                assertThat(ueberlappungenTage(kinder(objekt.get("bezugsflaechen")))).isEmpty());
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

    private static List<JsonNode> alleVergleichsquellen(JsonNode messstelle) {
        List<JsonNode> out = new ArrayList<>(kinder(messstelle.get("vergleichsquellen")));
        for (JsonNode ng : kinder(messstelle.get("nebengroessen"))) {
            out.addAll(kinder(ng.get("vergleichsquellen")));
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

    // Tagesgenau (AP-02 E9): „gueltig_ab“ ist ein Tag, „gueltig_bis“ der LETZTE gültige Tag.

    private static ZoneId zone(JsonNode d) {
        return ZoneId.of(d.at("/unternehmen/zeitzone").asText());
    }

    private static LocalDate tag(String s) {
        return LocalDate.parse(s);
    }

    /** Der Kalendertag eines Zeitpunkts in der Zeitzone des Unternehmens. */
    private static LocalDate tagVon(OffsetDateTime t, ZoneId zone) {
        return t.atZoneSameInstant(zone).toLocalDate();
    }

    /** Der letzte gültige Tag, einschließlich; offen heißt „bis auf Weiteres“. */
    private static LocalDate letzterTag(JsonNode o) {
        return o.hasNonNull("gueltig_bis") ? tag(o.get("gueltig_bis").asText()) : LocalDate.MAX;
    }

    private static boolean giltAm(JsonNode o, LocalDate t) {
        return !t.isBefore(tag(o.get("gueltig_ab").asText())) && !t.isAfter(letzterTag(o));
    }

    /** Alle Tage, an denen sich in einer Liste tagesgenauer Gültigkeiten etwas ändert. */
    private static List<LocalDate> stichtage(JsonNode array) {
        Set<LocalDate> out = new LinkedHashSet<>();
        for (JsonNode o : kinder(array)) {
            out.add(tag(o.get("gueltig_ab").asText()));
        }
        return new ArrayList<>(out);
    }

    /** Paare tagesgenauer Gültigkeiten, die sich einen Tag teilen. */
    private static List<String> ueberlappungenTage(List<JsonNode> objekte) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < objekte.size(); i++) {
            for (int j = i + 1; j < objekte.size(); j++) {
                JsonNode a = objekte.get(i);
                JsonNode b = objekte.get(j);
                if (!tag(a.get("gueltig_ab").asText()).isAfter(letzterTag(b))
                        && !tag(b.get("gueltig_ab").asText()).isAfter(letzterTag(a))) {
                    out.add(a.toString() + " ∩ " + b.toString());
                }
            }
        }
        return out;
    }

    /** Der erste Tag in [von, bis], an dem keine der Gültigkeiten gilt — null, wenn sie ihn durchgehend decken. */
    private static LocalDate ersterFehlenderTag(List<JsonNode> gueltigkeiten, LocalDate von, LocalDate bis) {
        LocalDate t = von;
        while (true) {
            LocalDate stichtag = t;
            JsonNode deckt = gueltigkeiten.stream().filter(g -> giltAm(g, stichtag)).findFirst().orElse(null);
            if (deckt == null) {
                return t;
            }
            LocalDate ende = letzterTag(deckt);
            if (!ende.isBefore(bis)) {
                return null;
            }
            t = ende.plusDays(1);
        }
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
            for (JsonNode q : alleVergleichsquellen(m)) {
                out.add(new Verweis(kz + ".vergleich.komponente", q.get("komponente").asText(),
                        "komponenten"));
                out.add(new Verweis(kz + ".vergleich.geraet", q.get("geraet").asText(), "geraete"));
            }
            // Fassung 1.2 (AP-09 W5): wer abgelesen hat, ist eine Person dieser Datei.
            for (JsonNode a : kinder(m.get("ablesungen"))) {
                out.add(new Verweis(kz + ".ablesung.abgelesen_von",
                        a.get("abgelesen_von").asText(), "personen"));
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
            // Fassung 1.2 (AP-09 E1/W5): eine Bezugsgröße kann an einer Messstelle hängen.
            if (b.hasNonNull("messstelle")) {
                out.add(new Verweis(b.get("kennzeichen").asText() + ".messstelle",
                        b.get("messstelle").asText(), "messstellen"));
            }
        }
        // Welcher Elternknoten wem erlaubt ist, prüft jederOrtHaengtZeitgueltigAnSeinemElternknoten.
        Map<String, String[]> vonGattung = Map.of(
                "ort_eltern", new String[] {"standorte", "gebaeude", "bereiche"},
                "anlage_standort", new String[] {"anlagen"},
                "messstelle_ort", new String[] {"messstellen"},
                "datenquelle_box", new String[] {"datenquellen"});
        Map<String, String[]> nachGattung = Map.of(
                "ort_eltern", new String[] {"standorte", "gebaeude"},
                "anlage_standort", new String[] {"standorte"},
                "messstelle_ort", new String[] {"standorte", "gebaeude", "bereiche", "unternehmen"},
                "datenquelle_box", new String[] {"boxen"});
        for (JsonNode z : kinder(d.get("zuordnungen"))) {
            String art = z.get("art").asText();
            out.add(new Verweis(art + ".von", z.get("von").asText(), vonGattung.get(art)));
            if (z.hasNonNull("nach")) {
                out.add(new Verweis(art + ".nach", z.get("nach").asText(), nachGattung.get(art)));
            }
        }
        return out;
    }
}
