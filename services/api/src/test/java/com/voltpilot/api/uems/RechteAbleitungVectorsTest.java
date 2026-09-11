package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.RechteAbleitung.Aenderung;
import com.voltpilot.api.uems.RechteAbleitung.AenderungErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.AenderungsArt;
import com.voltpilot.api.uems.RechteAbleitung.Anlage;
import com.voltpilot.api.uems.RechteAbleitung.AnlageStandort;
import com.voltpilot.api.uems.RechteAbleitung.Antrag;
import com.voltpilot.api.uems.RechteAbleitung.Art;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Code;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.GeltungErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Geltungsbereich;
import com.voltpilot.api.uems.RechteAbleitung.GewaehrenErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Grund;
import com.voltpilot.api.uems.RechteAbleitung.Handeingriff;
import com.voltpilot.api.uems.RechteAbleitung.HandeingriffErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Konto;
import com.voltpilot.api.uems.RechteAbleitung.KontoZustand;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import com.voltpilot.api.uems.RechteAbleitung.OcppErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.OcppStufe;
import com.voltpilot.api.uems.RechteAbleitung.Person;
import com.voltpilot.api.uems.RechteAbleitung.Rolle;
import com.voltpilot.api.uems.RechteAbleitung.SichtErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Standort;
import com.voltpilot.api.uems.RechteAbleitung.SummeErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.TeilansichtErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Umfang;
import com.voltpilot.api.uems.RechteAbleitung.Unterstuetzer;
import com.voltpilot.api.uems.RechteAbleitung.Unterstuetzung;
import com.voltpilot.api.uems.RechteAbleitung.UnterstuetzungErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.UnterstuetzungsZustand;
import com.voltpilot.api.uems.RechteAbleitung.Wert;
import com.voltpilot.api.uems.RechteAbleitung.Ziel;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag der RECHTE (UEMS AP-03 IP-1): die Matrix-Datei {@code rechte-matrix.json} und die
 * Vektor-Datei {@code rechte-vectors.json} halten ihr Schema, die erzeugte Tabelle
 * {@code rechte-matrix.md} ist zeilengleich zur Matrix-Datei (die Build-Prüfung), und
 * {@link RechteAbleitung} zieht aus JEDEM Fall genau das Ergebnis, das dort steht — dieselbe
 * Datei fährt der TS-Zwilling {@code frontend/portal/src/rechte.test.ts}.
 *
 * <p>Die Fälle spielen im Referenzunternehmen Ahrenberg: jede Person, jeder Standort, jede
 * Anlage und jeder Wert wird gegen {@code uems-referenzunternehmen.json} geprüft; was die Datei
 * nicht kennt, nennt der Fall in {@code annahme}.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class RechteAbleitungVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("rechte-vectors.json");
    private static final Path MATRIX = V2.resolve("rechte-matrix.json");
    private static final Path TABELLE = V2.resolve("rechte-matrix.md");
    private static final Path SCHEMA = V2.resolve("rechte.schema.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static Matrix matrix() throws Exception {
        return RechteAbleitung.matrix(lies(MATRIX));
    }

    private static ZoneId zone() throws Exception {
        return ZoneId.of(lies(VECTORS).path("zeitzone").asText());
    }

    // ---------------------------------------------------------------- Form

    @Test
    void dieVektorDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA))).isEmpty();
    }

    @Test
    void dieMatrixHaeltIhrSchema() throws Exception {
        ObjectNode schema = (ObjectNode) lies(SCHEMA).deepCopy();
        schema.put("$ref", "#/$defs/matrix");
        assertThat(UemsSchemaLaeufer.verstoesse(lies(MATRIX), schema)).isEmpty();
    }

    /** 48 Zeilen mit eindeutiger Kennung, 7 Rollen in der Spaltenreihenfolge, 3 Umfänge aufsteigend. */
    @Test
    void dieMatrixIstDieKonzeptTabelle() throws Exception {
        JsonNode m = lies(MATRIX);
        List<String> kennungen = texte(m.path("aktionen"), "kennung");
        assertThat(kennungen).hasSize(48).doesNotHaveDuplicates();
        assertThat(texte(m.path("rollen"), "kennung")).containsExactlyElementsOf(codes(Rolle.values()));
        assertThat(texte(m.path("umfaenge"), "kennung")).containsExactlyElementsOf(codes(Umfang.values()));
        for (JsonNode r : m.path("rollen")) {
            Rolle rolle = Rolle.vonCode(r.path("kennung").asText());
            assertThat(r.path("kundenwort").asText()).isEqualTo(rolle.kundenwort());
        }
        for (JsonNode u : m.path("umfaenge")) {
            assertThat(u.path("kundenwort").asText())
                    .isEqualTo(Umfang.vonCode(u.path("kennung").asText()).kundenwort());
        }
        Set<String> gruppen = new HashSet<>(texte(m.path("gruppen"), "kennung"));
        m.path("aktionen").forEach(a -> assertThat(gruppen).contains(a.path("gruppe").asText()));
        // Jede Aktion, die ein Energiemanager oder eine Standort-Rolle hat, hat der
        // Kundenadministrator auch (§4.2 „alles, was Energiemanager und Bedienberechtigte dürfen“).
        for (JsonNode a : m.path("aktionen")) {
            JsonNode z = a.path("zellen");
            boolean jemand = z.path("energiemanager").asText().equals("U")
                    || List.of("bearbeiter", "bedienberechtigt", "leser").stream()
                            .anyMatch(r -> z.path(r).asText().equals("S"));
            if (jemand) {
                assertThat(z.path("kundenadministrator").asText()).as(a.path("kennung").asText()).isEqualTo("U");
            }
        }
        assertThat(matrix().aktionen()).hasSize(48);
    }

    /**
     * Die BUILD-PRÜFUNG: die erzeugte Tabelle {@code rechte-matrix.md} (Abschnitt „Matrix“) ist
     * zeilengleich zur Matrix-Datei — Kopf, Gruppenzeilen, Wortlaut, Herkunft, sieben Zellen,
     * Anmerkung. Wer die JSON-Datei ändert, erzeugt die Tabelle neu
     * ({@code python3 docs/contracts/v2/tools/rechte_matrix.py}).
     */
    @Test
    void dieErzeugteTabelleIstZeilengleichZurMatrix() throws Exception {
        JsonNode m = lies(MATRIX);
        List<String> soll = new ArrayList<>();
        List<String> kopf = new ArrayList<>(List.of("Aktion", "Herkunft"));
        m.path("rollen").forEach(r -> kopf.add(r.path("kundenwort").asText()));
        kopf.add("Anmerkung");
        soll.add(zeile(kopf));
        soll.add("|" + "---|".repeat(kopf.size()));
        Map<String, String> titel = new HashMap<>();
        m.path("gruppen").forEach(g -> titel.put(g.path("kennung").asText(), g.path("titel").asText()));
        String gruppe = null;
        for (JsonNode a : m.path("aktionen")) {
            if (!a.path("gruppe").asText().equals(gruppe)) {
                gruppe = a.path("gruppe").asText();
                List<String> g = new ArrayList<>(List.of("**" + titel.get(gruppe) + "**"));
                while (g.size() < kopf.size()) {
                    g.add("");
                }
                soll.add(zeile(g));
            }
            List<String> z = new ArrayList<>(List.of(a.path("kundenwort").asText(), a.path("herkunft").asText()));
            m.path("rollen").forEach(r -> z.add(a.path("zellen").path(r.path("kennung").asText()).asText()));
            z.add(a.path("anmerkung").isNull() ? "" : a.path("anmerkung").asText());
            soll.add(zeile(z));
        }
        List<String> ist = new ArrayList<>();
        boolean drin = false;
        for (String l : Files.readAllLines(TABELLE)) {
            if (l.startsWith("| Aktion | Herkunft |")) {
                drin = true;
            }
            if (drin && l.isEmpty()) {
                break;
            }
            if (drin) {
                ist.add(l);
            }
        }
        assertThat(ist).as("rechte-matrix.md veraltet → python3 docs/contracts/v2/tools/rechte_matrix.py")
                .containsExactlyElementsOf(soll);
    }

    private static String zeile(List<String> zellen) {
        return "| " + String.join(" | ", zellen.stream().map(s -> s.replace("|", "\\|")).toList()) + " |";
    }

    // ------------------------------------------------------------ Vokabular

    @Test
    void dasVokabularIstDasselbe() throws Exception {
        JsonNode v = lies(VECTORS).path("vokabular");
        assertThat(texte(v.path("konto"))).containsExactlyElementsOf(codes(Konto.values()));
        assertThat(texte(v.path("konto_zustand"))).containsExactlyElementsOf(codes(KontoZustand.values()));
        assertThat(texte(v.path("art"))).containsExactlyElementsOf(codes(Art.values()));
        assertThat(texte(v.path("umfang"))).containsExactlyElementsOf(codes(Umfang.values()));
        assertThat(texte(v.path("ocpp_stufe"))).containsExactlyElementsOf(codes(OcppStufe.values()));
        assertThat(texte(v.path("unterstuetzung_zustand")))
                .containsExactlyElementsOf(codes(UnterstuetzungsZustand.values()));
        assertThat(texte(v.path("aenderung"))).containsExactlyElementsOf(codes(AenderungsArt.values()));
        assertThat(texte(v.path("rolle_noetig_reihenfolge")))
                .containsExactlyElementsOf(RechteAbleitung.ROLLE_NOETIG_REIHENFOLGE.stream().map(Rolle::code).toList());
    }

    @Test
    void dieGruendeUndIhrStatusSindDieselben() throws Exception {
        Map<String, Integer> datei = new LinkedHashMap<>();
        lies(VECTORS).path("gruende").forEach(g -> datei.put(g.path("code").asText(), g.path("http").asInt()));
        Map<String, Integer> code = new LinkedHashMap<>();
        for (Grund g : Grund.values()) {
            code.put(g.code(), g.http());
        }
        assertThat(datei).containsExactlyEntriesOf(code);
    }

    @Test
    void dieKundensaetzeSindDieselben() throws Exception {
        Map<String, String> datei = new HashMap<>();
        lies(VECTORS).path("texte").fields().forEachRemaining(e -> datei.put(e.getKey(), e.getValue().asText()));
        assertThat(datei).isEqualTo(RechteAbleitung.TEXTE);
    }

    @Test
    void dieRegelZahlenSindDieselben() throws Exception {
        JsonNode r = lies(VECTORS).path("regeln");
        assertThat(r.path("unterstuetzung_hoechstens_monate").asInt()).isEqualTo(RechteAbleitung.HOECHSTENS_MONATE);
        assertThat(r.path("unterstuetzung_vorgabe_tage").asInt()).isEqualTo(RechteAbleitung.VORGABE_TAGE);
        assertThat(r.path("erinnerung_tage").asLong()).isEqualTo(RechteAbleitung.ERINNERUNG.toDays());
        assertThat(r.path("notfall_stunden").asLong()).isEqualTo(RechteAbleitung.NOTFALL.toHours());
        r.path("vorgabe_umfang").fields().forEachRemaining(e -> assertThat(
                        RechteAbleitung.vorgabeUmfang(Art.vonCode(e.getKey())).code())
                .as(e.getKey()).isEqualTo(e.getValue().asText()));
    }

    @Test
    void familienUndAbnahmefaelleSindAbgedeckt() throws Exception {
        JsonNode root = lies(VECTORS);
        Set<String> familien = new LinkedHashSet<>();
        Set<String> abnahmen = new LinkedHashSet<>();
        for (JsonNode c : root.path("cases")) {
            familien.add(c.path("familie").asText());
            if (c.hasNonNull("abnahme")) {
                abnahmen.add(c.path("abnahme").asText());
            }
        }
        assertThat(familien).containsExactlyInAnyOrderElementsOf(texte(root.path("familien")));
        assertThat(abnahmen).containsAll(texte(root.path("abnahmefaelle")));
        assertThat(texte(root.path("abnahmefaelle"))).hasSize(16);
    }

    @Test
    void jederFallSagtWarumErDaIst() throws Exception {
        Set<String> namen = new LinkedHashSet<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            assertThat(c.path("why").asText()).as("why für %s", c.path("name").asText()).isNotBlank();
            assertThat(namen.add(c.path("name").asText())).as("doppelter Name %s", c.path("name").asText()).isTrue();
        }
    }

    @Test
    void jederWiderspruchIstGepinnt() throws Exception {
        JsonNode root = lies(VECTORS);
        Set<String> namen = new HashSet<>(texte(root.path("cases"), "name"));
        for (JsonNode w : root.path("widersprueche")) {
            for (JsonNode f : w.path("faelle")) {
                assertThat(namen).as(w.path("kennung").asText()).contains(f.asText());
            }
        }
    }

    @Test
    void jedeAktionEinesFallsStehtInDerMatrix() throws Exception {
        Set<String> kennungen = matrix().aktionen().keySet();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            if (c.path("input").has("aktion")) {
                assertThat(kennungen).as(c.path("name").asText()).contains(c.path("input").path("aktion").asText());
            }
        }
    }

    // ------------------------------------------------------ die Vektor-Fälle

    /** Jeder Fall: dasselbe Ergebnis, Feld für Feld, ohne ein Feld zu viel oder zu wenig. */
    @TestFactory
    List<DynamicTest> jederFall() throws Exception {
        Matrix m = matrix();
        ZoneId zone = zone();
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            tests.add(DynamicTest.dynamicTest(
                    c.path("familie").asText() + " · " + c.path("name").asText(), () -> {
                        JsonNode ist = rechne(m, zone, c.path("ableitung").asText(), c.path("input"));
                        List<String> abweichungen = new ArrayList<>();
                        vergleiche(ist, c.path("expected"), "expected", abweichungen);
                        assertThat(abweichungen).as(c.path("why").asText()).isEmpty();
                    }));
        }
        assertThat(tests).hasSizeGreaterThan(100);
        return tests;
    }

    private static JsonNode rechne(Matrix m, ZoneId zone, String ableitung, JsonNode in) {
        return switch (ableitung) {
            case "darf" -> alsJson(RechteAbleitung.darf(m, benutzer(in.path("benutzer")),
                    kundenbereich(in.path("kundenbereich")), in.path("aktion").asText(), ziel(in.path("ziel")),
                    instant(in.path("jetzt"))));
            case "sichtbare_standorte" -> alsJson(RechteAbleitung.sichtbareStandorte(
                    benutzer(in.path("benutzer")), kundenbereich(in.path("kundenbereich")),
                    instant(in.path("jetzt")), zone));
            case "teilansicht" -> {
                ObjectNode o = JSON.objectNode();
                o.set("teilansicht", alsJson(RechteAbleitung.teilansicht(
                        texte(in.path("namen")), in.path("gesamt").asInt(), in.path("unternehmensweit").asBoolean())));
                yield o;
            }
            case "summe" -> alsJson(RechteAbleitung.summe(werte(in.path("werte")), texte(in.path("sichtbar")),
                    in.path("gesamt").asInt()));
            case "geltungsbereich" -> alsJson(RechteAbleitung.geltungsbereich(
                    new Geltungsbereich(in.path("objekt").path("geltungsbereich").path("unternehmen").asBoolean(),
                            texte(in.path("objekt").path("geltungsbereich").path("standorte"))),
                    texte(in.path("sichtbar")), in.path("unternehmensweit").asBoolean()));
            case "ocpp_stufe" -> alsJson(RechteAbleitung.ocppStufe(benutzer(in.path("benutzer")),
                    kundenbereich(in.path("kundenbereich")), in.path("standort").asText(), instant(in.path("jetzt"))));
            case "unterstuetzung" -> alsJson(RechteAbleitung.unterstuetzung(unterstuetzung(in.path("unterstuetzung")),
                    kundenbereich(in.path("kundenbereich")), instant(in.path("jetzt")), zone));
            case "gewaehren" -> alsJson(RechteAbleitung.gewaehren(antrag(in.path("antrag")), zone));
            case "handeingriff" -> {
                JsonNode h = in.path("handeingriff");
                yield alsJson(RechteAbleitung.handeingriff(m,
                        new Handeingriff(h.path("standort").asText(), instant(h.path("bis")),
                                h.path("gesetzt_von").asText(), benutzer(h.path("setzer"))),
                        kundenbereich(in.path("kundenbereich")), instant(in.path("jetzt")), zone));
            }
            case "zuweisung_aendern" -> {
                JsonNode a = in.path("aenderung");
                yield alsJson(RechteAbleitung.zuweisungAendern(m, benutzer(in.path("handelnder")),
                        person(in.path("betroffener")),
                        new Aenderung(AenderungsArt.vonCode(a.path("art").asText()),
                                a.path("rolle").isNull() ? null : Rolle.vonCode(a.path("rolle").asText()),
                                listeOderNull(a.path("standorte"))),
                        kundenbereich(in.path("kundenbereich")), instant(in.path("jetzt"))));
            }
            default -> throw new IllegalArgumentException("unbekannte Ableitung " + ableitung);
        };
    }

    // ------------------------------------------------------ Eingänge lesen

    private static Instant instant(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static List<String> listeOderNull(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : texte(n);
    }

    private static Zuweisung zuweisung(JsonNode z) {
        return new Zuweisung(
                Rolle.vonCode(z.path("rolle").asText()),
                listeOderNull(z.path("standorte")),
                z.path("umfang").isNull() ? null : Umfang.vonCode(z.path("umfang").asText()),
                z.path("art").isNull() ? null : Art.vonCode(z.path("art").asText()),
                instant(z.path("gueltig_ab")),
                instant(z.path("gueltig_bis")),
                instant(z.path("beendet_am")));
    }

    private static Benutzer benutzer(JsonNode b) {
        List<Zuweisung> z = new ArrayList<>();
        b.path("zuweisungen").forEach(x -> z.add(zuweisung(x)));
        return new Benutzer(b.path("kennung").asText(), b.path("name").asText(),
                Konto.vonCode(b.path("konto").asText()), KontoZustand.vonCode(b.path("zustand").asText()), z);
    }

    private static Person person(JsonNode p) {
        return new Person(p.path("kennung").asText(), p.path("name").asText());
    }

    private static Kundenbereich kundenbereich(JsonNode k) {
        List<Standort> s = new ArrayList<>();
        k.path("standorte").forEach(x -> s.add(new Standort(x.path("kennzeichen").asText(), x.path("name").asText())));
        List<Person> p = new ArrayList<>();
        k.path("kundenadministratoren").forEach(x -> p.add(person(x)));
        return new Kundenbereich(k.path("name").asText(), s, p);
    }

    private static Ziel ziel(JsonNode z) {
        if (!z.path("anlage").isNull()) {
            JsonNode a = z.path("anlage");
            List<AnlageStandort> zu = new ArrayList<>();
            a.path("zuordnungen").forEach(x -> zu.add(new AnlageStandort(x.path("standort").asText(),
                    instant(x.path("gueltig_ab")), instant(x.path("gueltig_bis")))));
            return Ziel.anlage(new Anlage(a.path("kennzeichen").asText(), zu), instant(z.path("stichtag")));
        }
        return z.path("standort").isNull() ? Ziel.unternehmen() : Ziel.standort(z.path("standort").asText());
    }

    private static List<Wert> werte(JsonNode w) {
        List<Wert> out = new ArrayList<>();
        w.forEach(x -> out.add(new Wert(x.path("messstelle").asText(), x.path("standort").asText(),
                x.path("kwh").isNull() ? null : x.path("kwh").decimalValue())));
        return out;
    }

    private static Unterstuetzung unterstuetzung(JsonNode u) {
        JsonNode p = u.path("unterstuetzer");
        return new Unterstuetzung(
                Art.vonCode(u.path("art").asText()),
                Umfang.vonCode(u.path("umfang").asText()),
                texte(u.path("standorte")),
                instant(u.path("gewaehrt_am")),
                instant(u.path("gueltig_ab")),
                instant(u.path("gueltig_bis")),
                instant(u.path("beendet_am")),
                u.path("beendet_von").isNull() ? null : u.path("beendet_von").asText(),
                p.isNull() ? null : new Unterstuetzer(p.path("name").asText(), p.path("organisation").asText(),
                        p.path("anzeigename").asText()),
                u.path("grund").isNull() ? null : u.path("grund").asText());
    }

    private static Antrag antrag(JsonNode a) {
        return new Antrag(
                Art.vonCode(a.path("art").asText()),
                a.path("umfang").isNull() ? null : Umfang.vonCode(a.path("umfang").asText()),
                texte(a.path("standorte")),
                instant(a.path("gueltig_ab")),
                instant(a.path("gueltig_bis")),
                a.path("grund").isNull() ? null : a.path("grund").asText());
    }

    // ------------------------------------------------------ Ergebnisse schreiben

    private static JsonNode alsJson(DarfErgebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("darf", e.darf());
        o.put("sichtbar", e.sichtbar());
        o.put("http", e.http());
        o.put("grund", e.grund().code());
        o.put("standort", e.standort());
        o.put("rolle", code(e.rolle()));
        o.put("rolle_noetig", code(e.rolleNoetig()));
        o.put("umfang_noetig", code(e.umfangNoetig()));
        o.put("text", e.text());
        return o;
    }

    private static JsonNode alsJson(SichtErgebnis e) {
        ObjectNode o = JSON.objectNode();
        ArrayNode st = o.putArray("standorte");
        e.standorte().forEach(s -> {
            ObjectNode x = st.addObject();
            x.put("kennzeichen", s.kennzeichen());
            x.put("name", s.name());
            ArrayNode r = x.putArray("rollen");
            s.rollen().forEach(rr -> r.add(rr.code()));
            x.put("umfang", code(s.umfang()));
        });
        o.put("unternehmensweit", e.unternehmensweit());
        ArrayNode k = o.putArray("kuenftig");
        e.kuenftig().forEach(x -> {
            ObjectNode y = k.addObject();
            y.put("standort", x.standort());
            y.put("ab", x.ab().toString());
            y.put("text", x.text());
        });
        o.put("text", e.text());
        o.set("teilansicht", alsJson(e.teilansicht()));
        return o;
    }

    private static JsonNode alsJson(TeilansichtErgebnis t) {
        ObjectNode o = JSON.objectNode();
        o.put("sichtbar", t.sichtbar());
        o.put("gesamt", t.gesamt());
        o.put("unternehmensebene", t.unternehmensebene());
        o.put("teilansicht", t.teilansicht());
        o.put("kopfzeile", t.kopfzeile());
        o.put("export_kopfzeile", t.exportKopfzeile());
        o.put("unternehmensweite_objekte", t.unternehmensweiteObjekte());
        return o;
    }

    private static JsonNode alsJson(SummeErgebnis s) {
        ObjectNode o = JSON.objectNode();
        o.put("kwh", s.kwh());
        ArrayNode m = o.putArray("messstellen");
        s.messstellen().forEach(m::add);
        ObjectNode t = o.putObject("teilansicht");
        t.put("sichtbar", s.sichtbar());
        t.put("gesamt", s.gesamt());
        return o;
    }

    private static JsonNode alsJson(GeltungErgebnis g) {
        ObjectNode o = JSON.objectNode();
        o.put("sichtbar", g.sichtbar());
        o.put("hinweis", g.hinweis());
        return o;
    }

    private static JsonNode alsJson(OcppErgebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("stufe", e.stufe().code());
        o.put("sichtbar", e.sichtbar());
        o.put("rolle", code(e.rolle()));
        return o;
    }

    private static JsonNode alsJson(UnterstuetzungErgebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("zustand", e.zustand().code());
        o.put("endet", e.endet() == null ? null : e.endet().toString());
        o.put("beendet_durch", e.beendetDurch());
        o.put("banner_kunde", e.bannerKunde());
        o.put("banner_unterstuetzer", e.bannerUnterstuetzer());
        o.put("urheber", e.urheber());
        o.put("erinnerung", e.erinnerung());
        o.put("text", e.text());
        return o;
    }

    private static JsonNode alsJson(GewaehrenErgebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("gueltig", e.gueltig());
        o.put("http", e.http());
        o.put("grund", e.grund().code());
        o.put("text", e.text());
        o.put("umfang", code(e.umfang()));
        o.put("endet", e.endet() == null ? null : e.endet().toString());
        return o;
    }

    private static JsonNode alsJson(HandeingriffErgebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("wirkt", e.wirkt());
        o.put("etikett", e.etikett());
        return o;
    }

    private static JsonNode alsJson(AenderungErgebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("erlaubt", e.erlaubt());
        o.put("http", e.http());
        o.put("grund", e.grund().code());
        o.put("rolle_noetig", code(e.rolleNoetig()));
        o.put("text", e.text());
        return o;
    }

    private static String code(Code c) {
        return c == null ? null : c.code();
    }

    /** Vergleicht Feld für Feld; Zeitpunkte als Instant, Zahlen als Dezimalzahl. */
    private static void vergleiche(JsonNode ist, JsonNode soll, String pfad, List<String> out) {
        if (soll.isObject()) {
            if (!ist.isObject()) {
                out.add(pfad + ": erwartet Objekt, ist " + ist);
                return;
            }
            Set<String> felder = new TreeSet<>();
            soll.fieldNames().forEachRemaining(felder::add);
            ist.fieldNames().forEachRemaining(felder::add);
            for (String f : felder) {
                if (!soll.has(f) || !ist.has(f)) {
                    out.add(pfad + "." + f + ": nur " + (soll.has(f) ? "erwartet" : "gerechnet"));
                } else {
                    vergleiche(ist.get(f), soll.get(f), pfad + "." + f, out);
                }
            }
        } else if (soll.isArray()) {
            if (!ist.isArray() || ist.size() != soll.size()) {
                out.add(pfad + ": erwartet " + soll + ", ist " + ist);
                return;
            }
            for (int i = 0; i < soll.size(); i++) {
                vergleiche(ist.get(i), soll.get(i), pfad + "[" + i + "]", out);
            }
        } else if (soll.isNumber()) {
            if (!ist.isNumber() || soll.decimalValue().compareTo(ist.decimalValue()) != 0) {
                out.add(pfad + ": erwartet " + soll + ", ist " + ist);
            }
        } else if (soll.isTextual() && zeitpunkt(soll.asText()) != null) {
            Instant i = ist.isTextual() ? zeitpunkt(ist.asText()) : null;
            if (!zeitpunkt(soll.asText()).equals(i)) {
                out.add(pfad + ": erwartet " + soll + ", ist " + ist);
            }
        } else if (!soll.equals(ist)) {
            out.add(pfad + ": erwartet " + soll + ", ist " + ist);
        }
    }

    private static Instant zeitpunkt(String s) {
        try {
            return OffsetDateTime.parse(s).toInstant();
        } catch (DateTimeParseException e) {
            try {
                return Instant.parse(s);
            } catch (DateTimeParseException e2) {
                return null;
            }
        }
    }

    // ------------------------------------------------ Referenzunternehmen

    /**
     * Jede Tatsache eines Falls steht so im Referenzunternehmen: Personen samt Zuweisung und
     * Konto, Standorte samt Namen, Kundenadministratoren, Anlagen samt Standort-Zuordnung,
     * Werte je Messstelle samt Standort, Unterstützungen, Geltungsbereiche aus den Eingängen.
     * Was die Datei nicht kennt, muss der Fall in {@code annahme} nennen.
     */
    @TestFactory
    List<DynamicTest> jederFallStehtImReferenzunternehmen() throws Exception {
        JsonNode ref = lies(REFERENZ);
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<String> fehler = new ArrayList<>();
                new Referenz(ref, !c.path("annahme").isNull(), fehler).pruefe(c.path("input"));
                assertThat(fehler).as(c.path("name").asText()).isEmpty();
            }));
        }
        return tests;
    }

    /** Die Prüfung eines Falls gegen die Referenzdatei. */
    private static final class Referenz {
        private final JsonNode ref;
        private final boolean annahme;
        private final List<String> fehler;
        private final Map<String, JsonNode> personen = new HashMap<>();
        private final Map<String, String> standorte = new LinkedHashMap<>();
        private final Map<String, JsonNode> messstellen = new HashMap<>();
        private final Map<String, String> gebaeude = new HashMap<>();
        private final Map<String, JsonNode> bereiche = new HashMap<>();

        Referenz(JsonNode ref, boolean annahme, List<String> fehler) {
            this.ref = ref;
            this.annahme = annahme;
            this.fehler = fehler;
            ref.path("personen").forEach(p -> personen.put(p.path("kuerzel").asText(), p));
            ref.path("standorte").forEach(s -> standorte.put(s.path("kennzeichen").asText(), s.path("name").asText()));
            ref.path("messstellen").forEach(m -> messstellen.put(m.path("kennzeichen").asText(), m));
            ref.path("gebaeude").forEach(g -> gebaeude.put(g.path("kennzeichen").asText(), g.path("standort").asText()));
            ref.path("bereiche").forEach(b -> bereiche.put(b.path("kennzeichen").asText(), b));
        }

        void pruefe(JsonNode in) {
            for (String f : List.of("benutzer", "handelnder")) {
                if (in.has(f)) {
                    benutzer(in.path(f));
                }
            }
            if (in.has("handeingriff")) {
                benutzer(in.path("handeingriff").path("setzer"));
                standort(in.path("handeingriff").path("standort").asText(), null);
            }
            if (in.has("betroffener")) {
                person(in.path("betroffener"));
            }
            if (in.has("kundenbereich")) {
                kundenbereich(in.path("kundenbereich"));
            }
            if (in.has("ziel")) {
                JsonNode z = in.path("ziel");
                if (!z.path("standort").isNull()) {
                    standort(z.path("standort").asText(), null);
                }
                if (!z.path("anlage").isNull()) {
                    anlage(z.path("anlage"));
                }
            }
            if (in.has("standort")) {
                standort(in.path("standort").asText(), null);
            }
            if (in.has("namen")) {
                in.path("namen").forEach(n -> {
                    if (!standorte.containsValue(n.asText()) && !annahme) {
                        fehler.add("Standort-Name " + n.asText() + " kennt die Referenzdatei nicht");
                    }
                });
            }
            if (in.has("werte")) {
                werte(in.path("zeitraum").asText(), in.path("werte"));
            }
            if (in.has("objekt")) {
                objekt(in.path("objekt"));
            }
            if (in.has("sichtbar") && in.hasNonNull("person")) {
                sichtbarWiePerson(in.path("person").asText(), texte(in.path("sichtbar")),
                        in.path("unternehmensweit").asBoolean(false));
            }
            if (in.has("unterstuetzung")) {
                unterstuetzung(in.path("unterstuetzung"));
            }
            if (in.has("antrag")) {
                in.path("antrag").path("standorte").forEach(s -> standort(s.asText(), null));
            }
            if (in.has("aenderung") && !in.path("aenderung").path("standorte").isNull()) {
                in.path("aenderung").path("standorte").forEach(s -> standort(s.asText(), null));
            }
        }

        private void unbekannt(String was) {
            if (!annahme) {
                fehler.add(was + " kennt die Referenzdatei nicht — der Fall muss es annehmen");
            }
        }

        private void standort(String kennzeichen, String name) {
            if (!standorte.containsKey(kennzeichen)) {
                unbekannt("Standort " + kennzeichen);
            } else if (name != null && !name.equals(standorte.get(kennzeichen))) {
                fehler.add("Standort " + kennzeichen + " heißt „" + standorte.get(kennzeichen) + "“, nicht „" + name + "“");
            }
        }

        private void kundenbereich(JsonNode k) {
            if (!k.path("name").asText().equals(ref.path("unternehmen").path("name").asText())) {
                fehler.add("Kundenbereich heißt " + ref.path("unternehmen").path("name").asText());
            }
            k.path("standorte").forEach(s -> standort(s.path("kennzeichen").asText(), s.path("name").asText()));
            for (JsonNode p : k.path("kundenadministratoren")) {
                JsonNode rp = personen.get(p.path("kennung").asText());
                if (rp == null || !rp.path("name").asText().equals(p.path("name").asText())) {
                    fehler.add("Kundenadministrator " + p + " passt zu keiner Person");
                } else if (!rp.path("rolle").asText().equals("Kundenadministrator")) {
                    unbekannt(p.path("name").asText() + " als Kundenadministrator");
                }
            }
        }

        private void person(JsonNode p) {
            JsonNode rp = personen.get(p.path("kennung").asText());
            if (rp == null) {
                unbekannt("Person " + p.path("kennung").asText());
            } else if (!rp.path("name").asText().equals(p.path("name").asText())) {
                fehler.add("Person " + p.path("kennung").asText() + " heißt " + rp.path("name").asText());
            }
        }

        private void benutzer(JsonNode b) {
            person(b);
            b.path("zuweisungen").forEach(z -> {
                if (!z.path("standorte").isNull()) {
                    z.path("standorte").forEach(s -> standort(s.asText(), null));
                }
            });
            JsonNode rp = personen.get(b.path("kennung").asText());
            if (rp == null || annahme) {
                return;
            }
            String konto = rp.path("art").asText().equals("benutzer")
                    ? "benutzer"
                    : rp.path("unterstuetzung").path("organisation").asText().equals("VoltPilot") ? "plattform" : "partner";
            if (!b.path("konto").asText().equals(konto)) {
                fehler.add(b.path("kennung").asText() + ": Konto " + konto + ", nicht " + b.path("konto").asText());
            }
            if (!b.path("zustand").asText().equals("aktiv")) {
                fehler.add(b.path("kennung").asText() + ": die Referenzdatei führt das Konto aktiv");
            }
            JsonNode z = b.path("zuweisungen");
            ObjectNode soll = JSON.objectNode();
            soll.put("rolle", rolleCode(rp.path("rolle").asText()));
            if (rp.path("geltungsbereich_art").asText().equals("unternehmen")) {
                soll.putNull("standorte");
            } else {
                ArrayNode s = soll.putArray("standorte");
                rp.path("standorte").forEach(x -> s.add(x.asText()));
            }
            JsonNode u = rp.path("unterstuetzung");
            soll.put("umfang", u.isNull() ? null : umfangCode(u.path("umfang").asText()));
            soll.put("art", u.isNull() ? null
                    : u.path("organisation").asText().equals("VoltPilot") ? "voltpilot" : "installateur");
            soll.put("gueltig_ab", rp.path("seit").asText());
            soll.set("gueltig_bis", rp.path("gueltig_bis"));
            soll.putNull("beendet_am");
            List<String> abw = new ArrayList<>();
            if (z.size() != 1) {
                abw.add("genau eine Zuweisung erwartet");
            } else {
                vergleiche(z.get(0), soll, "zuweisung", abw);
            }
            abw.forEach(a -> fehler.add(b.path("kennung").asText() + ": " + a));
        }

        private void anlage(JsonNode a) {
            JsonNode ra = null;
            for (JsonNode x : ref.path("anlagen")) {
                if (x.path("kennzeichen").asText().equals(a.path("kennzeichen").asText())) {
                    ra = x;
                }
            }
            if (ra == null) {
                unbekannt("Anlage " + a.path("kennzeichen").asText());
                return;
            }
            ArrayNode soll = JSON.arrayNode();
            for (JsonNode z : ref.path("zuordnungen")) {
                if (z.path("art").asText().equals("anlage_standort")
                        && z.path("von").asText().equals(a.path("kennzeichen").asText())) {
                    ObjectNode o = soll.addObject();
                    o.put("standort", z.path("nach").asText());
                    o.put("gueltig_ab", z.path("gueltig_ab").asText());
                    o.set("gueltig_bis", z.path("gueltig_bis"));
                }
            }
            a.path("zuordnungen").forEach(z -> standort(z.path("standort").asText(), null));
            List<String> abw = new ArrayList<>();
            if (annahme) {
                // Mit Annahme darf die Zuordnung weitergehen — ihr ANFANG bleibt der der Datei.
                vergleiche(a.path("zuordnungen").path(0).path("standort"), soll.path(0).path("standort"), "anfang", abw);
                vergleiche(a.path("zuordnungen").path(0).path("gueltig_ab"), soll.path(0).path("gueltig_ab"), "anfang", abw);
            } else {
                vergleiche(a.path("zuordnungen"), soll, "zuordnungen", abw);
            }
            abw.forEach(x -> fehler.add(a.path("kennzeichen").asText() + ": " + x));
        }

        /** Der Standort einer Messstelle über Ort → Bereich → Gebäude → Standort; null = Unternehmen. */
        private String standortVon(String messstelle) {
            JsonNode ort = messstellen.get(messstelle).path("ort");
            String art = ort.path("art").asText();
            String k = ort.path("kennzeichen").asText();
            while (art.equals("bereich")) {
                JsonNode b = bereiche.get(k);
                art = b.path("eltern_art").asText();
                k = b.path("eltern").asText();
            }
            return switch (art) {
                case "standort" -> k;
                case "gebaeude" -> gebaeude.get(k);
                default -> null;
            };
        }

        private void werte(String zeitraum, JsonNode werte) {
            for (JsonNode w : werte) {
                String ms = w.path("messstelle").asText();
                if (!messstellen.containsKey(ms)) {
                    unbekannt("Messstelle " + ms);
                    continue;
                }
                standort(w.path("standort").asText(), null);
                JsonNode beispiel = messstellen.get(ms).path("beispielwerte").path(zeitraum + "_kwh");
                if (beispiel.isMissingNode()) {
                    unbekannt("Wert " + ms + " für " + zeitraum);
                    continue;
                }
                List<String> abw = new ArrayList<>();
                vergleiche(w.path("kwh"), beispiel, ms + " " + zeitraum, abw);
                if (!w.path("standort").asText().equals(standortVon(ms))) {
                    abw.add(ms + " liegt in " + standortVon(ms));
                }
                fehler.addAll(abw);
            }
        }

        private void objekt(JsonNode o) {
            JsonNode g = o.path("geltungsbereich");
            g.path("standorte").forEach(s -> standort(s.asText(), null));
            if (o.path("eingaenge").isNull()) {
                return;
            }
            Set<String> aus = new TreeSet<>();
            boolean unternehmen = false;
            for (JsonNode e : o.path("eingaenge")) {
                if (!messstellen.containsKey(e.asText())) {
                    unbekannt("Messstelle " + e.asText());
                    return;
                }
                String s = standortVon(e.asText());
                if (s == null) {
                    unternehmen = true;
                } else {
                    aus.add(s);
                }
            }
            if (unternehmen != g.path("unternehmen").asBoolean()
                    || (!unternehmen && !aus.equals(new TreeSet<>(texte(g.path("standorte")))))) {
                fehler.add("Geltungsbereich " + g + " passt nicht zu den Eingängen (" + aus + ")");
            }
        }

        private void sichtbarWiePerson(String kuerzel, List<String> sichtbar, boolean unternehmensweit) {
            JsonNode rp = personen.get(kuerzel);
            if (rp == null) {
                unbekannt("Person " + kuerzel);
                return;
            }
            if (annahme) {
                return;
            }
            boolean uw = rp.path("geltungsbereich_art").asText().equals("unternehmen");
            List<String> soll = uw ? new ArrayList<>(standorte.keySet()) : texte(rp.path("standorte"));
            if (!new TreeSet<>(soll).equals(new TreeSet<>(sichtbar))) {
                fehler.add(kuerzel + " sieht laut Referenzdatei " + soll + ", nicht " + sichtbar);
            }
        }

        private void unterstuetzung(JsonNode u) {
            u.path("standorte").forEach(s -> standort(s.asText(), null));
            JsonNode p = u.path("unterstuetzer");
            if (p.isNull()) {
                if (!annahme) {
                    fehler.add("eine Unterstützung ohne Person kennt die Referenzdatei nicht");
                }
                return;
            }
            JsonNode rp = personen.get(p.path("kennung").asText());
            if (rp == null || rp.path("unterstuetzung").isNull()) {
                unbekannt("Unterstützer " + p.path("kennung").asText());
                return;
            }
            JsonNode ru = rp.path("unterstuetzung");
            if (!rp.path("name").asText().equals(p.path("name").asText())
                    || !ru.path("organisation").asText().equals(p.path("organisation").asText())) {
                fehler.add("Unterstützer " + p + " passt nicht zu " + rp.path("name").asText());
            }
            if (annahme) {
                return;
            }
            ObjectNode soll = JSON.objectNode();
            soll.put("umfang", umfangCode(ru.path("umfang").asText()));
            soll.put("gewaehrt_am", ru.path("gewaehrt_am").asText());
            soll.put("gueltig_ab", rp.path("seit").asText());
            soll.set("gueltig_bis", rp.path("gueltig_bis"));
            ArrayNode s = soll.putArray("standorte");
            rp.path("standorte").forEach(x -> s.add(x.asText()));
            ObjectNode ist = JSON.objectNode();
            soll.fieldNames().forEachRemaining(f -> ist.set(f, u.path(f)));
            List<String> abw = new ArrayList<>();
            vergleiche(ist, soll, "unterstuetzung", abw);
            fehler.addAll(abw);
        }

        private static String rolleCode(String kundenwort) {
            for (Rolle r : Rolle.values()) {
                if (r.kundenwort().equals(kundenwort)) {
                    return r.code();
                }
            }
            throw new IllegalArgumentException("Rolle " + kundenwort);
        }

        private static String umfangCode(String kundenwort) {
            for (Umfang u : Umfang.values()) {
                if (u.kundenwort().equals(kundenwort)) {
                    return u.code();
                }
            }
            throw new IllegalArgumentException("Umfang " + kundenwort);
        }
    }

    // ------------------------------------------------------------------ Hilfen

    private static List<String> texte(JsonNode n) {
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.asText()));
        return out;
    }

    private static List<String> texte(JsonNode n, String feld) {
        List<String> out = new ArrayList<>();
        n.forEach(x -> out.add(x.path(feld).asText()));
        return out;
    }

    private static List<String> codes(Code[] werte) {
        return Arrays.stream(werte).map(Code::code).toList();
    }

    /** Die Zelle A ≤ Ei ≤ B hängt an der Reihenfolge des Umfangs — sie IST die Regel. */
    @Test
    void dieUmfaengeSindAufsteigend() {
        assertThat(Umfang.EINRICHTEN_UND_BEDIENEN.compareTo(Umfang.EINRICHTEN)).isPositive();
        assertThat(Umfang.EINRICHTEN.compareTo(Umfang.ANSEHEN)).isPositive();
    }
}
