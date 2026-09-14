package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.ErgebnisZustand.AnzeigeEinheit;
import com.voltpilot.api.uems.ErgebnisZustand.Erkannt;
import com.voltpilot.api.uems.ErgebnisZustand.Ergebnis;
import com.voltpilot.api.uems.ErgebnisZustand.Feld;
import com.voltpilot.api.uems.ErgebnisZustand.FruehereFassung;
import com.voltpilot.api.uems.ErgebnisZustand.Muster;
import com.voltpilot.api.uems.ErgebnisZustand.Rundungsdifferenz;
import com.voltpilot.api.uems.ErgebnisZustand.Stellen;
import com.voltpilot.api.uems.ErgebnisZustand.Vorgesehen;
import com.voltpilot.api.uems.ErgebnisZustand.Zustand;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Ergebnis-Zustand (UEMS AP-08 IP-8) gegen die geteilte Vektor-Datei
 * {@code docs/contracts/v2/ergebnis-zustand-vectors.json}. Der TS-Zwilling
 * {@code frontend/portal/src/uemsErgebnis.test.ts} fährt dieselbe Datei.
 *
 * <p>Drei Zusagen neben den Fällen: das Vokabular im Code IST das der Datei; jeder Kennzeichen-Satz,
 * den die Verbrauchsregel heute spricht ({@code verbrauch-vectors.json}), steht in der geschlossenen
 * Liste und in Vertragsreihenfolge; und {@link VerbrauchRegeln} formuliert keinen Satz mehr selbst.
 * Rein — kein Testcontainers.
 */
