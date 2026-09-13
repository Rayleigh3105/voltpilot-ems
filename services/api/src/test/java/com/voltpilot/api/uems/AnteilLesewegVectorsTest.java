package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.betragGleich;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static com.voltpilot.api.uems.BilanzVectorsTest.texte;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.uems.AnteilLeseweg.Ablehnung;
import com.voltpilot.api.uems.AnteilLeseweg.Lesung;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Periodeneingang;
import com.voltpilot.api.uems.MessstelleFormelRegeln.Periodenwert;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Die Term-Art {@code verteilung} und das Feld {@code anteil} (UEMS AP-10 IP-5) gegen die geteilten
 * Vektor-Dateien — rein, ohne Docker.
 *
 * <ul>
 *   <li>{@link AnteilLeseweg.Ablehnung} ist Wort für Wort, Status für Status und Satz für Satz der
 *       Block {@code leseweg} von {@code verteilung-vectors.json}; jeder Fall dort ergibt genau die
 *       genannte Ablehnung;</li>
 *   <li>Familie {@code anteil} (F4, Laden/Entladen): jede Speicher-Rolle mit einem Teil des Messwerts
 *       ist ein Anteil-Wort des Terms, wird HEUTE benannt abgelehnt, und die Bilanz mit beiden Teilen
 *       rechnet über die Verzweigung des Formel-Moduls 54 580 kWh;</li>
 *   <li>Familie {@code verteilungs_term} (F11): seit AP-10 IP-8 liest der Verteilungs-Term den Anteil
 *       des Tages über DIE EINE Stelle {@link AnteilLeseweg#lies} (Zeilen der Verteilung am Tag →
 *       {@link VerteilungRegeln#amTag} → {@link AnteilLeseweg#tagesanteil}) und rechnet jede
 *       {@code term}-Prüfung — ohne Zeile {@code nicht_verteilt}, nie geraten;</li>
 *   <li>der Anteil eines alten Tages ist der von damals (F13: 70 % vor, 60 % ab dem 15.01.2027).</li>
 * </ul>
 */
class AnteilLesewegVectorsTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    /** Die Verteilung, die der Leseweg liest — je Prüfung aus dem Vertrag gesetzt (rein, ohne Datenbank). */
    private static volatile AnteilLeseweg.Stand stand = new AnteilLeseweg.Stand("MS-07", List.of(), List.of());
    private static final AnteilLeseweg LESEWEG = new AnteilLeseweg((messstelle, tag) -> stand);

    private static JsonNode verteilung() throws Exception {
        return lies(V2.resolve("verteilung-vectors.json"));
    }

    private static JsonNode bilanz() throws Exception {
        return lies(V2.resolve("bilanz-vectors.json"));
    }

    // ------------------------------------------------------------------ der Block im Vertrag

    @Test
    void dieAblehnungenSindDieDesVertragsInIhrerReihenfolge() throws Exception {
        JsonNode block = verteilung().path("leseweg");
        List<String> soll = new ArrayList<>();
        block.path("ablehnungen").forEach(a -> soll.add(a.path("code").asText() + "|" + a.path("status").asInt()
                + "|" + str(a.path("wartet_auf")) + "|" + a.path("feld").asText() + "|" + a.path("satz").asText()));
        List<String> ist = Arrays.stream(Ablehnung.values())
                .map(a -> a.code() + "|" + a.status() + "|" + a.wartetAuf() + "|" + a.feld() + "|" + a.satz())
                .toList();
        assertThat(ist).containsExactlyElementsOf(soll);
        assertThat(texte(block.path("pruefreihenfolge")))
                .containsExactlyElementsOf(Arrays.stream(Ablehnung.values()).map(Ablehnung::code).toList());
        assertThat(texte(block.path("zwillinge"))).contains("java");
        assertThat(block.path("stelle").asText()).contains("AnteilLeseweg#lies");
        assertThat(block.path("grund_im_wert").asText()).isEqualTo("fehlende[].grund");
    }

    /**
     * Eine fehlende Fähigkeit, ein Satz — und er borgt kein Wort einer VORHANDENEN Verteilung. Die zweite
     * ({@code verteilung_wartet_auf_ip8}) ist mit AP-10 IP-8 eingelöst und steht nirgends mehr.
     */
    @Test
    void jedeWartendeAblehnungNenntIhrPaketUndBorgtKeinWort() throws Exception {
        JsonNode v = verteilung();
        List<String> wartende = Arrays.stream(Ablehnung.values()).filter(a -> a.wartetAuf() != null)
                .map(Ablehnung::code).toList();
        assertThat(wartende).containsExactly("anteil_wartet_auf_ap08");
        assertThat(Ablehnung.ANTEIL_WARTET_AUF_AP08.wartetAuf()).isEqualTo("AP-08 IP-7");
        assertThat(wartende).doesNotContainAnyElementsOf(texte(v.path("vokabulare").path("fehler")));
        assertThat(texte(v.path("vokabulare").path("fehler"))).contains(Ablehnung.VERTEILUNGS_TERM_OHNE_FAKTOR.code());
        assertThat(Arrays.stream(Ablehnung.values()).map(Ablehnung::code)).doesNotContain("verteilung_wartet_auf_ip8");
        List<String> codes = new ArrayList<>();
        v.path("leseweg").path("ablehnungen").forEach(a -> codes.add(a.path("code").asText()));
        v.path("leseweg").path("faelle").forEach(f -> codes.add(str(f.path("ergebnis").path("ablehnung"))));
        assertThat(codes).as("eingelöst: der Vertrag nennt die wartende Verteilung nicht mehr")
                .doesNotContain("verteilung_wartet_auf_ip8");
    }

    /** Kundensprache: kein Paket, kein Code, kein internes Wort — und nie eine Ursache (bilanz verbotene_woerter). */
    @Test
    void keinKundensatzTraegtEinInternesWort() throws Exception {
        List<String> verboten = new ArrayList<>(texte(bilanz().path("verbotene_woerter")));
        verboten.addAll(List.of("AP-", "IP-", "Leseweg", "_", "null", "verteilung_ziel", "anteil_"));
        for (Ablehnung a : Ablehnung.values()) {
            for (String wort : verboten) {
                assertThat(a.satz()).as(a.code()).doesNotContain(wort);
            }
            assertThat(a.satz()).as(a.code() + " endet mit Punkt").endsWith(".");
            assertThat(a.satz().getBytes(StandardCharsets.UTF_8)).as(a.code()).isNotEmpty();
        }
    }

    @Test
    void dasAnteilVokabularIstDasBeiderVertraege() throws Exception {
        assertThat(texte(verteilung().path("vokabulare").path("anteil"))).containsExactlyElementsOf(AnteilLeseweg.ANTEILE);
        assertThat(texte(bilanz().path("vokabulare").path("anteil"))).containsExactlyElementsOf(AnteilLeseweg.ANTEILE);
        assertThat(texte(verteilung().path("vokabulare").path("term_art"))).contains(AnteilLeseweg.VERTEILUNG);
    }

    @TestFactory
    List<DynamicTest> jederFallDesLesewegs() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : verteilung().path("leseweg").path("faelle")) {
            tests.add(DynamicTest.dynamicTest(fall.path("name").asText(), () -> {
                JsonNode t = fall.path("term");
                String soll = str(fall.path("ergebnis").path("ablehnung"));
                assertThat(ablehnung(t, LocalDate.parse(fall.path("tag").asText())).map(Ablehnung::code).orElse(null))
                        .isEqualTo(soll);
                String wie = str(fall.path("ergebnis").path("lesung"));
                if (soll == null) {
                    Lesung l = lesung(t, LocalDate.parse(fall.path("tag").asText()));
                    if ("tagesanteil".equals(wie)) {
                        assertThat(l.ganz()).as("ein Verteilungs-Term nimmt nie den ganzen Wert").isFalse();
                        assertThat(l.wartet()).as("seit AP-10 IP-8 wartet er nicht mehr").isNull();
                        assertThat(l.term()).isNotNull();
                        assertThat(l.tag()).isEqualTo(LocalDate.parse(fall.path("tag").asText()));
                    } else {
                        assertThat(wie).isEqualTo("ganz");
                        assertThat(l.ganz()).as("ohne Anteil nimmt der Term den ganzen Wert").isTrue();
                    }
                } else {
                    assertThat(wie).as("eine Ablehnung liest nichts").isNull();
                }
            }));
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(7);
        return tests;
    }

    // ------------------------------------------------------------ Familie anteil (F4)

    /**
     * F4 Laden/Entladen: MS-04 (Speicher) geht mit ZWEI Anteilen ein — {@code positiv} als Abfluss,
     * {@code negativ} als Zufluss. Jede Rolle eines Teils ist ein Anteil-Wort des Terms, und ein Term
     * mit diesem Teil wird HEUTE benannt abgelehnt ({@code anteil_wartet_auf_ap08}), nie still als
     * ganzer Wert gelesen.
     */
    @Test
    void f4LadenUndEntladenSindZweiAnteileUndWartenBenannt() throws Exception {
        JsonNode f4 = fall(bilanz(), "F4");
        List<String> teile = new ArrayList<>();
        for (JsonNode p : f4.path("pruefungen")) {
            if (!p.path("regel").asText().equals("rolle")) {
                continue;
            }
            JsonNode e = p.path("eingang");
            BilanzAbleitung.RolleUrteil u = BilanzAbleitung.rolle(new BilanzAbleitung.RolleEingang(
                    str(e.path("stellung")), str(e.path("richtung")), str(e.path("art")), str(e.path("medium")),
                    str(e.path("unterzaehler_von"))));
            for (BilanzAbleitung.RolleAnteil r : u.rollen()) {
                assertThat(AnteilLeseweg.ANTEILE).contains(r.anteil());
                if (!AnteilLeseweg.GESAMT.equals(r.anteil())) {
                    teile.add(r.rolle() + ":" + r.anteil());
                    Lesung l = LESEWEG.lies("messstelle", r.anteil(), UUID.randomUUID(), null, LocalDate.of(2026, 10, 18));
                    assertThat(l.wartet()).isEqualTo(Ablehnung.ANTEIL_WARTET_AUF_AP08);
                    assertThat(l.urteil(new BigDecimal("7900")).menge()).as("nie eine geratene Zahl").isNull();
                    assertThat(l.urteil(new BigDecimal("7900")).fehler()).isEqualTo("anteil_wartet_auf_ap08");
                }
            }
        }
        assertThat(teile).containsExactly("abfluss:positiv", "zufluss:negativ");
    }

    /** Die Bilanz F4 mit beiden Teilen rechnet über die Verzweigung des Formel-Moduls: 54 580 kWh. */
    @Test
    void f4RechnetMitBeidenTeilen54580() throws Exception {
        JsonNode f4 = fall(bilanz(), "F4");
        JsonNode rest = null;
        for (JsonNode p : f4.path("pruefungen")) {
            if (p.path("regel").asText().equals("rest")) {
                rest = p;
            }
        }
        assertThat(rest).isNotNull();
        JsonNode ein = rest.path("eingang");
        List<Periodeneingang> eingaenge = new ArrayList<>();
        List<String> anteile = new ArrayList<>();
        for (JsonNode e : ein.path("eingaenge")) {
            anteile.add(e.path("messstelle").asText() + ":" + e.path("anteil").asText());
            eingaenge.add(new Periodeneingang(e.path("messstelle").asText(), str(e.path("rolle")),
                    str(e.path("anteil")), null, null, bd(e.path("menge")), e.path("zustand").asText(),
                    BilanzVectorsTest.ganz(e.path("abdeckung_prozent")), e.path("version").asInt(),
                    texte(e.path("kennzeichen"))));
        }
        assertThat(anteile).contains("MS-04:negativ", "MS-04:positiv").doesNotContain("MS-04:gesamt");
        Periodenwert w = MessstelleFormelRegeln.periodenwert(MessstelleFormelRegeln.REST, MessstelleRegeln.BERECHNET,
                str(ein.path("einheit")), str(ein.path("zahl_ebene")), ein.path("version").asInt(1), texte(ein.path("vermerke")), eingaenge);
        betragGleich(w.menge(), rest.path("ergebnis").path("menge"), "F4 · Rest");
        assertThat(w.menge()).isEqualByComparingTo("54580");
    }

    // ---------------------------------------------------- Familie verteilungs_term (F11)

    /**
     * F11 „4100 von MS-07“: die Vertragsregel {@code verteilungs_term_ohne_faktor} geht dem Leseweg voraus;
     * sonst liest {@link AnteilLeseweg#lies} — DIE EINE Stelle, seit AP-10 IP-8 ohne Ablehnung — die Zeilen
     * der Verteilung am Tag und rechnet jede Prüfung {@code term} des Vertrags: 11 130 kWh, 70 %,
     * „verteilt (70 % von MS-07)“ — oder {@code nicht_verteilt} ohne Zeile am Tag, nie ein geratener Anteil.
     */
    @TestFactory
    List<DynamicTest> f11DerVerteilungsTerm() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : verteilung().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!p.path("regel").asText().equals("term")) {
                    continue;
                }
                tests.add(DynamicTest.dynamicTest(fall.path("id").asText() + " · " + p.path("name").asText(), () -> {
                    JsonNode ein = p.path("eingang");
                    JsonNode soll = p.path("ergebnis");
                    JsonNode t = ein.path("term");
                    LocalDate tag = LocalDate.parse(ein.path("tag").asText());

                    Optional<Ablehnung> heute = ablehnung(t, tag);
                    VerteilungRegeln.TermUrteil ist;
                    if ("verteilungs_term_ohne_faktor".equals(str(soll.path("fehler")))) {
                        assertThat(heute).contains(Ablehnung.VERTEILUNGS_TERM_OHNE_FAKTOR);
                        ist = AnteilLeseweg.tagesanteil(verteilungsTerm(t), tag,
                                abschnitte(ein.path("verteilung"))).urteil(bd(ein.path("quelle_menge")));
                    } else {
                        assertThat(heute).as("eingelöst — keine Ablehnung mehr").isEmpty();
                        stand = standAus(t.path("quell_messstelle").asText(), abschnitte(ein.path("verteilung")));
                        ist = lesung(t, tag).urteil(bd(ein.path("quelle_menge")));
                    }
                    betragGleich(ist.menge(), soll.path("menge"), "Menge");
                    betragGleich(ist.anteilProzent(), soll.path("anteil_prozent"), "Anteil");
                    assertThat(ist.kennzeichen()).isEqualTo(texte(soll.path("kennzeichen")));
                    assertThat(ist.fehler()).isEqualTo(str(soll.path("fehler")));
                }));
            }
        }
        assertThat(tests).as("F11 trägt drei Prüfungen term").hasSize(3);
        return tests;
    }

    /**
     * Der Verteilungs-Term liest den Anteil DES TAGES: F13 ändert die Verteilung am 15.01.2027 von
     * 70/30 auf 60/40. Der 10.01. bleibt 70 % — auch wenn „heute“ längst 60 % gilt —, der 20.01. ist
     * 60 %. Was am Tag galt, ist die Wahrheit des Tages.
     */
    @Test
    void derAnteilEinesAltenTagesIstDerVonDamals() throws Exception {
        JsonNode f13 = fall(verteilung(), "F13");
        JsonNode mengen = null;
        for (JsonNode p : f13.path("pruefungen")) {
            if (p.path("regel").asText().equals("mengen") && !p.path("eingang").path("tage").isNull()) {
                mengen = p;
            }
        }
        assertThat(mengen).isNotNull();
        List<VerteilungRegeln.Abschnitt> abschnitte = abschnitte(mengen.path("eingang").path("verteilung"));
        VerteilungRegeln.VerteilungsTerm term =
                new VerteilungRegeln.VerteilungsTerm("verteilung", "4100", "MS-07", "gesamt", BigDecimal.ONE, "+");
        BigDecimal tagesmenge = new BigDecimal("500");

        VerteilungRegeln.TermUrteil damals =
                AnteilLeseweg.tagesanteil(term, LocalDate.of(2027, 1, 10), abschnitte).urteil(tagesmenge);
        VerteilungRegeln.TermUrteil spaeter =
                AnteilLeseweg.tagesanteil(term, LocalDate.of(2027, 1, 20), abschnitte).urteil(tagesmenge);
        assertThat(damals.anteilProzent()).isEqualByComparingTo("70");
        assertThat(damals.menge()).isEqualByComparingTo("350");
        assertThat(damals.kennzeichen()).containsExactly("verteilt (70 % von MS-07)");
        assertThat(spaeter.anteilProzent()).isEqualByComparingTo("60");
        assertThat(spaeter.menge()).isEqualByComparingTo("300");
        // Der letzte Tag der alten Fassung zählt noch zu ihr (Tage einschließlich).
        assertThat(AnteilLeseweg.tagesanteil(term, LocalDate.of(2027, 1, 14), abschnitte).urteil(tagesmenge)
                .anteilProzent()).isEqualByComparingTo("70");
        assertThat(AnteilLeseweg.tagesanteil(term, LocalDate.of(2027, 1, 15), abschnitte).urteil(tagesmenge)
                .anteilProzent()).isEqualByComparingTo("60");
        // Summe über den Monat aus Tagesanteilen = der Vektor 10 000 kWh (nie der Stichtag 9 300).
        BigDecimal monat = BigDecimal.ZERO;
        for (LocalDate d = LocalDate.of(2027, 1, 1); !d.isAfter(LocalDate.of(2027, 1, 31)); d = d.plusDays(1)) {
            monat = monat.add(AnteilLeseweg.tagesanteil(term, d, abschnitte).urteil(tagesmenge).menge());
        }
        betragGleich(monat, mengen.path("ergebnis").path("je_ziel").path("4100"), "F13 · 4100");
    }

    // ----------------------------------------------------------- der Bestand: ganz, zeichengleich

    @Test
    void einTermOhneAnteilNimmtDenGanzenWertUnveraendert() {
        for (String art : List.of("messkanal", "messstelle")) {
            for (String anteil : Arrays.asList(null, AnteilLeseweg.GESAMT)) {
                Lesung l = LESEWEG.lies(art, anteil, null, null, LocalDate.of(2026, 9, 13));
                assertThat(l).isSameAs(Lesung.GANZ);
                BigDecimal wert = new BigDecimal("12.345678901");
                assertThat(l.urteil(wert).menge()).isSameAs(wert);
                assertThat(l.urteil(null).menge()).as("keine Menge bleibt keine Menge, nie 0").isNull();
            }
        }
    }

    // ------------------------------------------------------------------------ Gerüst

    /** Erst die Vertragsregel, dann der Leseweg — die Reihenfolge des Schreibwegs. */
    private static Optional<Ablehnung> ablehnung(JsonNode t, LocalDate tag) {
        Optional<Ablehnung> regel = AnteilLeseweg.vertragsregel(t.path("art").asText(), bd(t.path("faktor")));
        if (regel.isPresent()) {
            return regel;
        }
        return Optional.ofNullable(lesung(t, tag).wartet());
    }

    private static Lesung lesung(JsonNode t, LocalDate tag) {
        return LESEWEG.lies(t.path("art").asText(), str(t.path("anteil")), id(str(t.path("quell_messstelle"))),
                id(str(t.path("verteilung_ziel"))), tag);
    }

    /**
     * Die Verteilung als das, was die Datenbank dem Leseweg gibt: Zeilen und Ziele, Schlüssel der Kostenstelle
     * ist ihre ID (hier aus dem Kennzeichen abgeleitet, wie {@link #id}).
     */
    private static AnteilLeseweg.Stand standAus(String messstelle, List<VerteilungRegeln.Abschnitt> abschnitte) {
        List<VerteilungRegeln.Bestandszeile> zeilen = new ArrayList<>();
        List<VerteilungRegeln.Ziel> ziele = new ArrayList<>();
        for (VerteilungRegeln.Abschnitt a : abschnitte) {
            for (VerteilungRegeln.Zeile z : a.zeilen()) {
                String k = id(z.kostenstelle()).toString();
                zeilen.add(new VerteilungRegeln.Bestandszeile(k, z.anteilProzent(), a.gueltigAb(), a.gueltigBis(), null));
                ziele.add(new VerteilungRegeln.Ziel(k, null, null));
            }
        }
        return new AnteilLeseweg.Stand(messstelle, zeilen, ziele);
    }

    private static UUID id(String kennzeichen) {
        return kennzeichen == null ? null : UUID.nameUUIDFromBytes(kennzeichen.getBytes(StandardCharsets.UTF_8));
    }

    private static VerteilungRegeln.VerteilungsTerm verteilungsTerm(JsonNode t) {
        return new VerteilungRegeln.VerteilungsTerm(t.path("art").asText(), t.path("verteilung_ziel").asText(),
                t.path("quell_messstelle").asText(), t.path("anteil").asText(), bd(t.path("faktor")),
                t.path("vorzeichen").asText());
    }

    private static JsonNode fall(JsonNode datei, String id) {
        for (JsonNode f : datei.path("cases")) {
            if (f.path("id").asText().equals(id)) {
                return f;
            }
        }
        throw new IllegalStateException(id + " fehlt");
    }

    private static List<VerteilungRegeln.Abschnitt> abschnitte(JsonNode n) {
        List<VerteilungRegeln.Abschnitt> raus = new ArrayList<>();
        for (JsonNode a : n) {
            List<VerteilungRegeln.Zeile> zeilen = new ArrayList<>();
            a.path("zeilen").forEach(z -> zeilen.add(new VerteilungRegeln.Zeile(z.path("kostenstelle").asText(),
                    new BigDecimal(z.path("anteil_prozent").asText()))));
            raus.add(new VerteilungRegeln.Abschnitt(tag(a.path("gueltig_ab")), tag(a.path("gueltig_bis")), zeilen));
        }
        return raus;
    }

    private static LocalDate tag(JsonNode n) {
        String s = str(n);
        return s == null ? null : LocalDate.parse(s);
    }
}
