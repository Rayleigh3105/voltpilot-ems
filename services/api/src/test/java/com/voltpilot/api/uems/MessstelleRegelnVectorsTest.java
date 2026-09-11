package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.MessstelleRegeln.Abschnitt;
import com.voltpilot.api.uems.MessstelleRegeln.BeendenEingang;
import com.voltpilot.api.uems.MessstelleRegeln.BeendenUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.Bindung;
import com.voltpilot.api.uems.MessstelleRegeln.BindungEingang;
import com.voltpilot.api.uems.MessstelleRegeln.BindungUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.FremdeFuehrung;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.KatalogEintrag;
import com.voltpilot.api.uems.MessstelleRegeln.KatalogQuelle;
import com.voltpilot.api.uems.MessstelleRegeln.KennzeichenUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.LebenszyklusEingang;
import com.voltpilot.api.uems.MessstelleRegeln.LebenszyklusErgebnis;
import com.voltpilot.api.uems.MessstelleRegeln.NeueBindung;
import com.voltpilot.api.uems.MessstelleRegeln.QuelleZeitraum;
import com.voltpilot.api.uems.MessstelleRegeln.Rueckwirkung;
import com.voltpilot.api.uems.MessstelleRegeln.Stand;
import com.voltpilot.api.uems.MessstelleRegeln.Stellung;
import com.voltpilot.api.uems.MessstelleRegeln.StellungEintrag;
import com.voltpilot.api.uems.MessstelleRegeln.StellungKandidat;
import com.voltpilot.api.uems.MessstelleRegeln.StellungUrteil;
import com.voltpilot.api.uems.MessstelleRegeln.Vergeben;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.Function;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings: {@link MessstelleRegeln} zieht aus JEDEM Fall
 * der EINEN geteilten Vektor-Datei ({@code docs/contracts/v2/messstelle-vectors.json})
 * dasselbe Urteil wie der TS-Zwilling ({@code frontend/portal/src/uemsMessstelle.test.ts}
 * fährt dieselbe Datei).
 *
 * <p>Dazu: die Datei und die Beispiele unter {@code fixtures/messstelle/} halten
 * ihr Schema, die Regel-Konstanten stehen genau so in der Datei, und jeder Fall,
 * der sich auf eine Messstelle des Referenzunternehmens beruft, übernimmt deren
 * Werte unverändert. Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class MessstelleRegelnVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("messstelle-vectors.json");
    private static final Path SCHEMA = V2.resolve("messstelle.schema.json");
    private static final Path FIXTURES = V2.resolve("fixtures").resolve("messstelle");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    private static final DateTimeFormatter ZEIT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ssxxx");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static JsonNode vectors() throws Exception {
        return lies(VECTORS);
    }

    private static List<JsonNode> faelle(String familie) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        vectors().path("cases").path(familie).forEach(out::add);
        assertThat(out).as("Fälle der Familie " + familie).isNotEmpty();
        return out;
    }

    // ------------------------------------------------------------------ Form

    @Test
    void dieVektorDateiHaeltIhrSchema() throws Exception {
        JsonNode schema = lies(SCHEMA);
        List<String> fehler = new ArrayList<>();
        new UemsSchemaLaeufer(schema, fehler).pruefe(vectors(), schema.at("/$defs/vektorDatei"), "$");
        assertThat(fehler).as("Schema-Verstöße der Vektor-Datei").isEmpty();
    }

    /** AP-04 §8 IP-1: mindestens 12 Fälle; jeder Name einmal. */
    @Test
    void mindestensZwoelfFaelleMitEindeutigenNamen() throws Exception {
        List<String> namen = new ArrayList<>();
        vectors().path("cases").forEach(familie -> familie.forEach(c -> namen.add(c.path("name").asText())));
        assertThat(namen).hasSizeGreaterThanOrEqualTo(12).doesNotHaveDuplicates();
    }

    /** Mindestens zwei gültige und ein ungültiges Beispiel; ein ungültiges bricht GENAU eine Regel. */
    @TestFactory
    List<DynamicTest> dieBeispieleHaltenIhrSchema() throws Exception {
        JsonNode schema = lies(SCHEMA);
        List<Path> dateien;
        try (Stream<Path> s = Files.list(FIXTURES)) {
            dateien = s.filter(p -> p.getFileName().toString().endsWith(".json")).sorted().toList();
        }
        assertThat(dateien.stream().filter(p -> p.getFileName().toString().contains(".valid."))).hasSizeGreaterThanOrEqualTo(2);
        assertThat(dateien.stream().filter(p -> p.getFileName().toString().contains(".invalid."))).hasSizeGreaterThanOrEqualTo(1);
        List<DynamicTest> tests = new ArrayList<>();
        for (Path p : dateien) {
            tests.add(DynamicTest.dynamicTest(p.getFileName().toString(), () -> {
                List<String> fehler = new ArrayList<>();
                new UemsSchemaLaeufer(schema, fehler).pruefe(lies(p), schema, "$");
                if (p.getFileName().toString().contains(".invalid.")) {
                    assertThat(fehler).as("genau ein Verstoß").hasSize(1);
                } else {
                    assertThat(fehler).as("Schema-Verstöße").isEmpty();
                }
            }));
        }
        return tests;
    }

    // ------------------------------------------------ die Regeln in der Datei

    /** Die Konstanten der Klasse sind genau die der Datei — in ihrer Reihenfolge. */
    @Test
    void dieRegelnStehenInDerDatei() throws Exception {
        JsonNode v = vectors();
        JsonNode k = v.path("kennzeichen_regel");
        assertThat(k.path("praefix").asText()).isEqualTo(MessstelleRegeln.KENNZEICHEN_PRAEFIX);
        assertThat(k.path("stellen").asInt()).isEqualTo(MessstelleRegeln.KENNZEICHEN_STELLEN);
        assertThat(k.path("muster").asText()).isEqualTo(MessstelleRegeln.KENNZEICHEN_MUSTER);
        assertThat(k.path("min_zeichen").asInt()).isEqualTo(MessstelleRegeln.KENNZEICHEN_MIN_ZEICHEN);
        assertThat(k.path("max_zeichen").asInt()).isEqualTo(MessstelleRegeln.KENNZEICHEN_MAX_ZEICHEN);
        assertThat(texte(v.path("medien"))).isEqualTo(MessstelleRegeln.MEDIEN);
        assertThat(texte(v.path("medien_waehlbar"))).isEqualTo(MessstelleRegeln.MEDIEN_WAEHLBAR);
        assertThat(texte(v.path("lebenszyklus"))).isEqualTo(MessstelleRegeln.LEBENSZYKLUS);
        assertThat(texte(v.path("fehlt"))).isEqualTo(MessstelleRegeln.FEHLT);
        assertThat(texte(v.path("bindung_status"))).isEqualTo(MessstelleRegeln.BINDUNG_STATUS);
        assertThat(texte(v.path("herleitungen"))).isEqualTo(MessstelleRegeln.HERLEITUNGEN);
        assertThat(texte(v.path("vergleich_zwecke"))).isEqualTo(MessstelleRegeln.VERGLEICH_ZWECKE);
        assertThat(texte(v.path("stellungen"))).isEqualTo(MessstelleRegeln.STELLUNGEN);
        assertThat(texte(v.path("stellung_gruende"))).isEqualTo(MessstelleRegeln.STELLUNG_GRUENDE);
        assertThat(texte(v.path("passung_gruende"))).isEqualTo(MessstelleRegeln.PASSUNG_GRUENDE);
        assertThat(texte(v.path("hinweise"))).isEqualTo(MessstelleRegeln.HINWEISE);
        assertThat(texte(v.path("rueckwirkung_arten"))).isEqualTo(MessstelleRegeln.RUECKWIRKUNG_ARTEN);

        List<String> fehlerDatei = new ArrayList<>();
        v.path("fehler").forEach(f -> fehlerDatei.add(
                f.path("code").asText() + "/" + f.path("status").asInt() + "/" + f.path("geprueft_von").asText()));
        assertThat(fehlerDatei).isEqualTo(Arrays.stream(MessstelleRegeln.Fehler.values())
                .map(f -> f.code() + "/" + f.status() + "/" + f.geprueftVon())
                .toList());

        List<KatalogEintrag> katalog = new ArrayList<>();
        for (JsonNode e : v.path("groessen_katalog")) {
            List<KatalogQuelle> quellen = new ArrayList<>();
            e.path("quellen").forEach(q -> quellen.add(new KatalogQuelle(
                    q.path("kanal_groesse").asText(), q.path("kanal_wertart").asText(), text(q.path("nur_wertart")))));
            katalog.add(new KatalogEintrag(e.path("groesse").asText(), texte(e.path("medien")),
                    e.path("einheit").asText(), texte(e.path("richtungen")), texte(e.path("wertarten")), quellen));
        }
        assertThat(katalog).isEqualTo(MessstelleRegeln.GROESSEN_KATALOG);

        List<String> einheiten = new ArrayList<>();
        v.path("kanal_einheiten").fields().forEachRemaining(e -> einheiten.add(e.getKey() + "=" + texte(e.getValue())));
        assertThat(einheiten).isEqualTo(MessstelleRegeln.KANAL_EINHEITEN.entrySet().stream()
                .map(e -> e.getKey() + "=" + e.getValue())
                .toList());
    }

    // ------------------------------------------------------ die Vektor-Fälle

    @TestFactory
    List<DynamicTest> kennzeichenVorschlag() throws Exception {
        return fuerJedenFall("kennzeichen_vorschlag", c -> {
            List<String> belegt = texte(c.at("/input/belegt"));
            MessstelleRegeln.Vorschlag v = MessstelleRegeln.kennzeichenVorschlag(c.at("/input/zaehler").asInt(), belegt);
            ObjectNode out = MAPPER.createObjectNode();
            out.put("kennzeichen", v.kennzeichen());
            out.put("zaehler", v.zaehler());
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> kennzeichenPruefen() throws Exception {
        return fuerJedenFall("kennzeichen_pruefen", c -> {
            JsonNode in = c.path("input");
            List<Vergeben> vergeben = new ArrayList<>();
            in.path("vergeben").forEach(v -> vergeben.add(new Vergeben(v.path("kennzeichen").asText(),
                    v.path("messstelle").asText(), v.path("name").asText(),
                    v.path("archiviert").asBoolean(), v.path("frueher").asBoolean())));
            KennzeichenUrteil u = MessstelleRegeln.kennzeichenPruefen(
                    in.path("kandidat").asText(), text(in.path("fuer_messstelle")), vergeben);
            ObjectNode out = MAPPER.createObjectNode();
            out.put("fehler", u.fehler() == null ? null : u.fehler().code());
            if (u.bestehend() == null) {
                out.putNull("bestehend");
            } else {
                ObjectNode b = out.putObject("bestehend");
                b.put("kennzeichen", u.bestehend().kennzeichen());
                b.put("messstelle", u.bestehend().messstelle());
                b.put("name", u.bestehend().name());
                b.put("archiviert", u.bestehend().archiviert());
                b.put("frueher", u.bestehend().frueher());
            }
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> groesse() throws Exception {
        return fuerJedenFall("groesse", c -> {
            MessstelleRegeln.GroesseUrteil u = MessstelleRegeln.groessePruefen(
                    c.at("/input/medium").asText(), groesse(c.at("/input/groesse")));
            ObjectNode out = MAPPER.createObjectNode();
            out.put("fehler", u.fehler() == null ? null : u.fehler().code());
            out.put("grund", u.grund());
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> lebenszyklus() throws Exception {
        return fuerJedenFall("lebenszyklus", c -> {
            LebenszyklusErgebnis r = MessstelleRegeln.lebenszyklus(lebenszyklusEingang(c.path("input")));
            ObjectNode out = MAPPER.createObjectNode();
            out.put("lebenszyklus", r.lebenszyklus());
            out.put("eingerichtet", r.eingerichtet());
            ArrayNode fehlt = out.putArray("fehlt");
            r.fehlt().forEach(fehlt::add);
            out.put("quelle_vorhanden", r.quelleVorhanden());
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> passung() throws Exception {
        return fuerJedenFall("passung", c -> {
            JsonNode k = c.at("/input/kanal");
            MessstelleRegeln.Passung p = MessstelleRegeln.passung(c.at("/input/medium").asText(),
                    groesse(c.at("/input/ziel")), k.path("groesse").asText(), k.path("richtung").asText(),
                    k.path("einheit").asText(), k.path("wertart").asText());
            ObjectNode out = MAPPER.createObjectNode();
            out.put("fehler", p.fehler() == null ? null : p.fehler().code());
            out.put("grund", p.grund());
            out.put("herleitung", p.herleitung());
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> bindung() throws Exception {
        return fuerJedenFall("bindung", c -> urteilAlsJson(MessstelleRegeln.bindungPruefen(bindungEingang(c.path("input")))));
    }

    @TestFactory
    List<DynamicTest> beenden() throws Exception {
        return fuerJedenFall("beenden", c -> {
            JsonNode in = c.path("input");
            BeendenUrteil u = MessstelleRegeln.beendenPruefen(new BeendenEingang(zeit(in.path("jetzt")),
                    bindung(in.path("bindung")), zeit(in.path("gueltig_bis")), stand(in.path("endstand"))));
            ObjectNode out = MAPPER.createObjectNode();
            out.put("fehler", u.fehler() == null ? null : u.fehler().code());
            out.put("status", u.status());
            out.put("rueckwirkend", u.rueckwirkend());
            out.put("angekuendigt", u.angekuendigt());
            ArrayNode hinweise = out.putArray("hinweise");
            u.hinweise().forEach(hinweise::add);
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> rueckwirkung() throws Exception {
        return fuerJedenFall("rueckwirkung", c -> {
            Rueckwirkung r = MessstelleRegeln.rueckwirkung(zeit(c.at("/input/jetzt")), zeit(c.at("/input/zeitpunkt")));
            ObjectNode out = MAPPER.createObjectNode();
            out.put("art", r.art());
            out.put("minuten", Math.toIntExact(r.minuten()));
            out.put("abzeichen", r.abzeichen());
            return out;
        });
    }

    @TestFactory
    List<DynamicTest> zeitstrahl() throws Exception {
        return fuerJedenFall("zeitstrahl", c -> {
            List<QuelleZeitraum> quellen = new ArrayList<>();
            c.at("/input/fuehrende_quelle").forEach(q -> quellen.add(quelleZeitraum(q)));
            ObjectNode out = MAPPER.createObjectNode();
            out.set("zeitstrahl", zeitstrahlAlsJson(MessstelleRegeln.zeitstrahl(zeit(c.at("/input/beginn")), quellen)));
            return out;
        });
    }

    /**
     * Vergleichsquellen gibt es 0..n NEBENEINANDER (E3) — nur derselbe Messwert nicht
     * zweimal zur selben Zeit. Das Referenzunternehmen hat für keine Größe zwei
     * Vergleichs-Messwerte, deshalb prüfen beide Zwillinge diesen Zweig als Einheit,
     * mit neutralen Platzhaltern statt Ahrenberg-Kennzeichen.
     */
    @Test
    void zweiVerschiedeneVergleichsquellenStehenNebeneinander() {
        OffsetDateTime ab = OffsetDateTime.parse("2026-10-20T10:15:00+02:00");
        Groesse ziel = new Groesse("Wirkleistung", "Bezug", "kW", "Momentanwert");
        Bindung erste = new Bindung("vergleich", "Wirkleistung", "Bezug", "K-A", "Leistung A", "GR-A", "GR-A",
                "gauge", "Plausibilität", ab, null);
        NeueBindung zweite = new NeueBindung("vergleich", "Abrechnungszähler", "K-B", "Leistung B", "GR-B", "GR-B",
                "Wirkleistung", "Bezug", "kW", "gauge", ab, null, null, null, null);
        BindungUrteil u = MessstelleRegeln.bindungPruefen(
                new BindungEingang("binden", ab, "Strom", ab, ziel, List.of(erste), zweite, List.of()));
        assertThat(u.fehler()).isNull();
        assertThat(u.zeitstrahl()).as("eine Vergleichsquelle hat keinen eigenen Zeitstrahl").isNull();
    }

    /**
     * Zwei Hauptzähler DERSELBEN Richtung sind nie erlaubt — auch nicht am selben
     * Zähler. Im Referenzunternehmen liest keine zweite Messstelle einen Zähler in
     * derselben Richtung; beide Zwillinge prüfen den Zweig als Einheit.
     */
    @Test
    void zweiHauptzaehlerGleicherRichtungAuchAmSelbenZaehler() {
        StellungEintrag bestehend = new StellungEintrag("MS-A", "Netzbezug A", "AN-A", "Hauptzähler", null, "Bezug", "K-A");
        StellungUrteil u = MessstelleRegeln.stellungPruefen(
                new StellungKandidat("MS-B", "gemessen", "Strom", "Bezug", "K-A"),
                new Stellung("AN-A", "Hauptzähler", null), List.of(bestehend));
        assertThat(u.fehler()).isEqualTo(MessstelleRegeln.Fehler.HAUPTZAEHLER_VORHANDEN);
        assertThat(u.bestehend()).isEqualTo(bestehend);
    }

    @TestFactory
    List<DynamicTest> stellung() throws Exception {
        return fuerJedenFall("stellung", c -> {
            JsonNode in = c.path("input");
            JsonNode m = in.path("messstelle");
            StellungKandidat kandidat = new StellungKandidat(m.path("kennzeichen").asText(), m.path("art").asText(),
                    m.path("medium").asText(), m.path("richtung").asText(), text(m.path("komponente")));
            JsonNode s = in.path("stellung");
            Stellung stellung = s.isNull() ? null : new Stellung(s.path("anlage").asText(),
                    s.path("stellung").asText(), text(s.path("unterzaehler_von")));
            List<StellungEintrag> liste = new ArrayList<>();
            in.path("messstellen").forEach(e -> liste.add(stellungEintrag(e)));
            StellungUrteil u = MessstelleRegeln.stellungPruefen(kandidat, stellung, liste);
            ObjectNode out = MAPPER.createObjectNode();
            out.put("fehler", u.fehler() == null ? null : u.fehler().code());
            out.put("grund", u.grund());
            if (u.bestehend() == null) {
                out.putNull("bestehend");
            } else {
                ObjectNode b = out.putObject("bestehend");
                b.put("kennzeichen", u.bestehend().kennzeichen());
                b.put("name", u.bestehend().name());
                b.put("anlage", u.bestehend().anlage());
            }
            ArrayNode kette = out.putArray("kette");
            u.kette().forEach(kette::add);
            return out;
        });
    }

    // ---------------------------------------------- die Zwillinge untereinander

    /**
     * E8 über BEIDE Verträge: eine gemessene Messstelle ohne geltende Quelle heißt
     * im Zustandsvokabular „Keine Datenquelle“ — nie 0, nie „wartet“.
     */
    @TestFactory
    List<DynamicTest> ohneQuelleIstKeineDatenquelle() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle("lebenszyklus")) {
            if (!"gemessen".equals(c.at("/input/art").asText()) || c.at("/expected/quelle_vorhanden").asBoolean()) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                LebenszyklusErgebnis r = MessstelleRegeln.lebenszyklus(lebenszyklusEingang(c.path("input")));
                ZustandAbleitung.LiefertDatenErgebnis z = ZustandAbleitung.liefertDaten(
                        new ZustandAbleitung.LiefertDatenEingang(r.quelleVorhanden(), null, false, 60,
                                zeit(c.at("/input/jetzt")).toInstant(), ZustandAbleitung.VORGABE_ZEITZONE));
                assertThat(z.zustand()).isEqualTo(ZustandAbleitung.LiefertDaten.KEINE_DATENQUELLE);
            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /** Die gültigen Beispiele halten auch die Regeln, die das Schema nicht ausdrücken kann. */
    @TestFactory
    List<DynamicTest> dieGueltigenBeispieleHaltenDieRegeln() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (Path p : gueltigeBeispiele()) {
            tests.add(DynamicTest.dynamicTest(p.getFileName().toString(), () -> {
                JsonNode d = lies(p);
                assertThat(MessstelleRegeln.kennzeichenFormatGueltig(d.path("kennzeichen").asText())).isTrue();
                assertThat(MessstelleRegeln.groessePruefen(d.path("medium").asText(), groesse(d.path("hauptgroesse"))).fehler()).isNull();
                for (JsonNode n : d.path("nebengroessen")) {
                    assertThat(MessstelleRegeln.groessePruefen(d.path("medium").asText(), groesse(n)).fehler()).isNull();
                    assertThat(ueberlappungsfrei(n.path("fuehrende_quelle"))).isTrue();
                }
                assertThat(ueberlappungsfrei(d.path("fuehrende_quelle"))).isTrue();
                List<QuelleZeitraum> quellen = new ArrayList<>();
                d.path("fuehrende_quelle").forEach(q -> quellen.add(quelleZeitraum(q)));
                LebenszyklusErgebnis r = MessstelleRegeln.lebenszyklus(new LebenszyklusEingang(
                        d.path("art").asText(), d.path("medium").asText(), d.path("kennzeichen").asText(),
                        d.path("name").asText(), groesse(d.path("hauptgroesse")), !d.path("orte").isEmpty(),
                        false, false, false, false, quellen, MOMENTAUFNAHME));
                assertThat(r.lebenszyklus()).isEqualTo(d.path("lebenszyklus").asText());
            }));
        }
        return tests;
    }

    // ------------------------------------------------- das Referenzunternehmen

    /** MS-06 und MS-21 sind die Messstellen des Referenzunternehmens — Feld für Feld. */
    @TestFactory
    List<DynamicTest> dieGueltigenBeispieleUebernehmenDasReferenzunternehmen() throws Exception {
        JsonNode ref = lies(REFERENZ);
        List<DynamicTest> tests = new ArrayList<>();
        for (Path p : gueltigeBeispiele()) {
            tests.add(DynamicTest.dynamicTest(p.getFileName().toString(), () -> {
                JsonNode d = lies(p);
                String kz = d.path("kennzeichen").asText();
                JsonNode m = refMessstelle(ref, kz);
                for (String feld : List.of("name", "art", "medium", "kadenz_s")) {
                    assertThat(d.path(feld)).as(kz + "." + feld).isEqualTo(m.path(feld));
                }
                assertThat(groesse(d.path("hauptgroesse"))).isEqualTo(groesse(m.path("hauptgroesse")));
                assertThat(quellenOhneStand(d.path("fuehrende_quelle"))).isEqualTo(m.path("fuehrende_quelle"));
                for (JsonNode q : d.path("fuehrende_quelle")) {
                    JsonNode einbau = refEinbau(ref, q.path("einbau").asText());
                    assertThat(standWert(q.path("endstand"))).as(kz + " Endstand " + q.path("einbau").asText())
                            .isEqualTo(einbau.path("endstand_kwh"));
                    assertThat(standWert(q.path("anfangsstand"))).as(kz + " Anfangsstand " + q.path("einbau").asText())
                            .isEqualTo(einbau.path("anfangsstand_kwh"));
                }
                assertThat(d.path("nebengroessen")).hasSameSizeAs(m.path("nebengroessen"));
                for (int i = 0; i < d.path("nebengroessen").size(); i++) {
                    JsonNode n = d.path("nebengroessen").get(i);
                    JsonNode rn = m.path("nebengroessen").get(i);
                    assertThat(groesse(n)).isEqualTo(groesse(rn));
                    assertThat(quellenOhneStand(n.path("fuehrende_quelle"))).isEqualTo(rn.path("fuehrende_quelle"));
                    assertThat(n.path("vergleichsquellen")).isEqualTo(rn.path("vergleichsquellen"));
                }
                assertThat(d.path("vergleichsquellen")).isEqualTo(m.path("vergleichsquellen"));
                assertThat(d.path("elektrische_stellung")).isEqualTo(m.path("elektrische_stellung"));
                List<String> orte = new ArrayList<>();
                d.path("orte").forEach(o -> orte.add(o.path("kennzeichen").asText() + "|"
                        + o.path("gueltig_ab").asText() + "|" + text(o.path("gueltig_bis"))));
                assertThat(orte).isEqualTo(refOrte(ref, kz));
                assertThat(d.at("/orte/" + (d.path("orte").size() - 1) + "/ort_art").asText())
                        .isEqualTo(m.at("/ort/art").asText());
            }));
        }
        return tests;
    }

    /**
     * Jeder Fall, der sich auf eine Messstelle des Referenzunternehmens beruft,
     * übernimmt deren Werte: Name, Art, Medium, Größen, Stellungen und Quellen.
     * Eine Quelle darf NUR früher enden als dort, wenn der Fall eine
     * {@code fortschreibung} nach dem letzten Ereignis der Zeitachse ist — oder
     * noch offen sein, weil der Fall den Stand VOR dem Eintrag zeigt.
     */
    @TestFactory
    List<DynamicTest> faelleUebernehmenDasReferenzunternehmen() throws Exception {
        JsonNode ref = lies(REFERENZ);
        OffsetDateTime letztes = null;
        for (JsonNode z : ref.path("zeitachse")) {
            OffsetDateTime t = OffsetDateTime.parse(z.path("zeitpunkt").asText());
            letztes = letztes == null || t.isAfter(letztes) ? t : letztes;
        }
        OffsetDateTime ende = letztes;
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle("lebenszyklus")) {
            if (!c.hasNonNull("referenz")) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest("lebenszyklus/" + c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                JsonNode m = refMessstelle(ref, c.path("referenz").asText());
                assertThat(in.path("kennzeichen").asText()).isEqualTo(m.path("kennzeichen").asText());
                assertThat(in.path("name").asText()).isEqualTo(m.path("name").asText());
                assertThat(in.path("art").asText()).isEqualTo(m.path("art").asText());
                assertThat(in.path("medium").asText()).isEqualTo(m.path("medium").asText());
                assertThat(groesse(in.path("hauptgroesse"))).isEqualTo(groesse(m.path("hauptgroesse")));
                assertThat(in.path("ort_vorhanden").asBoolean()).isEqualTo(!refOrte(ref, m.path("kennzeichen").asText()).isEmpty());
                for (JsonNode q : in.path("fuehrende_quelle")) {
                    pruefeQuelle(q, m.path("fuehrende_quelle"), c.path("fortschreibung").asBoolean(), ende);
                }
            }));
        }
        for (JsonNode c : faelle("bindung")) {
            if (!c.hasNonNull("referenz")) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest("bindung/" + c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                JsonNode m = refMessstelle(ref, c.path("referenz").asText());
                assertThat(in.at("/messstelle/kennzeichen").asText()).isEqualTo(m.path("kennzeichen").asText());
                assertThat(in.at("/messstelle/medium").asText()).isEqualTo(m.path("medium").asText());
                List<String> orte = refOrte(ref, m.path("kennzeichen").asText());
                assertThat(in.at("/messstelle/beginn").asText()).isEqualTo(mitternacht(orte.get(0).split("\\|")[1]));
                JsonNode zielQuellen = refQuellenDerGroesse(m, groesse(in.path("ziel")));
                assertThat(zielQuellen).as("die Zielgröße ist eine Größe von " + m.path("kennzeichen").asText()).isNotNull();
                for (JsonNode b : in.path("bestehende")) {
                    String feld = "vergleich".equals(b.path("rolle").asText()) ? "vergleichsquellen" : "fuehrende_quelle";
                    JsonNode quellen = refListeDerGroesse(m, new Groesse(b.path("groesse").asText(),
                            b.path("richtung").asText(), null, null), feld);
                    assertThat(quellen).as(b.path("groesse").asText() + " · " + b.path("richtung").asText()).isNotNull();
                    pruefeQuelle(b, quellen, c.path("fortschreibung").asBoolean(), ende);
                }
                // Ein erlaubter Vergleichs-Eintrag an einer Messstelle der Datei ist der der Datei —
                // es sei denn, der Fall nennt ihn ausdrücklich als Annahme.
                JsonNode neu = in.path("neu");
                if ("vergleich".equals(neu.path("rolle").asText()) && c.at("/expected/fehler").isNull()
                        && !c.hasNonNull("annahme")) {
                    pruefeQuelle(neu, refListeDerGroesse(m, groesse(in.path("ziel")), "vergleichsquellen"),
                            false, ende);
                }
                if (c.path("ergebnis_wie_referenz").asBoolean()) {
                    pruefeZeitstrahlWieReferenz(c.at("/expected/zeitstrahl"), zielQuellen);
                }
            }));
        }
        // Beenden: die Quelle steht so im Referenzunternehmen; mit ergebnis_wie_referenz endet
        // sie genau dort, wo sie dort endet.
        for (JsonNode c : faelle("beenden")) {
            if (!c.hasNonNull("referenz")) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest("beenden/" + c.path("name").asText(), () -> {
                JsonNode b = c.at("/input/bindung");
                JsonNode m = refMessstelle(ref, c.path("referenz").asText());
                String feld = "vergleich".equals(b.path("rolle").asText()) ? "vergleichsquellen" : "fuehrende_quelle";
                JsonNode quellen = refListeDerGroesse(m, new Groesse(b.path("groesse").asText(),
                        b.path("richtung").asText(), null, null), feld);
                assertThat(quellen).as(b.path("groesse").asText() + " · " + b.path("richtung").asText()).isNotNull();
                pruefeQuelle(b, quellen, c.path("fortschreibung").asBoolean(), ende);
                if (c.path("ergebnis_wie_referenz").asBoolean()) {
                    ObjectNode beendet = b.deepCopy();
                    beendet.set("gueltig_bis", c.at("/input/gueltig_bis"));
                    pruefeQuelle(beendet, quellen, false, ende);
                }
            }));
        }
        for (JsonNode c : faelle("zeitstrahl")) {
            if (!c.hasNonNull("referenz")) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest("zeitstrahl/" + c.path("name").asText(), () -> {
                JsonNode m = refMessstelle(ref, c.path("referenz").asText());
                assertThat(c.at("/input/beginn").asText())
                        .isEqualTo(mitternacht(refOrte(ref, m.path("kennzeichen").asText()).get(0).split("\\|")[1]));
                for (JsonNode q : c.at("/input/fuehrende_quelle")) {
                    pruefeQuelle(q, m.path("fuehrende_quelle"), c.path("fortschreibung").asBoolean(), ende);
                }
                if (c.path("ergebnis_wie_referenz").asBoolean()) {
                    pruefeZeitstrahlWieReferenz(c.at("/expected/zeitstrahl"), m.path("fuehrende_quelle"));
                }
            }));
        }
        for (JsonNode c : faelle("stellung")) {
            tests.add(DynamicTest.dynamicTest("stellung/" + c.path("name").asText(), () -> {
                OffsetDateTime tag = mittag(c.path("stichtag").asText());
                LocalDate stichtag = LocalDate.parse(c.path("stichtag").asText());
                JsonNode m = c.at("/input/messstelle");
                JsonNode rm = refMessstelle(ref, m.path("kennzeichen").asText());
                assertThat(m.path("art").asText()).isEqualTo(rm.path("art").asText());
                assertThat(m.path("medium").asText()).isEqualTo(rm.path("medium").asText());
                assertThat(m.path("richtung").asText()).isEqualTo(rm.at("/hauptgroesse/richtung").asText());
                assertThat(text(m.path("komponente"))).isEqualTo(refKomponenteAm(rm, tag));
                for (JsonNode e : c.at("/input/messstellen")) {
                    JsonNode r = refMessstelle(ref, e.path("kennzeichen").asText());
                    JsonNode st = null;
                    for (JsonNode s : r.path("elektrische_stellung")) {
                        if (giltAm(s, stichtag)) {
                            st = s;
                        }
                    }
                    assertThat(st).as(e.path("kennzeichen").asText() + " hat am Stichtag eine Stellung").isNotNull();
                    assertThat(stellungEintrag(e)).isEqualTo(new StellungEintrag(r.path("kennzeichen").asText(),
                            r.path("name").asText(), st.path("anlage").asText(), st.path("stellung").asText(),
                            text(st.path("unterzaehler_von")), r.at("/hauptgroesse/richtung").asText(),
                            refKomponenteAm(r, tag)));
                }
            }));
        }
        for (JsonNode c : faelle("kennzeichen_pruefen")) {
            tests.add(DynamicTest.dynamicTest("kennzeichen/" + c.path("name").asText(), () -> {
                for (JsonNode v : c.at("/input/vergeben")) {
                    JsonNode r = refMessstelleOderNull(ref, v.path("messstelle").asText());
                    if (r != null) {
                        assertThat(v.path("name").asText()).isEqualTo(r.path("name").asText());
                    }
                }
            }));
        }
        return tests;
    }

    // ------------------------------------------------------------------ Hilfen

    private interface Rechnung {
        JsonNode rechne(JsonNode fall) throws Exception;
    }

    private static List<DynamicTest> fuerJedenFall(String familie, Rechnung r) throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : faelle(familie)) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () ->
                    assertThat(r.rechne(c)).as(c.path("why").asText()).isEqualTo(c.path("expected"))));
        }
        return tests;
    }

    private static List<Path> gueltigeBeispiele() throws Exception {
        try (Stream<Path> s = Files.list(FIXTURES)) {
            return s.filter(p -> p.getFileName().toString().contains(".valid.")).sorted().toList();
        }
    }

    /** Die Momentaufnahme des Referenzunternehmens (20.10.2026 10:15). */
    private static final OffsetDateTime MOMENTAUFNAHME = OffsetDateTime.parse("2026-10-20T10:15:00+02:00");

    /** Ein Kalendertag dieses Vertrags als Zeitpunkt MITTEN in ihm — für „gilt an diesem Tag“. */
    private static OffsetDateTime mittag(String tag) {
        return LocalDate.parse(tag).atTime(12, 0).atZone(ZoneId.of("Europe/Berlin")).toOffsetDateTime();
    }

    /**
     * Der Beginn einer Messstelle: Mitternacht des ersten Tages ihres ersten Orts,
     * als Zeitpunkt in der Zeitzone des Standorts (Schema {@code beginn}).
     */
    private static String mitternacht(String tag) {
        return ZEIT.format(LocalDate.parse(tag).atStartOfDay(ZoneId.of("Europe/Berlin")).toOffsetDateTime());
    }

    /** Eine tagesgenaue Gültigkeit (Stellung, Ort): {@code gueltig_bis} ist der LETZTE Tag, einschließlich. */
    private static boolean giltAm(JsonNode o, LocalDate tag) {
        return !tag.isBefore(LocalDate.parse(o.path("gueltig_ab").asText()))
                && (text(o.path("gueltig_bis")) == null || !tag.isAfter(LocalDate.parse(o.path("gueltig_bis").asText())));
    }

    private static OffsetDateTime zeit(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : OffsetDateTime.parse(n.asText());
    }

    private static String zeitText(OffsetDateTime t) {
        return t == null ? null : ZEIT.format(t);
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static List<String> texte(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.forEach(e -> out.add(e.asText()));
        return out;
    }

    private static Groesse groesse(JsonNode n) {
        return n == null || n.isNull() ? null : new Groesse(n.path("groesse").asText(),
                n.path("richtung").asText(), n.path("einheit").asText(), n.path("wertart").asText());
    }

    private static Stand stand(JsonNode n) {
        return n == null || n.isNull() ? null : new Stand(n.path("wert").asDouble(), text(n.path("einheit")));
    }

    private static QuelleZeitraum quelleZeitraum(JsonNode q) {
        return new QuelleZeitraum(q.path("komponente").asText(), q.path("kanal").asText(),
                q.path("geraet").asText(), q.path("einbau").asText(),
                zeit(q.path("gueltig_ab")), zeit(q.path("gueltig_bis")));
    }

    private static LebenszyklusEingang lebenszyklusEingang(JsonNode in) {
        List<QuelleZeitraum> quellen = new ArrayList<>();
        in.path("fuehrende_quelle").forEach(q -> quellen.add(quelleZeitraum(q)));
        return new LebenszyklusEingang(in.path("art").asText(), in.path("medium").asText(),
                text(in.path("kennzeichen")), text(in.path("name")), groesse(in.path("hauptgroesse")),
                in.path("ort_vorhanden").asBoolean(), in.path("formel_vorhanden").asBoolean(),
                in.path("eingaenge_eingerichtet").asBoolean(), in.path("angehalten").asBoolean(),
                in.path("archiviert").asBoolean(), quellen, zeit(in.path("jetzt")));
    }

    private static Bindung bindung(JsonNode b) {
        return new Bindung(b.path("rolle").asText(),
                b.path("groesse").asText(), b.path("richtung").asText(), b.path("komponente").asText(),
                b.path("kanal").asText(), b.path("geraet").asText(), b.path("einbau").asText(),
                b.path("kanal_wertart").asText(), text(b.path("zweck")),
                zeit(b.path("gueltig_ab")), zeit(b.path("gueltig_bis")));
    }

    private static BindungEingang bindungEingang(JsonNode in) {
        List<Bindung> bestehende = new ArrayList<>();
        in.path("bestehende").forEach(b -> bestehende.add(bindung(b)));
        JsonNode n = in.path("neu");
        // Gerät, Einbau und Richtung dürfen leer sein (keine Speisung · Vorzeichen-Wert) — nie „null“ als Wort.
        NeueBindung neu = new NeueBindung(n.path("rolle").asText(), text(n.path("zweck")),
                n.path("komponente").asText(), n.path("kanal").asText(), text(n.path("geraet")),
                text(n.path("einbau")), text(n.path("kanal_groesse")), text(n.path("kanal_richtung")),
                text(n.path("kanal_einheit")), text(n.path("kanal_wertart")),
                zeit(n.path("gueltig_ab")), zeit(n.path("gueltig_bis")),
                stand(n.path("endstand_vorgaenger")), stand(n.path("anfangsstand")), zeit(n.path("geraet_bis")));
        List<FremdeFuehrung> anderswo = new ArrayList<>();
        in.path("kanal_fuehrend_anderswo").forEach(f -> anderswo.add(new FremdeFuehrung(
                f.path("messstelle").asText(), zeit(f.path("gueltig_ab")), zeit(f.path("gueltig_bis")))));
        return new BindungEingang(in.path("vorgang").asText(), zeit(in.path("jetzt")),
                in.at("/messstelle/medium").asText(), zeit(in.at("/messstelle/beginn")),
                groesse(in.path("ziel")), bestehende, neu, anderswo);
    }

    private static StellungEintrag stellungEintrag(JsonNode e) {
        return new StellungEintrag(e.path("kennzeichen").asText(), e.path("name").asText(),
                e.path("anlage").asText(), e.path("stellung").asText(), text(e.path("unterzaehler_von")),
                e.path("richtung").asText(), text(e.path("komponente")));
    }

    private static JsonNode urteilAlsJson(BindungUrteil u) {
        ObjectNode out = MAPPER.createObjectNode();
        out.put("fehler", u.fehler() == null ? null : u.fehler().code());
        out.put("grund", u.grund());
        if (u.bestehend() == null) {
            out.putNull("bestehend");
        } else {
            quelleMitZeit(out.putObject("bestehend"), u.bestehend(), u.bestehend().gueltigBis());
        }
        out.put("messstelle", u.messstelle());
        if (u.beendet() == null) {
            out.putNull("beendet");
        } else {
            ObjectNode b = out.putObject("beendet");
            quelleMitZeit(b, u.beendet().bindung(), u.beendet().bindung().gueltigBis());
            standAlsJson(b, "endstand", u.beendet().endstand());
        }
        out.put("status", u.status());
        out.put("rueckwirkend", u.rueckwirkend());
        out.put("angekuendigt", u.angekuendigt());
        out.put("herleitung", u.herleitung());
        ArrayNode hinweise = out.putArray("hinweise");
        u.hinweise().forEach(hinweise::add);
        if (u.zeitstrahl() == null) {
            out.putNull("zeitstrahl");
        } else {
            out.set("zeitstrahl", zeitstrahlAlsJson(u.zeitstrahl()));
        }
        out.put("ohne_geraet_ab", zeitText(u.ohneGeraetAb()));
        return out;
    }

    private static ArrayNode zeitstrahlAlsJson(List<Abschnitt> abschnitte) {
        ArrayNode strahl = MAPPER.createArrayNode();
        for (Abschnitt a : abschnitte) {
            ObjectNode o = strahl.addObject();
            o.put("von", zeitText(a.von()));
            o.put("bis", zeitText(a.bis()));
            if (a.quelle() == null) {
                o.putNull("quelle");
            } else {
                ObjectNode q = o.putObject("quelle");
                q.put("komponente", a.quelle().komponente());
                q.put("kanal", a.quelle().kanal());
                q.put("geraet", a.quelle().geraet());
                q.put("einbau", a.quelle().einbau());
            }
        }
        return strahl;
    }

    private static void quelle(ObjectNode o, Bindung b) {
        o.put("komponente", b.komponente());
        o.put("kanal", b.kanal());
        o.put("geraet", b.geraet());
        o.put("einbau", b.einbau());
    }

    private static void quelleMitZeit(ObjectNode o, Bindung b, OffsetDateTime bis) {
        quelle(o, b);
        o.put("gueltig_ab", zeitText(b.gueltigAb()));
        o.put("gueltig_bis", zeitText(bis));
    }

    private static void standAlsJson(ObjectNode o, String feld, Stand s) {
        if (s == null) {
            o.putNull(feld);
        } else {
            ObjectNode n = o.putObject(feld);
            n.put("wert", s.wert());
            n.put("einheit", s.einheit());
        }
    }

    private static boolean ueberlappungsfrei(JsonNode quellen) {
        List<JsonNode> l = new ArrayList<>();
        quellen.forEach(l::add);
        for (int i = 0; i < l.size(); i++) {
            for (int j = i + 1; j < l.size(); j++) {
                OffsetDateTime ab1 = zeit(l.get(i).path("gueltig_ab"));
                OffsetDateTime bis1 = zeit(l.get(i).path("gueltig_bis"));
                OffsetDateTime ab2 = zeit(l.get(j).path("gueltig_ab"));
                OffsetDateTime bis2 = zeit(l.get(j).path("gueltig_bis"));
                if ((bis2 == null || ab1.isBefore(bis2)) && (bis1 == null || ab2.isBefore(bis1))) {
                    return false;
                }
            }
        }
        return true;
    }

    /** Eine Quelle ohne die Ablesestände — die Form, in der das Referenzunternehmen sie führt. */
    private static JsonNode quellenOhneStand(JsonNode quellen) {
        ArrayNode out = MAPPER.createArrayNode();
        for (JsonNode q : quellen) {
            ObjectNode o = q.deepCopy();
            o.remove("anfangsstand");
            o.remove("endstand");
            out.add(o);
        }
        return out;
    }

    private static JsonNode standWert(JsonNode s) {
        if (s.isNull()) {
            return MAPPER.nullNode();
        }
        assertThat(s.path("einheit").asText()).isEqualTo("kWh");
        return s.path("wert");
    }

    /** Der Zeitstrahl ist GENAU der des Referenzunternehmens — Quelle für Quelle, ohne Lücke. */
    private static void pruefeZeitstrahlWieReferenz(JsonNode zeitstrahl, JsonNode referenzQuellen) {
        List<String> strahl = new ArrayList<>();
        zeitstrahl.forEach(a -> strahl.add(a.path("quelle").isNull() ? "LÜCKE"
                : quellenSchluessel(a.path("quelle"), a.path("von").asText(), text(a.path("bis")))));
        List<String> referenz = new ArrayList<>();
        referenzQuellen.forEach(q -> referenz.add(
                quellenSchluessel(q, q.path("gueltig_ab").asText(), text(q.path("gueltig_bis")))));
        assertThat(strahl).isEqualTo(referenz);
    }

    private static String quellenSchluessel(JsonNode q, String ab, String bis) {
        return q.path("komponente").asText() + "|" + q.path("kanal").asText() + "|"
                + q.path("geraet").asText() + "|" + q.path("einbau").asText() + "|" + ab + "|" + bis;
    }

    private static void pruefeQuelle(JsonNode q, JsonNode referenz, boolean fortschreibung, OffsetDateTime ende) {
        JsonNode treffer = null;
        for (JsonNode r : referenz) {
            boolean gleich = r.path("komponente").equals(q.path("komponente"))
                    && r.path("kanal").equals(q.path("kanal"))
                    && r.path("geraet").equals(q.path("geraet"))
                    && r.path("einbau").equals(q.path("einbau"))
                    && r.path("gueltig_ab").equals(q.path("gueltig_ab"))
                    && (!q.has("kanal_wertart") || r.path("kanal_wertart").equals(q.path("kanal_wertart")))
                    && (!q.hasNonNull("zweck") || r.path("zweck").equals(q.path("zweck")));
            treffer = gleich ? r : treffer;
        }
        assertThat(treffer).as("Quelle " + q + " steht so im Referenzunternehmen").isNotNull();
        String bis = text(q.path("gueltig_bis"));
        String refBis = text(treffer.path("gueltig_bis"));
        boolean erlaubt = bis == null && refBis != null
                || (bis == null ? refBis == null : bis.equals(refBis))
                || fortschreibung && refBis == null && OffsetDateTime.parse(bis).isAfter(ende);
        assertThat(erlaubt).as("Ende " + bis + " der Quelle " + q.path("einbau").asText()
                + " gegen " + refBis + " im Referenzunternehmen").isTrue();
    }

    private static JsonNode refMessstelle(JsonNode ref, String kz) {
        JsonNode m = refMessstelleOderNull(ref, kz);
        assertThat(m).as(kz + " steht im Referenzunternehmen").isNotNull();
        return m;
    }

    private static JsonNode refMessstelleOderNull(JsonNode ref, String kz) {
        for (JsonNode m : ref.path("messstellen")) {
            if (m.path("kennzeichen").asText().equals(kz)) {
                return m;
            }
        }
        return null;
    }

    private static JsonNode refEinbau(JsonNode ref, String einbau) {
        for (JsonNode g : ref.path("geraete")) {
            for (JsonNode e : g.path("einbauten")) {
                if (e.path("kennzeichen").asText().equals(einbau)) {
                    return e;
                }
            }
        }
        ObjectNode ohne = MAPPER.createObjectNode();
        ohne.putNull("endstand_kwh");
        ohne.putNull("anfangsstand_kwh");
        return ohne;
    }

    /** Die Orte einer Messstelle als {@code ort|ab|bis}, in der Reihenfolge der Datei. */
    private static List<String> refOrte(JsonNode ref, String kz) {
        List<String> out = new ArrayList<>();
        for (JsonNode z : ref.path("zuordnungen")) {
            if ("messstelle_ort".equals(z.path("art").asText()) && kz.equals(z.path("von").asText())) {
                out.add(z.path("nach").asText() + "|" + z.path("gueltig_ab").asText() + "|" + text(z.path("gueltig_bis")));
            }
        }
        return out;
    }

    /** Die führenden Quellen der Größe (Hauptgröße oder Nebengröße) mit dieser Größe und Richtung. */
    private static JsonNode refQuellenDerGroesse(JsonNode m, Groesse g) {
        return refListeDerGroesse(m, g, "fuehrende_quelle");
    }

    /** Die führenden Quellen ({@code fuehrende_quelle}) oder Vergleichsquellen der Größe. */
    private static JsonNode refListeDerGroesse(JsonNode m, Groesse g, String feld) {
        Function<JsonNode, Boolean> passt = n -> n.path("groesse").asText().equals(g.groesse())
                && n.path("richtung").asText().equals(g.richtung())
                && (g.einheit() == null || n.path("einheit").asText().equals(g.einheit()))
                && (g.wertart() == null || n.path("wertart").asText().equals(g.wertart()));
        if (passt.apply(m.path("hauptgroesse"))) {
            return m.path(feld);
        }
        for (JsonNode n : m.path("nebengroessen")) {
            if (passt.apply(n)) {
                return n.path(feld);
            }
        }
        return null;
    }

    private static String refKomponenteAm(JsonNode m, OffsetDateTime tag) {
        String k = null;
        for (JsonNode q : m.path("fuehrende_quelle")) {
            if (gilt(q, tag)) {
                k = q.path("komponente").asText();
            }
        }
        return k;
    }

    private static boolean gilt(JsonNode o, OffsetDateTime t) {
        OffsetDateTime ab = zeit(o.path("gueltig_ab"));
        OffsetDateTime bis = zeit(o.path("gueltig_bis"));
        return !t.isBefore(ab) && (bis == null || t.isBefore(bis));
    }
}
