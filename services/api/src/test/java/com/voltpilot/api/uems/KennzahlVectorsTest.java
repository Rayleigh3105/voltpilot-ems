package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.KennzahlRegeln.Antrag;
import com.voltpilot.api.uems.KennzahlRegeln.Eingang;
import com.voltpilot.api.uems.KennzahlRegeln.Ergebnis;
import com.voltpilot.api.uems.KennzahlRegeln.Periode;
import com.voltpilot.api.uems.KennzahlRegeln.Teil;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings der KENNZAHL (UEMS AP-11 IP-1/IP-3): {@link KennzahlRegeln} zieht aus JEDER Prüfung
 * der EINEN geteilten Vektor-Datei ({@code docs/contracts/v2/kennzahl-vectors.json}) genau das Ergebnis, das dort
 * steht — und der TS-Zwilling ({@code frontend/portal/src/uemsKennzahl.ts}, Test {@code uemsKennzahl.test.ts}) aus
 * derselben Datei dasselbe.
 *
 * <p>{@code zwillinge} in der Datei sagt je Regel, wer sie prüft. Dieser Test fährt JEDE Regel (alle nennen „java“)
 * und beweist, dass jede Regel ohne TS-Zwilling ihren Grund nennt.
 *
 * <p>Die Datei wird PER PFAD gelesen — wer sie verschiebt, bricht diesen Test absichtlich. Rein; kein Docker.
 */
class KennzahlVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("kennzahl-vectors.json");
    private static final Path SCHEMA = V2.resolve("kennzahl.schema.json");
    private static final Path HERKUNFT_SCHEMA = V2.resolve("kennzahlwert-herkunft.schema.json");
    private static final Path ERGEBNIS_ZUSTAND = V2.resolve("ergebnis-zustand-vectors.json");
    private static final Path EREIGNISSE = V2.resolve("events-vocabulary-vectors.json");
    private static final Path RECHTE_MATRIX = V2.resolve("rechte-matrix.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path TS_ZWILLING = Path.of("..", "..", "frontend", "portal", "src", "uemsKennzahl.ts");
    private static final Path QUELLE =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", "KennzahlRegeln.java");

    static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static JsonNode vektoren() throws Exception {
        return lies(VECTORS);
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

    static LocalDate tag(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : LocalDate.parse(n.asText());
    }

    static List<String> texte(JsonNode n) {
        List<String> raus = new ArrayList<>();
        if (n != null) {
            n.forEach(e -> raus.add(e.asText()));
        }
        return raus;
    }

    static Map<String, String> textMap(JsonNode n) {
        Map<String, String> raus = new LinkedHashMap<>();
        n.fields().forEachRemaining(e -> raus.put(e.getKey(), e.getValue().asText()));
        return raus;
    }

    /** Beträge auf den Vergleichs-Stellen des Vertrags: gerechnet wird ungerundet, verglichen auf 4 Stellen. */
    static void gleich(BigDecimal ist, JsonNode soll, String was) {
        if (soll == null || soll.isNull()) {
            assertThat(ist).as(was).isNull();
            return;
        }
        assertThat(ist).as(was).isNotNull();
        int stellen = KennzahlRegeln.VERGLEICH_NACHKOMMASTELLEN;
        assertThat(ist.setScale(stellen, RoundingMode.HALF_UP))
                .as(was + ": " + ist + " soll " + soll.asText() + " sein")
                .isEqualByComparingTo(new BigDecimal(soll.asText()).setScale(stellen, RoundingMode.HALF_UP));
    }

    // ---------------------------------------------------------------------------- Form

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(vektoren(), lies(SCHEMA))).as("Schema-Verstöße").isEmpty();
    }

    /**
     * Die Vektor-Datei verweist auf die EINE Beispielwelt in der Fassung, deren Kennzahlen sie liest — oder in einer
     * späteren: seit 1.4 (AP-12 IP-2) ergänzt die Datei nur, der Diff-Test der Referenz-Zwillinge hält die Kennzahlen gleich.
     */
    @Test
    void dieBeispielweltIstDasReferenzunternehmen13() throws Exception {
        assertThat(vektoren().path("referenzunternehmen").asText()).isEqualTo("./uems-referenzunternehmen.json");
        assertThat(BerichtVectorsTest.fassung(lies(REFERENZ).path("version").asText()))
                .isGreaterThanOrEqualTo(BerichtVectorsTest.fassung(vektoren().path("referenz_stand").asText()));
    }

    @Test
    void prosaUndTsZwillingLiegen() {
        assertThat(Files.exists(V2.resolve("kennzahl.md"))).as("kennzahl.md").isTrue();
        assertThat(Files.exists(V2.resolve("kennzahlwert-herkunft.md"))).as("kennzahlwert-herkunft.md").isTrue();
        assertThat(Files.exists(TS_ZWILLING)).as("TS-Zwilling").isTrue();
    }

    /** K1 … K23 in ihrer Reihenfolge (K23 = AP-17 W11), jeder mit Zweck, Titel und Handrechnung. */
    @Test
    void jederFallHatZweckTitelUndHandrechnung() throws Exception {
        List<String> ids = new ArrayList<>();
        Set<String> namen = new LinkedHashSet<>();
        vektoren().path("cases").forEach(c -> {
            ids.add(c.path("id").asText());
            assertThat(namen.add(c.path("name").asText())).as("Name eindeutig").isTrue();
            assertThat(c.path("why").asText()).as(c.path("id").asText() + " · why").isNotBlank();
            assertThat(c.path("schritte")).as(c.path("id").asText() + " · Handrechnung").isNotEmpty();
        });
        List<String> erwartet = new ArrayList<>();
        for (int i = 1; i <= 23; i++) {
            erwartet.add("K" + i);
        }
        assertThat(ids).isEqualTo(erwartet);
    }

    /** Die Abnahme des Captains hat ihre drei Fälle — und die Zahl 0,32 steht nur als die, die nicht entsteht. */
    @Test
    void diePlanAbnahmeHatIhreFaelle() throws Exception {
        JsonNode v = vektoren();
        Map<String, String> abnahmen = new LinkedHashMap<>();
        v.path("cases").forEach(c -> {
            if (!c.path("abnahme").isNull()) {
                abnahmen.put(c.path("id").asText(), c.path("abnahme").asText());
            }
        });
        assertThat(abnahmen).containsExactly(Map.entry("K1", "gebaeude"), Map.entry("K2", "gebaeude"),
                Map.entry("K3", "unternehmen"));
        assertThat(v.at("/plan_abnahmen/unternehmen").asText()).contains("0,20", "Summe ÷ Summe", "0,32");
    }

    // ---------------------------------------------------------------------------- Vokabulare

    @Test
    void dieVokabulareUndRegelnSindDieDerKlasse() throws Exception {
        JsonNode v = vektoren();
        JsonNode vok = v.path("vokabulare");
        assertThat(texte(vok.path("rechenform"))).isEqualTo(KennzahlRegeln.RECHENFORMEN);
        assertThat(texte(vok.path("rechenform_vorgesehen"))).isEqualTo(KennzahlRegeln.RECHENFORMEN_VORGESEHEN);
        assertThat(texte(vok.path("eingang_art"))).isEqualTo(KennzahlRegeln.EINGANG_ARTEN);
        assertThat(texte(vok.path("eingang_art_anfrage"))).isEqualTo(KennzahlRegeln.EINGANG_ARTEN_ANFRAGE);
        assertThat(texte(vok.path("eingang_rolle"))).isEqualTo(KennzahlRegeln.EINGANG_ROLLEN);
        assertThat(texte(vok.path("periode_art"))).isEqualTo(KennzahlRegeln.PERIODEN);
        assertThat(texte(vok.path("geltung_art"))).isEqualTo(KennzahlRegeln.GELTUNG_ARTEN);
        assertThat(texte(vok.path("zustand"))).containsExactlyInAnyOrderElementsOf(KennzahlRegeln.ZUSTAND_RANG);
        assertThat(texte(vok.path("richtung_unsicherheit"))).isEqualTo(KennzahlRegeln.RICHTUNGEN);
        assertThat(texte(vok.path("grund_ohne_zahl"))).isEqualTo(KennzahlRegeln.GRUENDE_OHNE_ZAHL);
        assertThat(texte(vok.path("fehler"))).isEqualTo(KennzahlRegeln.FEHLER);
        assertThat(texte(vok.path("sichtbarkeit"))).isEqualTo(KennzahlRegeln.SICHTBARKEIT);
        assertThat(texte(vok.path("protokoll"))).isEqualTo(KennzahlRegeln.PROTOKOLL);
        assertThat(texte(vok.path("ereignisse_reserviert"))).isEqualTo(KennzahlRegeln.EREIGNISSE_RESERVIERT);
        assertThat(texte(vok.path("rechte"))).isEqualTo(KennzahlRegeln.RECHTE);
        assertThat(texte(v.path("zustand_rang"))).isEqualTo(KennzahlRegeln.ZUSTAND_RANG);

        JsonNode p = v.path("perioden");
        assertThat(texte(p.path("ordnung"))).isEqualTo(KennzahlRegeln.PERIODEN);
        Map<String, List<String>> aufgehen = new LinkedHashMap<>();
        p.path("aufgehen").fields().forEachRemaining(e -> aufgehen.put(e.getKey(), texte(e.getValue())));
        assertThat(aufgehen).isEqualTo(KennzahlRegeln.AUFGEHEN);
        Map<String, KennzahlRegeln.PeriodenWoerter> woerter = new LinkedHashMap<>();
        p.path("woerter").fields().forEachRemaining(e -> {
            JsonNode w = e.getValue();
            woerter.put(e.getKey(), new KennzahlRegeln.PeriodenWoerter(w.path("werte").asText(), w.path("werte_dativ").asText(),
                    w.path("wert").asText(), w.path("je").asText(), w.path("teile").asText(), w.path("ende").asText()));
        });
        assertThat(woerter).isEqualTo(KennzahlRegeln.PERIODEN_WOERTER);
        assertThat(texte(p.path("monatsnamen"))).isEqualTo(KennzahlRegeln.MONATSNAMEN);

        assertThat(textMap(v.at("/rechte/geltung"))).isEqualTo(KennzahlRegeln.RECHTE_GELTUNG);
        assertThat(textMap(v.at("/rechte/kennung"))).isEqualTo(KennzahlRegeln.KENNUNG);
        assertThat(v.at("/rechte/ansehen").asText()).isEqualTo(KennzahlRegeln.ANSEHEN);

        JsonNode r = v.path("regeln");
        assertThat(r.path("wert_nachkommastellen").asInt()).isEqualTo(KennzahlRegeln.WERT_NACHKOMMASTELLEN);
        assertThat(r.path("vergleich_nachkommastellen").asInt()).isEqualTo(KennzahlRegeln.VERGLEICH_NACHKOMMASTELLEN);
        assertThat(r.path("anzeige_nachkommastellen").asInt()).isEqualTo(KennzahlRegeln.ANZEIGE_NACHKOMMASTELLEN);
        assertThat(new BigDecimal(r.path("anteil_faktor").asText())).isEqualByComparingTo(KennzahlRegeln.ANTEIL_FAKTOR);
        assertThat(r.path("je").asText()).isEqualTo(KennzahlRegeln.JE);
        assertThat(r.path("einheit_trenner").asText()).isEqualTo(KennzahlRegeln.EINHEIT_TRENNER);
        assertThat(textMap(r.path("einzahl"))).isEqualTo(KennzahlRegeln.EINZAHL);
        assertThat(r.path("ohne_zahl").asText()).isEqualTo(KennzahlRegeln.OHNE_ZAHL);
        assertThat(r.path("zahlform").asText()).startsWith("ergebnis-zustand-vectors.json");

        assertThat(textMap(v.path("saetze"))).isEqualTo(KennzahlRegeln.SAETZE);
        assertThat(texte(v.path("verbotene_woerter"))).isEqualTo(KennzahlRegeln.VERBOTENE_WOERTER);
    }

    /** Die Kennungen sind die der Rechte-Matrix — AP-11 legt keine an (E10). */
    @Test
    void dieRechteKennungenStehenInDerMatrix() throws Exception {
        Set<String> matrix = new LinkedHashSet<>();
        lies(RECHTE_MATRIX).path("aktionen").forEach(a -> matrix.add(a.path("kennung").asText()));
        assertThat(matrix).containsAll(KennzahlRegeln.RECHTE);
    }

    /** Wortlaut, Rang und Erbregeln der Kennzeichen stehen im Ergebnis-Zustand (1.9) — und nur dort. */
    @Test
    void dieKennzeichenStehenImErgebnisZustand() throws Exception {
        JsonNode block = lies(ERGEBNIS_ZUSTAND).path("kennzahl_kennzeichen");
        assertThat(textMap(block.path("platzhalter"))).isEqualTo(KennzahlRegeln.PLATZHALTER);
        List<KennzahlRegeln.Kennzeichen> saetze = new ArrayList<>();
        for (JsonNode s : block.path("saetze")) {
            saetze.add(new KennzahlRegeln.Kennzeichen(s.path("schluessel").asText(), s.path("muster").asText(),
                    textMap(s.path("platzhalter")), s.path("rang").asInt(), s.path("herkunft").asText(),
                    s.path("stelle").asText(), s.path("ohne_zahl").asBoolean()));
            KennzahlRegeln.Kennzeichen erkannt = KennzahlRegeln.erkenne(s.path("beispiel").asText());
            assertThat(erkannt).as("Beispiel " + s.path("beispiel").asText()).isNotNull();
            assertThat(erkannt.schluessel()).as("Beispiel " + s.path("beispiel").asText())
                    .isEqualTo(s.path("schluessel").asText());
        }
        assertThat(saetze).isEqualTo(KennzahlRegeln.KENNZEICHEN);
        List<KennzahlRegeln.Erbregel> erbend = new ArrayList<>();
        for (JsonNode e : block.path("erbend")) {
            erbend.add(new KennzahlRegeln.Erbregel(e.path("muster").asText(), e.path("als").asText(), texte(e.path("von"))));
            assertThat(e.path("warum").asText()).as("Grund je Erbregel").isNotBlank();
        }
        assertThat(erbend).isEqualTo(KennzahlRegeln.ERBEND);
    }

    /**
     * Die Reservierungen im Ereignis-Vokabular sind die der Kennzahl. Eine Reservierung darf schon eingelöst sein (AP-09
     * IP-7 legt `correction` mit Bezug `bezugsgroesse` an) — dann mit denselben Urhebern; sonst kennt das Vokabular sie nicht.
     */
    @Test
    void dieReservierungenWidersprechenDerAnlageNicht() throws Exception {
        JsonNode ev = lies(EREIGNISSE);
        List<String> reserviert = new ArrayList<>();
        Map<String, JsonNode> arten = new LinkedHashMap<>();
        ev.at("/vokabular/arten").forEach(a -> arten.put(a.path("art").asText(), a));
        for (JsonNode r : ev.path("reserviert")) {
            String art = r.path("art").asText();
            String bezug = r.path("bezug").asText();
            if (BerichtRegeln.EREIGNISSE_RESERVIERT.contains(art + "/" + bezug)) {
                continue; // die Reservierungen der Berichte prüft BerichtVectorsTest (AP-12 IP-1)
            }
            if (List.of("einstufung_gesetzt/energieeinsatz", "messbedarf_erfasst/messbedarf",
                    "messbedarf_eingeloest/messbedarf").contains(art + "/" + bezug)) {
                continue; // AP-16 IP-3: EreignisVokabularVectorsTest prüft diese Reservierungen.
            }
            if (List.of("bezugsbasis_freigegeben/bezugsbasis", "bezugsbasis_beendet/bezugsbasis",
                    "bezugsbasis_anstoss/bezugsbasis").contains(art + "/" + bezug)) {
                continue; // AP-17 IP-6: EreignisVokabularVectorsTest prüft diese Reservierungen.
            }
            reserviert.add(art + "/" + bezug);
            JsonNode angelegt = arten.get(art);
            if (angelegt == null) {
                continue;
            }
            Set<String> bezuege = new LinkedHashSet<>(texte(angelegt.path("bezug_pflicht")));
            bezuege.addAll(texte(angelegt.path("bezug_erlaubt")));
            if (bezuege.contains(bezug)) {
                assertThat(texte(angelegt.path("urheber"))).as(art + " eingelöst: Urheber").containsAll(texte(r.path("urheber")));
            }
        }
        assertThat(reserviert).isEqualTo(KennzahlRegeln.EREIGNISSE_RESERVIERT);
    }

    /** Jede Regel der Fälle hat ihre Zwillinge; eine Regel ohne TS-Zwilling nennt ihren Grund. */
    @Test
    void jedeRegelHatIhrenZwilling() throws Exception {
        JsonNode v = vektoren();
        Set<String> regeln = new LinkedHashSet<>();
        v.path("cases").forEach(c -> c.path("pruefungen").forEach(p -> regeln.add(p.path("regel").asText())));
        Set<String> zwillinge = new LinkedHashSet<>();
        v.path("zwillinge").fieldNames().forEachRemaining(zwillinge::add);
        assertThat(zwillinge).containsExactlyInAnyOrderElementsOf(regeln);
        Set<String> ohneTs = new LinkedHashSet<>();
        v.path("zwillinge").fields().forEachRemaining(e -> {
            assertThat(texte(e.getValue())).as(e.getKey() + " prüft Java").contains("java");
            if (!texte(e.getValue()).contains("ts")) {
                ohneTs.add(e.getKey());
            }
        });
        Set<String> gruende = new LinkedHashSet<>();
        v.path("zwillinge_grund").fieldNames().forEachRemaining(gruende::add);
        assertThat(gruende).isEqualTo(ohneTs);
    }

    // ---------------------------------------------------------------------------- Fälle

    @TestFactory
    List<DynamicTest> jedePruefungDerVektorDatei() throws Exception {
        JsonNode v = vektoren();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                String regel = p.path("regel").asText();
                tests.add(DynamicTest.dynamicTest(fall.path("id").asText() + " · " + regel + " · " + p.path("name").asText(),
                        () -> pruefe(regel, p.path("eingang"), p.path("ergebnis"))));
            }
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(100);
        return tests;
    }

    private static void pruefe(String regel, JsonNode e, JsonNode erw) throws Exception {
        switch (regel) {
            case "wert" -> pruefeWert(e, erw);
            case "einheit" -> {
                KennzahlRegeln.EinheitUrteil u = KennzahlRegeln.einheit(e.path("rechenform").asText(),
                        seite(e.path("zaehler")), seite(e.path("nenner")), paare(e.path("paare")));
                assertThat(baum("einheit", u.einheit(), "anzeige", u.anzeige(), "fehler", u.fehler(), "kundensatz", u.kundensatz()))
                        .isEqualTo(erw);
            }
            case "periode" -> {
                List<KennzahlRegeln.PeriodenEingang> eingaenge = new ArrayList<>();
                e.path("eingaenge").forEach(x -> eingaenge.add(new KennzahlRegeln.PeriodenEingang(str(x.path("art")),
                        str(x.path("objekt")), str(x.path("name")), str(x.path("wertart")), str(x.path("periode_art")))));
                KennzahlRegeln.PeriodenUrteil u = KennzahlRegeln.periode(str(e.path("gewuenscht")), eingaenge);
                assertThat(baum("grundperiode", u.grundperiode(), "perioden", u.perioden(), "fehler", u.fehler(),
                        "kundensatz", u.kundensatz())).isEqualTo(erw);
            }
            case "bestehen" -> {
                KennzahlRegeln.BestehenUrteil u = KennzahlRegeln.bestehen(periode(e.path("periode")), tag(e.path("seit")));
                assertThat(baum("grund", u.grund(), "kennzeichen", u.kennzeichen())).isEqualTo(erw);
            }
            case "laufend" -> {
                KennzahlRegeln.LaufendUrteil u = KennzahlRegeln.laufend(periode(e.path("periode")),
                        OffsetDateTime.parse(e.path("jetzt").asText()), ZoneId.of(e.path("zeitzone").asText()),
                        str(e.at("/nenner/art")), str(e.at("/nenner/wertart")));
                assertThat(baum("laeuft", u.laeuft(), "grund", u.grund(), "fassung", u.fassung(), "kundensatz", u.kundensatz()))
                        .isEqualTo(erw);
            }
            case "stichtag" -> {
                List<BezugsdatenRegeln.Intervall> intervalle = new ArrayList<>();
                e.path("intervalle").forEach(i -> intervalle.add(new BezugsdatenRegeln.Intervall(bd(i.path("betrag")),
                        tag(i.path("gueltig_ab")), tag(i.path("gueltig_bis")), null)));
                KennzahlRegeln.StichtagUrteil u = KennzahlRegeln.stichtag(periode(e.path("periode")), intervalle);
                assertThat(u.stichtag()).isEqualTo(tag(erw.path("stichtag")));
                gleich(u.wert(), erw.path("wert"), "wert am Stichtag");
            }
            case "zyklus" -> {
                Map<String, List<String>> bestehende = new LinkedHashMap<>();
                e.path("bestehende").fields().forEachRemaining(x -> bestehende.put(x.getKey(), texte(x.getValue())));
                KennzahlRegeln.KreisUrteil u = KennzahlRegeln.zyklus(e.path("kennzeichen").asText(),
                        texte(e.path("verweise")), bestehende);
                assertThat(baum("zyklus", u.zyklus(), "kette", u.kette(), "fehler", u.fehler(), "kundensatz", u.kundensatz()))
                        .isEqualTo(erw);
            }
            case "fassung" -> {
                KennzahlRegeln.FassungsUrteil u = KennzahlRegeln.fassung(fassungen(e.path("wirksam")), tag(e.path("ab")),
                        OffsetDateTime.parse(e.path("eingetragen_um").asText()), ZoneId.of(e.path("zeitzone").asText()));
                assertThat(baum("fehler", u.fehler(), "kundensatz", u.kundensatz(), "nummer", u.nummer(), "beenden",
                        u.beenden(), "beenden_am", u.beendenAm() == null ? null : u.beendenAm().toString(), "rueckwirkend",
                        u.rueckwirkend(), "tage", (int) u.tage(), "abzeichen", u.abzeichen())).isEqualTo(erw);
            }
            case "fassung_am" -> {
                KennzahlRegeln.FassungAmUrteil u = KennzahlRegeln.fassungAm(fassungen(e.path("wirksam")), periode(e.path("periode")));
                assertThat(baum("nummer", u.nummer(), "kennzeichen", u.kennzeichen())).isEqualTo(erw);
            }
            case "geltung" -> {
                KennzahlRegeln.GeltungUrteil u = KennzahlRegeln.geltung(e.path("geltung_art").asText(), str(e.path("standort")));
                assertThat(baum("rechte_geltung", u.rechteGeltung(), "standort", u.standort(), "kennung", u.kennung(),
                        "fehler", u.fehler(), "kundensatz", u.kundensatz())).isEqualTo(erw);
            }
            case "eingang_geltung" -> {
                JsonNode k = e.path("kennzahl");
                JsonNode x = e.path("eingang");
                KennzahlRegeln.GeltungHinweis u = KennzahlRegeln.eingangGeltung(
                        new KennzahlRegeln.KennzahlOrt(str(k.path("rechte_geltung")), str(k.path("standort")),
                                str(k.path("standort_name")), str(k.path("geltung_name"))),
                        new KennzahlRegeln.EingangOrt(str(x.path("objekt")), str(x.path("standort")), str(x.path("standort_name")),
                                x.path("im_geltungsobjekt").asBoolean(), tag(x.path("seit"))));
                assertThat(baum("fehler", u.fehler(), "kundensatz", u.kundensatz(), "kennzeichen", u.kennzeichen())).isEqualTo(erw);
            }
            case "rechte" -> pruefeRechte(e, erw);
            case "vorlage" -> {
                JsonNode vl = e.path("vorlage");
                KennzahlRegeln.Belegung u = KennzahlRegeln.vorlage(vl.path("rechenform").asText(),
                        vl.path("name_vorschlag").asText(), vl.path("zweck_vorschlag").asText(), e.path("geltung_name").asText());
                assertThat(baum("rechenform", u.rechenform(), "name", u.name(), "zweck", u.zweck())).isEqualTo(erw);
            }
            case "kopie" -> {
                JsonNode q = e.path("quelle");
                KennzahlRegeln.Kopie u = KennzahlRegeln.kopie(new KennzahlRegeln.Quelle(q.path("kennzeichen").asText(),
                        q.path("name").asText(), q.path("zweck").asText(), q.path("rechenform").asText(),
                        q.path("geltung_name").asText()), e.path("neue_geltung_name").asText());
                assertThat(baum("rechenform", u.rechenform(), "name", u.name(), "zweck", u.zweck(), "fassung_nummer",
                        u.fassungNummer(), "gueltig_ab", u.gueltigAb(), "eingaenge", u.eingaenge(), "kennzeichen", u.kennzeichen()))
                        .isEqualTo(erw);
            }
            case "herkunft" -> {
                KennzahlRegeln.Huelle h = KennzahlRegeln.herkunft(herkunftAntrag(e));
                JsonNode ist = baum("satz", h.satz(), "fehlt", h.fehlt());
                assertThat(ist).isEqualTo(erw);
                assertThat(UemsSchemaLaeufer.verstoesse(ist, lies(HERKUNFT_SCHEMA))).as("Herkunfts-Schema").isEmpty();
            }
            case "referenz" -> pruefeReferenz(e, erw);
            case "kennzeichen" -> assertThat(KennzahlRegeln.kennzeichenPruefen(texte(e.path("liste"))))
                    .isEqualTo(texte(erw.path("verstoesse")));
            case "rechenform" -> {
                KennzahlRegeln.RechenformUrteil u = KennzahlRegeln.rechenform(e.path("rechenform").asText());
                assertThat(baum("fehler", u.fehler(), "kundensatz", u.kundensatz())).isEqualTo(erw);
            }
            case "satz" -> assertThat(KennzahlRegeln.satz(e.path("code").asText(), textMap(e.path("werte"))))
                    .isEqualTo(erw.path("kundensatz").asText());
            default -> throw new AssertionError("Regel ohne Java-Prüfung: " + regel);
        }
    }

    private static JsonNode baum(Object... paare) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], paare[i + 1]);
        }
        return MAPPER.valueToTree(m);
    }

    private static Periode periode(JsonNode n) {
        return new Periode(n.path("art").asText(), n.path("schluessel").asText());
    }

    private static List<MessstelleFormelRegeln.Fassung> fassungen(JsonNode n) {
        List<MessstelleFormelRegeln.Fassung> raus = new ArrayList<>();
        n.forEach(f -> raus.add(new MessstelleFormelRegeln.Fassung(f.path("nummer").asInt(), tag(f.path("ab")), tag(f.path("bis")))));
        return raus;
    }

    private static KennzahlRegeln.EinheitSeite seite(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : new KennzahlRegeln.EinheitSeite(str(n.path("art")),
                str(n.path("objekt")), str(n.path("einheit")), str(n.path("groesse")), str(n.path("wertart")));
    }

    private static List<KennzahlRegeln.Paar> paare(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        List<KennzahlRegeln.Paar> raus = new ArrayList<>();
        n.forEach(p -> raus.add(new KennzahlRegeln.Paar(p.path("objekt").asText(), p.path("rechenform").asText(),
                p.path("einheit").asText())));
        return raus;
    }

    static Eingang eingang(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        return new Eingang(str(n.path("art")), str(n.path("objekt")), str(n.path("name")), str(n.path("geltung")),
                str(n.path("wertart")), str(n.path("status")), bd(n.path("wert")), str(n.path("einheit")),
                str(n.path("zustand")), bd(n.path("abdeckung_prozent")), n.path("endgueltig").asBoolean(true),
                str(n.path("ursache")), texte(n.path("kennzeichen")));
    }

    static Antrag antrag(JsonNode e) {
        List<Teil> teile = null;
        if (e.path("teile").isArray()) {
            teile = new ArrayList<>();
            for (JsonNode t : e.path("teile")) {
                teile.add(new Teil(str(t.path("objekt")), str(t.path("geltung")), bd(t.path("zaehler")), bd(t.path("nenner")),
                        str(t.path("zustand")), str(t.path("richtung")), bd(t.path("abdeckung_prozent")),
                        t.path("endgueltig").asBoolean(true), texte(t.path("kennzeichen"))));
            }
        }
        JsonNode b = e.path("bisher");
        JsonNode an = e.path("anlass");
        return new Antrag(str(e.path("rechenform")), periode(e.path("periode")), str(e.path("einheit")),
                eingang(e.path("zaehler")), eingang(e.path("nenner")), e.path("komplement").asBoolean(false),
                e.path("mengen_nicht_negativ").asBoolean(false), teile, str(e.path("teile_art")), str(e.path("teile_wort")),
                str(e.path("teile_periode_art")), str(e.path("teile_rechenform")), tag(e.path("bestehen_ab")),
                texte(e.path("hinweise")), b.isObject() ? new KennzahlRegeln.Bisher(b.path("version").asInt(),
                        b.path("endgueltig").asBoolean()) : null,
                an.isObject() ? new KennzahlRegeln.Anlass(str(an.path("art")), ganz(an.path("fassung"))) : null);
    }

    private static void pruefeWert(JsonNode e, JsonNode erw) {
        Ergebnis r = KennzahlRegeln.wert(antrag(e));
        gleich(r.wert(), erw.path("wert"), "wert");
        gleich(r.zaehler(), erw.path("zaehler"), "zaehler");
        gleich(r.nenner(), erw.path("nenner"), "nenner");
        gleich(r.abdeckungProzent(), erw.path("abdeckung_prozent"), "abdeckung_prozent");
        assertThat(r.zustand()).as("zustand").isEqualTo(str(erw.path("zustand")));
        assertThat(r.richtung()).as("richtung").isEqualTo(str(erw.path("richtung")));
        assertThat(r.grund()).as("grund").isEqualTo(str(erw.path("grund")));
        assertThat(r.fassung()).as("fassung").isEqualTo(str(erw.path("fassung")));
        assertThat(r.version()).as("version").isEqualTo(ganz(erw.path("version")));
        assertThat(r.kennzeichen()).as("kennzeichen").isEqualTo(texte(erw.path("kennzeichen")));
        assertThat(r.anzeige()).as("anzeige").isEqualTo(str(erw.path("anzeige")));
        assertThat(r.kundensatz()).as("kundensatz").isEqualTo(str(erw.path("kundensatz")));
        assertThat(KennzahlRegeln.kennzeichenPruefen(r.kennzeichen())).as("die Liste ist eine Kennzahl-Liste").isEmpty();
        if (erw.has("nie")) {
            assertThat(r.wert().setScale(KennzahlRegeln.VERGLEICH_NACHKOMMASTELLEN, RoundingMode.HALF_UP))
                    .as("die Zahl, die nicht entstehen darf").isNotEqualByComparingTo(new BigDecimal(erw.path("nie").asText()));
        }
    }

    private static KennzahlRegeln.HerkunftAntrag herkunftAntrag(JsonNode e) {
        List<KennzahlRegeln.HerkunftEingang> eingaenge = new ArrayList<>();
        e.path("eingaenge").forEach(x -> eingaenge.add(new KennzahlRegeln.HerkunftEingang(str(x.path("rolle")),
                str(x.path("art")), str(x.path("objekt")), bd(x.path("wert")), bd(x.path("zaehler")), bd(x.path("nenner")),
                str(x.path("einheit")), str(x.path("zustand")), bd(x.path("abdeckung_prozent")), ganz(x.path("version")),
                ganz(x.path("fassung")), texte(x.path("kennzeichen")))));
        JsonNode r = e.path("ergebnis");
        return new KennzahlRegeln.HerkunftAntrag(str(e.path("kennzahl")), str(e.path("rechenform")),
                ganz(e.path("definition_fassung")), periode(e.path("periode")), str(e.path("berechnet_am")),
                ganz(e.path("version")), str(e.path("anlass")), eingaenge,
                new KennzahlRegeln.HerkunftErgebnis(bd(r.path("wert")), str(r.path("einheit")), str(r.path("zustand")),
                        str(r.path("richtung")), str(r.path("grund")), bd(r.path("abdeckung_prozent")),
                        texte(r.path("kennzeichen"))));
    }

    /**
     * Die Fallquelle ist das Referenzunternehmen 1.3: die Kennzahl steht dort mit denselben Zahlen, UND die Regel rechnet
     * aus diesen Zahlen denselben Wert.
     */
    private static void pruefeReferenz(JsonNode e, JsonNode erw) throws Exception {
        Map<String, JsonNode> kennzahlen = new LinkedHashMap<>();
        lies(REFERENZ).path("kennzahlen").forEach(k -> kennzahlen.put(k.path("kennzeichen").asText(), k));
        JsonNode k = kennzahlen.get(e.path("kennzahl").asText());
        assertThat(k).as("Kennzahl im Referenzunternehmen").isNotNull();
        assertThat(k.path("rechenform").asText()).isEqualTo(erw.path("rechenform").asText());
        assertThat(k.path("einheit").asText()).isEqualTo(erw.path("einheit").asText());
        gleich(k.path("oktober_2026_zaehler").decimalValue(), erw.path("zaehler"), "Zähler");
        gleich(k.path("oktober_2026_nenner").decimalValue(), erw.path("nenner"), "Nenner");
        gleich(k.path("oktober_2026_wert").decimalValue(), erw.path("wert"), "Wert");

        String form = k.path("rechenform").asText();
        Periode oktober = new Periode("monat", "2026-10");
        Antrag antrag;
        if (KennzahlRegeln.ZUSAMMENFASSUNG.equals(form)) {
            List<Teil> teile = new ArrayList<>();
            for (JsonNode p : k.path("paare")) {
                JsonNode paar = kennzahlen.get(p.asText());
                teile.add(new Teil(p.asText(), paar.path("geltung").asText(), paar.path("oktober_2026_zaehler").decimalValue(),
                        paar.path("oktober_2026_nenner").decimalValue(), ErgebnisZustand.VOLLSTAENDIG, null, null, true, List.of()));
            }
            antrag = new Antrag(form, oktober, k.path("einheit").asText(), null, null, false, false, teile, "ebene",
                    "Gebäuden", null, KennzahlRegeln.QUOTIENT, null, List.of(), null, null);
        } else {
            Eingang zaehler = new Eingang(KennzahlRegeln.MESSSTELLE, k.path("zaehler").asText(), null, null, null, null,
                    k.path("oktober_2026_zaehler").decimalValue(), "kWh", ErgebnisZustand.VOLLSTAENDIG, null, true, null, List.of());
            boolean stammdatum = !k.path("nenner_ort").isNull();
            Eingang nenner = new Eingang(KennzahlRegeln.BEZUGSGROESSE, k.path("nenner").asText(), null, null,
                    stammdatum ? KennzahlRegeln.STAMMDATUM : KennzahlRegeln.PERIODENWERT, stammdatum ? null : KennzahlRegeln.WIRKSAM,
                    k.path("oktober_2026_nenner").decimalValue(), "Stück", null, null, true, null, List.of());
            antrag = new Antrag(form, oktober, k.path("einheit").asText(), zaehler, nenner, false, false, null, null, null, null,
                    null, null, List.of(), null, null);
        }
        gleich(KennzahlRegeln.wert(antrag).wert(), erw.path("wert"), "die Regel rechnet den Wert des Referenzunternehmens");
    }

    /** K18: Sichtbarkeit (R-A1 ∧ R-A6, R-A7) und Anlegen — die Wahrheitswerte kommen aus RechteAbleitung.darf. */
    private static void pruefeRechte(JsonNode e, JsonNode erw) throws Exception {
        Matrix m = RechteAbleitung.matrix(lies(RECHTE_MATRIX));
        Instant jetzt = OffsetDateTime.parse(e.path("jetzt").asText()).toInstant();
        JsonNode kbJson = e.path("kundenbereich");
        List<Standort> standorte = new ArrayList<>();
        kbJson.path("standorte").forEach(s -> standorte.add(new Standort(s.path("kennzeichen").asText(), s.path("name").asText())));
        List<Person> admins = new ArrayList<>();
        kbJson.path("kundenadministratoren").forEach(p -> admins.add(new Person(p.path("kennung").asText(), p.path("name").asText())));
        Kundenbereich kb = new Kundenbereich(kbJson.path("name").asText(), standorte, admins);

        Map<String, Benutzer> personen = new LinkedHashMap<>();
        for (JsonNode p : e.path("personen")) {
            List<Zuweisung> zuweisungen = new ArrayList<>();
            for (JsonNode z : p.path("zuweisungen")) {
                zuweisungen.add(new Zuweisung(Rolle.vonCode(z.path("rolle").asText()),
                        z.path("standorte").isNull() ? null : texte(z.path("standorte")),
                        z.path("umfang").isNull() ? null : Umfang.vonCode(z.path("umfang").asText()),
                        z.path("art").isNull() ? null : Art.vonCode(z.path("art").asText()),
                        OffsetDateTime.parse(z.path("gueltig_ab").asText()).toInstant(), str(z.path("gueltig_bis")), null));
            }
            personen.put(p.path("kennung").asText(), new Benutzer(p.path("kennung").asText(), p.path("name").asText(),
                    Konto.vonCode(p.path("konto").asText()), KontoZustand.vonCode(p.path("zustand").asText()), zuweisungen));
        }
        Map<String, JsonNode> kennzahlen = new LinkedHashMap<>();
        e.path("kennzahlen").forEach(k -> kennzahlen.put(k.path("kennzeichen").asText(), k));

        Map<String, Map<String, String>> sicht = new LinkedHashMap<>();
        for (Map.Entry<String, Benutzer> p : personen.entrySet()) {
            Map<String, String> je = new LinkedHashMap<>();
            for (JsonNode k : kennzahlen.values()) {
                KennzahlRegeln.GeltungUrteil g = KennzahlRegeln.geltung(k.path("geltung_art").asText(), str(k.path("standort")));
                boolean rA1 = RechteAbleitung.darf(m, p.getValue(), kb, KennzahlRegeln.ANSEHEN, ziel(g), jetzt).darf();
                List<Boolean> rA6 = new ArrayList<>();
                for (String s : texte(k.path("eingangs_standorte"))) {
                    rA6.add(RechteAbleitung.darf(m, p.getValue(), kb, KennzahlRegeln.ANSEHEN, Ziel.standort(s), jetzt).darf());
                }
                je.put(k.path("kennzeichen").asText(),
                        KennzahlRegeln.sichtbarkeit(rA1, rA6, p.getValue().konto() != Konto.BENUTZER));
            }
            sicht.put(p.getKey(), je);
        }
        List<Map<String, Object>> anlegen = new ArrayList<>();
        for (JsonNode a : e.path("anlegen")) {
            JsonNode k = kennzahlen.get(a.path("kennzahl").asText());
            KennzahlRegeln.GeltungUrteil g = KennzahlRegeln.geltung(k.path("geltung_art").asText(), str(k.path("standort")));
            RechteAbleitung.DarfErgebnis d = RechteAbleitung.darf(m, personen.get(a.path("person").asText()), kb, g.kennung(),
                    ziel(g), jetzt);
            Map<String, Object> zeile = new LinkedHashMap<>();
            zeile.put("person", a.path("person").asText());
            zeile.put("kennzahl", a.path("kennzahl").asText());
            zeile.put("http", d.darf() ? 201 : d.http());
            zeile.put("rolle_noetig", d.rolleNoetig() == null ? null : d.rolleNoetig().code());
            anlegen.add(zeile);
        }
        assertThat(baum("sichtbarkeit", sicht, "anlegen", anlegen)).isEqualTo(erw);
    }

    private static Ziel ziel(KennzahlRegeln.GeltungUrteil g) {
        return KennzahlRegeln.STANDORT.equals(g.rechteGeltung()) ? Ziel.standort(g.standort()) : Ziel.unternehmen();
    }

    // ---------------------------------------------------------------------------- Grenzen

    /** Kein Kundensatz, keine Anzeige und kein Kennzeichen spricht ein verbotenes Wort (§4.13). */
    @Test
    void keinKundensatzTraegtEinVerbotenesWort() throws Exception {
        JsonNode v = vektoren();
        Pattern verboten = Pattern.compile("\\b(" + String.join("|", texte(v.path("verbotene_woerter"))) + ")\\b",
                Pattern.UNICODE_CHARACTER_CLASS);
        List<String> saetze = new ArrayList<>(textMap(v.path("saetze")).values());
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                JsonNode erw = p.path("ergebnis");
                for (String feld : List.of("kundensatz", "anzeige")) {
                    if (erw.path(feld).isTextual()) {
                        saetze.add(erw.path(feld).asText());
                    }
                }
                erw.path("kennzeichen").forEach(k -> saetze.add(k.asText()));
            }
        }
        lies(ERGEBNIS_ZUSTAND).at("/kennzahl_kennzeichen/saetze").forEach(s -> saetze.add(s.path("beispiel").asText()));
        assertThat(saetze).hasSizeGreaterThan(100);
        assertThat(saetze.stream().filter(s -> verboten.matcher(s).find()).toList()).isEmpty();
    }

    /**
     * Die Abnahme des Captains als Test: 0,32 (das ungewichtete Mittel der Gebäude) und 0,2346 (das Mittel der
     * Monatsquotienten) entstehen nirgends — und keiner der beiden Zwillinge teilt durch die Zahl seiner Teile.
     */
    @Test
    void dasUngewichteteMittelEntstehtNirgends() throws Exception {
        int geprueft = 0;
        for (JsonNode fall : vektoren().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (p.path("ergebnis").has("nie")) {
                    BigDecimal wert = KennzahlRegeln.wert(antrag(p.path("eingang"))).wert();
                    assertThat(wert.setScale(4, RoundingMode.HALF_UP))
                            .isNotEqualByComparingTo(new BigDecimal(p.at("/ergebnis/nie").asText()));
                    geprueft++;
                }
            }
        }
        assertThat(geprueft).as("K3 und K14").isEqualTo(2);
        Pattern teiltDurchAnzahl = Pattern.compile("(?i)\\baverage\\b|\\.mean\\(|divide\\([^;]*(size|length|count)\\(");
        assertThat(teiltDurchAnzahl.matcher(Files.readString(QUELLE)).find()).as("KennzahlRegeln.java").isFalse();
        Pattern tsTeilt = Pattern.compile("(?i)\\baverage\\b|\\.mean\\(|/\\s*[\\w.]*\\.length\\b|teile\\w*\\([^)]*\\.length");
        assertThat(tsTeilt.matcher(Files.readString(TS_ZWILLING)).find()).as("uemsKennzahl.ts").isFalse();
    }

    /** E1: Kreis, Fassung und Stichtag werden AUFGERUFEN — keine zweite Suche, kein zweiter Fassungs-Eintrag. */
    @Test
    void kreisUndFassungWerdenAufgerufenNichtKopiert() throws Exception {
        String java = Files.readString(QUELLE);
        assertThat(java).contains("MessstelleFormelRegeln.zyklus(", "MessstelleFormelRegeln.fassungEintrag(",
                "MessstelleFormelRegeln.fassungAm(", "BezugsdatenRegeln.wertAm(", "BezugsPeriode.spanneVon(");
        assertThat(java).doesNotContain("besucht", "RueckwirkungEingang");
        String ts = Files.readString(TS_ZWILLING);
        assertThat(ts).contains("from './uemsMessstelleFormel'").doesNotContain("besucht");
    }
}
