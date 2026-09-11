package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.DatenquelleRegeln.Antrag;
import com.voltpilot.api.uems.DatenquelleRegeln.AntragErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Art;
import com.voltpilot.api.uems.DatenquelleRegeln.BestandKomponente;
import com.voltpilot.api.uems.DatenquelleRegeln.BoxLiest;
import com.voltpilot.api.uems.DatenquelleRegeln.FaehigkeitStatus;
import com.voltpilot.api.uems.DatenquelleRegeln.FaehigkeitenErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Fehlerklasse;
import com.voltpilot.api.uems.DatenquelleRegeln.FuehrungsErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Grund;
import com.voltpilot.api.uems.DatenquelleRegeln.Herkunft;
import com.voltpilot.api.uems.DatenquelleRegeln.Kandidat;
import com.voltpilot.api.uems.DatenquelleRegeln.Pruefung;
import com.voltpilot.api.uems.DatenquelleRegeln.Quelle;
import com.voltpilot.api.uems.DatenquelleRegeln.QuellenZeitraeume;
import com.voltpilot.api.uems.DatenquelleRegeln.Rolle;
import com.voltpilot.api.uems.DatenquelleRegeln.Stand;
import com.voltpilot.api.uems.DatenquelleRegeln.TabellenEintrag;
import com.voltpilot.api.uems.DatenquelleRegeln.TauschErgebnis;
import com.voltpilot.api.uems.DatenquelleRegeln.Vorschlag;
import com.voltpilot.api.uems.DatenquelleRegeln.Zeitraum;
import com.voltpilot.api.uems.DatenquelleRegeln.ZeitraumErgebnis;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings: {@link DatenquelleRegeln} zieht aus JEDEM Fall der EINEN
 * geteilten Vektor-Datei ({@code docs/contracts/v2/data-source-vectors.json}) dasselbe Urteil
 * und denselben Kundensatz wie der TS-Zwilling ({@code frontend/portal/src/uemsDatenquelle.test.ts}
 * fährt dieselbe Datei). Die Datei hält ihr Schema ({@link UemsSchemaLaeufer}), die
 * Fähigkeiten-Tabelle {@code edge-capabilities.json} ebenso, und jede Tatsache eines Falls über
 * ein Ahrenberg-Objekt steht so im Referenzunternehmen.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class DatenquelleRegelnVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("data-source-vectors.json");
    private static final Path SCHEMA = V2.resolve("data-source-assignment.schema.json");
    private static final Path TABELLE = V2.resolve("edge-capabilities.json");
    private static final Path TABELLE_SCHEMA = V2.resolve("edge-capabilities.schema.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    /** Die Abbildung des Referenz-Protokolls auf das geschlossene Vokabular (Kopf der Vektor-Datei). */
    private static final Map<String, String> PROTOKOLL_AUS_REFERENZ =
            Map.of("Modbus TCP", "modbus_tcp", "OCPP 1.6J", "ocpp");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static JsonNode vectors() throws Exception {
        return lies(VECTORS);
    }

    // ------------------------------------------------------------------ Hilfen

    private static Instant instant(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        return OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static ZoneId zone(JsonNode in) {
        JsonNode z = in.path("zeitzone");
        return z.isMissingNode() || z.isNull() ? ZustandAbleitung.VORGABE_ZEITZONE : ZoneId.of(z.asText());
    }

    private static Zeitraum zeitraum(JsonNode z) {
        return new Zeitraum(z.path("box").asText(), instant(z.get("effective_from")), instant(z.get("effective_to")));
    }

    private static List<Zeitraum> zeitraeume(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        List<Zeitraum> out = new ArrayList<>();
        n.forEach(z -> out.add(zeitraum(z)));
        return out;
    }

    private static List<String> texte(JsonNode arr) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.isNull() ? null : n.asText()));
        return out;
    }

    private static Map<String, String> boxNamen(JsonNode boxen) {
        Map<String, String> m = new LinkedHashMap<>();
        boxen.forEach(b -> m.put(b.path("kennzeichen").asText(), b.path("name").asText()));
        return m;
    }

    private static Quelle quelle(JsonNode q) {
        return new Quelle(q.path("kennzeichen").asText(), q.path("protokoll").asText(), q.path("adresse").asText(),
                text(q.get("netz")), q.path("steuerquelle").asBoolean(), q.path("mehrere_leser").asBoolean(),
                zeitraeume(q.path("zeitraeume")));
    }

    private static List<Quelle> quellen(JsonNode arr) {
        List<Quelle> out = new ArrayList<>();
        arr.forEach(q -> out.add(quelle(q)));
        return out;
    }

    private static List<TabellenEintrag> tabelle(JsonNode arr) {
        List<TabellenEintrag> out = new ArrayList<>();
        arr.forEach(e -> out.add(new TabellenEintrag(e.path("code").asText(), e.path("name").asText(),
                text(e.get("ab_release")))));
        return out;
    }

    private static List<DynamicTest> faelle(String familie, Consumer<JsonNode> pruefe) throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (familie.equals(c.path("familie").asText())) {
                tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> pruefe.accept(c)));
            }
        }
        assertThat(tests).as("Fälle der Familie %s", familie).isNotEmpty();
        return tests;
    }

    // ------------------------------------------------------ die Vektor-Fälle

    @TestFactory
    List<DynamicTest> antrag() throws Exception {
        return faelle("antrag", c -> {
            JsonNode in = c.path("input");
            JsonNode a = in.path("antrag");
            JsonNode k = a.path("kandidat");
            JsonNode p = a.path("pruefung");
            List<Integer> ids = new ArrayList<>();
            k.path("geraete_ids").forEach(i -> ids.add(i.asInt()));
            Antrag antrag = new Antrag(
                    "wechsel".equals(a.path("art").asText()) ? Art.WECHSEL : Art.ANLEGEN,
                    text(a.get("quelle")),
                    k.isMissingNode() ? null : new Kandidat(k.path("protokoll").asText(), k.path("adresse").asText(),
                            text(k.get("netz")), ids, k.path("mehrere_leser").asBoolean()),
                    a.path("box").asText(),
                    instant(a.get("effective_from")),
                    p.isNull() ? null : new Pruefung(p.path("box").asText(), p.path("ergebnis").asText(),
                            instant(p.get("zeitpunkt"))),
                    a.path("vergleich_bestaetigt").asBoolean());
            AntragErgebnis ist = DatenquelleRegeln.pruefeAntrag(antrag, quellen(in.path("quellen")),
                    boxNamen(in.path("boxen")), instant(in.get("jetzt")), zone(in));
            JsonNode exp = c.path("expected");
            assertThat(ist.urteil().code()).isEqualTo(exp.path("urteil").asText());
            assertThat(ist.grund() == null ? null : ist.grund().code()).isEqualTo(text(exp.get("grund")));
            assertThat(ist.text()).isEqualTo(exp.path("text").asText());
            assertThat(ist.hinweis()).isEqualTo(text(exp.get("hinweis")));
            assertThat(ist.vergleichsquelle()).isEqualTo(exp.path("vergleichsquelle").asBoolean());
            assertThat(ist.zeitraeume()).isEqualTo(zeitraeume(exp.get("zeitraeume")));
        });
    }

    @TestFactory
    List<DynamicTest> zeitraeume() throws Exception {
        return faelle("zeitraeume", c -> {
            JsonNode in = c.path("input");
            ZeitraumErgebnis ist = DatenquelleRegeln.pruefeZeitraum(zeitraeume(in.path("bestehend")),
                    zeitraum(in.path("neu")), boxNamen(in.path("boxen")));
            JsonNode exp = c.path("expected");
            assertThat(ist.gueltig()).isEqualTo(exp.path("gueltig").asBoolean());
            assertThat(ist.grund() == null ? null : ist.grund().code()).isEqualTo(text(exp.get("grund")));
            assertThat(ist.text()).isEqualTo(text(exp.get("text")));
        });
    }

    @TestFactory
    List<DynamicTest> zustaendig() throws Exception {
        return faelle("zustaendig", c -> {
            JsonNode in = c.path("input");
            List<Zeitraum> zs = zeitraeume(in.path("zeitraeume"));
            List<String> ist = new ArrayList<>();
            in.path("zeitpunkte").forEach(t -> ist.add(DatenquelleRegeln.zustaendigeBox(zs, instant(t))));
            assertThat(ist).isEqualTo(texte(c.path("expected").path("boxen")));
        });
    }

    @TestFactory
    List<DynamicTest> boxTausch() throws Exception {
        return faelle("box_tausch", c -> {
            JsonNode in = c.path("input");
            JsonNode t = in.path("tausch");
            TauschErgebnis ist = DatenquelleRegeln.boxTausch(quellen(in.path("quellen")), rolle(t.path("alt")),
                    t.path("neu").asText(), instant(t.get("zeitpunkt")), instant(in.get("jetzt")),
                    boxNamen(in.path("boxen")), zone(in));
            JsonNode exp = c.path("expected");
            assertThat(ist.urteil().code()).isEqualTo(exp.path("urteil").asText());
            assertThat(ist.grund() == null ? null : ist.grund().code()).isEqualTo(text(exp.get("grund")));
            assertThat(ist.text()).isEqualTo(exp.path("text").asText());
            if (exp.path("quellen").isNull()) {
                assertThat(ist.quellen()).isNull();
                assertThat(ist.neu()).isNull();
                return;
            }
            List<QuellenZeitraeume> soll = new ArrayList<>();
            exp.path("quellen").forEach(q -> soll.add(
                    new QuellenZeitraeume(q.path("kennzeichen").asText(), zeitraeume(q.path("zeitraeume")))));
            assertThat(ist.quellen()).isEqualTo(soll);
            assertThat(ist.neu()).isEqualTo(rolle(exp.path("neu")));
        });
    }

    private static Rolle rolle(JsonNode r) {
        return new Rolle(r.path("kennzeichen").asText(), r.path("heimat_anlage").asText(),
                texte(r.path("fuehrend_fuer")));
    }

    @TestFactory
    List<DynamicTest> fuehrendeBox() throws Exception {
        return faelle("fuehrende_box", c -> {
            JsonNode in = c.path("input");
            List<BoxLiest> boxen = new ArrayList<>();
            in.path("boxen").forEach(b -> boxen.add(
                    new BoxLiest(b.path("kennzeichen").asText(), b.path("name").asText(), b.path("liest").asInt())));
            FuehrungsErgebnis ist = DatenquelleRegeln.fuehrendeBox(boxen, text(in.get("speicher_box")),
                    text(in.get("gespeichert")));
            JsonNode exp = c.path("expected");
            assertThat(ist.box()).isEqualTo(text(exp.get("box")));
            assertThat(ist.grund().code()).isEqualTo(exp.path("grund").asText());
            assertThat(ist.text()).isEqualTo(exp.path("text").asText());
            List<DatenquelleRegeln.BoxRolle> rollen = new ArrayList<>();
            exp.path("rollen").forEach(r -> rollen.add(
                    new DatenquelleRegeln.BoxRolle(r.path("box").asText(), r.path("text").asText())));
            assertThat(ist.rollen()).isEqualTo(rollen);
        });
    }

    @TestFactory
    List<DynamicTest> faehigkeiten() throws Exception {
        JsonNode datei = lies(TABELLE).path("faehigkeiten");
        return faelle("faehigkeiten", c -> {
            JsonNode in = c.path("input");
            JsonNode s = in.path("stand");
            List<String> supports = s.path("supports").isNull() ? null : texte(s.path("supports"));
            // Ohne eigene Tabelle liest der Fall die ECHTE Datei (A7).
            List<TabellenEintrag> tab = tabelle(in.has("tabelle") ? in.path("tabelle") : datei);
            FaehigkeitenErgebnis ist = DatenquelleRegeln.faehigkeiten(
                    new Stand(text(s.get("version")), text(s.get("release")), supports), tab,
                    texte(in.path("register")));
            List<FaehigkeitStatus> soll = new ArrayList<>();
            c.path("expected").path("faehigkeiten").forEach(f -> soll.add(new FaehigkeitStatus(
                    f.path("code").asText(), "vorhanden".equals(f.path("status").asText()),
                    "supports".equals(f.path("nachweis").asText())
                            ? DatenquelleRegeln.Nachweis.SUPPORTS
                            : DatenquelleRegeln.Nachweis.TABELLE)));
            assertThat(ist.faehigkeiten()).isEqualTo(soll);
            assertThat(ist.text()).isEqualTo(c.path("expected").path("text").asText());
        });
    }

    @TestFactory
    List<DynamicTest> fehlerklasse() throws Exception {
        return faelle("fehlerklasse", c -> {
            JsonNode in = c.path("input");
            Optional<Fehlerklasse> ist = DatenquelleRegeln.fehlerklasse(in.path("code").asText(),
                    Herkunft.vonCode(in.path("von").asText()));
            JsonNode exp = c.path("expected");
            assertThat(ist.map(Fehlerklasse::code).orElse(null)).isEqualTo(text(exp.get("klasse")));
            assertThat(ist.map(Fehlerklasse::kundenwort).orElse(null)).isEqualTo(text(exp.get("name")));
        });
    }

    @TestFactory
    List<DynamicTest> bestand() throws Exception {
        return faelle("bestand", c -> {
            JsonNode in = c.path("input");
            List<BestandKomponente> ks = new ArrayList<>();
            in.path("komponenten").forEach(k -> ks.add(new BestandKomponente(k.path("kennzeichen").asText(),
                    k.path("anlage").asText(), k.path("box").asText(), k.path("protokoll").asText(),
                    k.path("adresse").asText(), k.path("geraete_id").isNull() ? null : k.path("geraete_id").asInt(),
                    instant(k.get("in_betrieb_ab")), k.path("steuerbar").asBoolean())));
            List<Vorschlag> ist = DatenquelleRegeln.vorschlagsliste(ks, in.path("naechste_nummer").asInt());
            List<Vorschlag> soll = new ArrayList<>();
            c.path("expected").path("vorschlaege").forEach(v -> {
                List<Integer> ids = new ArrayList<>();
                v.path("geraete_ids").forEach(i -> ids.add(i.asInt()));
                soll.add(new Vorschlag(v.path("kennzeichen").asText(), v.path("anlage").asText(),
                        v.path("box").asText(), v.path("protokoll").asText(), v.path("adresse").asText(), ids,
                        texte(v.path("komponenten")), v.path("steuerquelle").asBoolean(),
                        zeitraeume(v.path("zeitraeume"))));
            });
            assertThat(ist).isEqualTo(soll);
        });
    }

    // ---------------------------------------------------- die Datei als Ganzes

    @Test
    void dieDateienHaltenIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(vectors(), lies(SCHEMA))).as("Vektor-Datei").isEmpty();
        assertThat(UemsSchemaLaeufer.verstoesse(lies(TABELLE), lies(TABELLE_SCHEMA))).as("Fähigkeiten").isEmpty();
    }

    /** Das Vokabular ist wirklich geschlossen — und die Reihenfolgen SIND die Regel. */
    @Test
    void dasVokabularIstDasselbe() throws Exception {
        JsonNode root = vectors();
        List<String> protokolle = new ArrayList<>();
        root.path("protokolle").forEach(p -> protokolle.add(p.path("code").asText() + "=" + p.path("name").asText()));
        List<String> javaProtokolle = new ArrayList<>();
        for (DatenquelleRegeln.Protokoll p : DatenquelleRegeln.Protokoll.values()) {
            javaProtokolle.add(p.code() + "=" + p.kundenwort());
        }
        assertThat(javaProtokolle).containsExactlyElementsOf(protokolle);

        List<String> urteile = new ArrayList<>();
        for (DatenquelleRegeln.Urteil u : DatenquelleRegeln.Urteil.values()) {
            urteile.add(u.code());
        }
        assertThat(urteile).containsExactlyElementsOf(texte(root.path("urteile")));

        List<String> gruende = new ArrayList<>();
        root.path("gruende").forEach(g -> gruende.add(
                g.path("code").asText() + "|" + g.path("urteil").asText() + "|" + g.path("text").asText()));
        List<String> javaGruende = new ArrayList<>();
        for (Grund g : Grund.values()) {
            javaGruende.add(g.code() + "|" + g.urteil().code() + "|" + g.text());
        }
        assertThat(javaGruende).containsExactlyElementsOf(gruende);

        assertThat(codes(DatenquelleRegeln.PRUEFREIHENFOLGE_ANTRAG))
                .containsExactlyElementsOf(texte(root.path("pruefreihenfolge_antrag")));
        assertThat(codes(DatenquelleRegeln.PRUEFREIHENFOLGE_ZEITRAUM))
                .containsExactlyElementsOf(texte(root.path("pruefreihenfolge_zeitraum")));
        assertThat(codes(DatenquelleRegeln.PRUEFREIHENFOLGE_TAUSCH))
                .containsExactlyElementsOf(texte(root.path("pruefreihenfolge_tausch")));

        List<String> klassen = new ArrayList<>();
        root.path("fehlerklassen").forEach(k -> klassen.add(k.path("code").asText() + "|" + k.path("name").asText()
                + "|" + k.path("von").asText() + "|" + k.path("text").asText()));
        List<String> javaKlassen = new ArrayList<>();
        for (Fehlerklasse k : Fehlerklasse.values()) {
            javaKlassen.add(k.code() + "|" + k.kundenwort() + "|" + k.von().code() + "|" + k.text());
        }
        assertThat(javaKlassen).containsExactlyElementsOf(klassen);

        List<String> fuehrung = new ArrayList<>();
        for (DatenquelleRegeln.FuehrungsGrund g : DatenquelleRegeln.FuehrungsGrund.values()) {
            fuehrung.add(g.code());
        }
        assertThat(fuehrung).containsExactlyElementsOf(texte(root.path("gruende_fuehrende_box")));
        assertThat(MAPPER.convertValue(root.path("texte"), Map.class)).isEqualTo(DatenquelleRegeln.TEXTE);
        assertThat(root.path("zeitzone").asText()).isEqualTo(ZustandAbleitung.VORGABE_ZEITZONE.getId());
    }

    private static List<String> codes(List<Grund> gruende) {
        return gruende.stream().map(Grund::code).toList();
    }

    /** Jede Familie hat Fälle, jeder genannte Abnahmefall ist gepinnt, und es sind mindestens zwölf. */
    @Test
    void familienUndAbnahmefaelleSindAbgedeckt() throws Exception {
        JsonNode root = vectors();
        Set<String> familien = new LinkedHashSet<>();
        Set<String> abnahmen = new LinkedHashSet<>();
        for (JsonNode c : root.path("cases")) {
            familien.add(c.path("familie").asText());
            if (c.hasNonNull("abnahme")) {
                abnahmen.add(c.path("abnahme").asText());
            }
        }
        assertThat(familien).containsExactlyInAnyOrderElementsOf(texte(root.path("familien")));
        assertThat(abnahmen).containsExactlyInAnyOrderElementsOf(texte(root.path("abnahmefaelle")));
        assertThat(root.path("cases").size()).isGreaterThanOrEqualTo(12);
    }

    /** Jeder Fall trägt einen Grund, warum er in der Datei steht — und einen eigenen Namen. */
    @Test
    void jederFallSagtWarumErDaIst() throws Exception {
        Set<String> namen = new LinkedHashSet<>();
        for (JsonNode c : vectors().path("cases")) {
            assertThat(c.path("why").asText()).as("why für %s", c.path("name").asText()).isNotBlank();
            assertThat(namen.add(c.path("name").asText())).as("doppelter Name %s", c.path("name").asText()).isTrue();
        }
    }

    /**
     * Die echte Tabelle trägt die zwei Fähigkeiten, die AP-06 braucht, in der Reihenfolge des
     * A7-Satzes — und heute noch kein Release (kein ausgeliefertes Release hat sie).
     */
    @Test
    void dieFaehigkeitenTabelleIstDieDesKonzepts() throws Exception {
        List<TabellenEintrag> tab = tabelle(lies(TABELLE).path("faehigkeiten"));
        assertThat(tab).extracting(TabellenEintrag::code).containsExactly("data_sources", "assignment_effective_at");
        assertThat(tab).extracting(TabellenEintrag::name)
                .containsExactly("Rückmeldung je Datenquelle", "Zuständigkeit ab Zeitpunkt");
        assertThat(tab).extracting(TabellenEintrag::abRelease).containsOnlyNulls();
    }

    // ------------------------------------------------ Referenzunternehmen

    /**
     * Jede Tatsache eines Falls über ein Ahrenberg-Objekt steht so im Referenzunternehmen: Box-Name,
     * Heimat und führende Rolle, Software-Stand, Anlage/Protokoll/Adresse/Netz/Steuerquelle jeder
     * Quelle, die Zeiträume der zuständigen Box (offen nur, wo das Ende zum Zeitpunkt `jetzt` noch
     * nicht eingetreten war) und der Anschluss jeder Bestands-Komponente. Wer etwas erfindet,
     * nennt es in `annahme`.
     */
    @TestFactory
    List<DynamicTest> jederFallStehtImReferenzunternehmen() throws Exception {
        JsonNode ref = lies(REFERENZ);
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<String> fehler = new ArrayList<>();
                boolean erlaubt = !c.path("expected").has("urteil")
                        || "erlaubt".equals(c.path("expected").path("urteil").asText());
                boolean erfunden = pruefeGegenReferenz(c.path("input"), erlaubt, new Referenz(ref), fehler);
                if (erfunden && !c.hasNonNull("annahme")) {
                    fehler.add("der Fall erfindet etwas, nennt aber keine `annahme`");
                }
                assertThat(fehler).as(c.path("name").asText()).isEmpty();
            }));
        }
        return tests;
    }

    /** Die Referenzdatei, nach Kennzeichen erschlossen. */
    private record Referenz(
            Map<String, JsonNode> boxen,
            Map<String, JsonNode> quellen,
            Map<String, JsonNode> anlagen,
            Map<String, JsonNode> komponenten,
            Map<String, JsonNode> geraete,
            Map<String, List<Zeitraum>> perioden) {

        Referenz(JsonNode ref) {
            this(nachKennzeichen(ref.path("boxen")), nachKennzeichen(ref.path("datenquellen")),
                    nachKennzeichen(ref.path("anlagen")), nachKennzeichen(ref.path("komponenten")),
                    nachKennzeichen(ref.path("geraete")), perioden(ref.path("zuordnungen")));
        }

        private static Map<String, JsonNode> nachKennzeichen(JsonNode arr) {
            Map<String, JsonNode> m = new LinkedHashMap<>();
            arr.forEach(n -> m.put(n.path("kennzeichen").asText(), n));
            return m;
        }

        private static Map<String, List<Zeitraum>> perioden(JsonNode zuordnungen) {
            Map<String, List<Zeitraum>> m = new LinkedHashMap<>();
            zuordnungen.forEach(z -> {
                if ("datenquelle_box".equals(z.path("art").asText())) {
                    m.computeIfAbsent(z.path("von").asText(), k -> new ArrayList<>()).add(new Zeitraum(
                            z.path("nach").asText(), instant(z.get("gueltig_ab")), instant(z.get("gueltig_bis"))));
                }
            });
            return m;
        }
    }

    /**
     * Prüft einen Eingang gegen die Referenz; true, wenn er ein Objekt außerhalb der Referenz benutzt.
     * Ob die neue Box zum Beginn in Betrieb ist, zählt nur für ein ERLAUBTES Ergebnis — ein
     * abgelehnter Versuch darf gerade das Unmögliche versuchen.
     */
    private static boolean pruefeGegenReferenz(JsonNode in, boolean erlaubt, Referenz r, List<String> fehler) {
        Instant jetzt = instant(in.get("jetzt"));
        boolean erfunden = in.has("tabelle");
        for (JsonNode b : in.path("boxen")) {
            JsonNode rb = r.boxen().get(b.path("kennzeichen").asText());
            if (rb == null) {
                erfunden = true;
            } else {
                gleich(fehler, "Name " + b.path("kennzeichen").asText(), rb.path("name").asText(),
                        b.path("name").asText());
            }
        }
        for (JsonNode q : in.path("quellen")) {
            erfunden |= pruefeQuelle(q, r, jetzt, fehler);
        }
        if (in.has("quelle")) {
            String dq = in.path("quelle").asText();
            if (!r.perioden().containsKey(dq)) {
                erfunden = true;
            } else {
                if (in.has("bestehend")) {
                    pruefeZeitraeume(dq, zeitraeume(in.path("bestehend")), r, jetzt, fehler, false);
                }
                if (in.has("zeitraeume")) {
                    pruefeZeitraeume(dq, zeitraeume(in.path("zeitraeume")), r, jetzt, fehler, true);
                }
            }
        }
        JsonNode antrag = in.path("antrag");
        if (!antrag.isMissingNode() && erlaubt) {
            erfunden |= pruefeInBetrieb(antrag.path("box").asText(), instant(antrag.get("effective_from")), r, fehler);
        }
        JsonNode tausch = in.path("tausch");
        if (!tausch.isMissingNode()) {
            JsonNode alt = tausch.path("alt");
            JsonNode rb = r.boxen().get(alt.path("kennzeichen").asText());
            if (rb == null) {
                erfunden = true;
            } else {
                gleich(fehler, "Heimat " + alt.path("kennzeichen").asText(), rb.path("heimat_anlage").asText(),
                        alt.path("heimat_anlage").asText());
                gleich(fehler, "führend " + alt.path("kennzeichen").asText(),
                        List.of(rb.path("fuehrend_fuer").asText()).toString(),
                        texte(alt.path("fuehrend_fuer")).toString());
            }
            if (erlaubt) {
                erfunden |= pruefeInBetrieb(tausch.path("neu").asText(), instant(tausch.get("zeitpunkt")), r, fehler);
            }
        }
        if (in.has("anlage")) {
            erfunden |= pruefeFuehrung(in, r, fehler);
        }
        if (in.has("box") && in.has("stand")) {
            JsonNode rb = r.boxen().get(in.path("box").asText());
            if (rb == null) {
                erfunden = true;
            } else {
                gleich(fehler, "Software " + in.path("box").asText(), text(rb.get("software")),
                        text(in.path("stand").get("version")));
            }
        }
        for (JsonNode k : in.path("komponenten")) {
            erfunden |= pruefeKomponente(k, r, fehler);
        }
        return erfunden;
    }

    private static boolean pruefeQuelle(JsonNode q, Referenz r, Instant jetzt, List<String> fehler) {
        String dq = q.path("kennzeichen").asText();
        JsonNode rq = r.quellen().get(dq);
        if (rq == null) {
            return true;
        }
        gleich(fehler, dq + " Anlage", rq.path("anlage").asText(), q.path("anlage").asText());
        gleich(fehler, dq + " Protokoll", PROTOKOLL_AUS_REFERENZ.get(rq.path("protokoll").asText()),
                q.path("protokoll").asText());
        gleich(fehler, dq + " Adresse", adresseAusReferenz(rq), q.path("adresse").asText());
        gleich(fehler, dq + " Netz", text(rq.get("netz")), text(q.get("netz")));
        gleich(fehler, dq + " Steuerquelle", rq.path("steuerquelle").asText(), q.path("steuerquelle").asText());
        pruefeZeitraeume(dq, zeitraeume(q.path("zeitraeume")), r, jetzt, fehler, false);
        return false;
    }

    /**
     * Jeder Zeitraum steht so in der Referenz — offen darf er nur sein, wo die Referenz ein Ende
     * nennt, das zu {@code jetzt} (auf die Minute) noch nicht vorbei war. Jeder Referenz-Zeitraum,
     * der VOR der Minute von {@code jetzt} begonnen hat, ist dabei (einer, der in ihr beginnt, kann
     * der sein, den der Fall gerade anlegt); ohne {@code jetzt} die ganze Zeitreihe.
     */
    private static void pruefeZeitraeume(
            String dq, List<Zeitraum> zs, Referenz r, Instant jetzt, List<String> fehler, boolean vollstaendig) {
        List<Zeitraum> soll = r.perioden().get(dq);
        Instant minute = jetzt == null ? null : jetzt.truncatedTo(ChronoUnit.MINUTES);
        for (Zeitraum z : zs) {
            boolean passt = soll.stream().anyMatch(s -> s.box().equals(z.box()) && s.von().equals(z.von())
                    && (Objects.equals(s.bis(), z.bis())
                            || (z.bis() == null && minute != null && s.bis() != null && !s.bis().isBefore(minute))));
            if (!passt) {
                fehler.add(dq + ": Zeitraum " + z + " steht so nicht in der Referenz");
            }
        }
        for (Zeitraum s : soll) {
            boolean begonnen = vollstaendig || minute == null || s.von().isBefore(minute);
            boolean da = zs.stream().anyMatch(z -> z.box().equals(s.box()) && z.von().equals(s.von()));
            if (begonnen && !da) {
                fehler.add(dq + ": Zeitraum der Referenz fehlt: " + s);
            }
        }
    }

    private static boolean pruefeInBetrieb(String box, Instant ab, Referenz r, List<String> fehler) {
        JsonNode rb = r.boxen().get(box);
        if (rb == null) {
            return true;
        }
        Instant inBetrieb = instant(rb.get("in_betrieb_ab"));
        Instant ausgebaut = instant(rb.get("ausgebaut_am"));
        if (ab.isBefore(inBetrieb) || (ausgebaut != null && !ab.isBefore(ausgebaut))) {
            fehler.add(box + " ist ab " + ab + " nicht in Betrieb");
        }
        return false;
    }

    private static boolean pruefeFuehrung(JsonNode in, Referenz r, List<String> fehler) {
        boolean erfunden = false;
        String anlage = in.path("anlage").asText();
        JsonNode ra = r.anlagen().get(anlage);
        if (ra == null) {
            fehler.add("unbekannte Anlage " + anlage);
            return false;
        }
        for (JsonNode b : in.path("boxen")) {
            JsonNode rb = r.boxen().get(b.path("kennzeichen").asText());
            if (rb == null) {
                erfunden = true;
            } else {
                gleich(fehler, "Heimat " + b.path("kennzeichen").asText(), anlage, rb.path("heimat_anlage").asText());
            }
        }
        String speicher = text(in.get("speicher_box"));
        gleich(fehler, anlage + " hat einen Speicher", Boolean.toString(!ra.path("speicher_kwh").isNull()),
                Boolean.toString(speicher != null));
        for (String b : new String[] {speicher, text(in.get("gespeichert"))}) {
            JsonNode rb = b == null ? null : r.boxen().get(b);
            if (rb != null) {
                gleich(fehler, b + " führt", anlage, rb.path("fuehrend_fuer").asText());
            }
        }
        return erfunden;
    }

    private static boolean pruefeKomponente(JsonNode k, Referenz r, List<String> fehler) {
        String kz = k.path("kennzeichen").asText();
        JsonNode rk = r.komponenten().get(kz);
        if (rk == null) {
            return true;
        }
        JsonNode g = r.geraete().get(rk.path("geraet").asText());
        JsonNode q = r.quellen().get(g.path("datenquelle").asText());
        Instant ab = instant(k.get("in_betrieb_ab"));
        gleich(fehler, kz + " Anlage", rk.path("anlage").asText(), k.path("anlage").asText());
        gleich(fehler, kz + " in Betrieb", instant(rk.get("in_betrieb_ab")).toString(), ab.toString());
        gleich(fehler, kz + " Protokoll", PROTOKOLL_AUS_REFERENZ.get(q.path("protokoll").asText()),
                k.path("protokoll").asText());
        gleich(fehler, kz + " Adresse", adresseAusReferenz(q), k.path("adresse").asText());
        gleich(fehler, kz + " Geräte-ID", text(g.get("modbus_geraete_id")), text(k.get("geraete_id")));
        gleich(fehler, kz + " Box", DatenquelleRegeln.zustaendigeBox(r.perioden().get(q.path("kennzeichen").asText()), ab),
                k.path("box").asText());
        return false;
    }

    private static String adresseAusReferenz(JsonNode q) {
        if ("OCPP 1.6J".equals(q.path("protokoll").asText())) {
            Matcher m = Pattern.compile("„([^“]+)“").matcher(q.path("weg").asText());
            return m.find() ? m.group(1) : null;
        }
        return q.path("adresse").asText() + ":" + q.path("port").asInt();
    }

    private static void gleich(List<String> fehler, String was, String referenz, String fall) {
        if (!Objects.equals(referenz, fall)) {
            fehler.add(was + ": Referenz „" + referenz + "“, Fall „" + fall + "“");
        }
    }
}
