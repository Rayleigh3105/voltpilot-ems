package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Rueckwirkung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungErgebnis;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.IntStream;
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
        assertThat(d.get("prozesse")).as("Prozesse").hasSize(7);
        assertThat(d.get("netzanschluesse")).as("Netzanschlüsse").hasSize(3);
        assertThat(d.get("anlagen")).as("Anlagen").hasSize(3);
        // Fassung 1.5 (AP-15 E8): DQ-8 … DQ-10 mit GR-11 … GR-18 an Box Verwaltung.
        assertThat(d.get("datenquellen")).as("Datenquellen").hasSize(10);
        assertThat(d.get("geraete")).as("Geräte").hasSize(19);
        assertThat(d.get("messstellen")).as("Messstellen").hasSize(23);
        // Fassung 1.3 (AP-11 E13): BZ-6 und BZ-7 als Gebäude-Stückzahlen, fünf Kennzahlen.
        assertThat(d.get("bezugsgroessen")).as("Bezugsgrößen").hasSize(7);
        assertThat(d.get("kennzahlen")).as("Kennzahlen").hasSize(5);
        // Fassung 1.5 (AP-15 E8): eine gemeinsame Steuerung mit Grenzen an NA-1, die Abnahmefälle R1 … R22.
        assertThat(d.get("netzanschluss_grenzen")).as("Netzanschluss-Grenzen").hasSize(1);
        assertThat(d.get("gemeinsame_steuerungen")).as("Gemeinsame Steuerungen").hasSize(1);
        assertThat(d.at("/abnahmefaelle_ap15/faelle")).as("Abnahmefälle AP-15").hasSize(22);

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
        assertThat(gemessen).as("gemessene Messstellen (17 elektrisch + MS-21 Gas)").isEqualTo(18);
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

                LocalDate stichtag = zs.stream().anyMatch(z -> giltAm(z, heute)) || zs.isEmpty()
                        ? heute
                        : zs.stream().map(z -> tag(z.get("gueltig_ab").asText())).min(LocalDate::compareTo).orElse(heute);
                List<JsonNode> jetztGueltig =
                        zs.stream().filter(z -> giltAm(z, stichtag)).toList();
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

    // ------------------------------------------------------- Fassung 1.3 (AP-11 IP-2, E13)

    /**
     * Der Fingerabdruck der Fassung 1.2, {@link #kanonisch} geschrieben und aus {@code origin/uems}
     * vor AP-11 IP-2 berechnet (14.09.2026). Der TS-Zwilling trägt denselben Wert.
     */
    static final String FASSUNG_1_2_SHA256 = "33d0893e68193b0503b2dfcd6903e1f5743fb53f6ff49019a52221c0d73d25bd";

    /** So viele Zeilen hatte {@code _comment} in Fassung 1.2 — Fassung 1.3 hängt nur an. */
    static final int KOMMENTAR_ZEILEN_1_2 = 64;

    /**
     * Diff-Test (AP-11 IP-2): nimmt man GENAU die Zusätze der Fassung 1.3 heraus — BZ-6 und BZ-7, den
     * Block {@code kennzahlen}, die Zeile der Zeitachse vom 03.11.2026, die Herkunft {@code fassung_1_3}
     * und die angehängten Kommentarzeilen — und setzt Fassung und Stand zurück, ist die Datei Zeichen für
     * Zeichen die Fassung 1.2. Kein Feld hat seinen Wert geändert, keins ist verschwunden.
     */
    @Test
    void ohneDieZusaetzeDerFassung13IstEsDieFassung12() throws Exception {
        ObjectNode d = daten().deepCopy();
        ohneFassung17(d);
        ohneFassung16(d);
        ohneFassung15(d);
        ohneFassung14(d);
        assertThat(d.path("version").asText()).isEqualTo("1.3");
        d.put("version", "1.2");
        d.put("stand", "2026-09-12");
        ArrayNode kommentar = (ArrayNode) d.get("_comment");
        assertThat(kommentar.size()).as("_comment wächst nur hinten").isGreaterThan(KOMMENTAR_ZEILEN_1_2);
        while (kommentar.size() > KOMMENTAR_ZEILEN_1_2) {
            kommentar.remove(kommentar.size() - 1);
        }
        assertThat(((ObjectNode) d.get("_herkunft")).remove("fassung_1_3")).as("_herkunft.fassung_1_3").isNotNull();
        entferne((ArrayNode) d.get("bezugsgroessen"),
                b -> List.of("BZ-6", "BZ-7").contains(b.path("kennzeichen").asText()), 2);
        assertThat(d.remove("kennzahlen")).as("kennzahlen").isNotNull();
        entferne((ArrayNode) d.get("zeitachse"),
                z -> z.path("zeitpunkt").asText().equals("2026-11-03T00:00:00+01:00")
                        && z.path("herkunft").asText().startsWith("AP-11"), 1);
        assertThat(sha256(kanonisch(d))).as("Fingerabdruck der Fassung 1.2").isEqualTo(FASSUNG_1_2_SHA256);
    }

    /**
     * Fassung 1.3: BZ-6 + BZ-7 = BZ-2; jede Kennzahl rechnet ihren Oktoberwert aus den Werten, auf die
     * ihre Kennzeichen zeigen (beim Stammdatum die Fläche am letzten Tag); eine Zusammenfassung ist
     * Summe durch Summe ihrer Paare und nie die festgehaltene Zahl, die NICHT entsteht;
     * {@code kennzahl_beispiel} ist KZ-0004 auf 2 Stellen.
     */
    @Test
    void dieKennzahlenDerFassung13RechnenAusIhrenKennzeichen() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> bz = new LinkedHashMap<>();
        kinder(d.get("bezugsgroessen")).forEach(b -> bz.put(b.get("kennzeichen").asText(), b));
        Map<String, JsonNode> kz = new LinkedHashMap<>();
        kinder(d.get("kennzahlen")).forEach(k -> kz.put(k.get("kennzeichen").asText(), k));
        assertThat(kz.keySet()).containsExactly("KZ-0001", "KZ-0002", "KZ-0003", "KZ-0004", "KZ-0005");
        assertThat(bz.get("BZ-6").get("oktober_2026_wert").decimalValue()
                .add(bz.get("BZ-7").get("oktober_2026_wert").decimalValue()))
                .as("BZ-6 + BZ-7 = BZ-2")
                .isEqualByComparingTo(bz.get("BZ-2").get("oktober_2026_wert").decimalValue());

        List<String> fehler = new ArrayList<>();
        for (JsonNode k : kz.values()) {
            String name = k.get("kennzeichen").asText();
            BigDecimal zaehler = k.get("oktober_2026_zaehler").decimalValue();
            BigDecimal nenner = k.get("oktober_2026_nenner").decimalValue();
            BigDecimal gespeichert = k.get("oktober_2026_wert").decimalValue();
            if ("zusammenfassung".equals(k.get("rechenform").asText())) {
                BigDecimal summeZ = BigDecimal.ZERO;
                BigDecimal summeN = BigDecimal.ZERO;
                for (JsonNode p : kinder(k.get("paare"))) {
                    summeZ = summeZ.add(kz.get(p.asText()).get("oktober_2026_zaehler").decimalValue());
                    summeN = summeN.add(kz.get(p.asText()).get("oktober_2026_nenner").decimalValue());
                }
                if (summeZ.compareTo(zaehler) != 0 || summeN.compareTo(nenner) != 0) {
                    fehler.add(name + ": Zähler und Nenner sind nicht die Summen der Paare");
                }
                if (k.hasNonNull("mittel_ungewichtet_nicht_gebildet")
                        && k.get("mittel_ungewichtet_nicht_gebildet").decimalValue().compareTo(gespeichert) == 0) {
                    fehler.add(name + ": der Wert ist die Zahl, die nicht entstehen darf");
                }
            } else {
                BigDecimal soll = k.hasNonNull("nenner_ort")
                        ? flaecheAm(d, k.get("nenner_ort").asText(), LocalDate.of(2026, 10, 31))
                        : bz.get(k.get("nenner").asText()).get("oktober_2026_wert").decimalValue();
                if (soll == null || soll.compareTo(nenner) != 0) {
                    fehler.add(name + ": Nenner " + nenner + " ist nicht der Wert von " + k.get("nenner").asText());
                }
            }
            BigDecimal wert = zaehler.divide(nenner, 4, RoundingMode.HALF_UP);
            if (wert.compareTo(gespeichert) != 0) {
                fehler.add(name + ": " + zaehler + " ÷ " + nenner + " = " + wert + ", nicht " + gespeichert);
            }
        }
        assertThat(fehler).isEmpty();
        assertThat(d.at("/kennzahl_beispiel/ergebnis").decimalValue())
                .as("kennzahl_beispiel = round(KZ-0004, 2)")
                .isEqualByComparingTo(kz.get("KZ-0004").get("oktober_2026_wert").decimalValue()
                        .setScale(2, RoundingMode.HALF_UP));
    }

    private static BigDecimal flaecheAm(JsonNode d, String gebaeude, LocalDate tag) {
        for (JsonNode g : kinder(d.get("gebaeude"))) {
            if (!g.get("kennzeichen").asText().equals(gebaeude)) {
                continue;
            }
            for (JsonNode f : kinder(g.get("bezugsflaechen"))) {
                LocalDate ab = LocalDate.parse(f.get("gueltig_ab").asText());
                LocalDate bis = f.hasNonNull("gueltig_bis") ? LocalDate.parse(f.get("gueltig_bis").asText()) : null;
                if (!tag.isBefore(ab) && (bis == null || !tag.isAfter(bis))) {
                    return f.get("flaeche_m2").decimalValue();
                }
            }
        }
        return null;
    }

    // ------------------------------------------------------- Fassung 1.4 (AP-12 IP-2, E15)

    /**
     * Der Fingerabdruck der Fassung 1.3, {@link #kanonisch} geschrieben und aus {@code origin/uems}
     * vor AP-12 IP-2 berechnet (15.09.2026). Der TS-Zwilling trägt denselben Wert.
     */
    static final String FASSUNG_1_3_SHA256 = "e65be4ed56d5f3cec687075f0a782c4e1807c82410f8962444272dc200424196";

    /** So viele Zeilen hatte {@code _comment} in Fassung 1.3 — Fassung 1.4 hängt nur an. */
    static final int KOMMENTAR_ZEILEN_1_3 = 80;

    /**
     * Nimmt GENAU die Zusätze der Fassung 1.4 heraus — die Blöcke {@code korrekturen} und {@code berichte},
     * die vier Zeilen der Zeitachse aus AP-12, die Herkunft {@code fassung_1_4} und die angehängten
     * Kommentarzeilen — und setzt Fassung und Stand auf 1.3 zurück.
     */
    static void ohneFassung14(ObjectNode d) {
        assertThat(d.path("version").asText()).isEqualTo("1.4");
        d.put("version", "1.3");
        d.put("stand", "2026-09-14");
        ArrayNode kommentar = (ArrayNode) d.get("_comment");
        assertThat(kommentar.size()).as("_comment wächst nur hinten").isGreaterThan(KOMMENTAR_ZEILEN_1_3);
        while (kommentar.size() > KOMMENTAR_ZEILEN_1_3) {
            kommentar.remove(kommentar.size() - 1);
        }
        assertThat(((ObjectNode) d.get("_herkunft")).remove("fassung_1_4")).as("_herkunft.fassung_1_4").isNotNull();
        assertThat(d.remove("korrekturen")).as("korrekturen").isNotNull();
        assertThat(d.remove("berichte")).as("berichte").isNotNull();
        entferne((ArrayNode) d.get("zeitachse"), z -> z.path("herkunft").asText().startsWith("AP-12"), 4);
    }

    /** Diff-Test (AP-12 IP-2): ohne ihre Zusätze ist die Datei Zeichen für Zeichen die Fassung 1.3. */
    @Test
    void ohneDieZusaetzeDerFassung14IstEsDieFassung13() throws Exception {
        ObjectNode d = daten().deepCopy();
        ohneFassung17(d);
        ohneFassung16(d);
        ohneFassung15(d);
        ohneFassung14(d);
        assertThat(sha256(kanonisch(d))).as("Fingerabdruck der Fassung 1.3").isEqualTo(FASSUNG_1_3_SHA256);
    }

    /**
     * Fassung 1.4: die Korrektur berichtigt die Zahl der Datei, ihre Folgen rechnen aus der Formel von MS-15 und den
     * Kennzahlen der Datei; Berichtsstand Nr. 1 zitiert die Zahl der Datei in Version 1, Nr. 2 die Korrektur in
     * Version 2; MS-15 ist in beiden die Formel; jeder Stand nennt nur Kennzeichen der Datei; Datenstand vor Freigabe;
     * Nr. 2 trägt den Datenstand der Kaskade (= Freigabe der Korrektur); „ersetzt durch“ zeigt auf den Nachfolger.
     */
    @Test
    void dieKorrekturUndDerBerichtDerFassung14StimmenMitDerDatei() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> ms = new LinkedHashMap<>();
        kinder(d.get("messstellen")).forEach(m -> ms.put(m.get("kennzeichen").asText(), m));
        Map<String, JsonNode> bz = new LinkedHashMap<>();
        kinder(d.get("bezugsgroessen")).forEach(b -> bz.put(b.get("kennzeichen").asText(), b));
        Map<String, JsonNode> kz = new LinkedHashMap<>();
        kinder(d.get("kennzahlen")).forEach(k -> kz.put(k.get("kennzeichen").asText(), k));
        Set<String> personen = new LinkedHashSet<>();
        kinder(d.get("personen")).forEach(p -> personen.add(p.get("kuerzel").asText()));
        Set<String> standorte = new LinkedHashSet<>();
        kinder(d.get("standorte")).forEach(s -> standorte.add(s.get("kennzeichen").asText()));
        List<String> fehler = new ArrayList<>();

        JsonNode k = d.at("/korrekturen/0");
        String reihe = k.get("reihe").asText();
        BigDecimal alt = k.get("alt_kwh").decimalValue();
        BigDecimal neu = k.get("neu_kwh").decimalValue();
        if (alt.compareTo(ms.get(reihe).at("/beispielwerte/oktober_2026_kwh").decimalValue()) != 0) {
            fehler.add("Korrektur: alt ist nicht die Oktober-Zahl von " + reihe);
        }
        if (!k.get("zeitraum_von").asText().equals("2026-10-01") || !k.get("zeitraum_bis").asText().equals("2026-10-31")
                || !k.get("periode").asText().equals("2026-10")) {
            fehler.add("Korrektur: Zeitraum ist nicht der Oktober 2026 mit letztem Tag");
        }
        if (!personen.contains(k.get("vorgeschlagen_von").asText()) || !personen.contains(k.get("freigegeben_von").asText())) {
            fehler.add("Korrektur: vorgeschlagen/freigegeben von einer Person, die es nicht gibt");
        }
        if (!zeit(k.get("vorgeschlagen_am").asText()).isBefore(zeit(k.get("freigegeben_am").asText()))) {
            fehler.add("Korrektur: freigegeben vor dem Vorschlag");
        }
        if (formel(ms, "MS-15", reihe, alt).compareTo(ms.get("MS-15").at("/beispielwerte/oktober_2026_kwh").decimalValue()) != 0) {
            fehler.add("MS-15 ist mit der Zahl der Datei nicht seine Formel");
        }
        Map<String, BigDecimal> soll = new LinkedHashMap<>();
        soll.put(reihe, neu);
        soll.put("MS-15", formel(ms, "MS-15", reihe, neu));
        BigDecimal nenner1 = bz.get(kz.get("KZ-0001").get("nenner").asText()).get("oktober_2026_wert").decimalValue();
        soll.put("KZ-0001", neu.divide(nenner1, 4, java.math.RoundingMode.HALF_UP));
        JsonNode kz2 = kz.get("KZ-0002");
        soll.put("KZ-0003", neu.add(kz2.get("oktober_2026_zaehler").decimalValue())
                .divide(nenner1.add(kz2.get("oktober_2026_nenner").decimalValue()), 4, java.math.RoundingMode.HALF_UP));
        Map<String, JsonNode> folgen = new LinkedHashMap<>();
        kinder(k.get("folgen")).forEach(f -> folgen.put(f.get("objekt").asText(), f));
        assertThat(folgen.keySet()).as("Folgen der Korrektur").containsExactlyElementsOf(soll.keySet());
        soll.forEach((objekt, wert) -> {
            if (folgen.get(objekt).get("wert").decimalValue().compareTo(wert) != 0 || folgen.get(objekt).get("version").asInt() != 2) {
                fehler.add("Folge " + objekt + ": " + folgen.get(objekt) + " statt " + wert + " in Version 2");
            }
        });

        JsonNode b = d.at("/berichte/0");
        if (!standorte.contains(b.get("geltung").asText())) {
            fehler.add("Bericht: Geltung " + b.get("geltung").asText() + " gibt es nicht");
        }
        Set<String> quellen = new LinkedHashSet<>();
        kinder(b.get("quellen")).forEach(q -> quellen.add(q.asText()));
        for (String q : quellen) {
            if (!ms.containsKey(q) && !bz.containsKey(q) && !kz.containsKey(q)) {
                fehler.add("Bericht: Quelle " + q + " gibt es nicht");
            }
        }
        List<JsonNode> staende = new ArrayList<>();
        kinder(b.get("staende")).forEach(staende::add);
        Map<String, BigDecimal> ersteZahl = Map.of(reihe, alt, "MS-15", formel(ms, "MS-15", reihe, alt),
                "KZ-0001", kz.get("KZ-0001").get("oktober_2026_wert").decimalValue());
        for (int i = 0; i < staende.size(); i++) {
            JsonNode st = staende.get(i);
            String nr = "Nr. " + st.get("nr").asText();
            if (st.get("nr").asInt() != i + 1) {
                fehler.add(nr + ": Nummern sind nicht lückenlos");
            }
            if (!zeit(st.get("datenstand").asText()).isBefore(zeit(st.get("freigegeben_am").asText()))) {
                fehler.add(nr + ": Datenstand nicht vor der Freigabe");
            }
            if (!personen.contains(st.get("freigegeben_von").asText())) {
                fehler.add(nr + ": freigegeben von einer Person, die es nicht gibt");
            }
            boolean letzter = i == staende.size() - 1;
            if (letzter ? st.hasNonNull("ersetzt_durch") : st.path("ersetzt_durch").asInt() != i + 2) {
                fehler.add(nr + ": ersetzt_durch zeigt nicht auf den Nachfolger");
            }
            Map<String, BigDecimal> zahlen = i == 0 ? ersteZahl : soll;
            int version = i == 0 ? 1 : 2;
            for (JsonNode w : kinder(st.get("werte"))) {
                String objekt = w.get("objekt").asText();
                if (!quellen.contains(objekt)) {
                    fehler.add(nr + ": " + objekt + " steht nicht im Quellenverzeichnis");
                }
                if (w.get("wert").decimalValue().compareTo(zahlen.get(objekt)) != 0 || w.get("version").asInt() != version) {
                    fehler.add(nr + ": " + objekt + " = " + w.get("wert") + " v" + w.get("version") + " statt " + zahlen.get(objekt) + " v" + version);
                }
            }
        }
        JsonNode nr1 = staende.get(0);
        JsonNode nr2 = staende.get(1);
        if (!nr1.get("anlass").isNull() || !nr2.get("anlass").asText().equals(k.get("kennung").asText())) {
            fehler.add("Anlass: Nr. 1 ohne, Nr. 2 mit der Korrektur");
        }
        if (!zeit(nr2.get("datenstand").asText()).isEqual(zeit(k.get("freigegeben_am").asText()))) {
            fehler.add("Nr. 2: Datenstand ist nicht der der Kaskade (Freigabe der Korrektur)");
        }
        if (!zeit(nr1.get("freigegeben_am").asText()).isBefore(zeit(k.get("freigegeben_am").asText()))) {
            fehler.add("Nr. 1 ist nicht vor der Korrektur freigegeben");
        }
        java.time.ZoneId zone = java.time.ZoneId.of(d.at("/unternehmen/zeitzone").asText());
        java.time.Instant freigebbar = TagRegeln.endgueltigAb(TagRegeln.beginn(LocalDate.of(2026, 11, 1), zone));
        if (zeit(nr1.get("datenstand").asText()).toInstant().isBefore(freigebbar)) {
            fehler.add("Nr. 1: Datenstand vor „endgültig ab“ des Oktobers");
        }
        int abweichungen = 0;
        for (int i = 0; i < nr1.get("werte").size(); i++) {
            JsonNode a = nr1.get("werte").get(i);
            JsonNode n = nr2.get("werte").get(i);
            if (a.get("wert").decimalValue().compareTo(n.get("wert").decimalValue()) != 0 || a.get("version").asInt() != n.get("version").asInt()) {
                abweichungen++;
            }
        }
        if (nr2.get("abweichungen").asInt() != abweichungen) {
            fehler.add("Nr. 2: " + nr2.get("abweichungen") + " Abweichungen statt " + abweichungen);
        }
        Set<java.time.Instant> zeitachse = new LinkedHashSet<>();
        kinder(d.get("zeitachse")).forEach(z -> zeitachse.add(zeit(z.get("zeitpunkt").asText()).toInstant()));
        for (String t : List.of(nr1.get("freigegeben_am").asText(), k.get("freigegeben_am").asText(), nr2.get("freigegeben_am").asText())) {
            if (!zeitachse.contains(zeit(t).toInstant())) {
                fehler.add("Zeitachse nennt " + t + " nicht");
            }
        }
        assertThat(fehler).isEmpty();
    }

    // ------------------------------------------------------- Fassung 1.5 (AP-15 IP-1, E8)

    /**
     * Der Fingerabdruck der Fassung 1.4, {@link #kanonisch} geschrieben und aus {@code origin/uems}
     * vor AP-15 IP-1 berechnet (21.09.2026). Der TS-Zwilling trägt denselben Wert.
     */
    static final String FASSUNG_1_4_SHA256 = "a32f92053787fb6cdbe31c5c1c154179ccfadd2bc330e4c8c3b0061a768000a4";

    /** So viele Zeilen hatte {@code _comment} in Fassung 1.4 — Fassung 1.5 hängt nur an. */
    static final int KOMMENTAR_ZEILEN_1_4 = 89;

    /** Die Datenquellen, die Fassung 1.5 der Box Verwaltung gibt (AP-15 E8). */
    private static final Set<String> QUELLEN_1_5 = Set.of("DQ-8", "DQ-9", "DQ-10");

    /**
     * Nimmt GENAU die Zusätze der Fassung 1.5 heraus — Box E-4/E-4′, DQ-8 … DQ-10 mit ihren Geräten, Komponenten
     * und Zuständigkeiten, die Blöcke {@code netzanschluss_grenzen}, {@code gemeinsame_steuerungen},
     * {@code geraete_rueckfaelle} und {@code abnahmefaelle_ap15}, die sechs Zeilen der Zeitachse aus AP-15, die
     * Herkunft {@code fassung_1_5} und die angehängten Kommentarzeilen — und setzt Fassung und Stand auf 1.4 zurück.
     */
    static void ohneFassung15(ObjectNode d) {
        assertThat(d.path("version").asText()).isEqualTo("1.5");
        d.put("version", "1.4");
        d.put("stand", "2026-09-15");
        ArrayNode kommentar = (ArrayNode) d.get("_comment");
        assertThat(kommentar.size()).as("_comment wächst nur hinten").isGreaterThan(KOMMENTAR_ZEILEN_1_4);
        while (kommentar.size() > KOMMENTAR_ZEILEN_1_4) {
            kommentar.remove(kommentar.size() - 1);
        }
        assertThat(((ObjectNode) d.get("_herkunft")).remove("fassung_1_5")).as("_herkunft.fassung_1_5").isNotNull();
        for (String block : List.of("netzanschluss_grenzen", "gemeinsame_steuerungen", "geraete_rueckfaelle",
                "abnahmefaelle_ap15")) {
            assertThat(d.remove(block)).as(block).isNotNull();
        }
        Set<String> geraete = new LinkedHashSet<>();
        kinder(d.get("geraete")).stream().filter(g -> QUELLEN_1_5.contains(g.get("datenquelle").asText()))
                .forEach(g -> geraete.add(g.get("kennzeichen").asText()));
        entferne((ArrayNode) d.get("boxen"), b -> List.of("E-4", "E-4′").contains(b.path("kennzeichen").asText()), 2);
        entferne((ArrayNode) d.get("datenquellen"), q -> QUELLEN_1_5.contains(q.path("kennzeichen").asText()), 3);
        entferne((ArrayNode) d.get("geraete"), g -> geraete.contains(g.path("kennzeichen").asText()), 8);
        entferne((ArrayNode) d.get("komponenten"), k -> geraete.contains(k.path("geraet").asText()), 8);
        entferne((ArrayNode) d.get("zuordnungen"), z -> QUELLEN_1_5.contains(z.path("von").asText()), 6);
        entferne((ArrayNode) d.get("zeitachse"), z -> z.hasNonNull("gemeinsame_steuerung"), 6);
    }

    /** Diff-Test (AP-15 IP-1): ohne ihre Zusätze ist die Datei Zeichen für Zeichen die Fassung 1.4. */
    @Test
    void ohneDieZusaetzeDerFassung15IstEsDieFassung14() throws Exception {
        ObjectNode d = daten().deepCopy();
        ohneFassung17(d);
        ohneFassung16(d);
        ohneFassung15(d);
        assertThat(sha256(kanonisch(d))).as("Fingerabdruck der Fassung 1.4").isEqualTo(FASSUNG_1_4_SHA256);
    }

    /**
     * Fassung 1.5 (AP-15 E8): „höchstens eine Steuerquelle je Anlage“ gilt nur noch OHNE gemeinsame Steuerung. Zu
     * jedem Zeitpunkt, an dem eine Zuständigkeit oder Mitgliedschaft beginnt: hat die Anlage dann keine gemeinsame
     * Steuerung, liest höchstens EINE ihrer Steuerquellen; hat sie eine, liest jede Steuerquelle eine Mitglied-Box mit
     * Heimat in dieser Anlage. Mehr als eine Steuerquelle hat nur eine Anlage mit gemeinsamer Steuerung.
     */
    @Test
    void hoechstensEineSteuerquelleJeAnlageOhneGemeinsameSteuerung() throws Exception {
        JsonNode d = daten();
        Map<String, List<JsonNode>> zustaendig = zuordnungenNach(d, "datenquelle_box");
        Map<String, JsonNode> boxen = nachKennzeichen(d.get("boxen"));
        List<String> fehler = new ArrayList<>();
        Set<String> mehrAlsEine = new TreeSet<>();
        Set<String> gemeinsam = new TreeSet<>();
        for (JsonNode a : kinder(d.get("anlagen"))) {
            String an = a.get("kennzeichen").asText();
            List<JsonNode> quellen = kinder(d.get("datenquellen")).stream()
                    .filter(q -> an.equals(q.get("anlage").asText()) && q.get("steuerquelle").asBoolean()).toList();
            List<JsonNode> mitglieder = kinder(d.get("gemeinsame_steuerungen")).stream()
                    .filter(v -> an.equals(v.get("anlage").asText()))
                    .flatMap(v -> kinder(v.get("mitglieder")).stream()).toList();
            if (quellen.size() > 1) {
                mehrAlsEine.add(an);
            }
            if (!mitglieder.isEmpty()) {
                gemeinsam.add(an);
            }
            Set<OffsetDateTime> stichzeiten = new TreeSet<>();
            for (JsonNode q : quellen) {
                zustaendig.getOrDefault(q.get("kennzeichen").asText(), List.of())
                        .forEach(z -> stichzeiten.add(zeit(z.get("gueltig_ab").asText())));
            }
            mitglieder.forEach(m -> stichzeiten.add(zeit(m.get("gueltig_ab").asText())));
            for (OffsetDateTime t : stichzeiten) {
                List<String> mitgliedBoxen = mitglieder.stream().filter(m -> gilt(m, t))
                        .map(m -> m.get("box").asText()).toList();
                List<String> lesend = new ArrayList<>();
                for (JsonNode q : quellen) {
                    String kz = q.get("kennzeichen").asText();
                    for (JsonNode z : zustaendig.getOrDefault(kz, List.of())) {
                        if (!gilt(z, t)) {
                            continue;
                        }
                        String box = z.get("nach").asText();
                        lesend.add(kz);
                        if (!mitgliedBoxen.isEmpty() && (!mitgliedBoxen.contains(box)
                                || !an.equals(boxen.get(box).get("heimat_anlage").asText()))) {
                            fehler.add(an + " " + t + ": Steuerquelle " + kz + " liest " + box
                                    + " — kein Mitglied der gemeinsamen Steuerung mit Heimat in der Anlage");
                        }
                    }
                }
                if (mitgliedBoxen.isEmpty() && lesend.size() > 1) {
                    fehler.add(an + " " + t + ": " + lesend + " — mehr als eine Steuerquelle ohne gemeinsame Steuerung");
                }
            }
        }
        assertThat(fehler).isEmpty();
        assertThat(mehrAlsEine).as("Anlagen mit mehr als einer Steuerquelle").isNotEmpty().isSubsetOf(gemeinsam);
    }

    /**
     * Fassung 1.5: eine gemeinsame Steuerung hängt an ihrer Anlage und deren Netzanschluss. Zu jedem Zeitpunkt führt
     * genau ein Mitglied — die führende Box der Anlage —; jedes Mitglied hat seine Heimat in der Anlage, ist beim
     * Eintritt in Betrieb und liest seinen Messpunkt (eine Datenquelle der Anlage, keine Steuerquelle) selbst. Die
     * Stufen steigen, Code und Stufe passen; der Netzanschluss hat ab der ersten Stufe eine Grenze, deren Bezug nicht
     * über der vereinbarten Leistung liegt.
     */
    @Test
    void dieGemeinsameSteuerungHaengtAnIhrerAnlage() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> anlagen = nachKennzeichen(d.get("anlagen"));
        Map<String, JsonNode> boxen = nachKennzeichen(d.get("boxen"));
        Map<String, JsonNode> quellen = nachKennzeichen(d.get("datenquellen"));
        Map<String, JsonNode> na = nachKennzeichen(d.get("netzanschluesse"));
        Map<String, List<JsonNode>> zustaendig = zuordnungenNach(d, "datenquelle_box");
        Map<String, String> stufenCode = Map.of("S0", "erklaert", "S1", "beobachtet", "S2", "geprueft",
                "S3", "anteile_aktiv");
        List<String> fehler = new ArrayList<>();
        for (JsonNode v : kinder(d.get("gemeinsame_steuerungen"))) {
            String kz = v.get("kennzeichen").asText();
            String an = v.get("anlage").asText();
            String netz = v.get("netzanschluss").asText();
            if (!netz.equals(anlagen.get(an).get("netzanschluss").asText())) {
                fehler.add(kz + ": " + netz + " ist nicht der Netzanschluss von " + an);
            }
            List<JsonNode> mitglieder = kinder(v.get("mitglieder"));
            for (JsonNode m : mitglieder) {
                String box = m.get("box").asText();
                String punkt = m.get("messpunkt").asText();
                OffsetDateTime ab = zeit(m.get("gueltig_ab").asText());
                if (!an.equals(boxen.get(box).get("heimat_anlage").asText())) {
                    fehler.add(kz + ": " + box + " hat ihre Heimat nicht in " + an);
                }
                if (!laeuft(boxen.get(box), ab, "in_betrieb_ab", "ausgebaut_am")) {
                    fehler.add(kz + ": " + box + " ist beim Eintritt nicht in Betrieb");
                }
                if (!an.equals(quellen.get(punkt).get("anlage").asText())
                        || quellen.get(punkt).get("steuerquelle").asBoolean()) {
                    fehler.add(kz + ": " + punkt + " ist kein Messpunkt in " + an);
                }
                if (zustaendig.getOrDefault(punkt, List.of()).stream()
                        .noneMatch(z -> gilt(z, ab) && box.equals(z.get("nach").asText()))) {
                    fehler.add(kz + ": " + box + " liest ihren Messpunkt " + punkt + " nicht selbst");
                }
                if ("fuehrt".equals(m.get("rolle").asText()) && !an.equals(text(boxen.get(box), "fuehrend_fuer"))) {
                    fehler.add(kz + ": " + box + " führt, ist aber nicht die führende Box von " + an);
                }
                long fuehrend = mitglieder.stream()
                        .filter(x -> gilt(x, ab) && "fuehrt".equals(x.get("rolle").asText())).count();
                if (fuehrend != 1) {
                    fehler.add(kz + " " + ab + ": " + fuehrend + " führende Mitglieder statt einem");
                }
            }
            List<JsonNode> stufen = kinder(v.get("stufen"));
            for (int i = 0; i < stufen.size(); i++) {
                JsonNode s = stufen.get(i);
                if (!s.get("code").asText().equals(stufenCode.get(s.get("stufe").asText()))) {
                    fehler.add(kz + ": Stufe " + s.get("stufe").asText() + " heißt nicht " + s.get("code").asText());
                }
                if (i > 0 && (s.get("stufe").asText().compareTo(stufen.get(i - 1).get("stufe").asText()) <= 0
                        || !tag(s.get("ab").asText()).isAfter(tag(stufen.get(i - 1).get("ab").asText())))) {
                    fehler.add(kz + ": die Stufen steigen nicht");
                }
            }
            LocalDate beginn = tag(stufen.get(0).get("ab").asText());
            if (!beginn.equals(tagVon(mitglieder.stream().map(m -> zeit(m.get("gueltig_ab").asText()))
                    .min(Comparator.naturalOrder()).orElseThrow(), zone(d)))) {
                fehler.add(kz + ": die erste Stufe beginnt nicht mit den ersten Mitgliedern");
            }
            JsonNode grenze = grenzeAm(d, netz, beginn);
            if (grenze == null) {
                fehler.add(kz + ": " + netz + " hat ab " + beginn + " keine Grenze");
            } else if (kw(grenze.get("bezugsgrenze_kw")).compareTo(kw(na.get(netz).get("vereinbart_kw"))) > 0) {
                fehler.add(kz + ": die Bezugsgrenze liegt über der vereinbarten Leistung von " + netz);
            }
        }
        assertThat(fehler).isEmpty();
    }

    /**
     * Fassung 1.5: die Auslegung rechnet aus der Datei, am Tag, an dem die Anteile scharf werden. Vorbehalt =
     * Viertelstunden-Maximum × Zuschlag; verteilbar ist die Einspeisegrenze bzw. die Bezugsgrenze minus Vorbehalt;
     * Anteile + ungenutzt = verteilbar; die Summe der Rückfälle ist die der Komponenten, die eine Mitglied-Box
     * steuert; keine Box hält weniger Anteil, als ihre Geräte ohne sie beanspruchen; „passt“ heißt: die Summe der
     * Rückfälle liegt nicht über dem Verteilbaren.
     */
    @Test
    void dieAuslegungDerGemeinsamenSteuerungRechnetAusDerDatei() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> komponenten = nachKennzeichen(d.get("komponenten"));
        Map<String, JsonNode> geraete = nachKennzeichen(d.get("geraete"));
        Map<String, List<JsonNode>> zustaendig = zuordnungenNach(d, "datenquelle_box");
        List<String> fehler = new ArrayList<>();
        for (JsonNode v : kinder(d.get("gemeinsame_steuerungen"))) {
            String kz = v.get("kennzeichen").asText();
            LocalDate scharf = kinder(v.get("stufen")).stream().filter(s -> "S3".equals(s.get("stufe").asText()))
                    .map(s -> tag(s.get("ab").asText())).findFirst().orElseThrow();
            OffsetDateTime t = scharf.atStartOfDay(zone(d)).toOffsetDateTime();
            JsonNode grenze = grenzeAm(d, v.get("netzanschluss").asText(), scharf);
            JsonNode gl = v.get("grundlast");
            BigDecimal vorbehalt = kw(gl.get("gemessenes_viertelstunden_maximum_kw")).multiply(kw(gl.get("zuschlag")))
                    .setScale(1, RoundingMode.HALF_UP);
            Set<String> mitglieder = new LinkedHashSet<>();
            kinder(v.get("mitglieder")).stream().filter(m -> gilt(m, t)).forEach(m -> mitglieder.add(m.get("box").asText()));
            for (String richtung : List.of("einspeisung", "bezug")) {
                JsonNode a = v.get("auslegung").get(richtung);
                BigDecimal verteilbar = "einspeisung".equals(richtung) ? kw(grenze.get("einspeisegrenze_kw"))
                        : kw(grenze.get("bezugsgrenze_kw")).subtract(vorbehalt);
                if ("bezug".equals(richtung) && kw(a.get("vorbehalt_grundlast_kw")).compareTo(vorbehalt) != 0) {
                    fehler.add(kz + " bezug: Vorbehalt " + a.get("vorbehalt_grundlast_kw") + " statt " + vorbehalt);
                }
                if (kw(a.get("verteilbar_kw")).compareTo(verteilbar) != 0) {
                    fehler.add(kz + " " + richtung + ": verteilbar " + a.get("verteilbar_kw") + " statt " + verteilbar);
                }
                BigDecimal summe = kw(a.get("ungenutzt_kw"));
                for (String box : feldnamen(a.get("anteile"))) {
                    summe = summe.add(kw(a.get("anteile").get(box)));
                    if (!mitglieder.contains(box)) {
                        fehler.add(kz + " " + richtung + ": Anteil für " + box + ", kein Mitglied am " + scharf);
                    }
                }
                if (summe.compareTo(verteilbar) != 0) {
                    fehler.add(kz + " " + richtung + ": Anteile + ungenutzt = " + summe + " statt " + verteilbar);
                }
                Map<String, BigDecimal> jeBox = new LinkedHashMap<>();
                for (JsonNode r : kinder(d.get("geraete_rueckfaelle"))) {
                    if (!richtung.equals(r.get("richtung").asText())) {
                        continue;
                    }
                    String quelle = geraete.get(komponenten.get(r.get("komponente").asText()).get("geraet").asText())
                            .get("datenquelle").asText();
                    zustaendig.getOrDefault(quelle, List.of()).stream().filter(z -> gilt(z, t))
                            .map(z -> z.get("nach").asText()).filter(mitglieder::contains)
                            .forEach(box -> jeBox.merge(box, kw(r.get("rueckfall_kw")), BigDecimal::add));
                }
                BigDecimal rueckfall = jeBox.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add);
                if (rueckfall.compareTo(kw(a.get("summe_rueckfall_kw"))) != 0) {
                    fehler.add(kz + " " + richtung + ": Summe der Rückfälle " + rueckfall + " statt "
                            + a.get("summe_rueckfall_kw"));
                }
                jeBox.forEach((box, kwBox) -> {
                    JsonNode anteil = a.get("anteile").get(box);
                    if (anteil == null || kwBox.compareTo(kw(anteil)) > 0) {
                        fehler.add(kz + " " + richtung + ": " + box + " hält weniger Anteil als den Rückfall " + kwBox);
                    }
                });
                String urteil = rueckfall.compareTo(verteilbar) <= 0 ? "passt" : "auslegung_passt_nicht";
                if (!urteil.equals(a.get("urteil").asText())) {
                    fehler.add(kz + " " + richtung + ": Urteil " + a.get("urteil").asText() + " statt " + urteil);
                }
            }
        }
        assertThat(fehler).isEmpty();
    }

    /**
     * Fassung 1.5: jeder Geräte-Rückfall gehört zu einer steuerbaren Komponente, höchstens einer je Komponente und
     * Richtung; frei laufen zählt mit der Nennleistung, ein Rückfallwert liegt nie über ihr. Jede steuerbare
     * Komponente hinter einer Steuerquelle einer Anlage mit gemeinsamer Steuerung nennt ihren Rückfall.
     */
    @Test
    void jederGeraeteRueckfallGehoertZuEinerSteuerbarenKomponente() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> komponenten = nachKennzeichen(d.get("komponenten"));
        Map<String, JsonNode> geraete = nachKennzeichen(d.get("geraete"));
        Map<String, JsonNode> quellen = nachKennzeichen(d.get("datenquellen"));
        List<String> fehler = new ArrayList<>();
        Set<String> gesehen = new LinkedHashSet<>();
        for (JsonNode r : kinder(d.get("geraete_rueckfaelle"))) {
            String k = r.get("komponente").asText();
            if (!gesehen.add(k + "/" + r.get("richtung").asText())) {
                fehler.add(k + ": zwei Rückfälle in derselben Richtung");
            }
            if (text(komponenten.get(k), "steuerbar") == null || text(komponenten.get(k), "steuerbar").startsWith("nein")) {
                fehler.add(k + ": Rückfall an einer nicht steuerbaren Komponente");
            }
            int vergleich = kw(r.get("rueckfall_kw")).compareTo(kw(r.get("nenn_kw")));
            if ("laeuft_frei".equals(r.get("rueckfall").asText()) ? vergleich != 0 : vergleich > 0) {
                fehler.add(k + ": Rückfall " + r.get("rueckfall_kw") + " kW passt nicht zu " + r.get("rueckfall").asText());
            }
        }
        Set<String> gemeinsam = new LinkedHashSet<>();
        kinder(d.get("gemeinsame_steuerungen")).forEach(v -> gemeinsam.add(v.get("anlage").asText()));
        for (JsonNode k : komponenten.values()) {
            JsonNode quelle = quellen.get(geraete.get(k.get("geraet").asText()).get("datenquelle").asText());
            String steuerbar = text(k, "steuerbar");
            if (gemeinsam.contains(k.get("anlage").asText()) && quelle.get("steuerquelle").asBoolean()
                    && steuerbar != null && steuerbar.startsWith("ja")
                    && gesehen.stream().noneMatch(s -> s.startsWith(k.get("kennzeichen").asText() + "/"))) {
                fehler.add(k.get("kennzeichen").asText() + ": steuerbar in einer gemeinsamen Steuerung, aber ohne Rückfall");
            }
        }
        assertThat(fehler).isEmpty();
    }

    /**
     * Fassung 1.5: die Abnahmefälle R1 … R22 stehen vollständig und in Reihenfolge; nur R16 (Stufe S4, nicht gebaut)
     * ist Entwurf. Wo „gegeben“ eine Tatsache dieser Welt nennt, ist es die des Objekts der Datei — Grenzen,
     * Auslegung, Grundlast, Rückfälle, Anteile, Arbeitspreis, Netzanschlüsse, Box-Tausch und die Zuständigkeitskette
     * von DQ-3; der Augenblick des Beispielsonntags rechnet in sich.
     */
    @Test
    void dieAbnahmefaelleNennenDieTatsachenDerDatei() throws Exception {
        JsonNode d = daten();
        List<JsonNode> faelle = kinder(d.at("/abnahmefaelle_ap15/faelle"));
        assertThat(faelle.stream().map(f -> f.get("fall").asText()).toList())
                .isEqualTo(IntStream.rangeClosed(1, 22).mapToObj(i -> "R" + i).toList());
        assertThat(faelle.stream().filter(f -> "entwurf".equals(f.get("stand").asText()))
                .map(f -> f.get("fall").asText()).toList()).containsExactly("R16");
        Map<String, JsonNode> g = new LinkedHashMap<>();
        faelle.forEach(f -> g.put(f.get("fall").asText(), f.get("gegeben")));

        JsonNode v = d.at("/gemeinsame_steuerungen/0");
        String netz = v.get("netzanschluss").asText();
        Map<String, JsonNode> na = nachKennzeichen(d.get("netzanschluesse"));
        ObjectNode grenze = kinder(d.get("netzanschluss_grenzen")).stream()
                .filter(x -> netz.equals(x.get("netzanschluss").asText())).findFirst().orElseThrow().deepCopy();
        grenze.remove(List.of("netzanschluss", "gueltig_bis"));
        JsonNode einspeisung = v.at("/auslegung/einspeisung");
        JsonNode bezug = v.at("/auslegung/bezug");
        assertThat(kanonisch(g.get("R1").get("grenzen_na1"))).as("R1 Grenzen").isEqualTo(kanonisch(grenze));
        assertThat(kanonisch(g.get("R1").get("einspeisung"))).as("R1 Einspeisung").isEqualTo(kanonisch(einspeisung));
        assertThat(kanonisch(g.get("R1").get("bezug"))).as("R1 Bezug").isEqualTo(kanonisch(bezug));
        assertThat(kanonisch(g.get("R3").get("bezug"))).as("R3 Bezug").isEqualTo(kanonisch(bezug));
        assertThat(kanonisch(g.get("R3").get("grundlast"))).as("R3 Grundlast").isEqualTo(kanonisch(v.get("grundlast")));
        assertThat(kanonisch(g.get("R7").get("anteile_kw"))).as("R7").isEqualTo(kanonisch(einspeisung.get("anteile")));
        assertThat(kanonisch(g.get("R12").get("alt"))).as("R12 alt").isEqualTo(kanonisch(einspeisung.get("anteile")));
        assertThat(kw(g.get("R2").get("arbeitspreis_ct_kwh"))).as("R2 Arbeitspreis")
                .isEqualByComparingTo(kw(na.get(netz).get("arbeitspreis_ct_kwh")));

        // Geräte-Rückfälle: K-1 wörtlich, die Ladepunkte der Anlage als Summe.
        Map<String, JsonNode> komponenten = nachKennzeichen(d.get("komponenten"));
        ObjectNode k1 = kinder(d.get("geraete_rueckfaelle")).stream()
                .filter(r -> "K-1".equals(r.get("komponente").asText())).findFirst().orElseThrow().deepCopy();
        k1.remove(List.of("komponente", "richtung"));
        assertThat(kanonisch(g.get("R5").get("rueckfall_k1"))).as("R5 Rückfall K-1").isEqualTo(kanonisch(k1));
        BigDecimal ladepunkte = kinder(d.get("geraete_rueckfaelle")).stream()
                .map(r -> komponenten.get(r.get("komponente").asText()))
                .filter(k -> v.get("anlage").asText().equals(k.get("anlage").asText())
                        && text(k, "art").startsWith("Ladepunkt"))
                .map(k -> kinder(d.get("geraete_rueckfaelle")).stream()
                        .filter(r -> r.get("komponente").asText().equals(k.get("kennzeichen").asText()))
                        .map(r -> kw(r.get("rueckfall_kw"))).reduce(BigDecimal.ZERO, BigDecimal::add))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        assertThat(kw(g.get("R3").get("geraete_rueckfall_ladepunkte_kw"))).as("R3 Ladepunkte")
                .isEqualByComparingTo(ladepunkte);

        // Der Augenblick des Beispielsonntags (R1 = R4 vorher = R5 vorher) rechnet in sich.
        JsonNode aug = g.get("R1").get("augenblick");
        assertThat(kanonisch(g.get("R4").get("vorher"))).isEqualTo(kanonisch(aug));
        assertThat(kanonisch(g.get("R5").get("vorher"))).isEqualTo(kanonisch(aug));
        assertThat(kw(aug.get("grenze_kw"))).isEqualByComparingTo(kw(grenze.get("einspeisegrenze_kw")));
        BigDecimal ueberschussE4 = kw(aug.get("pv_e4_kw")).subtract(kw(aug.get("last_kw")));
        assertThat(kw(aug.get("ungeregelt_einspeisung_kw")))
                .isEqualByComparingTo(ueberschussE4.add(kw(aug.get("pv_e1_verfuegbar_kw"))));
        assertThat(kw(aug.get("einspeisung_kw")))
                .isEqualByComparingTo(kw(aug.get("grenze_kw")).subtract(kw(aug.get("marge_kw"))));
        assertThat(kw(aug.get("e1_darf_kw"))).isEqualByComparingTo(kw(aug.get("einspeisung_kw")).subtract(ueberschussE4));
        assertThat(kw(aug.get("e1_regelt_ab_kw")))
                .isEqualByComparingTo(kw(aug.get("pv_e1_verfuegbar_kw")).subtract(kw(aug.get("e1_darf_kw"))));
        // Der Dienstag (R3): der Ladepark bekommt seinen Anteil, schlimmstenfalls genau die Bezugsgrenze.
        JsonNode di = g.get("R3").get("augenblick");
        assertThat(kw(di.get("anteil_e4_kw"))).isEqualByComparingTo(kw(bezug.get("anteile").get("E-4")));
        assertThat(kw(di.get("laden_kw"))).isEqualByComparingTo(kw(di.get("ladewunsch_kw")).min(kw(di.get("anteil_e4_kw"))));
        assertThat(kw(di.get("schlimmster_fall_kw"))).isEqualByComparingTo(kw(grenze.get("bezugsgrenze_kw")))
                .isEqualByComparingTo(kw(bezug.get("vorbehalt_grundlast_kw")).add(kw(bezug.get("verteilbar_kw"))));

        // R17: die Nachfolgerin von E-4 übernimmt genau die Quellen, die ihr die Datei zuordnet.
        String nachfolger = g.get("R17").get("nachfolger").asText();
        JsonNode box = nachKennzeichen(d.get("boxen")).get(nachfolger);
        assertThat(box).as("R17 Nachfolgerin").isNotNull();
        assertThat(text(box, "vorgaenger")).isEqualTo("E-4");
        List<String> uebernimmt = new ArrayList<>();
        kinder(g.get("R17").get("uebernimmt")).forEach(x -> uebernimmt.add(x.asText()));
        assertThat(kinder(d.get("zuordnungen")).stream()
                .filter(z -> "datenquelle_box".equals(z.get("art").asText()) && nachfolger.equals(z.get("nach").asText()))
                .map(z -> z.get("von").asText()).toList()).containsExactlyInAnyOrderElementsOf(uebernimmt);

        // R20: die Netzanschlüsse, wie die Datei sie führt, je mit ihrer Anlage.
        for (String n : feldnamen(g.get("R20").get("na"))) {
            JsonNode r = g.get("R20").get("na").get(n);
            JsonNode anschluss = na.get(n);
            assertThat(r.get("standort").asText()).isEqualTo(anschluss.get("standort").asText());
            assertThat(kw(r.get("anschluss_kva"))).isEqualByComparingTo(kw(anschluss.get("anschluss_kva")));
            assertThat(kw(r.get("vereinbart_kw"))).isEqualByComparingTo(kw(anschluss.get("vereinbart_kw")));
            assertThat(kinder(d.get("anlagen")).stream().filter(a -> n.equals(a.get("netzanschluss").asText()))
                    .map(a -> a.get("kennzeichen").asText()).toList()).containsExactly(r.get("anlage").asText());
        }

        // R21: die Zuständigkeitskette von DQ-3, wie Fassung 1.4 sie führt.
        String kette = String.join(" → ", zuordnungenNach(d, "datenquelle_box").get("DQ-3").stream()
                .sorted(Comparator.comparing(z -> zeit(z.get("gueltig_ab").asText())))
                .map(z -> z.get("nach").asText()).toList());
        assertThat(g.get("R21").get("zeitachse").asText()).endsWith("DQ-3 " + kette);
    }

    // ------------------------------------------------------- Fassung 1.6 (AP-16 IP-1, E11)

    static final String FASSUNG_1_5_SHA256 = "c6a03b8b8446edc9324f6d5bb9288b4ebf16f5c3577a8210c805d4b76cdb5b8c";
    static final int KOMMENTAR_ZEILEN_1_5 = 111;

    static void ohneFassung16(ObjectNode d) {
        assertThat(d.path("version").asText()).isEqualTo("1.6");
        d.put("version", "1.5");
        d.put("stand", "2026-09-21");
        d.put("beschreibung", d.get("beschreibung").asText()
                .replace(", erweitert um energetische Bewertung und Messplanung", ""));
        ArrayNode kommentar = (ArrayNode) d.get("_comment");
        assertThat(kommentar.size()).isGreaterThan(KOMMENTAR_ZEILEN_1_5);
        while (kommentar.size() > KOMMENTAR_ZEILEN_1_5) {
            kommentar.remove(kommentar.size() - 1);
        }
        assertThat(((ObjectNode) d.get("_herkunft")).remove("fassung_1_6")).isNotNull();
        for (String block : List.of("bewertung_umfang", "energieeinsaetze", "bewertung_kriterien",
                "einstufungen", "messbedarfe", "messmittel_angaben", "abnahmefaelle_ap16")) {
            assertThat(d.remove(block)).as(block).isNotNull();
        }
        entferne((ArrayNode) d.get("prozesse"), p -> "P-7".equals(text(p, "kennzeichen")), 1);
        entferne((ArrayNode) d.get("geraete"), g -> "GR-19".equals(text(g, "kennzeichen")), 1);
        entferne((ArrayNode) d.get("komponenten"), k -> "K-15".equals(text(k, "kennzeichen")), 1);
        entferne((ArrayNode) d.get("messstellen"), m -> "MS-23".equals(text(m, "kennzeichen")), 1);
        entferne((ArrayNode) d.get("zuordnungen"), z -> "MS-23".equals(text(z, "von")), 1);
        entferne((ArrayNode) d.get("berichte"), b -> text(b, "kennung").startsWith("BW-"), 2);
        entferne((ArrayNode) d.get("zeitachse"), z -> text(z, "herkunft").startsWith("AP-16"), 11);
        ObjectNode dq3 = (ObjectNode) nachKennzeichen(d.get("datenquellen")).get("DQ-3");
        dq3.set("geraete_ids", MAPPER.valueToTree(List.of(1, 2, 3, 4)));
        dq3.put("weg", "Modbus TCP 192.168.10.31:502, Geräte-IDs 1–4");
        dq3.put("kanaele", 8);
        dq3.put("hinweis", "Multi-Zähler-Gateway in der Unterverteilung Halle 1 — vier Zähler hinter EINER Adresse");
        JsonNode ms01 = nachKennzeichen(d.get("messstellen")).get("MS-01");
        assertThat(((ObjectNode) ms01.at("/nebengroessen/0/vergleichsquellen/0"))
                .remove("toleranz_fassungen")).isNotNull();
    }

    @Test
    void ohneDieZusaetzeDerFassung16IstEsDieFassung15() throws Exception {
        ObjectNode d = daten().deepCopy();
        ohneFassung17(d);
        ohneFassung16(d);
        assertThat(sha256(kanonisch(d))).as("Fingerabdruck der Fassung 1.5")
                .isEqualTo(FASSUNG_1_5_SHA256);
    }

    @Test
    void energetischeBewertungTraegtDieGegebenWerteUndIhreInvarianten() throws Exception {
        JsonNode d = daten();
        Map<String, JsonNode> ms = nachKennzeichen(d.get("messstellen"));
        Map<String, BigDecimal> oktober = new LinkedHashMap<>();
        for (JsonNode m : kinder(d.get("messstellen"))) {
            JsonNode wert = m.at("/beispielwerte/oktober_2026_kwh");
            if (wert.isNumber()) {
                oktober.put(text(m, "kennzeichen"), wert.decimalValue());
            }
        }
        for (JsonNode k : kinder(d.get("korrekturen"))) {
            for (JsonNode f : kinder(k.get("folgen"))) {
                if (text(f, "objekt").startsWith("MS-")) {
                    oktober.put(text(f, "objekt"), f.get("wert").decimalValue());
                }
            }
        }

        Set<String> personen = new LinkedHashSet<>();
        kinder(d.get("personen")).forEach(p -> personen.add(text(p, "kuerzel")));
        Set<String> bezugsgroessen = nachKennzeichen(d.get("bezugsgroessen")).keySet();
        Set<String> paare = new LinkedHashSet<>();
        Map<String, BigDecimal> einsatzMengen = new LinkedHashMap<>();
        Map<String, BigDecimal> zugeordnetJeAnlage = new LinkedHashMap<>();
        for (JsonNode e : kinder(d.get("energieeinsaetze"))) {
            assertThat(paare.add(text(e, "prozess") + "|" + text(e, "traeger")))
                    .as("höchstens ein laufender Einsatz je (Prozess, Träger)").isTrue();
            assertThat(personen).contains(text(e, "verantwortlich"));
            for (JsonNode i : kinder(e.get("einflussgroessen"))) {
                if (i.hasNonNull("bezugsgroesse")) {
                    assertThat(bezugsgroessen).contains(text(i, "bezugsgroesse"));
                }
            }
            if (!"Strom".equals(text(e, "traeger"))) {
                continue;
            }
            BigDecimal summe = BigDecimal.ZERO;
            for (JsonNode kz : kinder(e.get("messstellen"))) {
                BigDecimal wert = oktober.get(kz.asText());
                if (wert == null) {
                    continue;
                }
                summe = summe.add(wert);
                JsonNode stellung = ms.get(kz.asText()).at("/elektrische_stellung/0");
                zugeordnetJeAnlage.merge(text(stellung, "anlage"), wert, BigDecimal::add);
            }
            einsatzMengen.put(text(e, "kennzeichen"), summe);
        }
        Map<String, BigDecimal> rest = new LinkedHashMap<>();
        kinder(d.get("messstellen")).stream().filter(m -> "rest".equals(text(m, "formel_typ"))).forEach(m -> {
            String anlage = text(m.at("/elektrische_stellung/0"), "anlage");
            rest.put(anlage, oktober.get(text(m, "kennzeichen")));
        });
        Map<String, BigDecimal> nenner = new LinkedHashMap<>();
        for (String anlage : List.of("AN-1", "AN-2", "AN-3")) {
            nenner.put(anlage, zugeordnetJeAnlage.get(anlage).add(rest.get(anlage)));
        }
        assertThat(nenner).containsExactly(
                Map.entry("AN-1", new BigDecimal("139380")),
                Map.entry("AN-2", new BigDecimal("36900")),
                Map.entry("AN-3", new BigDecimal("9100")));
        assertThat(nenner.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add))
                .isEqualByComparingTo("185380");
        assertThat(einsatzMengen.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add))
                .isEqualByComparingTo("125740");
        assertThat(rest.values().stream().reduce(BigDecimal.ZERO, BigDecimal::add))
                .isEqualByComparingTo("59640");
        assertThat(einsatzMengen).containsEntry("EE-1", new BigDecimal("77500"))
                .containsEntry("EE-3", new BigDecimal("15900"))
                .containsEntry("EE-2", new BigDecimal("9640"));
        assertThat(ms.get("MS-20").at("/beispielwerte/oktober_2026_kwh").decimalValue())
                .isEqualByComparingTo("88630");

        for (JsonNode e : kinder(d.get("einstufungen"))) {
            for (JsonNode f : kinder(e.get("fassungen"))) {
                assertThat(personen).contains(text(f, "person"));
                assertThat(text(f, "begruendung")).isNotBlank();
                assertThat(f.get("herkunft").fieldNames()).toIterable()
                        .contains("zeitraum", "kriterien_fassung", "eingaenge", "nenner", "urteil", "vorschlag");
            }
        }
        JsonNode mb1 = nachKennzeichen(d.get("messbedarfe")).get("MB-1");
        assertThat(text(mb1, "zustand")).isEqualTo("eingeloest");
        assertThat(ms).containsKey(text(mb1, "messstelle"));
        JsonNode geplanteStellung = ms.get(text(mb1, "messstelle")).get("geplante_elektrische_stellung");
        assertThat(geplanteStellung).isNotNull();
        assertThat(text(geplanteStellung, "anlage")).isEqualTo("AN-1");
        assertThat(text(geplanteStellung, "unterzaehler_von")).isEqualTo("MS-01");

        Map<String, JsonNode> berichte = new LinkedHashMap<>();
        kinder(d.get("berichte")).forEach(b -> berichte.put(text(b, "kennung"), b));
        kinder(d.get("zeitachse")).stream().filter(z -> z.hasNonNull("energetische_bewertung"))
                .forEach(z -> assertThat(berichte).containsKey(text(z, "energetische_bewertung")));
        assertThat(berichte.get("BW-2026-0001").at("/staende/0/werte/0/wert").decimalValue())
                .isEqualByComparingTo("6100");
        assertThat(berichte.get("BW-2026-0001").at("/staende/1/werte/0/wert").decimalValue())
                .isEqualByComparingTo("6040");
        assertThat(berichte.get("BW-2026-0001").at("/staende/1/werte/2/wert").decimalValue())
                .isEqualByComparingTo("59640");
        assertThat(berichte.get("BW-2027-0001").at("/staende/0/annahme").asBoolean()).isTrue();
        assertThat(berichte.get("BW-2027-0001").at("/staende/0/werte")).isEmpty();

        Map<String, JsonNode> angaben = new LinkedHashMap<>();
        kinder(d.get("messmittel_angaben")).forEach(a -> angaben.put(text(a, "ziel"), a));
        assertThat(text(angaben.get("GR-2"), "pruefungsart")).isEqualTo("eichung");
        assertThat(text(angaben.get("Z-5b"), "pruefungsart")).isEqualTo("werksbescheinigung");
        assertThat(text(angaben.get("GR-5"), "pruefungsart")).isEqualTo("nicht_erhoben");
        assertThat(angaben.get("K-8.2").get("genauigkeitsklasse").isNull()).isTrue();
        assertThat(ms.get("MS-21").at("/beispielwerte/oktober_2026_m3").decimalValue())
                .isEqualByComparingTo("1240");
        assertThat(kinder(d.get("energieeinsaetze")).stream()
                .collect(java.util.stream.Collectors.toMap(e -> text(e, "kennzeichen"), e -> text(e, "verantwortlich"))))
                .containsEntry("EE-1", "MD").containsEntry("EE-2", "PH").containsEntry("EE-5", "PH")
                .containsEntry("EE-3", "IK").containsEntry("EE-6", "JW").containsEntry("EE-7", "JW");

        List<JsonNode> fallListe = kinder(d.at("/abnahmefaelle_ap16/faelle"));
        assertThat(fallListe.stream().map(f -> text(f, "fall")).toList())
                .containsExactly("R1", "R2", "R3", "R4", "R5", "R7", "R8", "R9", "R12", "R14"); // R9 ab Fassung 1.7
        Map<String, JsonNode> gegeben = new LinkedHashMap<>();
        fallListe.forEach(f -> gegeben.put(text(f, "fall"), f.get("gegeben")));
        assertThat(gegeben.get("R1").get("nenner_kwh").decimalValue()).isEqualByComparingTo("185380");
        assertThat(gegeben.get("R1").get("zugeordnet_kwh").decimalValue()).isEqualByComparingTo("125740");
        assertThat(gegeben.get("R1").get("rest_kwh").decimalValue()).isEqualByComparingTo("59640");
        for (String kz : List.of("EE-1", "EE-3", "EE-2", "EE-6", "EE-5", "EE-4")) {
            JsonNode r = gegeben.get("R2").at("/rangliste/" + kz);
            assertThat(r.get("menge_kwh").decimalValue()).isEqualByComparingTo(einsatzMengen.get(kz));
            BigDecimal anteil = einsatzMengen.get(kz).multiply(new BigDecimal("100"))
                    .divide(new BigDecimal("185380"), 1, RoundingMode.HALF_UP);
            assertThat(r.get("anteil_prozent").decimalValue()).isEqualByComparingTo(anteil);
        }
        Map<String, JsonNode> einstufungen = new LinkedHashMap<>();
        kinder(d.get("einstufungen")).forEach(e -> einstufungen.put(text(e, "einsatz"), e));
        for (JsonNode r : kinder(gegeben.get("R3").get("einstufungen"))) {
            JsonNode f = einstufungen.get(text(r, "einsatz")).at("/fassungen/0");
            assertThat(text(r, "einstufung")).isEqualTo(text(f, "einstufung"));
            assertThat(text(r, "begruendung")).isEqualTo(text(f, "begruendung"));
            assertThat(text(r, "person")).isEqualTo(text(f, "person"));
        }
        assertThat(gegeben.get("R4").get("EE-1_menge_kwh").decimalValue()).isEqualByComparingTo(einsatzMengen.get("EE-1"));
        assertThat(gegeben.get("R4").get("MS-20_minus_EE-1").decimalValue()).isEqualByComparingTo("11130");
        assertThat(kanonisch(gegeben.get("R5").get("messbedarf"))).isEqualTo(kanonisch(mb1));
        JsonNode r5Messstelle = gegeben.get("R5").get("MS-23");
        assertThat(text(r5Messstelle, "name")).isEqualTo(text(ms.get("MS-23"), "name"));
        assertThat(text(r5Messstelle, "ort")).isEqualTo(text(ms.get("MS-23").get("ort"), "kennzeichen"));
        assertThat(text(r5Messstelle, "stellung")).isEqualTo(String.format("%s · %s von %s",
                text(geplanteStellung, "anlage"), text(geplanteStellung, "stellung"),
                text(geplanteStellung, "unterzaehler_von")));
        assertThat(text(r5Messstelle, "quelle_ab")).startsWith(
                ms.get("MS-23").at("/fuehrende_quelle/0/gueltig_ab").asText());
        assertThat(gegeben.get("R7").at("/stand_2/MS-12/wert").decimalValue()).isEqualByComparingTo("6040");
        assertThat(gegeben.get("R7").at("/stand_2/rest_kwh").decimalValue()).isEqualByComparingTo("59640");
        assertThat(text(gegeben.get("R8").get("GR-2"), "pruefungsart")).isEqualTo(text(angaben.get("GR-2"), "pruefungsart"));
        assertThat(text(gegeben.get("R8").get("GR-5"), "pruefungsart")).isEqualTo(text(angaben.get("GR-5"), "pruefungsart"));
        assertThat(gegeben.get("R12").at("/MS-21/oktober_2026_m3").decimalValue()).isEqualByComparingTo("1240");
        assertThat(text(gegeben.get("R12").get("EE-7"), "traeger")).isEqualTo("Gas");
        Map<String, String> verantwortlich = kinder(d.get("energieeinsaetze")).stream()
                .collect(java.util.stream.Collectors.toMap(e -> text(e, "kennzeichen"), e -> text(e, "verantwortlich")));
        for (String kz : List.of("EE-2", "EE-5", "EE-3", "EE-4", "EE-6", "EE-7")) {
            assertThat(text(gegeben.get("R14").get("verantwortlich"), kz)).startsWith(verantwortlich.get(kz));
        }
    }

    // ------------------------------------ Fassung 1.7 (K-1 an der Hauptgröße, Befund aus PR 1104)

    static final String FASSUNG_1_6_SHA256 = "5b3c87b06a7b8b48d4b00a95f505cad6b7c75b54cdfdf33e1463a72977cf1c14";
    static final int KOMMENTAR_ZEILEN_1_6 = 118;
    static final String ZEITACHSE_K1_1_6 = "als Vergleichsquelle der Wirkleistung, Zweck";
    static final String ZEITACHSE_K1_1_7 =
            "als Vergleichsquelle der Wirkleistung und — aus der Leistung integriert — der Wirkenergie Bezug, Zweck";
    /** Herleitungen mit Monatsmenge (messstelle.md §5) — wie im {@link VergleichToleranzService}. */
    static final Set<String> MIT_MENGE = Set.of("zaehlerstand", "differenzen", "integration");

    /** Nimmt GENAU die Zusätze der Fassung 1.7 heraus: K-1 nur an der Nebengröße (mit der Toleranz), ohne R9. */
    static void ohneFassung17(ObjectNode d) {
        assertThat(d.path("version").asText()).isEqualTo("1.7");
        d.put("version", "1.6");
        d.put("stand", "2026-09-22");
        ArrayNode kommentar = (ArrayNode) d.get("_comment");
        assertThat(kommentar.size()).isGreaterThan(KOMMENTAR_ZEILEN_1_6);
        while (kommentar.size() > KOMMENTAR_ZEILEN_1_6) {
            kommentar.remove(kommentar.size() - 1);
        }
        assertThat(((ObjectNode) d.get("_herkunft")).remove("fassung_1_7")).isNotNull();
        ObjectNode ms01 = (ObjectNode) nachKennzeichen(d.get("messstellen")).get("MS-01");
        ArrayNode haupt = (ArrayNode) ms01.get("vergleichsquellen");
        assertThat(kinder(haupt).stream().map(q -> text(q, "komponente")).toList()).containsExactly("K-1");
        ObjectNode k1 = (ObjectNode) haupt.remove(0);
        assertThat(k1.remove("herleitung").asText()).isEqualTo("integration");
        JsonNode toleranz = k1.remove("toleranz_fassungen");
        assertThat(toleranz).isNotNull();
        ObjectNode neben = (ObjectNode) ms01.at("/nebengroessen/0/vergleichsquellen/0");
        assertThat(neben).as("an der Nebengröße dieselbe Bindung ohne Herleitung und Toleranz").isEqualTo(k1);
        neben.set("toleranz_fassungen", toleranz);
        List<JsonNode> zeile = kinder(d.get("zeitachse")).stream()
                .filter(z -> text(z, "ereignis").contains(ZEITACHSE_K1_1_7)).toList();
        assertThat(zeile).hasSize(1);
        ((ObjectNode) zeile.get(0)).put("ereignis", text(zeile.get(0), "ereignis")
                .replace(ZEITACHSE_K1_1_7, ZEITACHSE_K1_1_6));
        ObjectNode ap16 = (ObjectNode) d.get("abnahmefaelle_ap16");
        ap16.put("quelle", text(ap16, "quelle").replace("R7, R8, R9, R12", "R7, R8, R12"));
        entferne((ArrayNode) ap16.get("faelle"), f -> "R9".equals(text(f, "fall")), 1);
    }

    /** Je Vergleichsquelle von MS-01 („Größe · Komponente“): Monatsvergleich nur an der Hauptgröße mit Monatsmenge (bewertung.md §13). */
    private static Map<String, String> monatsvergleichArt(JsonNode ms01) {
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode q : kinder(ms01.get("vergleichsquellen"))) {
            out.put(text(ms01.get("hauptgroesse"), "groesse") + " · " + text(q, "komponente"),
                    MIT_MENGE.contains(q.path("herleitung").asText())
                            ? VergleichToleranzService.MIT_MONATSVERGLEICH : VergleichToleranzService.OHNE_MONATSMENGE);
        }
        for (JsonNode n : kinder(ms01.get("nebengroessen"))) {
            kinder(n.get("vergleichsquellen")).forEach(q -> out.put(text(n, "groesse") + " · " + text(q, "komponente"),
                    VergleichToleranzService.OHNE_MONATSMENGE));
        }
        return out;
    }

    @Test
    void ohneDieZusaetzeDerFassung17IstEsDieFassung16() throws Exception {
        ObjectNode d = daten().deepCopy();
        ohneFassung17(d);
        assertThat(sha256(kanonisch(d))).as("Fingerabdruck der Fassung 1.6").isEqualTo(FASSUNG_1_6_SHA256);
    }

    @Test
    void k1VergleichtAnDerHauptgroesseUndR9ErgibtSichAusDerDatei() throws Exception {
        ObjectNode alt = daten().deepCopy();
        ohneFassung17(alt);
        assertThat(monatsvergleichArt(nachKennzeichen(alt.get("messstellen")).get("MS-01")))
                .as("Fassung 1.6: K-1 nur an der Nebengröße")
                .containsExactly(Map.entry("Wirkleistung · K-1", "ohne_monatsmenge"));

        JsonNode d = daten();
        JsonNode ms01 = nachKennzeichen(d.get("messstellen")).get("MS-01");
        assertThat(monatsvergleichArt(ms01)).containsExactly(Map.entry("Wirkenergie · K-1", "ja"),
                Map.entry("Wirkleistung · K-1", "ohne_monatsmenge"));
        JsonNode k1 = ms01.at("/vergleichsquellen/0");
        assertThat(List.of(text(ms01.get("hauptgroesse"), "groesse"), text(ms01.get("hauptgroesse"), "einheit"),
                text(k1, "kanal_wertart"), text(k1, "herleitung")))
                .containsExactly("Wirkenergie", "kWh", "gauge", "integration");
        assertThat(kinder(ms01.get("nebengroessen")).stream()
                .map(n -> text(n, "groesse") + " ← " + text(n.at("/fuehrende_quelle/0"), "komponente")
                        + " · Vergleich " + text(n.at("/vergleichsquellen/0"), "komponente")
                        + (n.at("/vergleichsquellen/0").has("toleranz_fassungen") ? " mit Toleranz" : "")).toList())
                .as("die Nebengröße bleibt wie sie war, nur ohne Toleranz")
                .containsExactly("Wirkleistung ← K-3 · Vergleich K-1");

        JsonNode r9 = kinder(d.at("/abnahmefaelle_ap16/faelle")).stream()
                .filter(f -> "R9".equals(text(f, "fall"))).findFirst().orElseThrow().get("gegeben");
        JsonNode fassung = kinder(k1.get("toleranz_fassungen")).stream()
                .filter(t -> t.get("fassung").asInt() == r9.at("/toleranz/fassung").asInt()).findFirst().orElseThrow();
        assertThat(fassung.get("prozent_je_monat").decimalValue())
                .isEqualByComparingTo(r9.at("/toleranz/prozent_je_monat").decimalValue());
        assertThat(r9.at("/toleranz/vergleichsquelle").asText()).isEqualTo("MS-01 ← " + text(k1, "komponente") + " Netzleistung");
        String grenze = fassung.get("prozent_je_monat").decimalValue().stripTrailingZeros().toPlainString();
        Map<String, Object> dez = BewertungRegeln.monatsvergleich(
                new BewertungRegeln.MonatsSeite(r9.at("/dezember_2026/fuehrend_kwh").asText(), "vollständig"),
                new BewertungRegeln.MonatsSeite(r9.at("/dezember_2026/vergleich_kwh").asText(), "vollständig"), true, grenze);
        Map<String, Object> gegen = BewertungRegeln.monatsvergleich(
                new BewertungRegeln.MonatsSeite(r9.at("/gegenprobe/fuehrend_kwh").asText(), "vollständig"),
                new BewertungRegeln.MonatsSeite(r9.at("/gegenprobe/vergleich_kwh").asText(), "vollständig"), true, grenze);
        assertThat(List.of(dez.get("zustand"), dez.get("abweichung_prozent"), dez.get("toleranz_prozent")))
                .containsExactly("passt", "1.1", "2");
        assertThat(List.of(gegen.get("zustand"), gegen.get("abweichung_prozent"), gegen.get("befund")))
                .containsExactly("abweichung", "3.4", true);
        assertThat(new BigDecimal((String) dez.get("abweichung_prozent")))
                .isEqualByComparingTo(r9.at("/dezember_2026/abweichung_prozent").decimalValue());
        assertThat(new BigDecimal((String) gegen.get("abweichung_prozent")))
                .isEqualByComparingTo(r9.at("/gegenprobe/abweichung_prozent").decimalValue());
    }

    /** Die Objekte einer Liste nach ihrem Kennzeichen. */
    private static Map<String, JsonNode> nachKennzeichen(JsonNode array) {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        kinder(array).forEach(o -> out.put(o.get("kennzeichen").asText(), o));
        return out;
    }

    /** Die Grenze eines Netzanschlusses an einem Tag (tagesgenau), oder {@code null}. */
    private static JsonNode grenzeAm(JsonNode d, String netzanschluss, LocalDate tag) {
        return kinder(d.get("netzanschluss_grenzen")).stream()
                .filter(g -> netzanschluss.equals(g.get("netzanschluss").asText()) && giltAm(g, tag))
                .findFirst().orElse(null);
    }

    private static BigDecimal kw(JsonNode n) {
        return n.decimalValue();
    }

    private static List<String> feldnamen(JsonNode o) {
        List<String> out = new ArrayList<>();
        o.fieldNames().forEachRemaining(out::add);
        return out;
    }

    /** Die Formel einer berechneten Messstelle („MS-10 − MS-11 − …“) mit den Oktoberzahlen der Datei, eine davon ersetzt. */
    private static BigDecimal formel(Map<String, JsonNode> ms, String messstelle, String ersetzt, BigDecimal durch) {
        BigDecimal summe = BigDecimal.ZERO;
        int vorzeichen = 1;
        for (String teil : ms.get(messstelle).get("formel").asText().split(" ")) {
            if (teil.equals("−") || teil.equals("+")) {
                vorzeichen = teil.equals("+") ? 1 : -1;
                continue;
            }
            BigDecimal wert = teil.equals(ersetzt) ? durch : ms.get(teil).at("/beispielwerte/oktober_2026_kwh").decimalValue();
            summe = summe.add(vorzeichen > 0 ? wert : wert.negate());
        }
        return summe;
    }

    private static void entferne(ArrayNode liste, Predicate<JsonNode> weg, int erwartet) {
        int entfernt = 0;
        for (int i = liste.size() - 1; i >= 0; i--) {
            if (weg.test(liste.get(i))) {
                liste.remove(i);
                entfernt++;
            }
        }
        assertThat(entfernt).as("Zusätze der Fassung 1.3").isEqualTo(erwartet);
    }

    private static final ObjectMapper KANON = new ObjectMapper();

    /** Kanonisch: Schlüssel sortiert, kein Leerraum, Zahlen ohne nachgestellte Nullen („46.0“ → „46“). */
    static String kanonisch(JsonNode n) throws Exception {
        if (n.isObject()) {
            List<String> namen = new ArrayList<>();
            n.fieldNames().forEachRemaining(namen::add);
            Collections.sort(namen);
            List<String> teile = new ArrayList<>();
            for (String name : namen) {
                teile.add(KANON.writeValueAsString(name) + ":" + kanonisch(n.get(name)));
            }
            return "{" + String.join(",", teile) + "}";
        }
        if (n.isArray()) {
            List<String> teile = new ArrayList<>();
            for (JsonNode e : n) {
                teile.add(kanonisch(e));
            }
            return "[" + String.join(",", teile) + "]";
        }
        if (n.isNumber()) {
            return n.decimalValue().stripTrailingZeros().toPlainString();
        }
        if (n.isTextual()) {
            return KANON.writeValueAsString(n.asText());
        }
        return n.toString();
    }

    private static String sha256(String text) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static void kennzeichenRegister(JsonNode d, Map<String, String> reg,
            List<String> fehler) {
        merke(reg, fehler, "unternehmen", d.at("/unternehmen/kennzeichen").asText());
        for (String s : List.of("standorte", "gebaeude", "bereiche", "prozesse", "kostenstellen",
                "netzanschluesse", "anlagen", "boxen", "datenquellen", "geraete", "komponenten",
                "messstellen", "bezugsgroessen", "kennzahlen", "gemeinsame_steuerungen",
                "energieeinsaetze", "messbedarfe")) {
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
            JsonNode geplant = m.get("geplante_elektrische_stellung");
            if (geplant != null && geplant.isObject()) {
                out.add(new Verweis(kz + ".geplante_stellung.anlage", text(geplant, "anlage"), "anlagen"));
                out.add(new Verweis(kz + ".geplante_stellung.unterzaehler_von",
                        text(geplant, "unterzaehler_von"), "messstellen"));
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
                for (JsonNode t : kinder(q.get("toleranz_fassungen"))) {
                    out.add(new Verweis(kz + ".vergleich.toleranz.person", t.get("person").asText(), "personen"));
                }
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
        for (JsonNode u : kinder(d.at("/bewertung_umfang/fassungen"))) {
            for (JsonNode s : kinder(u.get("standorte"))) {
                out.add(new Verweis("bewertung_umfang.standort", s.asText(), "standorte"));
            }
            out.add(new Verweis("bewertung_umfang.person", u.get("person").asText(), "personen"));
        }
        for (JsonNode e : kinder(d.get("energieeinsaetze"))) {
            String kz = e.get("kennzeichen").asText();
            out.add(new Verweis(kz + ".prozess", e.get("prozess").asText(), "prozesse"));
            out.add(new Verweis(kz + ".verantwortlich", e.get("verantwortlich").asText(), "personen"));
            for (JsonNode m : kinder(e.get("messstellen"))) {
                out.add(new Verweis(kz + ".messstelle", m.asText(), "messstellen"));
            }
            for (JsonNode i : kinder(e.get("einflussgroessen"))) {
                if (i.hasNonNull("bezugsgroesse")) {
                    out.add(new Verweis(kz + ".einflussgroesse", i.get("bezugsgroesse").asText(),
                            "bezugsgroessen"));
                }
            }
        }
        for (JsonNode k : kinder(d.get("bewertung_kriterien"))) {
            out.add(new Verweis("bewertung_kriterien.person", k.get("person").asText(), "personen"));
        }
        for (JsonNode e : kinder(d.get("einstufungen"))) {
            out.add(new Verweis("einstufung.einsatz", e.get("einsatz").asText(), "energieeinsaetze"));
            for (JsonNode f : kinder(e.get("fassungen"))) {
                out.add(new Verweis("einstufung.person", f.get("person").asText(), "personen"));
                for (JsonNode i : kinder(f.at("/herkunft/eingaenge"))) {
                    out.add(new Verweis("einstufung.herkunft.eingang", i.get("objekt").asText(), "messstellen"));
                }
            }
        }
        for (JsonNode b : kinder(d.get("messbedarfe"))) {
            out.add(new Verweis("messbedarf.einsatz", b.get("einsatz").asText(), "energieeinsaetze"));
            out.add(new Verweis("messbedarf.ort", b.get("ort").asText(), "bereiche", "gebaeude", "standorte"));
            if (b.hasNonNull("messstelle")) {
                out.add(new Verweis("messbedarf.messstelle", b.get("messstelle").asText(), "messstellen"));
            }
            out.add(new Verweis("messbedarf.person", b.get("person").asText(), "personen"));
        }
        for (JsonNode a : kinder(d.get("messmittel_angaben"))) {
            String art = a.get("ziel_art").asText();
            out.add(new Verweis("messmittel.ziel", a.get("ziel").asText(),
                    "geraet".equals(art) ? "geraete" : "einbau".equals(art) ? "einbauten" : "komponenten"));
            out.add(new Verweis("messmittel.person", a.get("person").asText(), "personen"));
            if (a.hasNonNull("beleg")) {
                out.add(new Verweis("messmittel.beleg.person", a.at("/beleg/person").asText(), "personen"));
            }
        }
        for (JsonNode b : kinder(d.get("bezugsgroessen"))) {
            if ("prozess".equals(b.get("geltung_art").asText()) && b.hasNonNull("geltung")) {
                out.add(new Verweis(b.get("kennzeichen").asText() + ".geltung",
                        b.get("geltung").asText(), "prozesse"));
            }
            // Fassung 1.3 (AP-11 E13): die Gebäude-Stückzahlen BZ-6 und BZ-7.
            if ("gebaeude".equals(b.get("geltung_art").asText()) && b.hasNonNull("geltung")) {
                out.add(new Verweis(b.get("kennzeichen").asText() + ".geltung",
                        b.get("geltung").asText(), "gebaeude"));
            }
            // Fassung 1.2 (AP-09 E1/W5): eine Bezugsgröße kann an einer Messstelle hängen.
            if (b.hasNonNull("messstelle")) {
                out.add(new Verweis(b.get("kennzeichen").asText() + ".messstelle",
                        b.get("messstelle").asText(), "messstellen"));
            }
        }
        // Fassung 1.3 (AP-11 E13): eine Kennzahl verweist NUR über Kennzeichen — auf ihre Menge, ihre
        // Bezugsgröße (beim Stammdatum mit dem Gebäude), ihre Paare, ihr Geltungsobjekt und die Person.
        Map<String, String> geltungGattung = Map.of("unternehmen", "unternehmen", "standort", "standorte",
                "gebaeude", "gebaeude", "bereich", "bereiche", "prozess", "prozesse",
                "kostenstelle", "kostenstellen", "messstelle", "messstellen");
        for (JsonNode k : kinder(d.get("kennzahlen"))) {
            String kz = k.get("kennzeichen").asText();
            out.add(new Verweis(kz + ".geltung", k.get("geltung").asText(),
                    geltungGattung.get(k.get("geltung_art").asText())));
            out.add(new Verweis(kz + ".verantwortlich", k.get("verantwortlich").asText(), "personen"));
            if (k.hasNonNull("zaehler")) {
                out.add(new Verweis(kz + ".zaehler", k.get("zaehler").asText(), "messstellen"));
            }
            if (k.hasNonNull("nenner")) {
                out.add(new Verweis(kz + ".nenner", k.get("nenner").asText(), "bezugsgroessen"));
            }
            if (k.hasNonNull("nenner_ort")) {
                out.add(new Verweis(kz + ".nenner_ort", k.get("nenner_ort").asText(), "gebaeude"));
            }
            if (k.hasNonNull("paare")) {
                for (JsonNode p : kinder(k.get("paare"))) {
                    out.add(new Verweis(kz + ".paar", p.asText(), "kennzahlen"));
                }
            }
        }
        // Fassung 1.5 (AP-15 E8): Grenzen, gemeinsame Steuerung und Geräte-Rückfälle verweisen nur über Kennzeichen.
        for (JsonNode g : kinder(d.get("netzanschluss_grenzen"))) {
            out.add(new Verweis("grenze.netzanschluss", g.get("netzanschluss").asText(), "netzanschluesse"));
        }
        for (JsonNode v : kinder(d.get("gemeinsame_steuerungen"))) {
            String kz = v.get("kennzeichen").asText();
            out.add(new Verweis(kz + ".anlage", v.get("anlage").asText(), "anlagen"));
            out.add(new Verweis(kz + ".netzanschluss", v.get("netzanschluss").asText(), "netzanschluesse"));
            for (JsonNode m : kinder(v.get("mitglieder"))) {
                out.add(new Verweis(kz + ".mitglied", m.get("box").asText(), "boxen"));
                out.add(new Verweis(kz + ".messpunkt", m.get("messpunkt").asText(), "datenquellen"));
            }
        }
        for (JsonNode r : kinder(d.get("geraete_rueckfaelle"))) {
            out.add(new Verweis("rueckfall.komponente", r.get("komponente").asText(), "komponenten"));
        }
        for (JsonNode z : kinder(d.get("zeitachse"))) {
            if (z.hasNonNull("gemeinsame_steuerung")) {
                out.add(new Verweis("zeitachse.gemeinsame_steuerung", z.get("gemeinsame_steuerung").asText(),
                        "gemeinsame_steuerungen"));
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
