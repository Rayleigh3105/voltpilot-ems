package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BezugsEinheit.Einheitswert;
import com.voltpilot.api.uems.BezugsEinheit.Umrechnung;
import com.voltpilot.api.uems.BezugsPeriode.Periodendeutung;
import com.voltpilot.api.uems.BezugsPeriode.Zeitdeutung;
import com.voltpilot.api.uems.BezugsdatenRegeln.Bestand;
import com.voltpilot.api.uems.BezugsdatenRegeln.Fassung;
import com.voltpilot.api.uems.BezugsdatenRegeln.Fassungsverlauf;
import com.voltpilot.api.uems.BezugsdatenRegeln.Importergebnis;
import com.voltpilot.api.uems.BezugsdatenRegeln.Intervall;
import com.voltpilot.api.uems.BezugsdatenRegeln.Kanalwert;
import com.voltpilot.api.uems.BezugsdatenRegeln.Luecke;
import com.voltpilot.api.uems.BezugsdatenRegeln.Stammdatenstand;
import com.voltpilot.api.uems.BezugsdatenRegeln.Urteil;
import com.voltpilot.api.uems.BezugsdatenRegeln.Vorgang;
import com.voltpilot.api.uems.BezugsdatenRegeln.Zahl;
import com.voltpilot.api.uems.BezugsdatenRegeln.Zeilenurteil;
import com.voltpilot.api.uems.BezugsdatenRegeln.Zuordnung;
import com.voltpilot.api.uems.BezugsdatenRegeln.Zustandswechsel;
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
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings der BEZUGSDATEN (UEMS AP-09 IP-1):
 * {@link BezugsdatenRegeln} zieht aus JEDER Prüfung der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/bezugsdaten-vectors.json}) genau das Ergebnis, das dort steht — und
 * der TS-Zwilling ({@code frontend/portal/src/bezugsdaten.ts}, Test
 * {@code bezugsdaten.test.ts}) aus derselben Datei dasselbe.
 *
 * <p>Die Datei wird PER PFAD gelesen — wer sie verschiebt, bricht diesen Test absichtlich.
 *
 * <p>{@code zwillinge} in der Datei sagt je Regel, wer sie prüft. Dieser Test fährt JEDE Regel,
 * die dort „java“ nennt, und beweist zusätzlich, dass keine Regel der Datei unbeprüft bleibt.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class BezugsdatenVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("bezugsdaten-vectors.json");
    private static final Path SCHEMA = V2.resolve("bezugsdaten.schema.json");
    private static final Path PROSA = V2.resolve("bezugsdaten.md");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path TS_ZWILLING =
            Path.of("..", "..", "frontend", "portal", "src", "bezugsdaten.ts");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static JsonNode vektoren() throws Exception {
        return lies(VECTORS);
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
        assertThat(Files.exists(PROSA)).as("bezugsdaten.md").isTrue();
        assertThat(Files.exists(TS_ZWILLING)).as("TS-Zwilling").isTrue();
    }

    /** 14 Fälle — der vollständige Referenzfallkatalog AP-09 §7, mit eindeutigen Kennungen. */
    @Test
    void vierzehnFaelleMitEindeutigenNamen() throws Exception {
        List<String> namen = new ArrayList<>();
        List<String> kennungen = new ArrayList<>();
        vektoren().path("cases").forEach(c -> {
            namen.add(c.path("name").asText());
            kennungen.add(c.path("id").asText());
        });
        assertThat(namen).hasSize(14).doesNotHaveDuplicates();
        assertThat(kennungen).hasSize(14).doesNotHaveDuplicates().contains("B1", "B14");
    }

    /** Beide Plan-Abnahmen des Programms haben ihren Fall — und jeder Fall seinen Zweck. */
    @Test
    void diePlanAbnahmenHabenIhrenFall() throws Exception {
        List<String> abnahmen = new ArrayList<>();
        vektoren().path("cases").forEach(c -> {
            assertThat(c.path("why").asText()).as(c.path("id").asText() + " · why").isNotBlank();
            assertThat(c.path("titel").asText()).as(c.path("id").asText() + " · titel").isNotBlank();
            if (!c.path("abnahme").isNull()) {
                abnahmen.add(c.path("id").asText() + "=" + c.path("abnahme").asText());
            }
        });
        assertThat(abnahmen).containsExactlyInAnyOrder("B2=plan-1", "B6=plan-2");
    }

    /** Die Schwellen stehen in der Datei; die Klasse schreibt sie nicht für sich allein fest. */
    @Test
    void dieRegelnStehenInDerDatei() throws Exception {
        JsonNode r = vektoren().path("regeln");
        assertThat(r.path("begruendung_min_zeichen").asInt()).isEqualTo(BezugsdatenRegeln.BEGRUENDUNG_MIN_ZEICHEN);
        assertThat(r.path("begruendung_max_zeichen").asInt()).isEqualTo(BezugsdatenRegeln.BEGRUENDUNG_MAX_ZEICHEN);
        assertThat(r.path("zuordnung_hoechstens_monate").asInt())
                .isEqualTo(BezugsdatenRegeln.ZUORDNUNG_HOECHSTENS_MONATE);
        assertThat(r.path("anteil_nachkommastellen").asInt()).isEqualTo(BezugsdatenRegeln.ANTEIL_NACHKOMMASTELLEN);
        assertThat(r.path("abdeckung_nachkommastellen").asInt())
                .isEqualTo(BezugsdatenRegeln.ABDECKUNG_NACHKOMMASTELLEN);
        assertThat(r.path("vergleich_nachkommastellen").asInt())
                .isEqualTo(BezugsdatenRegeln.VERGLEICH_NACHKOMMASTELLEN);
        assertThat(r.path("zahlformat_vorgabe").asText()).isEqualTo(BezugsdatenRegeln.ZAHLFORMAT_VORGABE);
        assertThat(r.path("vier_augen_vorgabe").asBoolean()).isEqualTo(BezugsdatenRegeln.VIER_AUGEN_VORGABE);
        assertThat(vektoren().path("zeitzone").asText()).isEqualTo(BezugsdatenRegeln.ANZEIGE_ZEITZONE.getId());
    }

    /** Das Befund-Vokabular, die Hinweise und die Kundensätze sind EINE Liste, nicht drei. */
    @Test
    void jederBefundHatSeinenKundensatzUndUmgekehrt() throws Exception {
        JsonNode v = vektoren();
        List<String> befunde = texte(v.path("vokabulare").path("befunde"));
        List<String> saetze = new ArrayList<>();
        v.path("befund_saetze").fieldNames().forEachRemaining(saetze::add);
        assertThat(saetze).containsExactlyInAnyOrderElementsOf(befunde);
        v.path("befund_saetze").fields().forEachRemaining(e -> assertThat(e.getValue().asText())
                .as("Kundensatz " + e.getKey())
                .isNotBlank());
        assertThat(texte(v.path("hinweis_befunde")))
                .as("Hinweis-Befunde")
                .isSubsetOf(befunde)
                .containsExactlyElementsOf(BezugsdatenRegeln.HINWEIS_BEFUNDE);
    }

    /**
     * AP-09 IP-5: der GESCHLOSSENE Satz der Ablehnungen steht in der Datei — Code, Status und Kundensatz
     * — und {@link BezugsgroesseRegeln.Ablehnung} ist Zeile für Zeile derselbe. Die Konstanten des
     * Verwaltens (Kennzeichen, M1, Lesarten) ebenso; {@code einheit_unbekannt} spricht denselben Satz
     * wie der Befund.
     */
    @Test
    void dieAblehnungenDesVerwaltensSindDieDerDatei() throws Exception {
        JsonNode vw = vektoren().path("verwalten");
        List<String> datei = new ArrayList<>();
        vw.path("ablehnungen").forEach(a -> datei.add(a.path("code").asText() + " · " + a.path("status").asInt()
                + " · " + a.path("satz").asText()));
        List<String> klasse = new ArrayList<>();
        for (BezugsgroesseRegeln.Ablehnung a : BezugsgroesseRegeln.Ablehnung.values()) {
            klasse.add(a.code() + " · " + a.status() + " · " + a.satz());
        }
        assertThat(klasse).as("Ablehnungen in Reihenfolge").containsExactlyElementsOf(datei);
        assertThat(vw.path("ablehnungen").findValuesAsText("code")).doesNotHaveDuplicates();
        assertThat(BezugsgroesseRegeln.Ablehnung.EINHEIT_UNBEKANNT.satz())
                .isEqualTo(vektoren().path("befund_saetze").path("einheit_unbekannt").asText());
        assertThat(vw.path("kennzeichen").path("praefix").asText()).isEqualTo(BezugsgroesseRegeln.KENNZEICHEN_PRAEFIX);
        assertThat(vw.path("kennzeichen").path("stellen").asInt()).isEqualTo(BezugsgroesseRegeln.KENNZEICHEN_STELLEN);
        assertThat(vw.path("kennzeichen").path("muster").asText()).isEqualTo(BezugsgroesseRegeln.KENNZEICHEN_MUSTER);
        assertThat(texte(vw.path("fest_nach_erstem_wert"))).isEqualTo(BezugsgroesseRegeln.FEST_NACH_ERSTEM_WERT);
        assertThat(texte(vw.path("immer_aenderbar"))).isEqualTo(BezugsgroesseRegeln.IMMER_AENDERBAR);
        assertThat(texte(vw.path("lesarten"))).isEqualTo(BezugsgroesseRegeln.LESARTEN);
        assertThat(texte(vektoren().path("vokabulare").path("geltung_art")))
                .as("wählbar ist eine Teilmenge des Vokabulars").containsAll(BezugsgroesseRegeln.GELTUNG_WAEHLBAR);
    }

    /**
     * Die Zustandswörter sind DIESELBEN wie im schon gemergten Verbrauchsvertrag — zwei Wortlaute
     * für dieselbe Aussage wären genau die Drift, die diese Dateien verhindern sollen.
     */
    @Test
    void dieZustandswoerterSindDieDerVerbrauchsregel() {
        assertThat(BezugsdatenRegeln.VOLLSTAENDIG).isEqualTo(VerbrauchRegeln.VOLLSTAENDIG);
        assertThat(BezugsdatenRegeln.UNVOLLSTAENDIG).isEqualTo(VerbrauchRegeln.UNVOLLSTAENDIG);
        assertThat(BezugsdatenRegeln.KEINE_WERTE).isEqualTo(VerbrauchRegeln.KEINE_WERTE);
    }

    /** Jede bewusste Abweichung von der Vorlage steht IN der Datei, mit Grund. */
    @Test
    void jedeAbweichungVonDerVorlageIstBenannt() throws Exception {
        JsonNode abweichungen = vektoren().path("_abweichungen");
        assertThat(abweichungen.isArray()).isTrue();
        abweichungen.forEach(a -> {
            assertThat(a.path("fall").asText()).isNotBlank();
            assertThat(a.path("feld").asText()).isNotBlank();
            assertThat(a.path("grund").asText()).isNotBlank();
        });
    }

    /** Jede Erwartung der Vorlage, die heute kein Zwilling nachrechnet, ist benannt. */
    @Test
    void jedeUngepruefteErwartungIstBenannt() throws Exception {
        JsonNode offen = vektoren().path("_nicht_geprueft");
        assertThat(offen.isArray()).isTrue();
        assertThat(offen).isNotEmpty();
        offen.forEach(o -> {
            assertThat(o.path("fall").asText()).isNotBlank();
            assertThat(o.path("feld").asText()).isNotBlank();
            assertThat(o.path("warum").asText()).isNotBlank();
        });
    }

    /**
     * Jede Regel, die in einer Prüfung vorkommt, ist in {@code zwillinge} deklariert — und jede
     * Regel ohne TS-Zwilling nennt dort ihren Grund. So bleibt keine Regel stillschweigend
     * ungeprüft.
     */
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
                tests.add(DynamicTest.dynamicTest(name, () -> pruefe(v, fall, p)));
            }
        }
        assertThat(tests).as("Prüfungen über alle Fälle").hasSizeGreaterThanOrEqualTo(60);
        return tests;
    }

    private void pruefe(JsonNode wurzel, JsonNode fall, JsonNode p) {
        String why = fall.path("id").asText() + " (" + fall.path("why").asText() + ")";
        JsonNode ein = p.path("eingang");
        JsonNode soll = p.path("ergebnis");
        ZoneId zone = BezugsdatenRegeln.ANZEIGE_ZEITZONE;

        switch (p.path("regel").asText()) {
            case "zahl" -> {
                Zahl ist = BezugsdatenRegeln.zahl(
                        text(ein.path("text")), ein.path("format").asText(), ein.path("ganzzahlig").asBoolean());
                betrag(why + " · betrag", soll.path("betrag"), ist.betrag());
                wort(why + " · befund", soll.path("befund"), ist.befund());
            }
            case "einheit" -> {
                Einheitswert ist = BezugsdatenRegeln.einheit(
                        dezimal(ein.path("betrag")),
                        text(ein.path("geliefert")),
                        ein.path("ziel").asText(),
                        einheiten(wurzel),
                        umrechnungen(wurzel));
                betrag(why + " · betrag", soll.path("betrag"), ist.betrag());
                assertThat(ist.einheit()).as(why + " · einheit").isEqualTo(soll.path("einheit").asText());
                assertThat(ist.befunde()).as(why + " · befunde").isEqualTo(texte(soll.path("befunde")));
            }
            case "periode" -> {
                Periodendeutung ist = BezugsdatenRegeln.periode(
                        text(ein.path("text")),
                        text(ein.path("von_text")),
                        text(ein.path("bis_text")),
                        ein.path("deutung").asText(),
                        ein.path("periode_art").asText(),
                        zone,
                        ein.has("jetzt") ? BezugsdatenRegeln.zeit(ein.path("jetzt").asText()) : null);
                wort(why + " · schluessel", soll.path("schluessel"), ist.schluessel());
                zeitpunkt(why + " · von", soll.path("von"), ist.von(), zone);
                zeitpunkt(why + " · bis", soll.path("bis"), ist.bis(), zone);
                if (soll.path("stunden").isNull()) {
                    assertThat(ist.stunden()).as(why + " · stunden").isNull();
                } else {
                    assertThat(ist.stunden()).as(why + " · stunden").isEqualTo(soll.path("stunden").asLong());
                }
                wort(why + " · befund", soll.path("befund"), ist.befund());
            }
            case "zeit" -> {
                Zeitdeutung ist = BezugsdatenRegeln.zeitpunkt(
                        ein.path("text").asText(),
                        ZoneId.of(ein.path("zeitzone").asText()),
                        text(ein.path("offset_in_datei")));
                zeitpunkt(why + " · zeitpunkt", soll.path("zeitpunkt"), ist.zeitpunkt(), zone);
                wort(why + " · befund", soll.path("befund"), ist.befund());
                assertThat(ist.varianten()).as(why + " · varianten").isEqualTo(texte(soll.path("varianten")));
            }
            case "stunden" -> assertThat(BezugsdatenRegeln.stundenDesTages(
                            LocalDate.parse(ein.path("tag").asText()), zone))
                    .as(why + " · stunden des Tages")
                    .isEqualTo(soll.path("stunden").asLong());
            case "plausibilitaet" -> wort(
                    why + " · befund",
                    soll.path("befund"),
                    BezugsdatenRegeln.plausibilitaet(
                            dezimal(ein.path("betrag")),
                            ein.path("einheit").asText(),
                            ein.path("stunden_des_tages").isNull() ? null : ein.path("stunden_des_tages").asInt(),
                            ein.path("einheiten_gebunden").asInt(1)));
            case "zuordnung" -> {
                Zuordnung ist = BezugsdatenRegeln.zuordnung(
                        BezugsdatenRegeln.zeit(ein.path("von").asText()),
                        BezugsdatenRegeln.zeit(ein.path("bis").asText()),
                        ZoneId.of(ein.path("zeitzone").asText()));
                assertThat(ist.dauerMinuten()).as(why + " · dauer_minuten").isEqualTo(soll.path("dauer_minuten").asLong());
                assertThat(ist.dauerText()).as(why + " · dauer_text").isEqualTo(soll.path("dauer_text").asText());
                assertThat(ist.monateBeruehrt())
                        .as(why + " · monate_beruehrt")
                        .isEqualTo(soll.path("monate_beruehrt").asInt());
                assertThat(ist.anteile()).as(why + " · Anzahl Anteile").hasSize(soll.path("anteile").size());
                for (int i = 0; i < ist.anteile().size(); i++) {
                    JsonNode a = soll.path("anteile").get(i);
                    assertThat(ist.anteile().get(i).monat()).as(why + " · anteil " + i + " monat").isEqualTo(a.path("monat").asText());
                    assertThat(ist.anteile().get(i).minuten()).as(why + " · anteil " + i + " minuten").isEqualTo(a.path("minuten").asLong());
                    betrag(why + " · anteil " + i + " prozent", a.path("prozent"), ist.anteile().get(i).prozent());
                }
                wort(why + " · vorgabe", soll.path("vorgabe"), ist.vorgabe());
            }
            case "urteil" -> {
                Urteil ist = BezugsdatenRegeln.urteil(
                        text(ein.path("schluessel")),
                        dezimal(ein.path("betrag")),
                        bestand(ein.path("bestand")),
                        ein.path("datei_fingerabdruck_bekannt").asBoolean(),
                        text(ein.path("frueherer_import_status")),
                        text(ein.path("entscheidung")),
                        texte(ein.path("befunde_vorher")));
                assertThat(ist.urteil()).as(why + " · urteil").isEqualTo(soll.path("urteil").asText());
                assertThat(ist.befunde()).as(why + " · befunde").isEqualTo(texte(soll.path("befunde")));
            }
            case "import" -> {
                List<Zeilenurteil> zeilen = new ArrayList<>();
                ein.path("zeilen")
                        .forEach(z -> zeilen.add(new Zeilenurteil(z.path("urteil").asText(), texte(z.path("befunde")))));
                Importergebnis ist = BezugsdatenRegeln.importErgebnis(
                        ein.path("datenzeilen").asInt(),
                        ein.path("fingerabdruck_bekannt").asBoolean(),
                        text(ein.path("frueherer_import_status")),
                        zeilen);
                wort(why + " · status", soll.path("status"), ist.status());
                JsonNode z = soll.path("zaehler");
                assertThat(ist.zaehler())
                        .as(why + " · zaehler")
                        .isEqualTo(new BezugsdatenRegeln.Zaehler(
                                z.path("zeilen").asInt(),
                                z.path("neu").asInt(),
                                z.path("wiederholung").asInt(),
                                z.path("konflikt").asInt(),
                                z.path("berichtigung").asInt(),
                                z.path("uebersprungen").asInt(),
                                z.path("abgelehnt").asInt(),
                                z.path("mit_hinweis").asInt()));
                assertThat(ist.uebernahmeMoeglich())
                        .as(why + " · uebernahme_moeglich")
                        .isEqualTo(soll.path("uebernahme_moeglich").asBoolean());
                assertThat(ist.importDatensatz())
                        .as(why + " · import_datensatz")
                        .isEqualTo(soll.path("import_datensatz").asBoolean());
                wort(why + " · bestaetigung", soll.path("bestaetigung"), ist.bestaetigung());
                assertThat(ist.aenderungen()).as(why + " · aenderungen").isEqualTo(soll.path("aenderungen").asInt());
                assertThat(ist.befunde()).as(why + " · befunde").isEqualTo(texte(soll.path("befunde")));
            }
            case "menge" -> {
                List<VerbrauchRegeln.Rohwert> staende = new ArrayList<>();
                ein.path("staende")
                        .forEach(s -> staende.add(new VerbrauchRegeln.Rohwert(
                                BezugsdatenRegeln.zeit(s.path("t").asText()), dezimal(s.path("stand")))));
                VerbrauchRegeln.Ergebnis ist = BezugsdatenRegeln.mengeAblesezeitraum(
                        staende,
                        BezugsdatenRegeln.zeit(ein.path("von").asText()),
                        BezugsdatenRegeln.zeit(ein.path("bis").asText()),
                        Duration.ofSeconds(ein.path("kadenz_s").asLong()));
                betrag(why + " · menge (Verbrauchsregel AP-08)", soll.path("menge"), ist.menge());
                assertThat(ist.zustand()).as(why + " · zustand").isEqualTo(soll.path("zustand").asText());
            }
            case "fassung" -> {
                List<Vorgang> vorgaenge = new ArrayList<>();
                ein.path("vorgaenge")
                        .forEach(g -> vorgaenge.add(new Vorgang(
                                g.path("art").asText(),
                                dezimal(g.path("betrag")),
                                text(g.path("begruendung")),
                                g.path("urheber").asText(),
                                text(g.path("freigeber")),
                                BezugsdatenRegeln.zeit(g.path("zeitpunkt").asText()),
                                text(g.path("herkunft_art")),
                                text(g.path("import_kennung")))));
                Fassungsverlauf ist = BezugsdatenRegeln.fassungen(ein.path("vier_augen").asBoolean(), vorgaenge);
                assertThat(ist.fassungen()).as(why + " · Anzahl Fassungen").hasSize(soll.path("fassungen").size());
                for (int i = 0; i < ist.fassungen().size(); i++) {
                    JsonNode f = soll.path("fassungen").get(i);
                    Fassung istF = ist.fassungen().get(i);
                    String wo = why + " · Fassung " + f.path("fassung").asInt();
                    assertThat(istF.fassung()).as(wo + " · Nummer").isEqualTo(f.path("fassung").asInt());
                    betrag(wo + " · betrag", f.path("betrag"), istF.betrag());
                    assertThat(istF.status()).as(wo + " · status").isEqualTo(f.path("status").asText());
                    wort(wo + " · begruendung", f.path("begruendung"), istF.begruendung());
                    if (f.path("ersetzt_fassung").isNull()) {
                        assertThat(istF.ersetztFassung()).as(wo + " · ersetzt_fassung").isNull();
                    } else {
                        assertThat(istF.ersetztFassung())
                                .as(wo + " · ersetzt_fassung")
                                .isEqualTo(f.path("ersetzt_fassung").asInt());
                    }
                    wort(wo + " · herkunft_art", f.path("herkunft_art"), istF.herkunftArt());
                    wort(wo + " · import_kennung", f.path("import_kennung"), istF.importKennung());
                }
                assertThat(ist.ereignisse()).as(why + " · Anzahl Ereignisse").hasSize(soll.path("ereignisse").size());
                for (int i = 0; i < ist.ereignisse().size(); i++) {
                    JsonNode e = soll.path("ereignisse").get(i);
                    assertThat(ist.ereignisse().get(i))
                            .as(why + " · Ereignis " + i)
                            .isEqualTo(new BezugsdatenRegeln.Ereignis(
                                    e.path("art").asText(),
                                    e.path("fassung_alt").asInt(),
                                    e.path("fassung_neu").asInt(),
                                    text(e.path("import_kennung"))));
                }
                betrag(why + " · wirksamer_betrag", soll.path("wirksamer_betrag"), ist.wirksamerBetrag());
                wort(why + " · abgelehnt", soll.path("abgelehnt"), ist.abgelehnt());
            }
            case "stammdatum" -> {
                List<Intervall> intervalle = new ArrayList<>();
                ein.path("intervalle")
                        .forEach(i -> intervalle.add(new Intervall(
                                dezimal(i.path("betrag")),
                                LocalDate.parse(i.path("gueltig_ab").asText()),
                                i.path("gueltig_bis").isNull() || i.path("gueltig_bis").isMissingNode()
                                        ? null
                                        : LocalDate.parse(i.path("gueltig_bis").asText()),
                                i.path("eingetragen_am").isNull() || i.path("eingetragen_am").isMissingNode()
                                        ? null
                                        : LocalDate.parse(i.path("eingetragen_am").asText()))));
                Stammdatenstand ist = BezugsdatenRegeln.stammdatum(
                        intervalle, texte(ein.path("perioden")), ein.path("periode_art").asText());
                soll.path("je_periode").fields().forEachRemaining(e -> betrag(
                        why + " · Nenner " + e.getKey(), e.getValue(), ist.jePeriode().get(e.getKey())));
                soll.path("stichtage").fields().forEachRemaining(e -> assertThat(
                                ist.stichtage().get(e.getKey()))
                        .as(why + " · Stichtag " + e.getKey())
                        .isEqualTo(LocalDate.parse(e.getValue().asText())));
                assertThat(ist.rueckwirkendTage())
                        .as(why + " · rueckwirkend_tage")
                        .isEqualTo(soll.path("rueckwirkend_tage").asLong());
                assertThat(ist.ereignisse()).as(why + " · Ereignisse (Plan-Abnahme 2: keine)").isEmpty();
            }
            case "kanal" -> {
                List<Zustandswechsel> wechsel = new ArrayList<>();
                ein.path("wechsel")
                        .forEach(w -> wechsel.add(new Zustandswechsel(
                                BezugsdatenRegeln.zeit(w.path("t").asText()), w.path("zustand").asText())));
                List<Luecke> luecken = new ArrayList<>();
                ein.path("luecken")
                        .forEach(l -> luecken.add(new Luecke(
                                BezugsdatenRegeln.zeit(l.path("von").asText()),
                                BezugsdatenRegeln.zeit(l.path("bis").asText()),
                                l.path("quelle").asText())));
                Kanalwert ist = BezugsdatenRegeln.kanal(
                        BezugsdatenRegeln.zeit(ein.path("von").asText()),
                        BezugsdatenRegeln.zeit(ein.path("bis").asText()),
                        ein.path("zustand_gewaehlt").asText(),
                        text(ein.path("zustand_am_anfang")),
                        wechsel,
                        luecken,
                        zone);
                betrag(why + " · betrag", soll.path("betrag"), ist.betrag());
                assertThat(ist.einheit()).as(why + " · einheit").isEqualTo(soll.path("einheit").asText());
                assertThat(ist.minutenImZustand())
                        .as(why + " · minuten_im_zustand")
                        .isEqualTo(soll.path("minuten_im_zustand").asLong());
                assertThat(ist.zustand()).as(why + " · zustand").isEqualTo(soll.path("zustand").asText());
                betrag(why + " · abdeckung_prozent", soll.path("abdeckung_prozent"), ist.abdeckungProzent());
                betrag(why + " · gemessene_stunden", soll.path("gemessene_stunden"), ist.gemesseneStunden());
                assertThat(ist.kennzeichen()).as(why + " · kennzeichen").isEqualTo(texte(soll.path("kennzeichen")));
            }
            case "verwalten" -> {
                JsonNode vw = ein.path("verwaltung");
                BezugsgroesseRegeln.Urteil ist = verwalten(wurzel, vw);
                wort(why + " · ablehnung", soll.path("ablehnung"), ist.erlaubt() ? null : ist.ablehnung().code());
                if (soll.has("ablehnung_felder")) {
                    assertThat(ist.fakten().get("felder")).as(why + " · ablehnung_felder")
                            .isEqualTo(texte(soll.path("ablehnung_felder")));
                }
                if (soll.has("kennzeichen_vorschlag")) {
                    assertThat(BezugsgroesseRegeln.kennzeichenVorschlag(texte(vw.path("belegt"))))
                            .as(why + " · kennzeichen_vorschlag")
                            .isEqualTo(soll.path("kennzeichen_vorschlag").asText());
                }
            }
            case "csv" -> CsvVektoren.pruefe(why, ein.path("csv"), soll.path("csv"));
            default -> throw new IllegalStateException("unbekannte Regel " + p.path("regel").asText());
        }
    }

    /** AP-09 IP-5: ein Vorgang der Regel {@code verwalten} gegen {@link BezugsgroesseRegeln}. */
    private static BezugsgroesseRegeln.Urteil verwalten(JsonNode wurzel, JsonNode vw) {
        JsonNode vok = wurzel.path("vokabulare");
        BezugsgroesseRegeln.Vokabular v = new BezugsgroesseRegeln.Vokabular(texte(vok.path("wertart")),
                texte(vok.path("geltung_art")), texte(vok.path("periode_art")), einheiten(wurzel));
        return switch (vw.path("vorgang").asText()) {
            case "anlegen" -> BezugsgroesseRegeln.anlegen(entwurf(vw.path("entwurf")), v, texte(vw.path("waehlbar")),
                    texte(vw.path("belegt")));
            case "aendern" -> BezugsgroesseRegeln.aendern(entwurf(vw.path("bestand")), entwurf(vw.path("entwurf")),
                    vw.path("archiviert").asBoolean(), vw.path("werte").asLong(), v, texte(vw.path("waehlbar")),
                    texte(vw.path("belegt")));
            case "archivieren" -> BezugsgroesseRegeln.archivieren(vw.path("archiviert").asBoolean());
            case "loeschen" -> BezugsgroesseRegeln.loeschen(vw.path("werte").asLong());
            default -> throw new IllegalStateException("unbekannter Vorgang " + vw.path("vorgang").asText());
        };
    }

    private static BezugsgroesseRegeln.Entwurf entwurf(JsonNode e) {
        return new BezugsgroesseRegeln.Entwurf(text(e.path("kennzeichen")), text(e.path("name")),
                text(e.path("wertart")), text(e.path("einheit")), text(e.path("periode_art")),
                text(e.path("geltung_art")), text(e.path("geltung_id")));
    }

    // ------------------------------------------------------------ Die Vektor-Form lesen

    private static List<String> texte(JsonNode array) {
        List<String> aus = new ArrayList<>();
        array.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static String text(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    /** Jede Zahl über ihre Textform — so erbt die Rechnung keine Binärbruch-Fehler. */
    private static BigDecimal dezimal(JsonNode n) {
        if (n.isMissingNode() || n.isNull()) {
            return null;
        }
        return n.isTextual() ? new BigDecimal(n.asText()) : n.decimalValue();
    }

    private static Bestand bestand(JsonNode n) {
        if (n.isMissingNode() || n.isNull()) {
            return null;
        }
        return new Bestand(dezimal(n.path("betrag")), n.path("fassung").asInt(), text(n.path("import_kennung")));
    }

    private static Map<String, List<String>> einheiten(JsonNode wurzel) {
        Map<String, List<String>> aus = new LinkedHashMap<>();
        wurzel.path("einheiten").fields().forEachRemaining(e -> aus.put(e.getKey(), texte(e.getValue())));
        return aus;
    }

    private static List<Umrechnung> umrechnungen(JsonNode wurzel) {
        List<Umrechnung> aus = new ArrayList<>();
        wurzel.path("umrechnung")
                .forEach(u -> aus.add(new Umrechnung(
                        u.path("von").asText(),
                        u.path("nach").asText(),
                        u.has("zehnerpotenz") ? u.path("zehnerpotenz").asInt() : null,
                        u.has("teiler") ? u.path("teiler").asInt() : null,
                        u.has("nachkommastellen") ? u.path("nachkommastellen").asInt() : null)));
        return aus;
    }

    /** Beträge werden NUMERISCH verglichen: „312400“ und „312400.0“ sind derselbe Betrag. */
    private static void betrag(String was, JsonNode soll, BigDecimal ist) {
        if (soll.isMissingNode()) {
            return;
        }
        if (soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        assertThat(ist).as(was).usingComparator(BigDecimal::compareTo).isEqualTo(dezimal(soll));
    }

    private static void wort(String was, JsonNode soll, String ist) {
        if (soll.isMissingNode()) {
            assertThat(ist).as(was + " (die Datei nennt keins)").isNull();
            return;
        }
        if (soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isEqualTo(soll.asText());
    }

    private static void zeitpunkt(String was, JsonNode soll, Instant ist, ZoneId zone) {
        if (soll.isMissingNode()) {
            return;
        }
        if (soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        assertThat(BezugsdatenRegeln.iso(ist, zone)).as(was).isEqualTo(soll.asText());
    }
}
