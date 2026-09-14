package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.betragGleich;
import static com.voltpilot.api.uems.BilanzVectorsTest.ganz;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static com.voltpilot.api.uems.BilanzVectorsTest.texte;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings der FESTEN VERTEILUNG (UEMS AP-10 IP-1): {@link VerteilungRegeln}
 * zieht aus JEDER Prüfung der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/verteilung-vectors.json}) genau das Ergebnis, das dort steht — und der
 * TS-Zwilling ({@code frontend/portal/src/uemsVerteilung.ts}) aus derselben Datei dasselbe.
 *
 * <p>Die Datei wird PER PFAD gelesen. {@code zwillinge} sagt je Regel, wer sie prüft;
 * {@code zwillinge_grund} nennt je Lücke den Grund — eine Regel bleibt nicht stillschweigend
 * ungeprüft.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class VerteilungVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("verteilung-vectors.json");
    private static final Path SCHEMA = V2.resolve("verteilung.schema.json");
    private static final Path HERKUNFT_SCHEMA = V2.resolve("bilanzwert-herkunft.schema.json");
    private static final Path PROSA = V2.resolve("verteilung.md");
    private static final Path TS_ZWILLING =
            Path.of("..", "..", "frontend", "portal", "src", "uemsVerteilung.ts");

    private static JsonNode vektoren() throws Exception {
        return lies(VECTORS);
    }

    private static LocalDate tag(JsonNode n) {
        String s = str(n);
        return s == null ? null : LocalDate.parse(s);
    }

    // ---------------------------------------------------------------------------- Form

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA)))
                .as("Schema-Verstöße")
                .isEmpty();
    }

    @Test
    void prosaUndTsZwillingLiegen() {
        assertThat(Files.exists(PROSA)).as("verteilung.md").isTrue();
        assertThat(Files.exists(TS_ZWILLING)).as("TS-Zwilling").isTrue();
    }

    @Test
    void dieBeispielweltIstDasReferenzunternehmen() throws Exception {
        assertThat(vektoren().path("referenzunternehmen").asText())
                .isEqualTo("./uems-referenzunternehmen.json");
    }

    /** Die 100 %, die Grenzen des Anteils und das Ziel-Wort stehen in der Datei, nicht nur im Modul. */
    @Test
    void dieRegelnStehenInDerDatei() throws Exception {
        JsonNode r = vektoren().path("regeln");
        assertThat(new BigDecimal(r.path("summe_prozent").asText()).compareTo(VerteilungRegeln.SUMME_PROZENT))
                .isZero();
        assertThat(r.path("anteil_max").asInt()).isEqualTo(VerteilungRegeln.SUMME_PROZENT.intValue());
        assertThat(r.path("anteil_min_ausschliesslich").asInt()).isZero();
        assertThat(r.path("anteil_nachkommastellen").asInt())
                .isEqualTo(VerteilungRegeln.ANTEIL_NACHKOMMASTELLEN);
        assertThat(r.path("menge_nachkommastellen").asInt())
                .isEqualTo(VerteilungRegeln.MENGE_NACHKOMMASTELLEN);
        assertThat(r.path("ziel_art").asText()).isEqualTo("kostenstelle");
        assertThat(texte(vektoren().path("vokabulare").path("verteilung_zustand")))
                .containsExactly(VerteilungRegeln.VERTEILT, VerteilungRegeln.NICHT_VERTEILT);
    }

    /** Jede Regel ist deklariert, jede Lücke im Portal begründet. */
    @Test
    void jedeRegelIstDeklariertUndJedeLueckeBegruendet() throws Exception {
        JsonNode v = vektoren();
        List<String> deklariert = new ArrayList<>();
        v.path("zwillinge").fieldNames().forEachRemaining(deklariert::add);
        List<String> benutzt = new ArrayList<>();
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                String regel = p.path("regel").asText();
                if (!benutzt.contains(regel)) {
                    benutzt.add(regel);
                }
            }
        }
        assertThat(deklariert).containsExactlyInAnyOrderElementsOf(benutzt);
        v.path("zwillinge").fields().forEachRemaining(e -> {
            List<String> wer = texte(e.getValue());
            assertThat(wer).as("Zwillinge von " + e.getKey()).contains("java");
            if (!wer.contains("ts")) {
                assertThat(v.path("zwillinge_grund").path(e.getKey()).asText())
                        .as("Grund, warum " + e.getKey() + " keinen TS-Zwilling hat")
                        .isNotBlank();
            }
        });
    }

    @Test
    void jedeAbweichungUndJedeUngepruefteErwartungIstBenannt() throws Exception {
        JsonNode v = vektoren();
        assertThat(v.path("_abweichungen")).isNotEmpty();
        v.path("_abweichungen").forEach(a -> {
            assertThat(a.path("fall").asText()).isNotBlank();
            assertThat(a.path("grund").asText()).isNotBlank();
        });
        assertThat(v.path("_nicht_geprueft")).isNotEmpty();
        v.path("_nicht_geprueft").forEach(o -> assertThat(o.path("warum").asText()).isNotBlank());
    }

    // ---------------------------------------------------------------------- Die Vektoren

    @TestFactory
    List<DynamicTest> vektoren_() throws Exception {
        JsonNode v = vektoren();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!texte(v.path("zwillinge").path(p.path("regel").asText())).contains("java")) {
                    continue;
                }
                String name = fall.path("id").asText() + " · " + p.path("regel").asText() + " :: "
                        + p.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> pruefe(fall, p)));
            }
        }
        assertThat(tests).as("Prüfungen über alle Fälle").hasSizeGreaterThanOrEqualTo(26);
        return tests;
    }

    private void pruefe(JsonNode fall, JsonNode p) throws Exception {
        String why = fall.path("id").asText() + " (" + fall.path("why").asText() + ")";
        JsonNode ein = p.path("eingang");
        JsonNode soll = p.path("ergebnis");

        switch (p.path("regel").asText()) {
            case "satz" -> {
                VerteilungRegeln.SatzUrteil ist = VerteilungRegeln.satz(tag(ein.path("tag")),
                        str(ein.path("messstelle")), zeilen(ein.path("zeilen")), ziele(ein.path("ziele")));
                assertThat(ist.gueltig()).as(why + " · gültig").isEqualTo(soll.path("gueltig").asBoolean());
                betragGleich(ist.summe(), soll.path("summe"), why + " · Summe");
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                Map<String, String> sollFakten = new LinkedHashMap<>();
                soll.path("fakten").fields().forEachRemaining(e -> sollFakten.put(e.getKey(), e.getValue().asText()));
                assertThat(ist.fakten()).as(why + " · Fakten").isEqualTo(sollFakten);
            }
            case "am_tag" -> {
                VerteilungRegeln.AmTagUrteil ist = VerteilungRegeln.amTag(tag(ein.path("tag")),
                        bestand(ein.path("zeilen")), ziele(ein.path("ziele")));
                assertThat(zeilenText(ist.zeilen())).as(why + " · Zeilen")
                        .isEqualTo(sollZeilenText(soll.path("zeilen")));
                assertThat(ist.zustand()).as(why + " · Zustand").isEqualTo(str(soll.path("zustand")));
            }
            case "fassung" -> {
                VerteilungRegeln.FassungUrteil ist = VerteilungRegeln.fassung(tag(ein.path("heute")),
                        bestand(ein.path("bestehend")), tag(ein.path("neu").path("gueltig_ab")),
                        zeilen(ein.path("neu").path("zeilen")));
                List<String> beendet = ist.beendet().stream()
                        .map(b -> b.kostenstelle() + "@" + b.gueltigBis())
                        .toList();
                List<String> sollBeendet = new ArrayList<>();
                soll.path("beendet").forEach(b -> sollBeendet.add(
                        b.path("kostenstelle").asText() + "@" + b.path("gueltig_bis").asText()));
                assertThat(beendet).as(why + " · beendet").isEqualTo(sollBeendet);
                List<String> neu = ist.neu().stream()
                        .map(n -> n.kostenstelle() + "=" + n.anteilProzent().stripTrailingZeros().toPlainString()
                                + "@" + n.gueltigAb())
                        .toList();
                List<String> sollNeu = new ArrayList<>();
                soll.path("neu").forEach(n -> sollNeu.add(n.path("kostenstelle").asText() + "="
                        + new BigDecimal(n.path("anteil_prozent").asText()).stripTrailingZeros().toPlainString()
                        + "@" + n.path("gueltig_ab").asText()));
                assertThat(neu).as(why + " · neue Zeilen").isEqualTo(sollNeu);
                assertThat(ist.rueckwirkend()).as(why + " · rückwirkend")
                        .isEqualTo(soll.path("rueckwirkend").asBoolean());
                assertThat(ist.tageRueckwirkend()).as(why + " · Tage rückwirkend")
                        .isEqualTo(soll.path("tage_rueckwirkend").asLong());
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
            }
            case "satz_ab_tag" -> {
                VerteilungRegeln.SatzAbTagUrteil ist = VerteilungRegeln.satzAbTag(tag(ein.path("heute")),
                        tag(ein.path("tag")), zeilen(ein.path("zeilen")), ziele(ein.path("ziele")),
                        bestand(ein.path("bestehend")), ein.path("korrektur").asBoolean());
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                betragGleich(ist.summe(), soll.path("summe"), why + " · Summe");
                Map<String, String> sollFakten = new LinkedHashMap<>();
                soll.path("fakten").fields().forEachRemaining(e -> sollFakten.put(e.getKey(), e.getValue().asText()));
                assertThat(ist.fakten()).as(why + " · Fakten").isEqualTo(sollFakten);
                assertThat(ist.aufgehoben().stream().map(a -> a.kostenstelle() + "@" + a.gueltigAb()).toList())
                        .as(why + " · aufgehoben").isEqualTo(paare(soll.path("aufgehoben"), "gueltig_ab"));
                assertThat(ist.beendet().stream().map(b -> b.kostenstelle() + "@" + b.gueltigBis()).toList())
                        .as(why + " · beendet").isEqualTo(paare(soll.path("beendet"), "gueltig_bis"));
                List<String> neu = ist.neu().stream()
                        .map(n -> n.kostenstelle() + "=" + n.anteilProzent().stripTrailingZeros().toPlainString()
                                + "@" + n.gueltigAb() + ".." + n.gueltigBis())
                        .toList();
                List<String> sollNeu = new ArrayList<>();
                soll.path("neu").forEach(n -> sollNeu.add(n.path("kostenstelle").asText() + "="
                        + new BigDecimal(n.path("anteil_prozent").asText()).stripTrailingZeros().toPlainString()
                        + "@" + n.path("gueltig_ab").asText() + ".." + str(n.path("gueltig_bis"))));
                assertThat(neu).as(why + " · neue Zeilen (enden mit ihrem Ziel)").isEqualTo(sollNeu);
                assertThat(ist.rueckwirkend()).as(why + " · rückwirkend")
                        .isEqualTo(soll.path("rueckwirkend").asBoolean());
                assertThat(ist.tageRueckwirkend()).as(why + " · Tage rückwirkend")
                        .isEqualTo(soll.path("tage_rueckwirkend").asLong());
                assertThat(ist.unveraendert()).as(why + " · unverändert")
                        .isEqualTo(soll.path("unveraendert").asBoolean());
            }
            case "mengen" -> {
                List<VerteilungRegeln.Tagesmenge> tage = null;
                if (ein.path("tage").isArray()) {
                    tage = new ArrayList<>();
                    for (JsonNode t : ein.path("tage")) {
                        tage.add(new VerteilungRegeln.Tagesmenge(tag(t.path("tag")), bd(t.path("menge"))));
                    }
                }
                VerteilungRegeln.MengenUrteil ist = VerteilungRegeln.mengen(tag(ein.path("von")),
                        tag(ein.path("bis")), bd(ein.path("periode_menge")), tage,
                        abschnitte(ein.path("verteilung")));
                assertThat(ist.jeZiel().keySet()).as(why + " · Ziele")
                        .containsExactlyInAnyOrderElementsOf(namen(soll.path("je_ziel")));
                soll.path("je_ziel").fields().forEachRemaining(e -> betragGleich(
                        ist.jeZiel().get(e.getKey()), e.getValue(), why + " · Ziel " + e.getKey()));
                betragGleich(ist.summe(), soll.path("summe"), why + " · Summe");
                betragGleich(ist.nichtVerteilt(), soll.path("nicht_verteilt"), why + " · nicht verteilt");
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
            }
            case "erbe" -> {
                JsonNode q = ein.path("quelle");
                VerteilungRegeln.ErbeUrteil ist = VerteilungRegeln.erbe(
                        new VerteilungRegeln.Quelle(q.path("messstelle").asText(), bd(q.path("menge")),
                                q.path("zustand").asText(), ganz(q.path("abdeckung_prozent")),
                                q.path("version").asInt(), texte(q.path("kennzeichen"))),
                        bd(ein.path("anteil_prozent")), ein.path("fassung").asInt(),
                        str(ein.path("ziel")), str(ein.path("einheit")));
                betragGleich(ist.menge(), soll.path("menge"), why + " · verteilte Menge");
                assertThat(ist.zustand()).as(why + " · Zustand").isEqualTo(str(soll.path("zustand")));
                assertThat(ist.abdeckungProzent()).as(why + " · Abdeckung")
                        .isEqualTo(ganz(soll.path("abdeckung_prozent")));
                assertThat(ist.version()).as(why + " · Version").isEqualTo(soll.path("version").asInt());
                assertThat(ist.kennzeichen()).as(why + " · Kennzeichen")
                        .isEqualTo(texte(soll.path("kennzeichen")));
                assertThat(ist.grund()).as(why + " · Grund").isEqualTo(str(soll.path("grund")));
            }
            case "term" -> {
                JsonNode t = ein.path("term");
                VerteilungRegeln.TermUrteil ist = VerteilungRegeln.term(
                        new VerteilungRegeln.VerteilungsTerm(t.path("art").asText(),
                                t.path("verteilung_ziel").asText(), t.path("quell_messstelle").asText(),
                                t.path("anteil").asText(), bd(t.path("faktor")),
                                t.path("vorzeichen").asText()),
                        tag(ein.path("tag")), bd(ein.path("quelle_menge")),
                        abschnitte(ein.path("verteilung")));
                betragGleich(ist.menge(), soll.path("menge"), why + " · Menge");
                betragGleich(ist.anteilProzent(), soll.path("anteil_prozent"), why + " · Anteil");
                assertThat(ist.kennzeichen()).as(why + " · Kennzeichen")
                        .isEqualTo(texte(soll.path("kennzeichen")));
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
            }
            case "herkunft" -> {
                BilanzwertHerkunft.Urteil ist =
                        BilanzwertHerkunft.herkunft(BilanzVectorsTest.herkunftEingang(ein));
                assertThat(ist.fehlt()).as(why + " · fehlende Pflichtangaben")
                        .isEqualTo(texte(soll.path("fehlt")));
                JsonNode gebaut = MAPPER.valueToTree(ist.satz());
                assertThat(gebaut).as(why + " · Herkunfts-Satz").isEqualTo(soll.path("satz"));
                assertThat(UemsSchemaLaeufer.verstoesse(gebaut, lies(HERKUNFT_SCHEMA)))
                        .as(why + " · der Satz hält bilanzwert-herkunft.schema.json")
                        .isEmpty();
            }
            case "kostenstelle" -> {
                List<KostenstelleEnergieRegeln.Quelle> quellen = new ArrayList<>();
                for (JsonNode q : ein.path("quellen")) {
                    List<KostenstelleEnergieRegeln.Anteil> anteile = new ArrayList<>();
                    for (JsonNode a : q.path("anteile")) {
                        anteile.add(new KostenstelleEnergieRegeln.Anteil(a.path("kostenstelle").asText(),
                                bd(a.path("anteil_prozent")), tag(a.path("gueltig_ab")), tag(a.path("gueltig_bis")),
                                a.path("fassung").asInt()));
                    }
                    List<KostenstelleEnergieRegeln.Tageswert> tage = new ArrayList<>();
                    for (JsonNode t : q.path("tage")) {
                        tage.add(new KostenstelleEnergieRegeln.Tageswert(tag(t.path("tag")), bd(t.path("menge")),
                                t.path("zustand").asText(), ganz(t.path("abdeckung_prozent")), t.path("version").asInt(),
                                texte(t.path("kennzeichen"))));
                    }
                    quellen.add(new KostenstelleEnergieRegeln.Quelle(q.path("messstelle").asText(),
                            q.path("art").asText(), q.path("groesse").asText(), q.path("richtung").asText(),
                            q.path("einheit").asText(), anteile, tage));
                }
                KostenstelleEnergieRegeln.Urteil ist = KostenstelleEnergieRegeln.energie(
                        ein.path("kostenstelle").asText(), tag(ein.path("von")), tag(ein.path("bis")),
                        ziele(ein.path("ziele")), quellen);
                blockGleich(ist.gemessen(), soll.path("gemessen"), why + " · gemessen");
                blockGleich(ist.verteilt(), soll.path("verteilt"), why + " · verteilt");
                blockGleich(ist.berechnet(), soll.path("berechnet"), why + " · berechnet");
                blockGleich(ist.summe(), soll.path("summe"), why + " · Summe der Kostenstelle");
                blockGleich(ist.nichtVerteilt(), soll.path("nicht_verteilt"), why + " · nicht verteilt");
            }
            default -> throw new IllegalStateException("unbekannte Regel " + p.path("regel").asText());
        }
    }

    /** Ein Block der Kostenstellen-Sicht: Zahl, Einheit, Zustand, Grund und JEDER Posten mit seinen Stichproben. */
    private static void blockGleich(KostenstelleEnergieRegeln.Block ist, JsonNode soll, String wo) {
        betragGleich(ist.menge(), soll.path("menge"), wo + " · Menge");
        assertThat(ist.einheit()).as(wo + " · Einheit").isEqualTo(str(soll.path("einheit")));
        assertThat(ist.zustand()).as(wo + " · Zustand").isEqualTo(str(soll.path("zustand")));
        assertThat(ist.grund()).as(wo + " · Grund").isEqualTo(str(soll.path("grund")));
        if (soll.has("anzahl_summen")) {
            assertThat(ist.summen()).as(wo + " · Summen je Größe").hasSize(soll.path("anzahl_summen").asInt());
        }
        assertThat(ist.posten().stream().map(KostenstelleEnergieRegeln.Posten::messstelle).toList())
                .as(wo + " · Posten").isEqualTo(sollNamen(soll.path("posten")));
        for (int i = 0; i < ist.posten().size(); i++) {
            KostenstelleEnergieRegeln.Posten p = ist.posten().get(i);
            JsonNode s = soll.path("posten").get(i);
            String hier = wo + " · " + p.messstelle();
            assertThat(p.art()).as(hier + " · Art").isEqualTo(s.path("art").asText());
            betragGleich(p.menge(), s.path("menge"), hier + " · Menge");
            assertThat(p.zustand()).as(hier + " · Zustand").isEqualTo(str(s.path("zustand")));
            assertThat(p.version()).as(hier + " · Version").isEqualTo(s.path("version").asInt());
            assertThat(p.kennzeichen()).as(hier + " · Kennzeichen").isEqualTo(texte(s.path("kennzeichen")));
            List<Integer> fassungen = new ArrayList<>();
            s.path("fassungen").forEach(f -> fassungen.add(f.asInt()));
            assertThat(p.fassungen()).as(hier + " · Fassungen").isEqualTo(fassungen);
            for (JsonNode stichprobe : s.path("tage_stichproben")) {
                LocalDate t = tag(stichprobe.path("tag"));
                KostenstelleEnergieRegeln.Tag tagIst = p.tage().stream().filter(x -> x.tag().equals(t)).findFirst()
                        .orElseThrow(() -> new AssertionError(hier + " · kein Tag " + t));
                betragGleich(tagIst.anteilProzent(), stichprobe.path("anteil_prozent"), hier + " · Anteil " + t);
                betragGleich(tagIst.menge(), stichprobe.path("menge"), hier + " · Tagesanteil " + t);
                assertThat(tagIst.grund()).as(hier + " · Grund " + t).isEqualTo(str(stichprobe.path("grund")));
            }
        }
    }

    private static List<String> sollNamen(JsonNode posten) {
        List<String> raus = new ArrayList<>();
        posten.forEach(p -> raus.add(p.path("messstelle").asText()));
        return raus;
    }

    private static List<String> paare(JsonNode n, String tagFeld) {
        List<String> raus = new ArrayList<>();
        n.forEach(x -> raus.add(x.path("kostenstelle").asText() + "@" + x.path(tagFeld).asText()));
        return raus;
    }

    private static List<String> namen(JsonNode obj) {
        List<String> raus = new ArrayList<>();
        obj.fieldNames().forEachRemaining(raus::add);
        return raus;
    }

    private static List<VerteilungRegeln.Zeile> zeilen(JsonNode n) {
        List<VerteilungRegeln.Zeile> raus = new ArrayList<>();
        for (JsonNode z : n) {
            raus.add(new VerteilungRegeln.Zeile(z.path("kostenstelle").asText(),
                    new BigDecimal(z.path("anteil_prozent").asText())));
        }
        return raus;
    }

    private static List<String> zeilenText(List<VerteilungRegeln.Zeile> zeilen) {
        return zeilen.stream()
                .map(z -> z.kostenstelle() + "=" + z.anteilProzent().stripTrailingZeros().toPlainString())
                .toList();
    }

    private static List<String> sollZeilenText(JsonNode n) {
        List<String> raus = new ArrayList<>();
        n.forEach(z -> raus.add(z.path("kostenstelle").asText() + "="
                + new BigDecimal(z.path("anteil_prozent").asText()).stripTrailingZeros().toPlainString()));
        return raus;
    }

    private static List<VerteilungRegeln.Ziel> ziele(JsonNode n) {
        List<VerteilungRegeln.Ziel> raus = new ArrayList<>();
        for (JsonNode z : n) {
            raus.add(new VerteilungRegeln.Ziel(z.path("kostenstelle").asText(),
                    tag(z.path("gueltig_ab")), tag(z.path("gueltig_bis"))));
        }
        return raus;
    }

    private static List<VerteilungRegeln.Bestandszeile> bestand(JsonNode n) {
        List<VerteilungRegeln.Bestandszeile> raus = new ArrayList<>();
        for (JsonNode z : n) {
            raus.add(new VerteilungRegeln.Bestandszeile(z.path("kostenstelle").asText(),
                    new BigDecimal(z.path("anteil_prozent").asText()), tag(z.path("gueltig_ab")),
                    tag(z.path("gueltig_bis")), tag(z.path("aufgehoben_am"))));
        }
        return raus;
    }

    private static List<VerteilungRegeln.Abschnitt> abschnitte(JsonNode n) {
        List<VerteilungRegeln.Abschnitt> raus = new ArrayList<>();
        for (JsonNode a : n) {
            raus.add(new VerteilungRegeln.Abschnitt(tag(a.path("gueltig_ab")), tag(a.path("gueltig_bis")),
                    zeilen(a.path("zeilen"))));
        }
        return raus;
    }
}
