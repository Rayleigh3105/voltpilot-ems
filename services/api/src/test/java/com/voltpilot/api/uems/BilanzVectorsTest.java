package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
 * Der Vertrag des Java-Zwillings der ENERGIEBILANZ (UEMS AP-10 IP-1): {@link BilanzAbleitung} und
 * {@link BilanzwertHerkunft} ziehen aus JEDER Prüfung der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/bilanz-vectors.json}) genau das Ergebnis, das dort steht — und der
 * TS-Zwilling ({@code frontend/portal/src/uemsBilanz.ts}, Test {@code uemsBilanz.test.ts}) aus
 * derselben Datei dasselbe.
 *
 * <p>Die Datei wird PER PFAD gelesen — wer sie verschiebt, bricht diesen Test absichtlich.
 *
 * <p>{@code zwillinge} in der Datei sagt je Regel, wer sie prüft. Dieser Test fährt JEDE Regel, die
 * dort „java“ nennt, und beweist zusätzlich, dass keine Regel der Datei unbeprüft bleibt.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class BilanzVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("bilanz-vectors.json");
    private static final Path SCHEMA = V2.resolve("bilanz.schema.json");
    private static final Path HERKUNFT_SCHEMA = V2.resolve("bilanzwert-herkunft.schema.json");
    private static final Path PROSA = V2.resolve("bilanz.md");
    private static final Path HERKUNFT_PROSA = V2.resolve("bilanzwert-herkunft.md");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path TS_ZWILLING =
            Path.of("..", "..", "frontend", "portal", "src", "uemsBilanz.ts");

    static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static JsonNode vektoren() throws Exception {
        return lies(VECTORS);
    }

    static List<String> texte(JsonNode n) {
        List<String> raus = new ArrayList<>();
        n.forEach(e -> raus.add(e.asText()));
        return raus;
    }

    static String str(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    static BigDecimal bd(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : new BigDecimal(n.asText());
    }

    static Integer ganz(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : n.asInt();
    }

    /** Beträge werden NUMERISCH verglichen: „10“ und „10.000000“ sind derselbe Betrag. */
    static void betragGleich(BigDecimal ist, JsonNode soll, String was) {
        if (soll == null || soll.isMissingNode() || soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        assertThat(ist.compareTo(new BigDecimal(soll.asText())))
                .as(was + ": " + ist + " soll " + soll.asText() + " sein")
                .isZero();
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
        assertThat(vektoren().path("referenzunternehmen").asText()).isEqualTo("./uems-referenzunternehmen.json");
        assertThat(Files.exists(REFERENZ)).isTrue();
    }

    /** Prosa und TS-Zwilling liegen, wo die Datei sie nennt — sonst ist der Gleichlauf nur behauptet. */
    @Test
    void prosaUndTsZwillingLiegen() {
        assertThat(Files.exists(PROSA)).as("bilanz.md").isTrue();
        assertThat(Files.exists(HERKUNFT_PROSA)).as("bilanzwert-herkunft.md").isTrue();
        assertThat(Files.exists(TS_ZWILLING)).as("TS-Zwilling").isTrue();
    }

    /** Jeder Fall hat einen Zweck, einen Titel und eine Handrechnung; die Kennungen sind eindeutig. */
    @Test
    void jederFallHatZweckTitelUndHandrechnung() throws Exception {
        List<String> namen = new ArrayList<>();
        List<String> kennungen = new ArrayList<>();
        vektoren().path("cases").forEach(c -> {
            namen.add(c.path("name").asText());
            kennungen.add(c.path("id").asText());
            assertThat(c.path("why").asText()).as(c.path("id").asText() + " · why").isNotBlank();
            assertThat(c.path("titel").asText()).as(c.path("id").asText() + " · titel").isNotBlank();
            assertThat(c.path("schritte")).as(c.path("id").asText() + " · Handrechnung").isNotEmpty();
        });
        assertThat(namen).doesNotHaveDuplicates();
        assertThat(kennungen).doesNotHaveDuplicates().contains("F1", "F19");
    }

    /** Die Plan-Abnahme des Captains hat ihren Fall — 100 · 60 · 30 · 10. */
    @Test
    void diePlanAbnahmeHatIhrenFall() throws Exception {
        JsonNode v = vektoren();
        assertThat(v.path("plan_abnahmen").path("plan").asText())
                .contains("100", "60", "30", "10");
        List<String> mitAbnahme = new ArrayList<>();
        v.path("cases").forEach(c -> {
            if (!c.path("abnahme").isNull()) {
                mitAbnahme.add(c.path("id").asText() + "=" + c.path("abnahme").asText());
            }
        });
        assertThat(mitAbnahme).containsExactly("F1=plan");
    }

    /** Die Zustandswörter sind DIESELBEN wie in der schon gemergten Verbrauchsregel AP-08. */
    @Test
    void dieZustandswoerterSindDieDerVerbrauchsregel() throws Exception {
        assertThat(BilanzAbleitung.VOLLSTAENDIG).isEqualTo(VerbrauchRegeln.VOLLSTAENDIG);
        assertThat(BilanzAbleitung.UNVOLLSTAENDIG).isEqualTo(VerbrauchRegeln.UNVOLLSTAENDIG);
        assertThat(BilanzAbleitung.KEINE_WERTE).isEqualTo(VerbrauchRegeln.KEINE_WERTE);
        assertThat(texte(vektoren().path("zustand_rang"))).isEqualTo(BilanzAbleitung.ZUSTAND_RANG);
        assertThat(texte(vektoren().path("vokabulare").path("zustand")))
                .containsExactlyInAnyOrderElementsOf(BilanzAbleitung.ZUSTAND_RANG);
    }

    /** Die Stellungen sind die des Messstellen-Vertrags — kein zweites Vokabular. */
    @Test
    void dieStellungenSindDieDesMessstellenVertrags() throws Exception {
        assertThat(texte(vektoren().path("vokabulare").path("stellung")))
                .containsExactlyElementsOf(MessstelleRegeln.STELLUNGEN);
    }

    /** Die Schwellen und Zeichen stehen in der Datei; die Klasse schreibt sie nicht für sich allein fest. */
    @Test
    void dieRegelnStehenInDerDatei() throws Exception {
        JsonNode r = vektoren().path("regeln");
        assertThat(r.path("menge_nachkommastellen").asInt()).isEqualTo(BilanzAbleitung.MENGE_NACHKOMMASTELLEN);
        assertThat(r.path("zahlform").asText()).startsWith("ergebnis-zustand-vectors.json");
        assertThat(r.has("tausender_trennzeichen")).as("die Zahlform steht im Ergebnis-Zustand, nicht hier").isFalse();
        assertThat(texte(vektoren().path("verbotene_woerter")))
                .containsExactlyElementsOf(BilanzAbleitung.VERBOTENE_WOERTER);
        List<String> muster = new ArrayList<>();
        List<String> als = new ArrayList<>();
        vektoren().path("kennzeichen_erbend").forEach(e -> {
            muster.add(e.path("muster").asText());
            als.add(e.path("als").asText());
            assertThat(e.path("warum").asText()).as("Grund je Erbregel").isNotBlank();
        });
        assertThat(muster).isEqualTo(
                BilanzAbleitung.KENNZEICHEN_ERBEND.stream().map(e -> e.muster().pattern()).toList());
        assertThat(als).isEqualTo(
                BilanzAbleitung.KENNZEICHEN_ERBEND.stream().map(BilanzAbleitung.Erbregel::als).toList());
    }

    /**
     * Die Grenze des Captains als Test: kein Satz und kein Kennzeichen dieses Vertrags behauptet
     * eine URSACHE. Eine Differenz ist eine Differenz.
     */
    @Test
    void keinSatzBehauptetEineUrsache() throws Exception {
        JsonNode v = vektoren();
        List<String> verboten = texte(v.path("verbotene_woerter"));
        List<String> saetze = new ArrayList<>();
        v.path("saetze").fields().forEachRemaining(e -> saetze.add(e.getValue().asText()));
        v.path("vokabulare").path("kennzeichen_neu").forEach(k -> saetze.add(k.asText()));
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                JsonNode satz = p.path("ergebnis").path("kundensatz");
                if (satz.isTextual()) {
                    saetze.add(satz.asText());
                }
            }
        }
        for (String satz : saetze) {
            for (String wort : verboten) {
                assertThat(satz).as("Satz ohne Ursachen-Behauptung").doesNotContain(wort);
            }
        }
    }

    // ------------------------------------------------ Zahlform E11 (ergebnis-zustand-vectors.json)

    private static BilanzAbleitung.Summand summand(String messstelle, String menge) {
        return new BilanzAbleitung.Summand(messstelle, menge == null ? null : new BigDecimal(menge),
                menge == null ? BilanzAbleitung.KEINE_WERTE : BilanzAbleitung.VOLLSTAENDIG, 100, 1, List.of(), "+",
                BigDecimal.ONE);
    }

    private static BilanzAbleitung.Eingang eingang(String messstelle, String rolle, String menge) {
        return new BilanzAbleitung.Eingang(messstelle, rolle, "gesamt", new BigDecimal(menge),
                BilanzAbleitung.VOLLSTAENDIG, 100, 1, List.of());
    }

    /** Die alte Form „1 055 kWh“ (Leerzeichen als Tausendertrenner) ist falsch: E11 schreibt „1.055 kWh“. */
    @Test
    void tausenderMitPunktNichtMitLeerzeichen() {
        String anzeige = BilanzAbleitung.summe("kWh", "tag",
                List.of(summand("MS-11", "740"), summand("MS-13", "315"), summand("MS-14", null))).anzeige();
        assertThat(anzeige).isEqualTo("mindestens 1.055\u00A0kWh (MS-14 fehlt)").doesNotContain("1 055");
        assertThat(NetzanschlussRegeln.kopfzeile("NA-9", new BigDecimal("1200"), null, null).text())
                .isEqualTo("vereinbart 1.200,0\u00A0kW").doesNotContain("1 200");
    }

    /** Die alte Form war ungerundet („1 200,5“): die EBENE bestimmt die Stellen — Tag/Monat ganz, Leistung eine. */
    @Test
    void festeStellenJeEbeneStattUngerundet() {
        List<BilanzAbleitung.Eingang> e = List.of(eingang("MS-16", BilanzAbleitung.ZUFLUSS, "1300.5"),
                eingang("MS-17", BilanzAbleitung.ZUGEORDNET, "100"));
        assertThat(BilanzAbleitung.rest("MS-16", "kWh", "monat", 1, List.of(), e).kundensatz())
                .isEqualTo("1.201\u00A0kWh sind keiner Messstelle zugeordnet").doesNotContain("1 200,5");
        assertThat(BilanzAbleitung.rest("MS-16", "kWh", "stunde", 1, List.of(), e).kundensatz())
                .isEqualTo("1.200,5\u00A0kWh sind keiner Messstelle zugeordnet");
        assertThat(NetzanschlussRegeln.kopfzeile("NA-1", new BigDecimal("550"), new BigDecimal("630"),
                new BigDecimal("312.44")).text())
                .isEqualTo("vereinbart 550,0\u00A0kW · Anschluss 630,0\u00A0kVA · Momentan 312,4\u00A0kW");
        assertThatThrownBy(() -> BilanzAbleitung.rest("MS-16", "kWh", null, 1, List.of(), e))
                .as("kWh ohne Ebene hat keine Anzeige (ebene_fehlt)")
                .isInstanceOf(IllegalArgumentException.class);
    }

    /** Die alte Form hatte ein normales Leerzeichen vor der Einheit: E11 verlangt U+00A0, auf 375 px bricht nichts um. */
    @Test
    void geschuetztesLeerzeichenVorDerEinheit() throws Exception {
        List<String> saetze = new ArrayList<>();
        for (JsonNode fall : vektoren().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                for (String feld : List.of("kundensatz", "anzeige")) {
                    JsonNode satz = p.path("ergebnis").path(feld);
                    if (satz.isTextual() && satz.asText().matches(".*\\d.*kWh.*")) {
                        saetze.add(satz.asText());
                    }
                }
            }
        }
        assertThat(saetze).hasSizeGreaterThanOrEqualTo(11)
                .allSatisfy(s -> assertThat(s).contains("\u00A0kWh").doesNotContain(" kWh"));
        assertThat(BilanzAbleitung.rest("MS-16", "kWh", "tag", 1, List.of(),
                List.of(eingang("MS-16", BilanzAbleitung.ZUFLUSS, "100"),
                        eingang("MS-17", BilanzAbleitung.ZUGEORDNET, "105"))).kundensatz())
                .isEqualTo("Messwerte passen nicht zusammen (\u22125\u00A0kWh)");
    }

    /**
     * Der Kundensatz des Rests kommt aus dem VERTRAG (AP-10 IP-4): die Vorlagen der Klasse sind
     * wörtlich die aus {@code saetze} — und die Plan-Abnahme F1 sagt damit „10 kWh sind keiner
     * Messstelle zugeordnet“, nie „Verlust“.
     */
    @Test
    void dieKundensaetzeDesRestsStehenImVertrag() throws Exception {
        JsonNode saetze = vektoren().path("saetze");
        assertThat(BilanzAbleitung.SATZ_REST_ZUGEORDNET).isEqualTo(saetze.path("rest_zugeordnet").asText());
        assertThat(BilanzAbleitung.SATZ_REST_NEGATIV).isEqualTo(saetze.path("rest_negativ").asText());
        assertThat(BilanzAbleitung.SATZ_REST_KEINE_WERTE).isEqualTo(saetze.path("rest_keine_werte").asText());
    }

    /**
     * Das BEFRISTETE Kennzeichen „vorläufig (Geräte-Verdichtung)“ (AP-10 IP-9, W12) ist mit seinem Ablaufpaket
     * AP-10 IP-10 entfallen: die Periodenwerte berechneter Messstellen liegen in der Speicherklasse. Kein
     * Kennzeichen dieses Vertrags spricht mehr von der Geräte-Verdichtung, und der befristete Block ist weg.
     */
    @Test
    void dasBefristeteKennzeichenIstMitSeinemAblaufpaketEntfallen() throws Exception {
        JsonNode v = vektoren().path("vokabulare");
        assertThat(v.has("kennzeichen_befristet")).isFalse();
        assertThat(texte(v.path("kennzeichen_neu"))).noneMatch(k -> k.contains("Geräte-Verdichtung"));
    }

    /**
     * E3 — jede Fassung eines Rests, die {@code rest_aus_stellung} aus den Stellungen des
     * Referenzunternehmens ableitet, ist GENAU die Eingangsmenge einer {@code rest}-Prüfung desselben
     * Falls: die Terme, mit denen gerechnet wird, sind die aus der Stellung — nicht eine zweite,
     * von Hand gepflegte Liste. (Die Reihenfolge ändert keine Zahl und wird hier nicht verglichen.)
     */
    @Test
    void dieTermeAusDerStellungSindDieEingaengeDesRests() throws Exception {
        int gedeckt = 0;
        for (JsonNode fall : vektoren().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!p.path("regel").asText().equals("rest_aus_stellung") || !p.path("ergebnis").path("fehler").isNull()) {
                    continue;
                }
                List<String> ausStellung = terme(p.path("ergebnis").path("terme"));
                List<List<String>> restEingaenge = new ArrayList<>();
                for (JsonNode r : fall.path("pruefungen")) {
                    if (r.path("regel").asText().equals("rest") && r.path("eingang").path("hauptzaehler").asText()
                            .equals(p.path("eingang").path("hauptzaehler").asText())) {
                        restEingaenge.add(terme(r.path("eingang").path("eingaenge")));
                    }
                }
                assertThat(restEingaenge)
                        .as(fall.path("id").asText() + " · " + p.path("name").asText())
                        .anySatisfy(e -> assertThat(e).containsExactlyInAnyOrderElementsOf(ausStellung));
                gedeckt++;
            }
        }
        assertThat(gedeckt).as("Fassungen mit Termen").isGreaterThanOrEqualTo(9);
    }

    /** Die Richtung je Typ ist eine REGEL in der Datei — `rest` fest auf Bezug, `saldo` auf saldiert. */
    @Test
    void dieRichtungJeTypStehtInDerDatei() throws Exception {
        JsonNode j = vektoren().path("richtung_je_typ");
        assertThat(j.path("rest").path("fest").asBoolean()).isTrue();
        assertThat(j.path("rest").path("richtung").asText()).isEqualTo("Bezug");
        assertThat(j.path("saldo").path("richtung").asText()).isEqualTo(BilanzAbleitung.SALDIERT);
        assertThat(j.path("saldo").path("nur_art").asText()).isEqualTo(MessstelleRegeln.BERECHNET);
        assertThat(j.path("gewichtete_summe").path("fest").asBoolean())
                .as("die gewichtete Summe behält die Regel des Formel-Vertrags")
                .isFalse();
        assertThat(texte(vektoren().path("vokabulare").path("richtung_berechnet_additiv")))
                .containsExactly(BilanzAbleitung.SALDIERT);
    }

    /** Jede bewusste Abweichung von der Vorlage und jede ungeprüfte Erwartung ist benannt. */
    @Test
    void jedeAbweichungUndJedeUngepruefteErwartungIstBenannt() throws Exception {
        JsonNode v = vektoren();
        assertThat(v.path("_abweichungen").isArray()).isTrue();
        v.path("_abweichungen").forEach(a -> {
            assertThat(a.path("fall").asText()).isNotBlank();
            assertThat(a.path("feld").asText()).isNotBlank();
            assertThat(a.path("grund").asText()).isNotBlank();
        });
        assertThat(v.path("_nicht_geprueft")).isNotEmpty();
        v.path("_nicht_geprueft").forEach(o -> {
            assertThat(o.path("fall").asText()).isNotBlank();
            assertThat(o.path("feld").asText()).isNotBlank();
            assertThat(o.path("warum").asText()).isNotBlank();
        });
    }

    /**
     * Jede Regel, die in einer Prüfung vorkommt, ist in {@code zwillinge} deklariert — und jede
     * Regel ohne TS-Zwilling nennt dort ihren Grund. Ein Fall ohne Prüfung steht in
     * {@code _nicht_geprueft}: so bleibt weder eine Regel noch ein Fall stillschweigend ungeprüft.
     */
    @Test
    void jedeRegelIstDeklariertUndJederFallOhnePruefungBegruendet() throws Exception {
        JsonNode v = vektoren();
        List<String> deklariert = new ArrayList<>();
        v.path("zwillinge").fieldNames().forEachRemaining(deklariert::add);
        List<String> benutzt = new ArrayList<>();
        List<String> ohnePruefung = new ArrayList<>();
        for (JsonNode fall : v.path("cases")) {
            if (fall.path("pruefungen").isEmpty()) {
                ohnePruefung.add(fall.path("id").asText());
            }
            for (JsonNode p : fall.path("pruefungen")) {
                String regel = p.path("regel").asText();
                if (!benutzt.contains(regel)) {
                    benutzt.add(regel);
                }
            }
        }
        assertThat(deklariert).as("deklarierte Regeln").containsExactlyInAnyOrderElementsOf(benutzt);
        v.path("zwillinge").fields().forEachRemaining(e -> {
            List<String> wer = texte(e.getValue());
            assertThat(wer).as("Zwillinge von " + e.getKey()).contains("java");
            if (!wer.contains("ts")) {
                assertThat(v.path("zwillinge_grund").path(e.getKey()).asText())
                        .as("Grund, warum " + e.getKey() + " keinen TS-Zwilling hat")
                        .isNotBlank();
            }
        });
        List<String> begruendet = new ArrayList<>();
        v.path("_nicht_geprueft").forEach(o -> begruendet.add(o.path("fall").asText()));
        for (String id : ohnePruefung) {
            assertThat(begruendet)
                    .as("Fall " + id + " hat keine Prüfung und muss in _nicht_geprueft stehen")
                    .anySatisfy(b -> assertThat(b).contains(id));
        }
    }

    // ---------------------------------------------------------------------- Die Vektoren

    /**
     * Jede Prüfung jedes Falls, deren Regel „java“ nennt: die Regel rechnet genau das, was in der
     * Datei steht. Eine Prüfung, die bricht, meldet den Zweck ihres Falls — den Grund, warum es
     * ihn gibt.
     */
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
        assertThat(tests).as("Prüfungen über alle Fälle").hasSizeGreaterThanOrEqualTo(45);
        return tests;
    }

    private void pruefe(JsonNode fall, JsonNode p) throws Exception {
        String why = fall.path("id").asText() + " (" + fall.path("why").asText() + ")";
        JsonNode ein = p.path("eingang");
        JsonNode soll = p.path("ergebnis");

        switch (p.path("regel").asText()) {
            case "rolle" -> {
                BilanzAbleitung.RolleUrteil ist = BilanzAbleitung.rolle(new BilanzAbleitung.RolleEingang(
                        str(ein.path("stellung")), str(ein.path("richtung")), str(ein.path("art")),
                        str(ein.path("medium")), str(ein.path("unterzaehler_von"))));
                List<String> rollen = ist.rollen().stream()
                        .map(r -> r.rolle() + ":" + r.anteil())
                        .toList();
                List<String> sollRollen = new ArrayList<>();
                soll.path("rollen").forEach(r ->
                        sollRollen.add(r.path("rolle").asText() + ":" + r.path("anteil").asText()));
                assertThat(rollen).as(why + " · Rollen").isEqualTo(sollRollen);
                assertThat(ist.ziel()).as(why + " · Ziel").isEqualTo(str(soll.path("ziel")));
                assertThat(ist.grund()).as(why + " · Grund").isEqualTo(str(soll.path("grund")));
            }
            case "rest" -> {
                BilanzAbleitung.RestUrteil ist = BilanzAbleitung.rest(
                        str(ein.path("hauptzaehler")), str(ein.path("einheit")), str(ein.path("zahl_ebene")),
                        ein.path("version").asInt(), texte(ein.path("vermerke")),
                        eingaenge(ein.path("eingaenge")));
                betragGleich(ist.zufluss(), soll.path("zufluss"), why + " · Zufluss");
                betragGleich(ist.abfluss(), soll.path("abfluss"), why + " · Abfluss");
                betragGleich(ist.zugeordnet(), soll.path("zugeordnet"), why + " · zugeordnet");
                betragGleich(ist.verbrauchSystem(), soll.path("verbrauch_system"), why + " · Verbrauch");
                betragGleich(ist.menge(), soll.path("menge"), why + " · Rest");
                assertThat(ist.groesse()).as(why + " · Größe").isEqualTo(str(soll.path("groesse")));
                assertThat(ist.richtung()).as(why + " · Richtung").isEqualTo(str(soll.path("richtung")));
                assertThat(ist.einheit()).as(why + " · Einheit").isEqualTo(str(soll.path("einheit")));
                assertThat(ist.zustand()).as(why + " · Zustand").isEqualTo(str(soll.path("zustand")));
                assertThat(ist.abdeckungProzent()).as(why + " · Abdeckung")
                        .isEqualTo(ganz(soll.path("abdeckung_prozent")));
                assertThat(ist.fehlend()).as(why + " · fehlend").isEqualTo(texte(soll.path("fehlend")));
                assertThat(ist.kennzeichen()).as(why + " · Kennzeichen")
                        .isEqualTo(texte(soll.path("kennzeichen")));
                assertThat(ist.kundensatz()).as(why + " · Kundensatz")
                        .isEqualTo(str(soll.path("kundensatz")));
            }
            case "summe" -> {
                BilanzAbleitung.SummeUrteil ist =
                        BilanzAbleitung.summe(str(ein.path("einheit")), str(ein.path("zahl_ebene")),
                                summanden(ein.path("eingaenge")));
                betragGleich(ist.menge(), soll.path("menge"), why + " · Summe");
                assertThat(ist.zustand()).as(why + " · Zustand").isEqualTo(str(soll.path("zustand")));
                assertThat(ist.abdeckungProzent()).as(why + " · Abdeckung")
                        .isEqualTo(ganz(soll.path("abdeckung_prozent")));
                assertThat(ist.vorhanden()).as(why + " · vorhanden").isEqualTo(soll.path("vorhanden").asInt());
                assertThat(ist.gesamt()).as(why + " · gesamt").isEqualTo(soll.path("gesamt").asInt());
                assertThat(ist.fehlend()).as(why + " · fehlend").isEqualTo(texte(soll.path("fehlend")));
                assertThat(ist.kennzeichen()).as(why + " · Kennzeichen")
                        .isEqualTo(texte(soll.path("kennzeichen")));
                assertThat(ist.anzeige()).as(why + " · Anzeige").isEqualTo(str(soll.path("anzeige")));
            }
            case "saldo" -> {
                BilanzAbleitung.SaldoUrteil ist = BilanzAbleitung.saldo(
                        str(ein.path("einheit")), str(ein.path("art")), eingaenge(ein.path("eingaenge")));
                betragGleich(ist.menge(), soll.path("menge"), why + " · Saldo");
                assertThat(ist.groesse()).as(why + " · Größe").isEqualTo(str(soll.path("groesse")));
                assertThat(ist.richtung()).as(why + " · Richtung").isEqualTo(str(soll.path("richtung")));
                assertThat(ist.einheit()).as(why + " · Einheit").isEqualTo(str(soll.path("einheit")));
                assertThat(ist.zustand()).as(why + " · Zustand").isEqualTo(str(soll.path("zustand")));
                assertThat(ist.abdeckungProzent()).as(why + " · Abdeckung")
                        .isEqualTo(ganz(soll.path("abdeckung_prozent")));
                assertThat(ist.fehlend()).as(why + " · fehlend").isEqualTo(texte(soll.path("fehlend")));
                assertThat(ist.kennzeichen()).as(why + " · Kennzeichen")
                        .isEqualTo(texte(soll.path("kennzeichen")));
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                assertThat(ist.grund()).as(why + " · Grund").isEqualTo(str(soll.path("grund")));
            }
            case "richtung" -> {
                List<MessstelleFormelRegeln.Term> terme = null;
                if (ein.path("terme").isArray()) {
                    terme = new ArrayList<>();
                    for (JsonNode t : ein.path("terme")) {
                        terme.add(new MessstelleFormelRegeln.Term(t.path("groesse").asText(),
                                t.path("richtung").asText(), t.path("einheit").asText(),
                                t.path("wertart").asText(), t.path("vorzeichen").asText()));
                    }
                }
                BilanzAbleitung.RichtungUrteil ist = BilanzAbleitung.richtung(
                        str(ein.path("typ")), str(ein.path("art")), str(ein.path("wertart")), terme);
                assertThat(ist.groesse()).as(why + " · Größe").isEqualTo(str(soll.path("groesse")));
                assertThat(ist.richtung()).as(why + " · Richtung").isEqualTo(str(soll.path("richtung")));
                assertThat(ist.einheit()).as(why + " · Einheit").isEqualTo(str(soll.path("einheit")));
                assertThat(ist.wertart()).as(why + " · Wertart").isEqualTo(str(soll.path("wertart")));
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                assertThat(ist.grund()).as(why + " · Grund").isEqualTo(str(soll.path("grund")));
            }
            case "ebene" -> {
                List<BilanzAbleitung.SystemZeile> systeme = new ArrayList<>();
                for (JsonNode s : ein.path("systeme")) {
                    systeme.add(new BilanzAbleitung.SystemZeile(s.path("anlage").asText(),
                            s.path("kurzname").asText(), s.path("messstelle").asText(),
                            bd(s.path("menge")), s.path("zustand").asText(),
                            ganz(s.path("abdeckung_prozent")), s.path("version").asInt(),
                            texte(s.path("kennzeichen"))));
                }
                BilanzAbleitung.EbeneUrteil ist =
                        BilanzAbleitung.ebene(str(ein.path("einheit")), str(ein.path("wort")), systeme);
                betragGleich(ist.menge(), soll.path("menge"), why + " · Summe");
                assertThat(ist.zustand()).as(why + " · Zustand").isEqualTo(str(soll.path("zustand")));
                assertThat(ist.abdeckungProzent()).as(why + " · Abdeckung")
                        .isEqualTo(ganz(soll.path("abdeckung_prozent")));
                assertThat(ist.mitWerten()).as(why + " · mit Werten").isEqualTo(soll.path("mit_werten").asInt());
                assertThat(ist.gesamt()).as(why + " · gesamt").isEqualTo(soll.path("gesamt").asInt());
                assertThat(ist.fehlend()).as(why + " · fehlend").isEqualTo(texte(soll.path("fehlend")));
                assertThat(ist.kennzeichen()).as(why + " · Kennzeichen")
                        .isEqualTo(texte(soll.path("kennzeichen")));
                assertThat(ist.anzeigeKennzeichen()).as(why + " · Anzeige-Kennzeichen")
                        .isEqualTo(texte(soll.path("anzeige_kennzeichen")));
            }
            case "live" -> {
                List<BilanzAbleitung.LiveTerm> terme = new ArrayList<>();
                for (JsonNode t : ein.path("terme")) {
                    terme.add(new BilanzAbleitung.LiveTerm(t.path("messstelle").asText(),
                            t.path("vorzeichen").asText(), t.path("faktor").asDouble(),
                            t.path("wert").isNull() ? null : t.path("wert").asDouble(),
                            t.path("einheit").asText(), str(t.path("grund"))));
                }
                BilanzAbleitung.LiveUrteil ist = BilanzAbleitung.live(str(ein.path("einheit")), terme);
                if (soll.path("wert").isNull()) {
                    assertThat(ist.wert()).as(why + " · Live-Wert").isNull();
                } else {
                    assertThat(ist.wert()).as(why + " · Live-Wert")
                            .isEqualTo(soll.path("wert").asDouble());
                }
                assertThat(ist.unvollstaendig()).as(why + " · unvollständig")
                        .isEqualTo(soll.path("unvollstaendig").asBoolean());
                List<String> fehlende = ist.fehlende().stream()
                        .map(f -> f.term() + ":" + f.grund())
                        .toList();
                List<String> sollFehlende = new ArrayList<>();
                soll.path("fehlende").forEach(f ->
                        sollFehlende.add(f.path("term").asText() + ":" + f.path("grund").asText()));
                assertThat(fehlende).as(why + " · fehlende").isEqualTo(sollFehlende);
            }
            case "gebaeude" -> {
                List<BilanzAbleitung.GebaeudeZeile> zeilen = new ArrayList<>();
                for (JsonNode z : ein.path("messstellen")) {
                    zeilen.add(new BilanzAbleitung.GebaeudeZeile(z.path("messstelle").asText(),
                            z.path("rolle").asText(), bd(z.path("menge")),
                            z.path("im_gebaeude").asBoolean()));
                }
                BilanzAbleitung.GebaeudeUrteil ist = BilanzAbleitung.gebaeude(
                        str(ein.path("gebaeude")), str(ein.path("anlage")), str(ein.path("einheit")),
                        zeilen, bd(ein.path("rest").path("menge")));
                betragGleich(ist.gemessenImGebaeude(), soll.path("gemessen_im_gebaeude"),
                        why + " · gemessen im Gebäude");
                betragGleich(ist.imSystemAusserhalb(), soll.path("im_system_ausserhalb"),
                        why + " · im System außerhalb");
                betragGleich(ist.restNichtVerortet(), soll.path("rest_nicht_verortet"),
                        why + " · Rest nicht verortet");
                betragGleich(ist.zuflussImGebaeude(), soll.path("zufluss_im_gebaeude"),
                        why + " · Zufluss im Gebäude");
                assertThat(ist.gebaeudeverbrauch()).as(why + " · Gebäudeverbrauch wird NIE behauptet")
                        .isNull();
                assertThat(ist.grund()).as(why + " · Grund").isEqualTo(str(soll.path("grund")));
            }
            case "versorgung" -> {
                List<BilanzAbleitung.Verortung> orte = new ArrayList<>();
                for (JsonNode m : ein.path("messstellen")) {
                    orte.add(new BilanzAbleitung.Verortung(m.path("messstelle").asText(),
                            m.path("anlage").asText(), m.path("stellung").asText(),
                            texte(m.path("ort_pfad"))));
                }
                BilanzAbleitung.VersorgungUrteil ist = BilanzAbleitung.versorgung(
                        str(ein.path("tag")), texte(ein.path("gebaeude")), orte);
                Map<String, List<String>> sollVersorgt = new LinkedHashMap<>();
                soll.path("versorgt").fields().forEachRemaining(e ->
                        sollVersorgt.put(e.getKey(), texte(e.getValue())));
                assertThat(ist.versorgt()).as(why + " · versorgt").isEqualTo(sollVersorgt);
                assertThat(ist.ausserhalbGebaeude()).as(why + " · außerhalb eines Gebäudes")
                        .isEqualTo(texte(soll.path("ausserhalb_gebaeude")));
                assertThat(ist.nichtMessbar()).as(why + " · nicht messbar")
                        .isEqualTo(texte(soll.path("nicht_messbar")));
            }
            case "herkunft" -> {
                BilanzwertHerkunft.Urteil ist = BilanzwertHerkunft.herkunft(herkunftEingang(ein));
                assertThat(ist.fehlt()).as(why + " · fehlende Pflichtangaben")
                        .isEqualTo(texte(soll.path("fehlt")));
                if (soll.path("satz").isNull()) {
                    assertThat(ist.satz()).as(why + " · kein halber Herkunfts-Satz").isNull();
                    return;
                }
                JsonNode gebaut = MAPPER.valueToTree(ist.satz());
                assertThat(gebaut).as(why + " · Herkunfts-Satz").isEqualTo(soll.path("satz"));
                assertThat(UemsSchemaLaeufer.verstoesse(gebaut, lies(HERKUNFT_SCHEMA)))
                        .as(why + " · der Satz hält bilanzwert-herkunft.schema.json")
                        .isEmpty();
            }
            case "rest_aus_stellung" -> {
                BilanzAbleitung.RestFassung ist = BilanzAbleitung.restAusStellung(
                        ein.path("hauptzaehler").asText(), LocalDate.parse(ein.path("tag").asText()),
                        stellungenDesReferenzunternehmens());
                assertThat(ist.hauptzaehler()).as(why + " · Hauptzähler").isEqualTo(ein.path("hauptzaehler").asText());
                assertThat(ist.anlage()).as(why + " · System").isEqualTo(str(soll.path("anlage")));
                assertThat(ist.terme().stream().map(t -> t.messstelle() + ":" + t.rolle() + ":" + t.anteil()).toList())
                        .as(why + " · Terme aus der Stellung")
                        .isEqualTo(terme(soll.path("terme")));
                assertThat(ist.ausserhalb()).as(why + " · außerhalb").isEqualTo(texte(soll.path("ausserhalb")));
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
            }
            default -> throw new IllegalStateException("unbekannte Regel " + p.path("regel").asText());
        }
    }

    private static List<String> terme(JsonNode n) {
        List<String> raus = new ArrayList<>();
        n.forEach(t -> raus.add(t.path("messstelle").asText() + ":" + (t.has("rolle") ? t.path("rolle").asText()
                : t.path("bilanz_rolle").asText()) + ":" + t.path("anteil").asText()));
        return raus;
    }

    /**
     * Die zeitgültigen Stellungen ALLER Messstellen des Referenzunternehmens — die Regel
     * {@code rest_aus_stellung} liest sie von dort und nicht aus einer Kopie in der Vektor-Datei.
     */
    static List<BilanzAbleitung.StellungZeile> stellungenDesReferenzunternehmens() throws Exception {
        List<BilanzAbleitung.StellungZeile> raus = new ArrayList<>();
        for (JsonNode m : lies(REFERENZ).path("messstellen")) {
            for (JsonNode st : m.path("elektrische_stellung")) {
                raus.add(new BilanzAbleitung.StellungZeile(m.path("kennzeichen").asText(),
                        st.path("anlage").asText(), st.path("stellung").asText(),
                        m.path("hauptgroesse").path("richtung").asText(), m.path("art").asText(),
                        m.path("medium").asText(), str(st.path("unterzaehler_von")),
                        tag(st.path("gueltig_ab")), tag(st.path("gueltig_bis"))));
            }
        }
        return raus;
    }

    private static LocalDate tag(JsonNode n) {
        return str(n) == null ? null : LocalDate.parse(n.asText());
    }

    private static List<BilanzAbleitung.Eingang> eingaenge(JsonNode n) {
        List<BilanzAbleitung.Eingang> raus = new ArrayList<>();
        for (JsonNode e : n) {
            raus.add(new BilanzAbleitung.Eingang(e.path("messstelle").asText(), e.path("rolle").asText(),
                    e.path("anteil").asText(), bd(e.path("menge")), e.path("zustand").asText(),
                    ganz(e.path("abdeckung_prozent")), e.path("version").asInt(),
                    texte(e.path("kennzeichen"))));
        }
        return raus;
    }

    private static List<BilanzAbleitung.Summand> summanden(JsonNode n) {
        List<BilanzAbleitung.Summand> raus = new ArrayList<>();
        for (JsonNode e : n) {
            raus.add(new BilanzAbleitung.Summand(e.path("messstelle").asText(), bd(e.path("menge")),
                    e.path("zustand").asText(), ganz(e.path("abdeckung_prozent")),
                    e.path("version").asInt(), texte(e.path("kennzeichen")),
                    e.path("vorzeichen").asText(), bd(e.path("faktor"))));
        }
        return raus;
    }

    static BilanzwertHerkunft.Eingang herkunftEingang(JsonNode ein) {
        List<BilanzwertHerkunft.Eingangswert> werte = new ArrayList<>();
        for (JsonNode w : ein.path("eingaenge")) {
            werte.add(new BilanzwertHerkunft.Eingangswert(w.path("messstelle").asText(),
                    str(w.path("bilanz_rolle")), str(w.path("anteil")), str(w.path("menge")),
                    w.path("zustand").asText(), ganz(w.path("abdeckung_prozent")),
                    w.path("version").asInt(), texte(w.path("kennzeichen"))));
        }
        JsonNode f = ein.path("formel_fassung");
        BilanzwertHerkunft.Fassung fassung = f.isMissingNode() || f.isNull()
                ? null
                : (f.isNumber() ? BilanzwertHerkunft.Fassung.nummer(f.asInt())
                        : BilanzwertHerkunft.Fassung.text(f.asText()));
        JsonNode v = ein.path("verteilung");
        BilanzwertHerkunft.Verteilungsbezug verteilung = v.isMissingNode() || v.isNull()
                ? null
                : new BilanzwertHerkunft.Verteilungsbezug(v.path("fassung").asInt(),
                        v.path("ziel").asText(), v.path("anteil_prozent").asText());
        JsonNode e = ein.path("ergebnis");
        BilanzwertHerkunft.Ergebnis ergebnis = e.isMissingNode() || e.isNull()
                ? null
                : new BilanzwertHerkunft.Ergebnis(str(e.path("menge")), str(e.path("zustand")),
                        ganz(e.path("abdeckung_prozent")), texte(e.path("kennzeichen")));
        return new BilanzwertHerkunft.Eingang(str(ein.path("art")), str(ein.path("messstelle")),
                str(ein.path("periode").path("art")), str(ein.path("periode").path("schluessel")),
                str(ein.path("formel_typ")), fassung, str(ein.path("periode_ende")),
                str(ein.path("berechnet_am")), ein.path("version").asInt(), str(ein.path("ausloeser")),
                verteilung, werte, ergebnis);
    }
}
