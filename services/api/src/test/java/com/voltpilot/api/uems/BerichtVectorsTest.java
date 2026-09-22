package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
import java.nio.charset.StandardCharsets;
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
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings des BERICHTS (UEMS AP-12 IP-1/IP-3): {@link BerichtRegeln} zieht aus JEDER Prüfung der
 * EINEN geteilten Vektor-Datei ({@code docs/contracts/v2/bericht-vectors.json}) genau das Ergebnis, das dort steht — und
 * der TS-Zwilling ({@code frontend/portal/src/uemsBericht.ts}, Test {@code uemsBericht.test.ts}) aus derselben Datei
 * dasselbe. Die kanonische Form eines Abzugs ist in beiden Sprachen byte-gleich (Prüfsumme und Länge je Abzug).
 *
 * <p>Die Datei wird PER PFAD gelesen — wer sie verschiebt, bricht diesen Test absichtlich. Rein; kein Docker.
 */
class BerichtVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("bericht-vectors.json");
    private static final Path SCHEMA = V2.resolve("bericht.schema.json");
    private static final Path VORLAGEN = V2.resolve("bericht-vorlagen.json");
    private static final Path ERGEBNIS_ZUSTAND = V2.resolve("ergebnis-zustand-vectors.json");
    private static final Path EREIGNISSE = V2.resolve("events-vocabulary-vectors.json");
    private static final Path RECHTE_MATRIX = V2.resolve("rechte-matrix.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");
    private static final Path TS_ZWILLING = Path.of("..", "..", "frontend", "portal", "src", "uemsBericht.ts");
    private static final Path QUELLE =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", "BerichtRegeln.java");

    private static JsonNode vektorenCache;

    static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static JsonNode vektoren() throws Exception {
        if (vektorenCache == null) {
            vektorenCache = lies(VECTORS);
        }
        return vektorenCache;
    }

    private static ZoneId zone() throws Exception {
        return ZoneId.of(vektoren().path("zeitzone").asText());
    }

    static String str(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    static BigDecimal bd(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : new BigDecimal(n.asText());
    }

    static Instant zeit(JsonNode n) {
        return n == null || n.isMissingNode() || n.isNull() ? null : OffsetDateTime.parse(n.asText()).toInstant();
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

    /** Ein Betrag als Dezimaltext ohne nachgestellte Nullen — die Schreibweise der Vektoren. */
    static String betrag(BigDecimal d) {
        return d == null ? null : d.signum() == 0 ? "0" : d.stripTrailingZeros().toPlainString();
    }

    private String iso(Instant t) throws Exception {
        return t == null ? null : BezugsPeriode.iso(t, zone());
    }

    /** Ein Ergebnis als Baum aus abwechselnd Schlüsseln und Werten — verglichen wird Knoten für Knoten. */
    static JsonNode baum(Object... paare) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            m.put((String) paare[i], paare[i + 1]);
        }
        return MAPPER.valueToTree(m);
    }

    // ---------------------------------------------------------------------------- Form

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(vektoren(), lies(SCHEMA))).as("Schema-Verstöße").isEmpty();
    }

    /** Die gespeicherten Formen: die Abzüge der Plan-Abnahme halten $defs/abzug, jede Quelle hält $defs/quelle. */
    @Test
    void dieAbzuegeUndDieQuellenHaltenIhreFormen() throws Exception {
        JsonNode schema = lies(SCHEMA);
        for (String schluessel : List.of("BR-2026-0001/1", "BR-2026-0001/2")) {
            assertThat(UemsSchemaLaeufer.verstoesse(vektoren().path("abzuege").path(schluessel), teil(schema, "abzug")))
                    .as("Abzug " + schluessel).isEmpty();
        }
        int zeilen = 0;
        for (JsonNode fall : vektoren().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                for (JsonNode q : quellenZeilen(p.path("eingang").path("quellen"))) {
                    assertThat(UemsSchemaLaeufer.verstoesse(q, teil(schema, "quelle"))).as(fall.path("id").asText()).isEmpty();
                    zeilen++;
                }
            }
        }
        assertThat(zeilen).as("Quellen-Zeilen").isGreaterThan(300);
    }

    private static JsonNode teil(JsonNode schema, String def) {
        ObjectNode wurzel = MAPPER.createObjectNode();
        wurzel.set("$defs", schema.path("$defs"));
        wurzel.put("$ref", "#/$defs/" + def);
        return wurzel;
    }

    /** Die Vorlagen-Datei hält ihre Form, und ihre vier Vorlagen sind die der Klasse (V2). */
    @Test
    void dieVorlagenSindDieDerKlasse() throws Exception {
        JsonNode datei = lies(VORLAGEN);
        assertThat(UemsSchemaLaeufer.verstoesse(datei, teil(lies(SCHEMA), "vorlagen_datei"))).isEmpty();
        Map<String, BerichtRegeln.Vorlage> ausDatei = new LinkedHashMap<>();
        for (JsonNode v : datei.path("vorlagen")) {
            List<String> abschnitte = new ArrayList<>();
            v.path("abschnitte").forEach(a -> abschnitte.add(a.path("schluessel").asText()));
            ausDatei.put(v.path("schluessel").asText(), new BerichtRegeln.Vorlage(v.path("schluessel").asText(),
                    v.path("fassung").asInt(), v.path("geltung_art").asText(), v.path("zeitraum_art").asText(),
                    texte(v.path("vergleiche")), abschnitte));
        }
        assertThat(ausDatei).isEqualTo(BerichtRegeln.VORLAGEN);
        assertThat(new ArrayList<>(ausDatei.keySet())).isEqualTo(texte(vektoren().at("/vokabulare/vorlage")));
    }

    /** Die Beispielwelt ist das Referenzunternehmen in der Fassung, deren Korrektur und Bericht die Fälle erzählen — oder später. */
    @Test
    void dieBeispielweltIstDasReferenzunternehmen14() throws Exception {
        JsonNode ref = lies(REFERENZ);
        assertThat(vektoren().path("referenzunternehmen").asText()).isEqualTo("./uems-referenzunternehmen.json");
        assertThat(fassung(ref.path("version").asText())).isGreaterThanOrEqualTo(fassung(vektoren().path("referenz_stand").asText()));
        assertThat(ref.at("/korrekturen/0/kennung").asText()).isEqualTo("K-2026-0007");
        assertThat(ref.at("/berichte/0/kennung").asText()).isEqualTo("BR-2026-0001");
        assertThat(texte(ref.at("/berichte/0/quellen"))).isEqualTo(texte(vektoren().at("/cases/0/nachweis/quellenverzeichnis")));
    }

    static int fassung(String text) {
        String[] teile = text.split("\\.");
        return Integer.parseInt(teile[0]) * 1000 + Integer.parseInt(teile[1]);
    }

    @Test
    void prosaVorlagenUndTsZwillingLiegen() {
        assertThat(Files.exists(V2.resolve("bericht.md"))).as("bericht.md").isTrue();
        assertThat(Files.exists(VORLAGEN)).as("bericht-vorlagen.json").isTrue();
        assertThat(Files.exists(TS_ZWILLING)).as("TS-Zwilling").isTrue();
    }

    /** B1 … B17 in ihrer Reihenfolge, jeder mit Zweck, Handrechnung und mindestens einer Prüfung. */
    @Test
    void jederFallHatZweckHandrechnungUndPruefungen() throws Exception {
        List<String> ids = new ArrayList<>();
        Set<String> namen = new LinkedHashSet<>();
        vektoren().path("cases").forEach(c -> {
            ids.add(c.path("id").asText());
            assertThat(namen.add(c.path("name").asText())).as("Name eindeutig").isTrue();
            assertThat(c.path("why").asText()).as(c.path("id").asText() + " · why").isNotBlank();
            assertThat(c.path("schritte")).as(c.path("id").asText() + " · Handrechnung").isNotEmpty();
            assertThat(c.path("pruefungen")).as(c.path("id").asText() + " · Prüfungen").isNotEmpty();
        });
        List<String> erwartet = new ArrayList<>();
        for (int i = 1; i <= 17; i++) {
            erwartet.add("B" + i);
        }
        assertThat(ids).isEqualTo(erwartet);
    }

    /** Die Abnahme des Captains: B1 und B16 — Nr. 1 bleibt nach Korrektur und Fristen aus ihrem Abzug erklärbar. */
    @Test
    void diePlanAbnahmeHatIhreFaelle() throws Exception {
        Map<String, String> abnahmen = new LinkedHashMap<>();
        vektoren().path("cases").forEach(c -> {
            if (!c.path("abnahme").isNull()) {
                abnahmen.put(c.path("id").asText(), c.path("abnahme").asText());
            }
        });
        assertThat(abnahmen).containsExactly(Map.entry("B1", "captain"), Map.entry("B16", "captain"));
        String b1 = vektoren().at("/cases/0/pruefungen").findValues("pruefsumme").get(0).asText();
        String b16 = vektoren().at("/cases/15/pruefungen").findValues("pruefsumme").get(0).asText();
        assertThat(b16).as("dieselbe Prüfsumme nach zehn Jahren").isEqualTo(b1)
                .isEqualTo(vektoren().at("/cases/0/nachweis/stand/pruefsumme").asText());
    }

    // ---------------------------------------------------------------------------- Vokabulare

    @Test
    void dieVokabulareUndRegelnSindDieDerKlasse() throws Exception {
        JsonNode v = vektoren();
        JsonNode vok = v.path("vokabulare");
        assertThat(texte(vok.path("bericht_stand"))).isEqualTo(BerichtRegeln.STAENDE);
        assertThat(texte(vok.path("vorlage"))).isEqualTo(new ArrayList<>(BerichtRegeln.VORLAGEN.keySet()));
        assertThat(texte(vok.path("geltung_art"))).isEqualTo(BerichtRegeln.GELTUNG_ARTEN);
        assertThat(texte(vok.path("zeitraum_art"))).isEqualTo(BerichtRegeln.ZEITRAUM_ARTEN);
        assertThat(texte(vok.path("vergleich_art"))).isEqualTo(BerichtRegeln.VERGLEICH_ARTEN);
        assertThat(texte(vok.path("quelle_art"))).isEqualTo(BerichtRegeln.QUELLE_ARTEN);
        assertThat(texte(vok.path("quelle_bezug"))).isEqualTo(BerichtRegeln.QUELLE_BEZUEGE);
        assertThat(texte(vok.path("anstoss_art"))).isEqualTo(BerichtRegeln.ANSTOSS_ARTEN);
        assertThat(texte(vok.path("anstoss_zustand"))).isEqualTo(BerichtRegeln.ANSTOSS_ZUSTAENDE);
        assertThat(texte(vok.path("grund_ohne_vergleich"))).isEqualTo(BerichtRegeln.GRUENDE_OHNE_VERGLEICH);
        assertThat(texte(vok.path("kein_anstoss"))).isEqualTo(BerichtRegeln.KEIN_ANSTOSS);
        assertThat(texte(vok.path("struktur_protokoll"))).isEqualTo(BerichtRegeln.STRUKTUR_PROTOKOLLE);
        assertThat(texte(vok.path("handlung"))).isEqualTo(BerichtRegeln.HANDLUNGEN);
        assertThat(texte(vok.path("fehler"))).isEqualTo(BerichtRegeln.FEHLER);
        assertThat(texte(vok.path("ereignisse_reserviert"))).isEqualTo(BerichtRegeln.EREIGNISSE_RESERVIERT);
        assertThat(texte(vok.path("rechte"))).isEqualTo(BerichtRegeln.RECHTE);
        Map<String, Integer> status = new LinkedHashMap<>();
        v.path("fehler_status").fields().forEachRemaining(e -> status.put(e.getKey(), e.getValue().asInt()));
        assertThat(status).isEqualTo(BerichtRegeln.FEHLER_STATUS);

        JsonNode r = v.path("regeln");
        assertThat((long) r.path("freigabe_frist_tage").asInt()).isEqualTo(BerichtRegeln.FREIGABE_FRIST.toDays())
                .isEqualTo(TagRegeln.FRIST.toDays());
        assertThat(r.path("prozent_nachkommastellen").asInt()).isEqualTo(BerichtRegeln.PROZENT_NACHKOMMASTELLEN);
        assertThat(r.path("prozent_rechen_nachkommastellen").asInt()).isEqualTo(BerichtRegeln.PROZENT_RECHEN_NACHKOMMASTELLEN);
        assertThat(r.path("quellen_im_satz").asInt()).isEqualTo(BerichtRegeln.QUELLEN_IM_SATZ);
        assertThat(r.path("pruefsumme_praefix").asText()).isEqualTo(BerichtRegeln.PRUEFSUMME_PRAEFIX);
        assertThat(r.path("kennzeichen_trenner").asText()).isEqualTo(BerichtRegeln.KENNZEICHEN_TRENNER);
        assertThat(r.path("ohne_zahl").asText()).isEqualTo(BerichtRegeln.OHNE_ZAHL);
        assertThat(r.path("csv_trenner").asText()).isEqualTo(BerichtRegeln.CSV_TRENNER);
        assertThat(r.path("csv_dezimal").asText()).isEqualTo(BerichtRegeln.CSV_DEZIMAL);
        assertThat(texte(r.path("csv_spalten"))).isEqualTo(BerichtRegeln.CSV_SPALTEN);
        assertThat(texte(r.path("csv_kopf"))).isEqualTo(BerichtRegeln.CSV_KOPF);
        assertThat(textMap(r.path("kennung"))).isEqualTo(BerichtRegeln.KENNUNG);
        assertThat(r.path("teilansicht_recht").asText()).isEqualTo(BerichtRegeln.TEILANSICHT_RECHT);

        assertThat(textMap(v.path("saetze"))).isEqualTo(BerichtRegeln.SAETZE);
        assertThat(texte(v.path("verbotene_woerter"))).isEqualTo(BerichtRegeln.VERBOTENE_WOERTER);
    }

    @Test
    void dieRechteKennungenStehenInDerMatrix() throws Exception {
        Set<String> matrix = new LinkedHashSet<>();
        lies(RECHTE_MATRIX).path("aktionen").forEach(a -> matrix.add(a.path("kennung").asText()));
        assertThat(matrix).containsAll(BerichtRegeln.RECHTE).contains(BerichtRegeln.TEILANSICHT_RECHT);
    }

    /** Wortlaut und Stelle der Kennzeichen stehen im Ergebnis-Zustand (1.10) — und jedes Beispiel ist sein eigenes Muster. */
    @Test
    void dieKennzeichenStehenImErgebnisZustand() throws Exception {
        JsonNode ez = lies(ERGEBNIS_ZUSTAND);
        JsonNode block = ez.path("bericht_kennzeichen");
        Map<String, String> platzhalter = textMap(block.path("platzhalter"));
        assertThat(platzhalter).isEqualTo(BerichtRegeln.KENNZEICHEN_PLATZHALTER);
        assertThat(platzhalter.get("datum")).as("datum wie im Kennzahl-Block")
                .isEqualTo(ez.at("/kennzahl_kennzeichen/platzhalter/datum").asText());
        List<BerichtRegeln.Kennzeichen> saetze = new ArrayList<>();
        for (JsonNode s : block.path("saetze")) {
            BerichtRegeln.Kennzeichen k = new BerichtRegeln.Kennzeichen(s.path("schluessel").asText(), s.path("muster").asText(),
                    textMap(s.path("platzhalter")), s.path("stelle").asText());
            saetze.add(k);
            String rx = Pattern.quote(k.muster());
            for (Map.Entry<String, String> p : k.platzhalter().entrySet()) {
                rx = rx.replace("{" + p.getKey() + "}", "\\E(" + platzhalter.get(p.getValue()) + ")\\Q");
            }
            assertThat(s.path("beispiel").asText()).as("Beispiel " + k.schluessel()).matches(rx);
        }
        assertThat(saetze).isEqualTo(BerichtRegeln.KENNZEICHEN);
    }

    /** Die vier Berichts-Ereignisse sind reserviert — oder, wenn IP-4 sie angelegt hat, mit denselben Urhebern. */
    @Test
    void dieReservierungenStehenImEreignisVokabular() throws Exception {
        JsonNode ev = lies(EREIGNISSE);
        Map<String, JsonNode> arten = new LinkedHashMap<>();
        ev.at("/vokabular/arten").forEach(a -> arten.put(a.path("art").asText(), a));
        List<String> reserviert = new ArrayList<>();
        for (JsonNode r : ev.path("reserviert")) {
            String schluessel = r.path("art").asText() + "/" + r.path("bezug").asText();
            if (!r.path("art").asText().startsWith("bericht_")) {
                continue;
            }
            reserviert.add(schluessel);
            JsonNode angelegt = arten.get(r.path("art").asText());
            if (angelegt != null) {
                assertThat(texte(angelegt.path("urheber"))).as(schluessel + " eingelöst").containsAll(texte(r.path("urheber")));
            }
        }
        assertThat(reserviert).isEqualTo(BerichtRegeln.EREIGNISSE_RESERVIERT);
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
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : vektoren().path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                String regel = p.path("regel").asText();
                tests.add(DynamicTest.dynamicTest(fall.path("id").asText() + " · " + regel + " · " + p.path("name").asText(),
                        () -> assertThat(pruefe(regel, p.path("eingang"))).as(p.path("name").asText())
                                .isEqualTo(p.path("ergebnis"))));
            }
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(100);
        return tests;
    }

    private JsonNode pruefe(String regel, JsonNode e) throws Exception {
        ZoneId zone = zone();
        switch (regel) {
            case "vorlage" -> {
                BerichtRegeln.Vorlage v = BerichtRegeln.vorlage(e.path("vorlage").asText());
                if (v == null) {
                    return baum("geltung_art", null, "zeitraum_art", null, "vergleiche", null, "abschnitte", null,
                            "fehler", BerichtRegeln.VORLAGE_UNBEKANNT, "status", BerichtRegeln.FEHLER_STATUS.get(BerichtRegeln.VORLAGE_UNBEKANNT),
                            "kundensatz", BerichtRegeln.SAETZE.get(BerichtRegeln.VORLAGE_UNBEKANNT));
                }
                return baum("geltung_art", v.geltungArt(), "zeitraum_art", v.zeitraumArt(), "vergleiche", v.vergleiche(),
                        "abschnitte", v.abschnitte(), "fehler", null, "status", null, "kundensatz", null);
            }
            case "zeitraum" -> {
                BerichtRegeln.Zeitraum z = BerichtRegeln.zeitraum(e.path("art").asText(), e.path("schluessel").asText(),
                        ZoneId.of(e.path("zone").asText()));
                List<Map<String, Object>> vergleiche = new ArrayList<>();
                for (BerichtRegeln.Vergleichszeitraum v : z.vergleiche()) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("art", v.art());
                    m.put("schluessel", v.schluessel());
                    m.put("erster_tag", v.ersterTag().toString());
                    m.put("letzter_tag", v.letzterTag().toString());
                    m.put("von", iso(v.von()));
                    m.put("bis", iso(v.bis()));
                    vergleiche.add(m);
                }
                return baum("art", z.art(), "schluessel", z.schluessel(), "erster_tag", z.ersterTag().toString(),
                        "letzter_tag", z.letzterTag().toString(), "von", iso(z.von()), "bis", iso(z.bis()),
                        "freigabe_ab", iso(z.freigabeAb()), "bezeichnung", z.bezeichnung(), "vergleiche", vergleiche);
            }
            case "vergleich_grund" -> {
                return baum("grund", BerichtRegeln.vergleichGrund(tag(e.path("erster_tag")), tag(e.path("letzter_tag")),
                        tag(e.path("besteht_seit")), tag(e.path("beendet_am")), e.path("hat_werte").asBoolean()));
            }
            case "vergleich" -> {
                BerichtRegeln.Vergleich v = BerichtRegeln.vergleich(bd(e.path("aktuell")), bd(e.path("vergleich")),
                        e.path("einheit").asText(), str(e.path("ebene")), str(e.path("grund")));
                return baum("differenz", betrag(v.differenz()), "prozent", betrag(v.prozent()), "anzeige_differenz",
                        v.anzeigeDifferenz(), "anzeige_prozent", v.anzeigeProzent(), "zustand", v.zustand(), "grund", v.grund());
            }
            case "freigabe" -> {
                List<BerichtRegeln.FreigabeWert> werte = new ArrayList<>();
                e.path("werte").forEach(w -> werte.add(new BerichtRegeln.FreigabeWert(w.path("quelle").asText(),
                        str(w.path("name")), str(w.path("fassung")), zeit(w.path("endgueltig_ab")))));
                BerichtRegeln.Freigabe f = BerichtRegeln.freigabe(new BerichtRegeln.FreigabeAntrag(e.path("zeitraum_art").asText(),
                        e.path("schluessel").asText(), ZoneId.of(e.path("zone").asText()), zeit(e.path("jetzt")), werte,
                        zeit(e.path("datenstand_uebermittelt")), zeit(e.path("datenstand_entwurf")), e.path("letzte_nr").asInt(),
                        str(e.path("anlass")), e.path("abweichungen").asInt()));
                return baum("erlaubt", f.erlaubt(), "status", f.status(), "code", f.code(), "nr", f.nr(),
                        "moeglich_ab", iso(f.moeglichAb()), "vorlaeufig", f.vorlaeufig(), "vorlaeufige", f.vorlaeufige(),
                        "datenstand_uebermittelt", iso(f.datenstandUebermittelt()), "datenstand_aktuell", iso(f.datenstandAktuell()),
                        "datenstand", iso(f.datenstand()), "freigegeben_am", iso(f.freigegebenAm()), "kundensatz", f.kundensatz());
            }
            case "datenstand" -> {
                Instant ds = zeit(e.path("datenstand"));
                Instant freigabe = zeit(e.path("freigabe"));
                List<Instant> berechnet = new ArrayList<>();
                e.path("berechnet_am").forEach(x -> berechnet.add(zeit(x)));
                List<Instant> endgueltig = new ArrayList<>();
                e.path("endgueltig_ab").forEach(x -> endgueltig.add(zeit(x)));
                List<BerichtRegeln.Aenderung> aenderungen = new ArrayList<>();
                e.path("aenderungen").forEach(a -> aenderungen.add(new BerichtRegeln.Aenderung(str(a.path("quelle")),
                        a.path("art").asText(), zeit(a.path("zeitpunkt")))));
                List<BerichtRegeln.Aenderung> d2 = BerichtRegeln.d2(ds, berechnet, endgueltig, freigabe != null);
                List<BerichtRegeln.Aenderung> d3 = freigabe == null ? List.of() : BerichtRegeln.d3(ds, freigabe, aenderungen);
                List<BerichtRegeln.Aenderung> d4 = BerichtRegeln.d4(ds, aenderungen);
                List<Map<String, Object>> d2v = new ArrayList<>();
                for (BerichtRegeln.Aenderung a : d2) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("art", a.art());
                    m.put("zeitpunkt", iso(a.zeitpunkt()));
                    d2v.add(m);
                }
                return baum("d2", d2.isEmpty(), "d2_verstoesse", d2v, "d3", freigabe == null ? null : d3.isEmpty(),
                        "d3_verstoesse", aenderungen(d3), "d4_aktuell", d4.isEmpty(), "d4_neuere", aenderungen(d4));
            }
            case "betroffenheit" -> {
                List<BerichtRegeln.Quelle> quellen = new ArrayList<>();
                for (JsonNode q : quellenZeilen(e.path("quellen"))) {
                    quellen.add(new BerichtRegeln.Quelle(q.path("bericht").asText(), q.path("nr").isNull() ? null : q.path("nr").asInt(),
                            q.path("ersetzt").asBoolean(), q.path("objekt").asText(), q.path("bezug").asText(),
                            tag(q.path("erster_tag")), tag(q.path("letzter_tag"))));
                }
                List<BerichteNaht.Bericht> treffer;
                String anstoss = null;
                if (e.has("betroffen")) {
                    KorrekturKaskade.Betroffen b = betroffen(e.path("betroffen"));
                    Map<KorrekturKaskade.Reihe, List<String>> bindung = new LinkedHashMap<>();
                    e.path("quellenbindung").forEach(x -> bindung.put(new KorrekturKaskade.Reihe(UUID.fromString(x.path("entity").asText()),
                            x.path("kanal").asText()), texte(x.path("messstellen"))));
                    treffer = BerichtRegeln.betroffene(quellen, b, r -> bindung.getOrDefault(r, List.of()));
                    anstoss = BerichtRegeln.anstossArt(b);
                } else {
                    treffer = BerichtRegeln.betroffene(quellen, texte(e.at("/struktur/objekte")), tag(e.at("/struktur/gilt_ab")));
                }
                List<List<String>> liste = new ArrayList<>();
                treffer.forEach(t -> liste.add(List.of(t.kennung(), t.stand().name())));
                return baum("betroffene", liste, "anstoss_art", anstoss);
            }
            case "struktur" -> {
                BerichtRegeln.Struktur s = BerichtRegeln.struktur(e.path("protokoll").asText(), e.path("objekt_art").asText(),
                        e.path("art").asText(), e.path("rueckwirkend").asBoolean(), e.path("korrektur").asBoolean());
                return baum("anstoss_art", s.anstossArt(), "grund", s.grund());
            }
            case "abweichungen" -> {
                JsonNode abzuege = vektoren().path("abzuege");
                List<Map<String, Object>> liste = new ArrayList<>();
                for (BerichtRegeln.Abweichung a : BerichtRegeln.abweichungen(abzuege.path(e.path("alt").asText()),
                        abzuege.path(e.path("neu").asText()))) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("quelle", a.quelle());
                    m.put("menge_art", a.mengeArt());
                    m.put("vorher", betrag(a.vorher()));
                    m.put("nachher", betrag(a.nachher()));
                    m.put("version", a.version());
                    m.put("anlass", a.anlass());
                    liste.add(m);
                }
                return baum("abweichungen", liste);
            }
            case "rechte" -> {
                return rechte(e);
            }
            case "kanonisch" -> {
                String text = BerichtRegeln.kanonisch(vektoren().path("abzuege").path(e.path("abzug").asText()));
                if ("randfall".equals(e.path("abzug").asText())) {
                    return baum("text", text, "pruefsumme", BerichtRegeln.pruefsumme(text), "bytes",
                            text.getBytes(StandardCharsets.UTF_8).length);
                }
                return baum("pruefsumme", BerichtRegeln.pruefsumme(text), "bytes", text.getBytes(StandardCharsets.UTF_8).length);
            }
            case "csv_kopf" -> {
                JsonNode g = e.path("geltung");
                List<String> teil = texte(e.path("teilansicht"));
                return baum("zeilen", BerichtRegeln.csvKopf(new BerichtRegeln.CsvKopf(e.path("bericht").asText(),
                        e.path("vorlage").asText(), e.path("vorlage_fassung").asInt(), g.path("art").asText(),
                        g.path("kennzeichen").asText(), g.path("name").asText(), e.at("/zeitraum/art").asText(),
                        e.at("/zeitraum/schluessel").asText(), ZoneId.of(e.path("zone").asText()), e.path("stand").asInt(),
                        zeit(e.path("datenstand")), zeit(e.path("freigegeben_am")), e.path("freigegeben_von").asText(),
                        e.path("pruefsumme").asText(), zeit(e.path("erzeugt_am")), e.path("erzeugt_von").asText(),
                        teil.isEmpty() ? null : teil)));
            }
            case "csv_zeile" -> {
                return baum("zeile", BerichtRegeln.csvZeile(new BerichtRegeln.CsvZeile(e.path("quelle").asText(), str(e.path("name")),
                        str(e.path("ort")), str(e.path("periode")), bd(e.path("menge")), str(e.path("einheit")),
                        str(e.path("zustand")), bd(e.path("abdeckung_prozent")), texte(e.path("kennzeichen")),
                        str(e.path("fassung")), zeit(e.path("endgueltig_ab")),
                        e.path("version").isNull() ? null : e.path("version").asInt(), zeit(e.path("berechnet_am"))), zone));
            }
            case "kopf" -> {
                JsonNode st = e.path("stand");
                ZoneId z = ZoneId.of(e.path("zone").asText());
                return baum("text", st.isNull() ? BerichtRegeln.kopf(zeit(e.path("datenstand")), z, null, null, null)
                        : BerichtRegeln.kopf(zeit(e.path("datenstand")), z, st.path("nr").asInt(), zeit(st.path("freigegeben_am")),
                                st.path("freigegeben_von").asText()));
            }
            case "kennzeichen" -> {
                return baum("text", kennzeichen(e, zone));
            }
            case "anlass" -> {
                return baum("text", BerichtRegeln.anlass(e.path("kennung").asText()));
            }
            case "satz" -> {
                String code = e.path("code").asText();
                return baum("status", BerichtRegeln.FEHLER_STATUS.get(code), "kundensatz", satz(code, e.path("werte"), zone));
            }
            case "anzeige" -> {
                return baum("text", BerichtRegeln.anzeige(e.path("art").asText(), bd(e.path("wert")), e.path("einheit").asText(),
                        str(e.path("ebene"))));
            }
            default -> throw new AssertionError("unbekannte Regel " + regel);
        }
    }

    /** Quellen stehen in der Datei als Gruppen je Bericht, Stand, Bezug und Tagen — hier eine Zeile je Objekt. */
    private static List<JsonNode> quellenZeilen(JsonNode gruppen) {
        List<JsonNode> raus = new ArrayList<>();
        for (JsonNode g : gruppen) {
            for (JsonNode o : g.path("objekte")) {
                ObjectNode z = g.deepCopy();
                z.remove("objekte");
                z.set("objekt", o);
                raus.add(z);
            }
        }
        return raus;
    }

    private List<Map<String, Object>> aenderungen(List<BerichtRegeln.Aenderung> liste) throws Exception {
        List<Map<String, Object>> raus = new ArrayList<>();
        for (BerichtRegeln.Aenderung a : liste) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("quelle", a.quelle());
            m.put("art", a.art());
            m.put("zeitpunkt", iso(a.zeitpunkt()));
            raus.add(m);
        }
        return raus;
    }

    private static KorrekturKaskade.Betroffen betroffen(JsonNode b) {
        List<KorrekturKaskade.Reihe> reihen = new ArrayList<>();
        b.path("reihen").forEach(r -> reihen.add(new KorrekturKaskade.Reihe(UUID.fromString(r.path("entity").asText()),
                r.path("kanal").asText())));
        List<UUID> ereignisse = new ArrayList<>();
        b.path("ereignisse").forEach(x -> ereignisse.add(UUID.fromString(x.asText())));
        List<KorrekturKaskade.Bezugsgroesse> bezugsgroessen = new ArrayList<>();
        b.path("bezugsgroessen").forEach(g -> bezugsgroessen.add(new KorrekturKaskade.Bezugsgroesse(
                UUID.fromString(g.path("id").asText()), g.path("kennzeichen").asText(), tag(g.path("periode_von")),
                tag(g.path("periode_bis")), g.path("fassung").asInt(), g.path("status").asText())));
        return new KorrekturKaskade.Betroffen(UUID.fromString(b.path("tenant").asText()), b.path("anlass").asText(),
                b.path("fassung").asInt(), b.path("status").asText(), reihen, zeit(b.path("von")), zeit(b.path("bis")),
                ZoneId.of(b.path("zone").asText()), tag(b.path("erster_tag")), tag(b.path("letzter_tag")),
                texte(b.path("messstellen")), ereignisse, b.path("versionen").asInt(), null, bezugsgroessen);
    }

    private static String kennzeichen(JsonNode e, ZoneId zone) {
        return switch (e.path("schluessel").asText()) {
            case "berichtsstand" -> BerichtRegeln.berichtsstand(e.path("nr").asInt());
            case "ersetzt_durch" -> BerichtRegeln.ersetztDurch(e.path("nr").asInt(), zeit(e.path("am")), zone);
            case "revision_noetig" -> BerichtRegeln.revisionNoetig(e.path("anlass").asText());
            case "entwurf" -> BerichtRegeln.entwurf(zeit(e.path("datenstand")), zone);
            case "zeitraum_laeuft" -> BerichtRegeln.ZEITRAUM_LAEUFT;
            case "vorlaeufig" -> BerichtRegeln.vorlaeufig(zeit(e.path("endgueltig_ab")), zone);
            case "heute" -> BerichtRegeln.heute(e.path("name_zum_datenstand").asText(), e.path("name_heute").asText());
            case "teilansicht" -> BerichtRegeln.teilansichtKennzeichen(texte(e.path("standorte")));
            case "vor_beginn" -> BerichtRegeln.vorBeginn(tag(e.path("seit")));
            case "anstoss_verworfen" -> BerichtRegeln.anstossVerworfen(e.path("begruendung").asText());
            default -> throw new AssertionError("unbekanntes Kennzeichen " + e.path("schluessel").asText());
        };
    }

    private static String satz(String code, JsonNode w, ZoneId zone) {
        return switch (code) {
            case BerichtRegeln.KEINE_QUELLEN -> BerichtRegeln.keineQuellen(w.path("geltung").asText(), w.at("/zeitraum/art").asText(),
                    w.at("/zeitraum/schluessel").asText(), tag(w.path("besteht_seit")));
            case BerichtRegeln.BERICHT_GIBT_ES_SCHON -> BerichtRegeln.berichtGibtEsSchon(w.path("kennung").asText(),
                    w.path("geltung").asText(), w.at("/zeitraum/art").asText(), w.at("/zeitraum/schluessel").asText());
            case BerichtRegeln.STAND_GIBT_ES_NICHT -> w.path("neueste").isNull()
                    ? BerichtRegeln.standGibtEsNicht(w.path("nr").asInt(), null, null, zone)
                    : BerichtRegeln.standGibtEsNicht(w.path("nr").asInt(), w.at("/neueste/nr").asInt(), zeit(w.at("/neueste/freigegeben_am")), zone);
            case BerichtRegeln.WERT_NICHT_MEHR_GESPEICHERT -> w.path("stand").isNull()
                    ? BerichtRegeln.wertNichtMehrGespeichert(w.at("/zeitraum/art").asText(), w.at("/zeitraum/schluessel").asText(), null, null, zone)
                    : BerichtRegeln.wertNichtMehrGespeichert(w.at("/zeitraum/art").asText(), w.at("/zeitraum/schluessel").asText(),
                            w.at("/stand/nr").asInt(), zeit(w.at("/stand/freigegeben_am")), zone);
            case BerichtRegeln.BERICHTS_BELEGE -> {
                List<BerichtRegeln.StandBezeichnung> staende = new ArrayList<>();
                w.path("staende").forEach(s -> staende.add(new BerichtRegeln.StandBezeichnung(s.path("kennung").asText(), s.path("nr").asInt())));
                yield BerichtRegeln.berichtsBelege(staende);
            }
            case BerichtRegeln.ABZUG_BESCHAEDIGT -> BerichtRegeln.abzugBeschaedigt(w.path("nr").asInt());
            case BerichtRegeln.VORLAGE_UNBEKANNT, BerichtRegeln.GELTUNG_UNBEKANNT -> BerichtRegeln.SAETZE.get(code);
            default -> throw new AssertionError("unbekannter Satz " + code);
        };
    }

    /** G1–G3: das Urteil spricht {@link RechteAbleitung#darf} gegen die Matrix; die Teilansicht {@link BerichtRegeln#teilansicht}. */
    private static JsonNode rechte(JsonNode e) throws Exception {
        Matrix m = RechteAbleitung.matrix(lies(RECHTE_MATRIX));
        Instant jetzt = zeit(e.path("jetzt"));
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
        List<Map<String, Object>> ergebnisse = new ArrayList<>();
        for (JsonNode a : e.path("anfragen")) {
            String kennung = BerichtRegeln.kennung(a.path("handlung").asText(), a.path("geltung_art").asText());
            String standort = str(a.path("standort"));
            RechteAbleitung.DarfErgebnis d = RechteAbleitung.darf(m, personen.get(a.path("person").asText()), kb, kennung,
                    standort == null ? Ziel.unternehmen() : Ziel.standort(standort), jetzt);
            Map<String, Object> zeile = new LinkedHashMap<>();
            zeile.put("person", a.path("person").asText());
            zeile.put("kennung", kennung);
            zeile.put("standort", standort);
            zeile.put("ergebnis", d.darf() ? "ja" : String.valueOf(d.http()));
            ergebnisse.add(zeile);
        }
        Map<String, Object> teilansicht = new LinkedHashMap<>();
        personen.forEach((kennung, b) -> {
            List<String> t = BerichtRegeln.teilansicht(m, b, kb, jetzt);
            teilansicht.put(kennung, t == null ? null : String.join(", ", t));
        });
        return baum("ergebnisse", ergebnisse, "teilansicht", teilansicht);
    }

    // ---------------------------------------------------------------------------- Grenzen

    /** Kein Satz, kein Kundensatz und kein Kennzeichen spricht über den Bericht in einem verbotenen Wort (E14). */
    @Test
    void keinSatzTraegtEinVerbotenesWort() throws Exception {
        List<String> texte = new ArrayList<>(BerichtRegeln.SAETZE.values());
        BerichtRegeln.KENNZEICHEN.forEach(k -> texte.add(k.muster()));
        vektoren().path("cases").forEach(c -> c.path("pruefungen").forEach(p -> {
            for (String feld : List.of("kundensatz", "text")) {
                if (p.path("ergebnis").path(feld).isTextual() && !"kanonisch".equals(p.path("regel").asText())) {
                    texte.add(p.path("ergebnis").path(feld).asText());
                }
            }
        }));
        assertThat(texte).hasSizeGreaterThan(80);
        for (String t : texte) {
            for (String w : BerichtRegeln.VERBOTENE_WOERTER) {
                assertThat(t).as("verbotenes Wort").doesNotContain(w);
            }
        }
    }

    /**
     * Aufgerufen, nicht kopiert: Periodengrenzen, Frist, Uhrzeit, Zone, Zahlform, Kennzahl-Anzeige, Datum und Recht kommen
     * aus ihren Klassen — in beiden Zwillingen steht keine eigene Sieben-Tage-Rechnung und keine feste Zeitzone.
     */
    @Test
    void dieRegelnWerdenAufgerufenNichtKopiert() throws Exception {
        String java = Files.readString(QUELLE);
        assertThat(java).contains("BezugsPeriode.spanneVon", "TagRegeln.endgueltigAb", "TagRegeln.beginn", "ErgebnisZustand.uhr",
                "ErgebnisZustand.zoneKurz", "ErgebnisZustand.zahl", "KennzahlRegeln.anzeige", "KennzahlRegeln.periodeText",
                "OrtsbaumAbleitung.datumText", "RechteAbleitung.darf", "BerichteNaht.Bericht", "KorrekturKaskade.Betroffen");
        assertThat(java).doesNotContain("Europe/Berlin", "ofDays(7)", "plusDays(7)", "\"MEZ\"");
        String ts = Files.readString(TS_ZWILLING);
        assertThat(ts).contains("spanneVon", "mitternacht", "uhr(", "zoneKurz(", "zahlMitStellen", "anzeige as kennzahlAnzeige",
                "periodeText", "datumText", "darf(");
        assertThat(ts).doesNotContain("Europe/Berlin", "'MEZ'", "86400000 * 7", "7 * 86400000");
    }
}
