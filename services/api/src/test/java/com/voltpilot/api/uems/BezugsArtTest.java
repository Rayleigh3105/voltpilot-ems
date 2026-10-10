package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BezugsArt.Art;
import com.voltpilot.api.uems.BezugsArt.Auswahl;
import com.voltpilot.api.uems.BezugsArt.Eingang;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Das Modul der ARTEN (UEMS AP-09 §4.2) gegen den Block {@code arten} der geteilten Vektor-Datei
 * {@code docs/contracts/v2/bezugsdaten-vectors.json}. Der TS-Zwilling {@code bezugsArt.test.ts}
 * fährt dieselbe Datei — beide grün heißt: dieselbe Antwort auf jede Prüfung.
 *
 * <p>Die Schema-Treue des Blocks prüft {@code BezugsdatenVectorsTest.dieDateiHaeltIhrSchema}.
 */
class BezugsArtTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");

    private static final Path MODUL =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", "BezugsArt.java");

    private static JsonNode lies(Path pfad) throws Exception {
        return MAPPER.readTree(Files.readString(pfad));
    }

    private static JsonNode vektoren() throws Exception {
        return lies(V2.resolve("bezugsdaten-vectors.json"));
    }

    private static List<String> texte(JsonNode liste) {
        List<String> aus = new ArrayList<>();
        liste.forEach(w -> aus.add(w.asText()));
        return List.copyOf(aus);
    }

    private static Auswahl auswahl(JsonNode knoten) {
        return knoten.isArray() ? Auswahl.liste(texte(knoten)) : Auswahl.verweis(knoten.asText());
    }

    private static List<Art> arten(JsonNode v) {
        List<Art> alle = new ArrayList<>();
        v.path("arten").path("je_art").properties().forEach(e -> {
            JsonNode a = e.getValue();
            alle.add(new Art(
                    e.getKey(),
                    a.path("name").asText(),
                    auswahl(a.path("einheiten")),
                    a.path("wertart").asText(),
                    texte(a.path("perioden")),
                    auswahl(a.path("geltung")),
                    texte(a.path("herkunft"))));
        });
        return List.copyOf(alle);
    }

    private static BezugsgroesseRegeln.Vokabular vokabular(JsonNode v) {
        Map<String, List<String>> einheiten = new LinkedHashMap<>();
        v.path("einheiten").properties().forEach(e -> einheiten.put(e.getKey(), texte(e.getValue())));
        return new BezugsgroesseRegeln.Vokabular(
                texte(v.at("/vokabulare/wertart")),
                texte(v.at("/vokabulare/geltung_art")),
                texte(v.at("/vokabulare/periode_art")),
                einheiten);
    }

    private static String text(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static Eingang eingang(JsonNode e) {
        return new Eingang(
                text(e.path("wertart")),
                text(e.path("geltung_art")),
                text(e.path("einheit")),
                text(e.path("periode_art")),
                text(e.path("herkunft_art")),
                text(e.path("einheit_der_messstelle")));
    }

    /** Je Art: jede Angabe ist ein Wort der VORHANDENEN Vokabulare — die Einheiten fragt das Modul bei {@link BezugsEinheit} an. */
    @TestFactory
    List<DynamicTest> jedeArtSprichtNurWoerterDerVorhandenenVokabulare() throws Exception {
        JsonNode v = vektoren();
        BezugsgroesseRegeln.Vokabular vok = vokabular(v);
        List<String> herkunftArten = texte(v.at("/vokabulare/herkunft_art"));
        List<DynamicTest> tests = new ArrayList<>();
        for (Art art : arten(v)) {
            tests.add(DynamicTest.dynamicTest(art.art() + " · " + art.name(), () -> {
                assertThat(art.name()).as("Kundenwort").isNotBlank();
                if (art.einheiten().aus() == null) {
                    assertThat(art.einheiten().woerter()).as("Einheiten").isNotEmpty().doesNotHaveDuplicates();
                    assertThat(BezugsArt.einheitenDer(art, vok.einheiten(), null))
                            .as("jede Einheit steht im Einheiten-Vokabular")
                            .containsExactlyElementsOf(art.einheiten().woerter());
                } else {
                    assertThat(art.einheiten().aus())
                            .as("Verweis der Einheiten")
                            .isIn(BezugsArt.ALLE, BezugsArt.EINHEIT_DER_MESSSTELLE);
                }
                assertThat(vok.wertarten()).as("Wertart").contains(art.wertart());
                assertThat(art.perioden()).doesNotHaveDuplicates();
                assertThat(BezugsArt.periodenDer(art, vok.periodeArten()))
                        .as("jede Periode steht in vokabulare.periode_art")
                        .containsExactlyElementsOf(art.perioden());
                assertThat(art.perioden().isEmpty())
                        .as("nur ein Periodenwert hat Perioden (M1)")
                        .isEqualTo(!BezugsgroesseRegeln.PERIODENWERT.equals(art.wertart()));
                if (art.geltung().aus() == null) {
                    assertThat(art.geltung().woerter()).isNotEmpty().doesNotHaveDuplicates();
                    assertThat(BezugsArt.geltungDer(art, vok.geltungArten()))
                            .as("jeder Geltungsbereich steht in vokabulare.geltung_art")
                            .containsExactlyElementsOf(art.geltung().woerter());
                } else {
                    assertThat(art.geltung().aus()).isEqualTo(BezugsArt.ALLE);
                }
                assertThat(art.herkunft()).isNotEmpty().doesNotHaveDuplicates();
                assertThat(BezugsArt.herkunftDer(art, herkunftArten))
                        .as("jede Herkunft steht in vokabulare.herkunft_art")
                        .containsExactlyElementsOf(art.herkunft());
            }));
        }
        assertThat(tests).as("das Vokabular der Arten ist nicht leer").isNotEmpty();
        return tests;
    }

    /** Jede Prüfung des Blocks — dieselbe Antwort, die der TS-Zwilling gibt. */
    @TestFactory
    List<DynamicTest> diePruefungenDerDatei() throws Exception {
        JsonNode v = vektoren();
        List<Art> arten = arten(v);
        BezugsgroesseRegeln.Vokabular vok = vokabular(v);
        List<String> herkunftArten = texte(v.at("/vokabulare/herkunft_art"));
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode p : v.at("/arten/pruefungen")) {
            tests.add(DynamicTest.dynamicTest(p.path("name").asText(), () -> assertThat(BezugsArt.pruefen(
                            p.path("art").asText(), eingang(p.path("eingang")), arten, vok, herkunftArten))
                    .containsExactlyElementsOf(texte(p.at("/ergebnis/abweichend")))));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    /**
     * Die Beispiele sind GENAU die Bezugsgrößen des Referenzunternehmens, jede passt zu ihrer Art,
     * und ihr Eingang ist der des Referenzunternehmens — eine Abweichung nennt ihren Grund.
     */
    @Test
    void dieBeispieleSindDieBezugsgroessenDesReferenzunternehmensUndPassen() throws Exception {
        JsonNode v = vektoren();
        Map<String, JsonNode> referenz = new LinkedHashMap<>();
        lies(V2.resolve("uems-referenzunternehmen.json"))
                .path("bezugsgroessen")
                .forEach(b -> referenz.put(b.path("kennzeichen").asText(), b));
        Set<String> beispiele = new LinkedHashSet<>();
        for (JsonNode p : v.at("/arten/pruefungen")) {
            String kz = text(p.path("beispiel"));
            if (kz == null) {
                continue;
            }
            beispiele.add(kz);
            JsonNode b = referenz.get(kz);
            JsonNode ein = p.path("eingang");
            assertThat(b).as(kz + " im Referenzunternehmen").isNotNull();
            assertThat(texte(p.at("/ergebnis/abweichend"))).as(kz + " passt zu seiner Art").isEmpty();
            assertThat(text(ein.path("einheit"))).as(kz + " · einheit").isEqualTo(text(b.path("einheit_code")));
            assertThat(text(ein.path("periode_art"))).as(kz + " · periode").isEqualTo(text(b.path("periode_code")));
            assertThat(text(ein.path("wertart"))).as(kz + " · wertart").isEqualTo(text(b.path("wertart")));
            String geltung = text(b.path("geltung_art"));
            if (!geltung.equals(text(ein.path("geltung_art")))) {
                assertThat(p.path("hinweis").asText())
                        .as(kz + ": die Abweichung vom Referenzunternehmen nennt ihren Grund")
                        .contains("„" + geltung + "“");
            }
        }
        assertThat(beispiele).as("BZ-1 … BZ-7").containsExactlyInAnyOrderElementsOf(referenz.keySet());
    }

    /** Eine Einheit, die die Art nicht führt, passt nicht — auch wenn sie im Vokabular steht. */
    @Test
    void eineEinheitDieDieArtNichtFuehrtWirdAbgelehnt() throws Exception {
        JsonNode v = vektoren();
        List<Art> arten = arten(v);
        BezugsgroesseRegeln.Vokabular vok = vokabular(v);
        List<String> herkunftArten = texte(v.at("/vokabulare/herkunft_art"));
        List<String> alleEinheiten = new ArrayList<>();
        vok.einheiten().values().forEach(alleEinheiten::addAll);
        int abgelehnt = 0;
        for (Art art : arten) {
            String messstelle = BezugsArt.EINHEIT_DER_MESSSTELLE.equals(art.einheiten().aus()) ? alleEinheiten.get(0) : null;
            List<String> gefuehrt = BezugsArt.einheitenDer(art, vok.einheiten(), messstelle);
            assertThat(gefuehrt).as(art.art() + " führt Einheiten").isNotEmpty();
            String periode = art.perioden().isEmpty() ? null : art.perioden().get(0);
            String geltung = BezugsArt.geltungDer(art, vok.geltungArten()).get(0);
            for (String einheit : alleEinheiten) {
                Eingang e = new Eingang(art.wertart(), geltung, einheit, periode, art.herkunft().get(0), messstelle);
                List<String> soll = gefuehrt.contains(einheit) ? List.of() : List.of("einheit");
                assertThat(BezugsArt.pruefen(art.art(), e, arten, vok, herkunftArten))
                        .as(art.art() + " in " + einheit)
                        .containsExactlyElementsOf(soll);
                abgelehnt += soll.size();
            }
        }
        assertThat(abgelehnt).as("es gibt Einheiten, die eine Art nicht führt").isPositive();
    }

    /** Keine zweite Liste: das Modul nennt keine Art und kein Wort eines Vokabulars — alles kommt herein. */
    @Test
    void dasModulFuehrtKeineZweiteListe() throws Exception {
        JsonNode v = vektoren();
        String quelle = Files.readString(MODUL);
        Set<String> woerter = new LinkedHashSet<>();
        for (Art art : arten(v)) {
            woerter.add(art.art());
            woerter.add(art.name());
        }
        v.path("einheiten").forEach(g -> woerter.addAll(texte(g)));
        for (String liste : List.of("wertart", "geltung_art", "periode_art", "herkunft_art")) {
            woerter.addAll(texte(v.path("vokabulare").path(liste)));
        }
        // Die beiden Verweise der Datei sind Wörter des Moduls; „messstelle“ ist zugleich ein Geltungsbereich.
        woerter.removeAll(List.of(BezugsArt.ALLE, BezugsArt.EINHEIT_DER_MESSSTELLE));
        for (String wort : woerter) {
            assertThat(quelle).as("BezugsArt.java nennt „" + wort + "“").doesNotContain("\"" + wort + "\"");
        }
    }
}