class ErgebnisZustandVectorsTest {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("ergebnis-zustand-vectors.json");
    private static final Path SCHEMA = V2.resolve("ergebnis-zustand.schema.json");
    private static final Path VERBRAUCH = V2.resolve("verbrauch-vectors.json");
    private static final Path REGELN =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", "VerbrauchRegeln.java");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static String textOderNull(JsonNode n) {
        return n == null || n.isNull() ? null : n.asText();
    }

    private static BigDecimal dezimal(JsonNode n) {
        return n == null || n.isNull() ? null : new BigDecimal(n.asText());
    }

    private static List<String> texte(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.asText()));
        return List.copyOf(out);
    }

    @Test
    void dieVektorDateiErfuelltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA))).isEmpty();
    }

    @Test
    void dasVokabularImCodeIstDasDerDatei() throws Exception {
        JsonNode v = lies(VECTORS);

        List<Zustand> zustaende = new ArrayList<>();
        v.path("zustaende").forEach(z -> zustaende.add(new Zustand(
                z.path("wort").asText(), z.path("zahl").asText(), z.path("kennzeichen").asText())));
        assertThat(ErgebnisZustand.ZUSTAENDE).containsExactlyElementsOf(zustaende);

        Map<String, String> platzhalter = new LinkedHashMap<>();
        v.path("platzhalter").fields().forEachRemaining(e -> platzhalter.put(e.getKey(), e.getValue().asText()));
        assertThat(ErgebnisZustand.PLATZHALTER).isEqualTo(platzhalter);

        List<Muster> muster = new ArrayList<>();
        v.path("kennzeichen").forEach(k -> {
            Map<String, String> arten = new LinkedHashMap<>();
            k.path("platzhalter").fields().forEachRemaining(e -> arten.put(e.getKey(), e.getValue().asText()));
            muster.add(new Muster(
                    k.path("schluessel").asText(),
                    k.path("muster").asText(),
                    Map.copyOf(arten),
                    textOderNull(k.get("wort")),
                    k.path("rang").asInt(),
                    k.path("fehlbestand").asBoolean(),
                    k.path("einmalig").asBoolean(),
                    k.path("folgt_auf").isNull() ? null : texte(k.path("folgt_auf")),
                    textOderNull(k.get("verlangt_danach"))));
        });
        assertThat(ErgebnisZustand.KENNZEICHEN).containsExactlyElementsOf(muster);

        List<FruehereFassung> frueher = new ArrayList<>();
        v.path("fruehere_fassungen").forEach(f -> {
            Map<String, String> arten = new LinkedHashMap<>();
            f.path("platzhalter").fields().forEachRemaining(e -> arten.put(e.getKey(), e.getValue().asText()));
            frueher.add(new FruehereFassung(f.path("schluessel").asText(), f.path("muster").asText(),
                    Map.copyOf(arten), f.path("bis_fassung").asText()));
        });
        assertThat(ErgebnisZustand.FRUEHERE_FASSUNGEN).containsExactlyElementsOf(frueher);

        List<Vorgesehen> vorgesehen = new ArrayList<>();
        v.path("kennzeichen_vorgesehen").forEach(w -> vorgesehen.add(new Vorgesehen(
                w.path("wort").asText(), w.path("anfang").asText(), w.path("wortlaut_mit").asText())));
        assertThat(ErgebnisZustand.VORGESEHEN).containsExactlyElementsOf(vorgesehen);

        assertThat(ErgebnisZustand.VERSTOESSE).containsExactlyElementsOf(texte(v.path("verstoesse")));

        JsonNode satz = v.path("satz");
        assertThat(ErgebnisZustand.TRENNER).isEqualTo(satz.path("trenner").asText());
        assertThat(ErgebnisZustand.OHNE_ZAHL).isEqualTo(satz.path("ohne_zahl").asText());

        JsonNode rundung = v.path("rundung");
        assertThat(ErgebnisZustand.TAUSENDER).isEqualTo(rundung.path("tausender").asText());
        assertThat(ErgebnisZustand.DEZIMAL).isEqualTo(rundung.path("dezimal").asText());
        assertThat(ErgebnisZustand.VOR_EINHEIT).isEqualTo(rundung.path("vor_einheit").asText());
        assertThat(ErgebnisZustand.MINUS).isEqualTo(rundung.path("minus").asText());
        assertThat(ErgebnisZustand.EBENEN).containsExactlyElementsOf(texte(rundung.path("ebenen")));
        List<Stellen> stellen = new ArrayList<>();
        rundung.path("stellen").forEach(s -> stellen.add(new Stellen(
                s.path("einheit").asText(), textOderNull(s.get("ebene")), s.path("stellen").asInt())));
        assertThat(ErgebnisZustand.STELLEN).containsExactlyElementsOf(stellen);
        List<AnzeigeEinheit> anzeige = new ArrayList<>();
        rundung.path("anzeige_einheiten").forEach(a -> anzeige.add(new AnzeigeEinheit(a.path("gespeichert").asText(),
                a.path("angezeigt").asText(), new BigDecimal(a.path("faktor").asText()))));
        assertThat(ErgebnisZustand.ANZEIGE_EINHEITEN).containsExactlyElementsOf(anzeige);
        assertThat(ErgebnisZustand.KENNZEICHEN_EBENE).isEqualTo(rundung.path("kennzeichen_ebene").asText());

        JsonNode sommerzeit = v.path("sommerzeit");
        Map<Long, String> tagesdauer = new LinkedHashMap<>();
        sommerzeit.path("tagesdauer").fields()
                .forEachRemaining(e -> tagesdauer.put(Long.parseLong(e.getKey()), e.getValue().asText()));
        assertThat(ErgebnisZustand.TAGESDAUER).isEqualTo(tagesdauer);
        Map<String, Integer> schritte = new LinkedHashMap<>();
        sommerzeit.path("schritte").fields().forEachRemaining(e -> schritte.put(e.getKey(), e.getValue().asInt()));
        assertThat(ErgebnisZustand.SCHRITTE).isEqualTo(schritte);

        // Seit 1.6 (AP-08 IP-11): die Herkunft der Menge am Zustandswort.
        JsonNode herkunft = v.path("mengen_herkunft");
        Map<String, String> herleitungen = new LinkedHashMap<>();
        herkunft.path("herleitungen").fields()
                .forEachRemaining(e -> herleitungen.put(e.getKey(), textOderNull(e.getValue())));
        assertThat(ErgebnisZustand.MENGEN_HERKUNFT).containsExactlyEntriesOf(herleitungen);
        assertThat(ErgebnisZustand.HERKUNFT_ZUSTAENDE).containsExactlyElementsOf(texte(herkunft.path("zustaende")));
        assertThat(herkunft.path("form").asText()).isEqualTo("{zustand} ({herkunft})");
        assertThat(herkunft.path("nur_mit_zahl").asBoolean()).isTrue();

        // Die Vorgabe der Ebenen ist dieselbe Kette wie die der Lücken-Zuordnung (E2).
        assertThat(ErgebnisZustand.EBENEN).containsExactlyElementsOf(VerbrauchRegeln.LUECKE_ZEITRAEUME);
    }

    @Test
    void jedesMusterErkenntSeinBeispielUndSprichtEsZurueck() throws Exception {
        for (JsonNode k : lies(VECTORS).path("kennzeichen")) {
            String beispiel = k.path("beispiel").asText();
            Erkannt e = ErgebnisZustand.erkenne(beispiel);
            assertThat(e).as(beispiel).isNotNull();
            assertThat(e.muster().schluessel()).isEqualTo(k.path("schluessel").asText());
            assertThat(e.fruehereFassung()).isFalse();
            assertThat(ErgebnisZustand.sprich(e.muster().schluessel(), e.werte())).isEqualTo(beispiel);
        }
        for (JsonNode f : lies(VECTORS).path("fruehere_fassungen")) {
            String beispiel = f.path("beispiel").asText();
            Erkannt e = ErgebnisZustand.erkenne(beispiel);
            assertThat(e).as(beispiel).isNotNull();
            assertThat(e.muster().schluessel()).isEqualTo(f.path("schluessel").asText());
            assertThat(e.fruehereFassung()).isTrue();
            // Erkannt, aber nie mehr gesprochen: dieselben Werte ergeben den heutigen Wortlaut — oder, wo
            // nur der Platzhalter sich änderte (1.3: „337.600“ ist keine Menge), nimmt das heutige Muster
            // den alten Wert nicht mehr an (sonst hätte erkenne oben auf zwei Muster gepasst).
            if (ErgebnisZustand.sprich(e.muster().schluessel(), e.werte()).equals(beispiel)) {
                Map<String, String> alt = new LinkedHashMap<>();
                f.path("platzhalter").fields().forEachRemaining(x -> alt.put(x.getKey(), x.getValue().asText()));
                assertThat(e.muster().platzhalter()).as(beispiel).isNotEqualTo(alt);
            }
        }
    }

    /**
     * Die INVENTUR als Test: jede Erwartung der Verbrauchsregel mit Kennzeichen ist ein gültiges
     * Ergebnis dieses Vertrags — jeder Satz steht in der Liste, in Reihenfolge, und der Zustand passt
     * zu ihnen. Kommt ein neuer Satz in {@code verbrauch-vectors.json} dazu, wird dieser Test rot.
     */
    @TestFactory
    List<DynamicTest> jederSatzDerVerbrauchsregelStehtInDerListe() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        // Seit 1.4 auch die Versionen mit Ersatzwerten (Block `ersatzwerte`, AP-08 IP-13).
        List<JsonNode> faelle = new ArrayList<>();
        lies(VERBRAUCH).path("cases").forEach(faelle::add);
        lies(VERBRAUCH).path("ersatzwerte").forEach(faelle::add);
        for (JsonNode fall : faelle) {
            for (JsonNode erw : fall.path("expected")) {
                if (!erw.has("kennzeichen")) {
                    continue;
                }
                String name = fall.path("name").asText() + " · " + erw.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> {
                    BigDecimal wert = dezimal(erw.hasNonNull("menge") ? erw.get("menge") : erw.get("mittel"));
                    List<String> kennzeichen = texte(erw.path("kennzeichen"));
                    for (String k : kennzeichen) {
                        assertThat(ErgebnisZustand.erkenne(k)).as(k).isNotNull();
                        // Die Verbrauchsregel spricht nur den HEUTIGEN Wortlaut.
                        assertThat(ErgebnisZustand.erkenne(k).fruehereFassung()).as(k).isFalse();
                    }
                    Ergebnis e = new Ergebnis(wert, "kWh", "viertelstunde", erw.path("zustand").asText(), null,
                            kennzeichen);
                    assertThat(ErgebnisZustand.pruefe(e)).isEmpty();
                }));
            }
        }
        assertThat(tests).hasSizeGreaterThan(60);
        return tests;
    }

    @TestFactory
    List<DynamicTest> vektoren() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : lies(VECTORS).path("cases")) {
            String name = fall.path("familie").asText() + " · " + fall.path("name").asText();
            tests.add(DynamicTest.dynamicTest(name, () -> pruefe(fall)));
        }
        return tests;
    }

    private static void pruefe(JsonNode fall) {
        JsonNode ein = fall.path("eingang");
        JsonNode erw = fall.path("erwartet");
        switch (fall.path("familie").asText()) {
            case "zahl" -> {
                String einheit = ein.path("einheit").asText();
                String ebene = textOderNull(ein.get("ebene"));
                List<String> verstoesse = texte(erw.path("verstoesse"));
                assertThat(ErgebnisZustand.pruefeZahl(einheit, ebene)).containsExactlyElementsOf(verstoesse);
                if (verstoesse.isEmpty()) {
                    assertThat(ErgebnisZustand.zahl(dezimal(ein.get("wert")), einheit, ebene))
                            .isEqualTo(erw.path("text").asText());
                } else {
                    assertThatThrownBy(() -> ErgebnisZustand.zahl(dezimal(ein.get("wert")), einheit, ebene))
                            .isInstanceOf(IllegalArgumentException.class);
                }
            }
            case "menge" -> {
                String einheit = ein.path("einheit").asText();
                String ebene = textOderNull(ein.get("ebene"));
                List<String> verstoesse = texte(erw.path("verstoesse"));
                assertThat(ErgebnisZustand.pruefeMenge(einheit, ebene)).containsExactlyElementsOf(verstoesse);
                if (verstoesse.isEmpty()) {
                    assertThat(ErgebnisZustand.menge(dezimal(ein.get("wert")), einheit, ebene))
                            .isEqualTo(erw.path("text").asText());
                } else {
                    assertThatThrownBy(() -> ErgebnisZustand.menge(dezimal(ein.get("wert")), einheit, ebene))
                            .isInstanceOf(IllegalArgumentException.class);
                }
            }
            case "ergebnis" -> {
                Ergebnis e = new Ergebnis(
                        dezimal(ein.get("wert")),
                        ein.path("einheit").asText(),
                        textOderNull(ein.get("ebene")),
                        ein.path("zustand").asText(),
                        dezimal(ein.get("abdeckung_prozent")),
                        texte(ein.path("kennzeichen")));
                List<String> verstoesse = texte(erw.path("verstoesse"));
                assertThat(ErgebnisZustand.pruefe(e)).containsExactlyElementsOf(verstoesse);
                if (verstoesse.isEmpty()) {
                    assertThat(ErgebnisZustand.satz(e)).isEqualTo(erw.path("satz").asText());
                } else {
                    assertThat(erw.get("satz").isNull()).isTrue();
                    assertThatThrownBy(() -> ErgebnisZustand.satz(e)).isInstanceOf(IllegalArgumentException.class);
                }
            }
            case "erkennen" -> {
                String satz = ein.path("satz").asText();
                Erkannt e = ErgebnisZustand.erkenne(satz);
                assertThat(e == null ? null : e.muster().schluessel())
                        .isEqualTo(textOderNull(erw.get("schluessel")));
                if (e != null) {
                    Map<String, String> werte = new LinkedHashMap<>();
                    erw.path("werte").fields().forEachRemaining(x -> werte.put(x.getKey(), x.getValue().asText()));
                    assertThat(e.werte()).isEqualTo(werte);
                    assertThat(e.fruehereFassung()).isEqualTo(erw.path("fruehere_fassung").asBoolean(false));
                }
                assertThat(ErgebnisZustand.vorgesehen(satz)).isEqualTo(erw.path("vorgesehen").asBoolean());
            }
            case "tagesdauer" -> {
                LocalDate tag = LocalDate.parse(ein.path("tag").asText());
                ZoneId zone = ZoneId.of(ein.path("zeitzone").asText());
                assertThat(BezugsPeriode.stundenDesTages(tag, zone)).isEqualTo(erw.path("stunden").asLong());
                assertThat(ErgebnisZustand.tagesdauer(tag, zone)).isEqualTo(textOderNull(erw.get("satz")));
            }
            case "raster" -> {
                List<Feld> felder = ErgebnisZustand.raster(
                        LocalDate.parse(ein.path("tag").asText()),
                        ZoneId.of(ein.path("zeitzone").asText()),
                        ein.path("schritt").asText());
                assertThat(felder).hasSize(erw.path("anzahl").asInt());
                int ab = fall.path("ausschnitt_ab").asInt(0);
                List<Feld> erwartet = new ArrayList<>();
                erw.path("felder").forEach(f -> erwartet.add(new Feld(
                        f.path("beschriftung").asText(), f.path("von").asText())));
                assertThat(felder.subList(ab, ab + erwartet.size())).containsExactlyElementsOf(erwartet);
                if (!fall.has("ausschnitt_ab")) {
                    assertThat(erwartet).hasSize(felder.size());
                }
            }
            case "uhr" -> assertThat(ErgebnisZustand.uhr(
                            VerbrauchRegeln.zeit(ein.path("zeit").asText()), ZoneId.of(ein.path("zeitzone").asText())))
                    .isEqualTo(erw.path("text").asText());
            case "rundungsdifferenz" -> {
                List<BigDecimal> teile = new ArrayList<>();
                ein.path("teile").forEach(t -> teile.add(new BigDecimal(t.asText())));
                Rundungsdifferenz r = ErgebnisZustand.rundungsdifferenz(
                        ein.path("einheit").asText(),
                        teile,
                        ein.path("ebene_teile").asText(),
                        new BigDecimal(ein.path("summe").asText()),
                        ein.path("ebene_summe").asText());
                assertThat(r).isEqualTo(new Rundungsdifferenz(
                        erw.path("summe_der_angezeigten").asText(),
                        textOderNull(erw.get("differenz")),
                        textOderNull(erw.get("satz"))));
            }
            case "herkunft" -> {
                String zustand = ein.path("zustand").asText();
                String herleitung = textOderNull(ein.get("herleitung"));
                BigDecimal wert = ein.path("wert").isNull() ? null : new BigDecimal(ein.path("wert").asText());
                String text = textOderNull(erw.get("text"));
                if (text == null) {
                    assertThatThrownBy(() -> ErgebnisZustand.zustandMitHerkunft(zustand, herleitung, wert))
                            .isInstanceOf(IllegalArgumentException.class);
                } else {
                    assertThat(ErgebnisZustand.zustandMitHerkunft(zustand, herleitung, wert)).isEqualTo(text);
                }
            }
            default -> throw new AssertionError("unbekannte Familie " + fall.path("familie").asText());
        }
    }

    @Test
    void jedeFamilieUndJedesZustandswortIstAbgedeckt() throws Exception {
        List<String> familien = new ArrayList<>();
        List<String> gesprocheneZustaende = new ArrayList<>();
        for (JsonNode fall : lies(VECTORS).path("cases")) {
            familien.add(fall.path("familie").asText());
            if (fall.path("familie").asText().equals("ergebnis") && fall.path("erwartet").path("satz").isTextual()) {
                gesprocheneZustaende.add(fall.path("eingang").path("zustand").asText());
            }
        }
        assertThat(familien).contains("zahl", "menge", "ergebnis", "erkennen", "tagesdauer", "raster", "uhr",
                "rundungsdifferenz", "herkunft");
        assertThat(gesprocheneZustaende).containsAll(
                ErgebnisZustand.ZUSTAENDE.stream().map(Zustand::wort).toList());
        // Jeder Verstoß des Vokabulars fliegt in mindestens einem Fall auf.
        List<String> gemeldet = new ArrayList<>();
        for (JsonNode fall : lies(VECTORS).path("cases")) {
            fall.path("erwartet").path("verstoesse").forEach(x -> gemeldet.add(x.asText()));
        }
        assertThat(gemeldet).containsAll(ErgebnisZustand.VERSTOESSE);
    }

    /**
     * {@link VerbrauchRegeln} RUFT an, statt Sätze zu formulieren: in ihren Zeichenketten (ohne
     * Kommentare) steht kein Stück eines Kennzeichen-Wortlauts und kein Zustandswort mehr.
     */
    @Test
    void dieVerbrauchsregelFormuliertKeinenSatzMehrSelbst() throws Exception {
        String quelle = Files.readString(REGELN)
                .replaceAll("(?s)/\\*.*?\\*/", " ")
                .replaceAll("//[^\\n]*", " ");
        List<String> literale = new ArrayList<>();
        Matcher m = Pattern.compile("\"(?:[^\"\\\\]|\\\\.)*\"").matcher(quelle);
        while (m.find()) {
            literale.add(m.group());
        }
        assertThat(literale).isNotEmpty();
        List<String> stuecke = List.of("vollständig", "keine Werte", "Ablesestände", "nicht aufgefüllt", "Wertebereich",
                "ohne Endstand", "Zählung", "Intervallmengen", "gemessene Zeit", "Anteil von", "Viertelstunden verteilbar",
                "Periodengrenze", "bildbar", "Rechteck-Halten", "Leistung integriert", "Gerätegrenze", "Überlauf", "Neustart ",
                "Rücksetzung");
        for (String literal : literale) {
            for (String stueck : stuecke) {
                assertThat(literal).as("Satzstück in VerbrauchRegeln").doesNotContain(stueck);
            }
        }
    }

    @Test
    void dieSprechFunktionenPruefenKeineWerteAberJedenPlatzhalter() {
        // Ein Satz im Rechenweg darf nie eine Menge kosten: ein ungewöhnlicher Wert wird gesprochen …
        assertThat(ErgebnisZustand.ueberlauf("10:03", new BigDecimal("65536.000")))
                .isEqualTo("Überlauf 10:03 (Wertebereich 65536.000)");
        // … ein fehlender Platzhalter ist dagegen ein Programmfehler.
        assertThatThrownBy(() -> ErgebnisZustand.sprich("neustart", Map.of("uhr", "10:22")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ErgebnisZustand.muster("gibt_es_nicht")).isInstanceOf(IllegalArgumentException.class);
        assertThat(ErgebnisZustand.anfang("ruecksetzung")).isEqualTo("Rücksetzung ");
        assertThat(ErgebnisZustand.anfang("aus_leistung_integriert")).isEqualTo(ErgebnisZustand.AUS_LEISTUNG_INTEGRIERT);
    }

    // ---------------------------------------------------------- die alten Kundensätze (PR 721)

    /** Befund Dativ: „mit Ablesestände“ spricht keine Sprech-Funktion mehr — nur noch gespeichert lesbar. */
    @Test
    void derAlteDativWirdNieMehrGesprochen() {
        assertThat(ErgebnisZustand.geraetegrenze("10:40", true)).isEqualTo("Gerätegrenze 10:40 mit Ableseständen");
        Erkannt alt = ErgebnisZustand.erkenne("Gerätegrenze 10:40 mit Ablesestände");
        assertThat(alt.muster().schluessel()).isEqualTo("geraetegrenze_mit");
        assertThat(alt.fruehereFassung()).isTrue();
    }

    /**
     * Befund Sommerzeit: am 25.10.2026 gibt es 02:30 zweimal. Die Verbrauchsregel spricht die
     * Rücksetzung der zweiten 02:30 nie mehr als bloßes „02:30“.
     */
    @Test
    void eineRuecksetzungInDerDoppeltenStundeIstEindeutig() {
        Instant zweite = Instant.parse("2026-10-25T01:30:00Z");
        List<VerbrauchRegeln.Rohwert> werte = List.of(
                new VerbrauchRegeln.Rohwert(zweite.minusSeconds(60), new BigDecimal("101")),
                new VerbrauchRegeln.Rohwert(zweite, new BigDecimal("5")),
                new VerbrauchRegeln.Rohwert(zweite.plusSeconds(60), new BigDecimal("6")));
        VerbrauchRegeln.Ergebnis e = VerbrauchRegeln.mengeZaehlerstand(new ReihenKontext("kWh", BERLIN), werte,
                zweite.minusSeconds(60),
                zweite.plusSeconds(60), Duration.ofSeconds(60), List.of(), BigDecimal.ONE, null, null);
        assertThat(e.kennzeichen()).contains("Rücksetzung 02:30 MEZ ohne Endstand — bis zu 1 Kadenz nicht gezählt")
                .doesNotContain("Rücksetzung 02:30 ohne Endstand — bis zu 1 Kadenz nicht gezählt");
        assertThat(ErgebnisZustand.uhr(zweite.minusSeconds(3600), BERLIN))
                .isEqualTo("02:30 MESZ");
    }

    // ------------------------------------------ Einheit und Zone aus dem Träger (Befunde aus 721/722)

    /** Befund Zuwachs: ein Wh-Zähler spricht seinen Zuwachs in kWh, mit den Stellen der Viertelstunde. */
    @Test
    void einZaehlerInWhErgibtEinenSatzInKwh() {
        List<VerbrauchRegeln.Rohwert> werte = List.of(
                new VerbrauchRegeln.Rohwert(Instant.parse("2026-11-03T13:00:00Z"), new BigDecimal("418200000")),
                new VerbrauchRegeln.Rohwert(Instant.parse("2026-11-03T16:31:00Z"), new BigDecimal("418537600")));
        Instant von = Instant.parse("2026-11-02T23:00:00Z");
        Instant bis = Instant.parse("2026-11-03T23:00:00Z");
        VerbrauchRegeln.Ergebnis wh = VerbrauchRegeln.mengeZaehlerstand(new ReihenKontext("Wh", BERLIN), werte,
                von, bis, Duration.ofSeconds(60), List.of(), BigDecimal.ONE, null, null);
        assertThat(wh.menge()).as("gerechnet wird in der gespeicherten Einheit").isEqualByComparingTo("337600");
        assertThat(wh.kennzeichen()).contains(
                "Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar");
        assertThat(ErgebnisZustand.erkenne(wh.kennzeichen().get(wh.kennzeichen().size() - 1)).fruehereFassung())
                .isFalse();
        // Ohne bekannte Einheit keine Zahl — nie „337600“ ohne Einheit und nie eine geratene.
        VerbrauchRegeln.Ergebnis ohne = VerbrauchRegeln.mengeZaehlerstand(new ReihenKontext(null, BERLIN), werte,
                von, bis, Duration.ofSeconds(60), List.of(), BigDecimal.ONE, null, null);
        assertThat(ohne.kennzeichen()).contains(
                "Lücke 14:00–17:31: Zuwachs gemessen, nicht auf Viertelstunden verteilbar");
    }

    /** Befund Sommerzeit/Zone: die Uhrzeit spricht die Zone des Standorts, die der Träger mitbringt (E10). */
    @Test
    void einStandortAusserhalbVonBerlinZeigtSeineEigeneUhrzeit() {
        Instant t = Instant.parse("2026-11-19T09:12:00Z");
        List<VerbrauchRegeln.Rohwert> werte = List.of(
                new VerbrauchRegeln.Rohwert(t.minusSeconds(60), new BigDecimal("101")),
                new VerbrauchRegeln.Rohwert(t, new BigDecimal("5")));
        List<VerbrauchRegeln.Ereignis> neustart = List.of(new VerbrauchRegeln.Ereignis(
                VerbrauchRegeln.Ereignis.NEUSTART, t, null, null, 120));
        VerbrauchRegeln.Ergebnis berlin = VerbrauchRegeln.mengeZaehlerstand(new ReihenKontext("kWh", BERLIN), werte,
                t.minusSeconds(60), t, Duration.ofSeconds(60), neustart, BigDecimal.ONE, null, null);
        VerbrauchRegeln.Ergebnis lissabon = VerbrauchRegeln.mengeZaehlerstand(
                new ReihenKontext("kWh", ZoneId.of("Europe/Lisbon")), werte,
                t.minusSeconds(60), t, Duration.ofSeconds(60), neustart, BigDecimal.ONE, null, null);
        assertThat(berlin.kennzeichen()).containsExactly(
                "Rücksetzung 10:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt",
                "Neustart 10:12: bis zu 120 s Zählung möglicherweise verloren");
        assertThat(lissabon.kennzeichen()).containsExactly(
                "Rücksetzung 09:12 ohne Endstand — bis zu 1 Kadenz nicht gezählt",
                "Neustart 09:12: bis zu 120 s Zählung möglicherweise verloren");
        assertThat(lissabon.menge()).as("die Zone ändert nur die Sprache, nie die Menge").isEqualTo(berlin.menge());
    }

    /** Befund Zuwachs: die Form der Fassung 1.2 bleibt gespeichert lesbar — gesprochen wird sie nie mehr. */
    @Test
    void derAlteZuwachsSatzBleibtLesbar() {
        Erkannt alt = ErgebnisZustand.erkenne(
                "Lücke 14:00–17:31: Zuwachs 337.600 gemessen, nicht auf Viertelstunden verteilbar");
        assertThat(alt.muster().schluessel()).isEqualTo("luecke_zuwachs");
        assertThat(alt.fruehereFassung()).isTrue();
        assertThat(ErgebnisZustand.lueckeZuwachs("14:00", "17:31", new BigDecimal("337.600"), "kWh"))
                .isEqualTo("Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar");
    }

    /**
     * Seit 1.5 (AP-08 IP-17): „korrigiert (Version n)“ ist ein Kennzeichen, kein vorgesehenes Wort — derselbe Wortlaut,
     * den die Bilanz (bilanz-vectors.json, F14) für eine berechnete Messstelle schon spricht. Version 1 ist nie korrigiert.
     */
    @Test
    void dieVersionSprichtDieKaskadeUndVersionEinsIstNieKorrigiert() throws Exception {
        assertThat(ErgebnisZustand.korrigiert(2)).isEqualTo("korrigiert (Version 2)");
        assertThat(ErgebnisZustand.korrigiert(12)).isEqualTo("korrigiert (Version 12)");
        assertThat(ErgebnisZustand.istKorrigiert("korrigiert (Version 3)")).isTrue();
        assertThat(ErgebnisZustand.istKorrigiert("korrigiert (Version 1)")).isFalse();
        assertThat(ErgebnisZustand.istKorrigiert("nachgeliefert")).isFalse();
        assertThatThrownBy(() -> ErgebnisZustand.korrigiert(1)).isInstanceOf(IllegalArgumentException.class);
        assertThat(ErgebnisZustand.VORGESEHEN).extracting(Vorgesehen::wort).doesNotContain("korrigiert (Version n)");

        // Derselbe Satz wie in der Bilanz-Kaskade — kein zweiter Wortlaut.
        List<String> bilanz = new ArrayList<>();
        for (JsonNode fall : lies(VECTORS.resolveSibling("bilanz-vectors.json")).path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                p.path("ergebnis").path("kennzeichen").forEach(k -> {
                    if (k.asText().startsWith("korrigiert")) {
                        bilanz.add(k.asText());
                    }
                });
            }
        }
        assertThat(bilanz).isNotEmpty().allSatisfy(k -> assertThat(ErgebnisZustand.istKorrigiert(k)).isTrue());
    }
}
