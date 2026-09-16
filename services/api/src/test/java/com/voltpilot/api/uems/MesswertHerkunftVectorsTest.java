package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.MesswertHerkunft.Bindung;
import com.voltpilot.api.uems.MesswertHerkunft.Ereignis;
import com.voltpilot.api.uems.MesswertHerkunft.EreignisArt;
import com.voltpilot.api.uems.MesswertHerkunft.Ergebnis;
import com.voltpilot.api.uems.MesswertHerkunft.FassungQuelle;
import com.voltpilot.api.uems.MesswertHerkunft.Grund;
import com.voltpilot.api.uems.MesswertHerkunft.Herkunft;
import com.voltpilot.api.uems.MesswertHerkunft.Rolle;
import com.voltpilot.api.uems.MesswertHerkunft.Urteil;
import com.voltpilot.api.uems.MesswertHerkunft.Zustellart;
import java.lang.reflect.RecordComponent;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des HERKUNFTSVERTRAGS je Messwert (UEMS AP-07 IP-1): die EINE Vektor-Datei
 * {@code docs/contracts/v2/messwert-herkunft-vectors.json} hält ihr Schema, und
 * {@link MesswertHerkunft} zieht aus jedem Fall genau das Urteil, die Ereignisse und die
 * fünfzehn Angaben, die dort stehen.
 *
 * <p>Die Fälle spielen im Referenzunternehmen Ahrenberg: jede Tatsache, die ein Fall über Boxen,
 * Komponenten, Einbauten, Zuständigkeiten, Quellenbindungen und Kadenzen behauptet, wird gegen
 * {@code docs/contracts/v2/uems-referenzunternehmen.json} geprüft — hier steht kein
 * abgeschriebener Wert. Der TS-Zwilling folgt mit der Rohtabelle (AP-07 IP-6).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class MesswertHerkunftVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("messwert-herkunft-vectors.json");
    private static final Path SCHEMA = V2.resolve("messwert-herkunft.schema.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    // ---------------------------------------------------------------- Form

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA)))
                .as("Schema-Verstöße")
                .isEmpty();
    }

    /** Die Vektor-Datei verweist auf die EINE Beispielwelt, nicht auf eine zweite. */
    @Test
    void dieBeispielweltIstDasReferenzunternehmen() throws Exception {
        assertThat(lies(VECTORS).path("referenzunternehmen").asText())
                .isEqualTo("./uems-referenzunternehmen.json");
        assertThat(Files.exists(REFERENZ)).isTrue();
    }

    /**
     * Genau fünfzehn Angaben (AP-07 §4.2), und es sind DIESELBEN, die der Java-Datensatz
     * {@link Herkunft} trägt — in derselben Reihenfolge. {@code maxItems} prüft der Läufer
     * nicht; deshalb steht die Zahl hier.
     */
    @Test
    void fuenfzehnAngabenWieDerDatensatz() throws Exception {
        List<String> felder = new ArrayList<>();
        lies(VECTORS).path("angaben").forEach(a -> { if (!"urheber".equals(a.path("feld").asText())) felder.add(a.path("feld").asText()); });
        List<String> komponenten = Arrays.stream(Herkunft.class.getRecordComponents())
                .map(RecordComponent::getName)
                .map(MesswertHerkunftVectorsTest::schlangenschrift)
                .toList();
        assertThat(felder).hasSize(15).doesNotHaveDuplicates().isEqualTo(komponenten);
    }

    /** Jeder gespeicherte Wert eines Falls trägt genau diese fünfzehn Angaben — keine mehr. */
    @Test
    void jedeGespeicherteHerkunftTraegtGenauDieFuenfzehnAngaben() throws Exception {
        JsonNode v = lies(VECTORS);
        List<String> felder = new ArrayList<>();
        v.path("angaben").forEach(a -> { if (!"urheber".equals(a.path("feld").asText())) felder.add(a.path("feld").asText()); });
        int gespeichert = 0;
        for (JsonNode c : v.path("cases")) {
            JsonNode h = c.path("expected").path("herkunft");
            boolean istGespeichert =
                    "gespeichert".equals(c.path("expected").path("urteil").asText());
            assertThat(h.isObject()).as(c.path("name").asText()).isEqualTo(istGespeichert);
            if (istGespeichert) {
                gespeichert++;
                List<String> keys = new ArrayList<>();
                h.fieldNames().forEachRemaining(keys::add);
                assertThat(keys).as(c.path("name").asText()).isEqualTo(felder);
            }
        }
        assertThat(gespeichert).isPositive();
    }

    @Test
    void dieRegelZahlenStimmenMitDerAbleitung() throws Exception {
        JsonNode r = lies(VECTORS).path("regeln");
        assertThat(r.path("zukunft_hoechstens_s").asLong())
                .isEqualTo(MesswertHerkunft.ZUKUNFT_HOECHSTENS_S);
        assertThat(r.path("vergangenheit_hoechstens_s").asLong())
                .isEqualTo(MesswertHerkunft.VERGANGENHEIT_HOECHSTENS_S);
        assertThat(r.path("zeitsprung_ab_s").asLong()).isEqualTo(MesswertHerkunft.ZEITSPRUNG_AB_S);
        assertThat(r.path("nachgeliefert_mindestens_s").asLong())
                .isEqualTo(MesswertHerkunft.NACHGELIEFERT_MINDESTENS_S);
        assertThat(r.path("nachgeliefert_faktor_kadenz").asInt())
                .isEqualTo(MesswertHerkunft.NACHGELIEFERT_FAKTOR);
        assertThat(r.path("unassigned_reader_hoechstens_je_s").asLong())
                .isEqualTo(MesswertHerkunft.UNASSIGNED_READER_HOECHSTENS_JE_S);
        assertThat(texte(r.path("idempotenz_schluessel")))
                .containsExactly("kundenbereich", "komponente", "messkanal", "messzeit");
    }

    @Test
    void dasVokabularStimmtMitDerAbleitung() throws Exception {
        JsonNode w = lies(VECTORS).path("vokabular");
        assertThat(texte(w.path("urteil"))).isEqualTo(codes(Urteil.values(), Urteil::code));
        assertThat(texte(w.path("grund"))).isEqualTo(codes(Grund.values(), Grund::code));
        assertThat(texte(w.path("rolle"))).isEqualTo(codes(Rolle.values(), Rolle::code));
        assertThat(texte(w.path("bindung"))).isEqualTo(codes(Bindung.values(), Bindung::code));
        assertThat(texte(w.path("zustellart")))
                .isEqualTo(codes(Zustellart.values(), Zustellart::code));
        assertThat(texte(w.path("fassung_quelle")))
                .isEqualTo(codes(FassungQuelle.values(), FassungQuelle::code));
        assertThat(texte(w.path("ereignis")))
                .isEqualTo(codes(EreignisArt.values(), EreignisArt::code));
    }

    @Test
    void jederFallNameIstEindeutig() throws Exception {
        List<String> namen = new ArrayList<>();
        lies(VECTORS).path("cases").forEach(c -> namen.add(c.path("name").asText()));
        assertThat(namen).doesNotHaveDuplicates();
    }

    // ------------------------------------------------------ die Vektor-Fälle

    /** Jeder Fall: dasselbe Urteil, dieselben Ereignisse, dieselben fünfzehn Angaben. */
    @TestFactory
    List<DynamicTest> jederFall() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                Ergebnis e = MesswertHerkunft.stelleFest(eingang(c.path("input")));
                List<String> abweichungen = new ArrayList<>();
                vergleiche(alsJson(e), c.path("expected"), "expected", abweichungen);
                assertThat(abweichungen).as(c.path("why").asText()).isEmpty();
            }));
        }
        return tests;
    }

    /**
     * Jede Tatsache eines Falls steht so im Referenzunternehmen: Box und Seriennummer, Box im
     * Betrieb, Komponente und Messkanal, Einbau zur Messzeit, Datenquelle, Kadenz, zuständige
     * Box zur Messzeit und Quellenbindung zur Messzeit (samt Wertart und Einheit) — führend
     * oder als Vergleichsquelle (seit Fassung 1.1 führt die Datei die Vergleichsquelle an MS-01).
     */
    @TestFactory
    List<DynamicTest> jederFallStehtImReferenzunternehmen() throws Exception {
        JsonNode ref = lies(REFERENZ);
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                List<String> fehler = new ArrayList<>();
                pruefeGegenReferenz(c, ref, fehler);
                assertThat(fehler).as(c.path("name").asText()).isEmpty();
            }));
        }
        return tests;
    }

    // ------------------------------------------------ Regeln als Einheiten

    /**
     * Kein Ahrenberg-Messkanal hat mehr als 100 s Kadenz — den Zweig, in dem 3 × Kadenz die
     * Schwelle bestimmt, prüft deshalb dieser Test statt eines Vektors.
     */
    @Test
    void dieNachlieferungsSchwelleWaechstMitDerKadenz() {
        assertThat(MesswertHerkunft.nachgeliefertSchwelleS(10)).isEqualTo(300);
        assertThat(MesswertHerkunft.nachgeliefertSchwelleS(100)).isEqualTo(300);
        assertThat(MesswertHerkunft.nachgeliefertSchwelleS(900)).isEqualTo(2_700);
        Instant messzeit = Instant.parse("2026-11-18T09:00:00Z");
        assertThat(MesswertHerkunft.zustellung(messzeit, messzeit.plusSeconds(2_700), 900).art())
                .isEqualTo(Zustellart.DIREKT);
        assertThat(MesswertHerkunft.zustellung(messzeit, messzeit.plusSeconds(2_701), 900).art())
                .isEqualTo(Zustellart.NACHGELIEFERT);
    }

    // ------------------------------------------------------------ Eingang

    private static MesswertHerkunft.Eingang eingang(JsonNode in) {
        JsonNode l = in.path("lieferung");
        JsonNode f = in.path("fakten");
        MesswertHerkunft.Lieferung lieferung = null;
        if (!l.isNull()) {
            JsonNode u = l.path("umschlag");
            JsonNode w = l.path("wert");
            lieferung = new MesswertHerkunft.Lieferung(
                    l.path("kundenbereich").asText(),
                    box(l.path("box")),
                    new MesswertHerkunft.Umschlag(
                            u.path("sequenz").asLong(),
                            instant(u.path("messzeit")),
                            u.path("katalogstand").asText(),
                            ganzzahl(u.path("angewendete_fassung"))),
                    new MesswertHerkunft.Messung(
                            text(w.path("komponente")),
                            w.path("messkanal").asText(),
                            instant(w.path("messzeit")),
                            drahtwert(w.path("raw")),
                            drahtwert(w.path("decoded")),
                            w.path("qualitaet").asText()),
                    instant(l.path("eingangszeit")));
        }
        JsonNode e = f.path("einbau");
        List<MesswertHerkunft.Gespeichert> gespeichert = new ArrayList<>();
        for (JsonNode g : f.path("gespeichert_zur_messzeit")) {
            gespeichert.add(new MesswertHerkunft.Gespeichert(
                    g.path("box").asText(),
                    Rolle.vonCode(g.path("rolle").asText()),
                    drahtwert(g.path("raw")),
                    drahtwert(g.path("decoded")),
                    g.path("qualitaet").asText(),
                    g.path("sequenz").asLong()));
        }
        JsonNode v = f.path("vorheriger_umschlag");
        return new MesswertHerkunft.Eingang(
                lieferung,
                new MesswertHerkunft.Fakten(
                        text(f.path("komponente_aus_auswahl")),
                        f.path("einheit").asText(),
                        f.path("wertart").asText(),
                        f.path("kadenz_s").asLong(),
                        e.isNull()
                                ? null
                                : new MesswertHerkunft.Einbau(
                                        e.path("geraet").asText(),
                                        e.path("einbau").asText(),
                                        text(e.path("seriennummer"))),
                        ganzzahl(f.path("fassung_aus_zustellung")),
                        f.path("datenquelle").asText(),
                        text(f.path("zustaendige_box")),
                        new MesswertHerkunft.Quellenbindung(
                                Bindung.vonCode(f.path("bindung").path("art").asText()),
                                text(f.path("bindung").path("messstelle"))),
                        gespeichert,
                        v.isNull()
                                ? null
                                : new MesswertHerkunft.VorherigerUmschlag(
                                        v.path("sequenz").asLong(), instant(v.path("messzeit"))),
                        instant(f.path("unassigned_reader_zuletzt"))));
    }

    private static MesswertHerkunft.Box box(JsonNode b) {
        return new MesswertHerkunft.Box(
                b.path("kennzeichen").asText(), b.path("seriennummer").asText());
    }

    /** Zahl → {@link BigDecimal}, Text → String, Wahrheitswert → Boolean — wie am Draht. */
    private static Object drahtwert(JsonNode n) {
        if (n.isNumber()) {
            return n.decimalValue();
        }
        if (n.isBoolean()) {
            return n.asBoolean();
        }
        return n.asText();
    }

    // ------------------------------------------------------------ Ergebnis

    private static JsonNode alsJson(Ergebnis e) {
        ObjectNode o = JSON.objectNode();
        o.put("urteil", e.urteil().code());
        o.put("grund", e.grund() == null ? null : e.grund().code());
        ArrayNode ereignisse = o.putArray("ereignisse");
        for (Ereignis x : e.ereignisse()) {
            ObjectNode n = ereignisse.addObject();
            n.put("art", x.art().code());
            x.felder().forEach((k, v) -> n.set(k, knoten(v)));
        }
        o.put("zaehler", e.zaehler());
        Herkunft h = e.herkunft();
        if (h == null) {
            o.putNull("herkunft");
            return o;
        }
        ObjectNode hk = o.putObject("herkunft");
        hk.put("kundenbereich", h.kundenbereich());
        hk.put("komponente", h.komponente());
        hk.put("messkanal", h.messkanal());
        hk.put("messzeit", h.messzeit().toString());
        hk.put("eingangszeit", h.eingangszeit().toString());
        ObjectNode wert = hk.putObject("wert");
        wert.set("raw", knoten(h.wert().raw()));
        wert.set("decoded", knoten(h.wert().decoded()));
        wert.put("einheit", h.wert().einheit());
        hk.put("qualitaet", h.qualitaet());
        hk.put("wertart", h.wertart());
        ObjectNode box = hk.putObject("lesende_box");
        box.put("kennzeichen", h.lesendeBox().kennzeichen());
        box.put("seriennummer", h.lesendeBox().seriennummer());
        ObjectNode einbau = hk.putObject("geraet_einbau");
        einbau.put("geraet", h.geraetEinbau().geraet());
        einbau.put("einbau", h.geraetEinbau().einbau());
        einbau.put("seriennummer", h.geraetEinbau().seriennummer());
        ObjectNode fassung = hk.putObject("einstellungs_fassung");
        fassung.put("fassung", h.einstellungsFassung().fassung());
        fassung.put("quelle", h.einstellungsFassung().quelle().code());
        hk.put("katalogstand", h.katalogstand());
        hk.put("sequenz", h.sequenz());
        ObjectNode zustellart = hk.putObject("zustellart");
        zustellart.put("art", h.zustellart().art().code());
        zustellart.put("verzoegerung_s", h.zustellart().verzoegerungS());
        hk.put("rolle", h.rolle().code());
        return o;
    }

    private static JsonNode knoten(Object v) {
        if (v == null) {
            return JSON.nullNode();
        }
        if (v instanceof BigDecimal d) {
            return JSON.numberNode(d);
        }
        if (v instanceof Long n) {
            return JSON.numberNode(n);
        }
        if (v instanceof Integer n) {
            return JSON.numberNode(n);
        }
        if (v instanceof Boolean b) {
            return JSON.booleanNode(b);
        }
        if (v instanceof Instant t) {
            return JSON.textNode(t.toString());
        }
        if (v instanceof Map<?, ?> m) {
            ObjectNode o = JSON.objectNode();
            m.forEach((k, x) -> o.set((String) k, knoten(x)));
            return o;
        }
        if (v instanceof List<?> l) {
            ArrayNode a = JSON.arrayNode();
            l.forEach(x -> a.add(knoten(x)));
            return a;
        }
        return JSON.textNode(v.toString());
    }

    /** Tiefer Vergleich; Zahlen nach Betrag (1083415.2 == 1083415.20), sonst genau. */
    private static void vergleiche(JsonNode ist, JsonNode soll, String pfad, List<String> out) {
        if (ist.isNumber() && soll.isNumber()) {
            if (ist.decimalValue().compareTo(soll.decimalValue()) != 0) {
                out.add(pfad + ": " + ist + " statt " + soll);
            }
            return;
        }
        if (ist.isObject() && soll.isObject()) {
            Set<String> namen = new HashSet<>();
            ist.fieldNames().forEachRemaining(namen::add);
            soll.fieldNames().forEachRemaining(namen::add);
            for (String n : namen) {
                if (!ist.has(n) || !soll.has(n)) {
                    out.add(pfad + "." + n + ": " + (ist.has(n) ? "zu viel" : "fehlt"));
                } else {
                    vergleiche(ist.get(n), soll.get(n), pfad + "." + n, out);
                }
            }
            return;
        }
        if (ist.isArray() && soll.isArray()) {
            if (ist.size() != soll.size()) {
                out.add(pfad + ": " + ist + " statt " + soll);
                return;
            }
            for (int i = 0; i < ist.size(); i++) {
                vergleiche(ist.get(i), soll.get(i), pfad + "[" + i + "]", out);
            }
            return;
        }
        if (!ist.equals(soll)) {
            out.add(pfad + ": " + ist + " statt " + soll);
        }
    }

    // ------------------------------------------------ Referenzunternehmen

    private static void pruefeGegenReferenz(JsonNode c, JsonNode ref, List<String> fehler) {
        Map<String, JsonNode> boxen = nachKennzeichen(ref.path("boxen"));
        Map<String, JsonNode> komponenten = nachKennzeichen(ref.path("komponenten"));
        Map<String, JsonNode> geraete = nachKennzeichen(ref.path("geraete"));
        Map<String, JsonNode> datenquellen = nachKennzeichen(ref.path("datenquellen"));
        Map<String, JsonNode> messstellen = nachKennzeichen(ref.path("messstellen"));
        JsonNode in = c.path("input");
        JsonNode l = in.path("lieferung");
        JsonNode f = in.path("fakten");

        String kundenbereich;
        String komponente;
        String kanal;
        Instant messzeit;
        if (l.isNull()) {
            if (!in.has("reihe") || !in.has("messzeit")) {
                fehler.add("ohne Lieferung braucht der Fall `reihe` und `messzeit`");
                return;
            }
            kundenbereich = in.path("reihe").path("kundenbereich").asText();
            komponente = in.path("reihe").path("komponente").asText();
            kanal = in.path("reihe").path("messkanal").asText();
            messzeit = instant(in.path("messzeit"));
        } else {
            JsonNode w = l.path("wert");
            kundenbereich = l.path("kundenbereich").asText();
            komponente = w.path("komponente").isNull()
                    ? f.path("komponente_aus_auswahl").asText()
                    : w.path("komponente").asText();
            kanal = w.path("messkanal").asText();
            messzeit = instant(w.path("messzeit"));
            if (!w.path("komponente").isNull() && !f.path("komponente_aus_auswahl").isNull()) {
                fehler.add("die Box nennt die Komponente — die Auswahl ergänzt nur für "
                        + "eine ältere");
            }
            String box = l.path("box").path("kennzeichen").asText();
            JsonNode b = boxen.get(box);
            if (b == null) {
                fehler.add("unbekannte Box " + box);
            } else {
                gleich(fehler, "Seriennummer " + box, b.path("seriennummer").asText(),
                        l.path("box").path("seriennummer").asText());
                Instant eingang = instant(l.path("eingangszeit"));
                if (!laeuft(b, eingang, "in_betrieb_ab", "ausgebaut_am")) {
                    fehler.add(box + " ist zur Eingangszeit nicht in Betrieb");
                }
            }
        }
        gleich(fehler, "Kundenbereich",
                ref.path("unternehmen").path("kundenbereich").asText(), kundenbereich);

        JsonNode k = komponenten.get(komponente);
        if (k == null) {
            fehler.add("unbekannte Komponente " + komponente);
            return;
        }
        if (!k.path("kanaele").asText().contains(kanal)) {
            fehler.add(komponente + " hat keinen Messkanal „" + kanal + "“");
        }
        JsonNode geraet = geraete.get(k.path("geraet").asText());

        // Einbau zur Messzeit — [gueltig_ab, gueltig_bis)
        JsonNode einbauZurMesszeit = null;
        for (JsonNode e : geraet.path("einbauten")) {
            if (laeuft(e, messzeit, "gueltig_ab", "gueltig_bis")) {
                einbauZurMesszeit = e;
            }
        }
        JsonNode einbau = f.path("einbau");
        if (einbauZurMesszeit == null) {
            if (!einbau.isNull()) {
                fehler.add("zur Messzeit gilt kein Einbau, der Fall nennt " + einbau);
            }
        } else if (einbau.isNull()) {
            fehler.add("zur Messzeit gilt " + einbauZurMesszeit.path("kennzeichen").asText());
        } else {
            gleich(fehler, "Gerät", geraet.path("kennzeichen").asText(),
                    einbau.path("geraet").asText());
            gleich(fehler, "Einbau", einbauZurMesszeit.path("kennzeichen").asText(),
                    einbau.path("einbau").asText());
            gleich(fehler, "Seriennummer des Einbaus",
                    text(einbauZurMesszeit.path("seriennummer")),
                    text(einbau.path("seriennummer")));
        }

        String dq = geraet.path("datenquelle").asText();
        gleich(fehler, "Datenquelle", dq, f.path("datenquelle").asText());
        gleich(fehler, "Kadenz", datenquellen.get(dq).path("kadenz_s").asText(),
                f.path("kadenz_s").asText());

        String zustaendig = null;
        for (JsonNode z : ref.path("zuordnungen")) {
            if ("datenquelle_box".equals(z.path("art").asText())
                    && dq.equals(z.path("von").asText())
                    && laeuft(z, messzeit, "gueltig_ab", "gueltig_bis")) {
                zustaendig = z.path("nach").asText();
            }
        }
        gleich(fehler, "zuständige Box zur Messzeit", zustaendig,
                text(f.path("zustaendige_box")));

        // Quellenbindung zur Messzeit: welche Messstelle führt diesen Messkanal — und an welcher
        // steht er als Vergleichsquelle?
        List<String[]> fuehrend = new ArrayList<>();
        List<String[]> vergleich = new ArrayList<>();
        for (JsonNode ms : messstellen.values()) {
            sammleFuehrend(ms, ms.path("fuehrende_quelle"), ms.path("hauptgroesse"),
                    komponente, kanal, messzeit, fuehrend);
            sammleFuehrend(ms, ms.path("vergleichsquellen"), ms.path("hauptgroesse"),
                    komponente, kanal, messzeit, vergleich);
            for (JsonNode n : ms.path("nebengroessen")) {
                sammleFuehrend(ms, n.path("fuehrende_quelle"), n, komponente, kanal, messzeit,
                        fuehrend);
                sammleFuehrend(ms, n.path("vergleichsquellen"), n, komponente, kanal, messzeit,
                        vergleich);
            }
        }
        String art = f.path("bindung").path("art").asText();
        String messstelle = text(f.path("bindung").path("messstelle"));
        switch (art) {
            case "fuehrend" -> {
                if (fuehrend.size() != 1) {
                    fehler.add("führend: " + fuehrend.size() + " führende Bindungen zur Messzeit");
                    return;
                }
                String[] b = fuehrend.get(0);
                gleich(fehler, "Messstelle", b[0], messstelle);
                gleich(fehler, "Einbau der Bindung", b[1], einbau.path("einbau").asText());
                gleich(fehler, "Wertart", b[2], f.path("wertart").asText());
                gleich(fehler, "Einheit", b[3], f.path("einheit").asText());
            }
            case "keine" -> {
                if (!fuehrend.isEmpty() || messstelle != null) {
                    fehler.add("keine Bindung behauptet, die Datei führt " + fuehrend.size());
                }
            }
            case "vergleich" -> {
                if (!fuehrend.isEmpty() || vergleich.size() != 1) {
                    fehler.add("Vergleich: " + fuehrend.size() + " führende und " + vergleich.size()
                            + " Vergleichs-Bindungen zur Messzeit");
                    return;
                }
                String[] b = vergleich.get(0);
                gleich(fehler, "Messstelle des Vergleichs", b[0], messstelle);
                gleich(fehler, "Einbau des Vergleichs", b[1], einbau.path("einbau").asText());
                gleich(fehler, "Wertart", b[2], f.path("wertart").asText());
                gleich(fehler, "Einheit", b[3], f.path("einheit").asText());
            }
            default -> fehler.add("unbekannte Bindung " + art);
        }

        for (JsonNode g : f.path("gespeichert_zur_messzeit")) {
            if (!boxen.containsKey(g.path("box").asText())) {
                fehler.add("gespeichert von unbekannter Box " + g.path("box").asText());
            }
        }
    }

    /** Sammelt [Messstelle, Einbau, Wertart, Einheit] jeder zur Messzeit gültigen Bindung. */
    private static void sammleFuehrend(JsonNode ms, JsonNode quellen, JsonNode groesse,
            String komponente, String kanal, Instant messzeit, List<String[]> out) {
        for (JsonNode q : quellen) {
            if (komponente.equals(q.path("komponente").asText())
                    && kanal.equals(q.path("kanal").asText())
                    && laeuft(q, messzeit, "gueltig_ab", "gueltig_bis")) {
                out.add(new String[] {
                    ms.path("kennzeichen").asText(),
                    q.path("einbau").asText(),
                    q.path("kanal_wertart").asText(),
                    groesse.path("einheit").asText()
                });
            }
        }
    }

    // ------------------------------------------------------------ Hilfen

    private static Map<String, JsonNode> nachKennzeichen(JsonNode array) {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        array.forEach(n -> out.put(n.path("kennzeichen").asText(), n));
        return out;
    }

    /** [ab, bis) — {@code bis} leer heißt „bis auf Weiteres“. */
    private static boolean laeuft(JsonNode o, Instant t, String abFeld, String bisFeld) {
        Instant ab = instant(o.path(abFeld));
        Instant bis = instant(o.path(bisFeld));
        return !t.isBefore(ab) && (bis == null || t.isBefore(bis));
    }

    private static void gleich(List<String> fehler, String was, String datei, String fall) {
        if (datei == null ? fall != null : !datei.equals(fall)) {
            fehler.add(was + ": Referenzdatei „" + datei + "“, Fall „" + fall + "“");
        }
    }

    private static Instant instant(JsonNode n) {
        return n.isNull() || n.isMissingNode()
                ? null
                : OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static String text(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static Integer ganzzahl(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asInt();
    }

    private static List<String> texte(JsonNode array) {
        List<String> out = new ArrayList<>();
        array.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static <E> List<String> codes(E[] werte, Function<E, String> code) {
        return Arrays.stream(werte).map(code).toList();
    }

    /** {@code geraetEinbau} → {@code geraet_einbau}. */
    private static String schlangenschrift(String kamel) {
        return kamel.replaceAll("([A-Z])", "_$1").toLowerCase();
    }
}
