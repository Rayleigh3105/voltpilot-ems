package com.voltpilot.writer;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.writer.MesswertHerkunft.Bindung;
import com.voltpilot.writer.MesswertHerkunft.Ereignis;
import com.voltpilot.writer.MesswertHerkunft.Ergebnis;
import com.voltpilot.writer.MesswertHerkunft.Herkunft;
import com.voltpilot.writer.MesswertHerkunft.Rolle;
import com.voltpilot.writer.MesswertHerkunft.Zustellart;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der WRITER-ZWILLING des Herkunftsvertrags (UEMS AP-07 IP-7): {@link MesswertHerkunft} im
 * Writer urteilt über JEDEN Fall von {@code docs/contracts/v2/messwert-herkunft-vectors.json}
 * genau so, wie die Datei es sagt — dieselbe Datei, an der die api-Klasse
 * ({@code MesswertHerkunftVectorsTest}) hängt. Das ist der Beweis, dass die beiden Kopien nicht
 * auseinanderlaufen. Dazu: die Regel-Zahlen und die Vokabulare sind die der Datei, und die
 * Wertarten, die {@link HerkunftNachschlag} kennt, sind genau die des Vertrags. Rein, kein Docker.
 */
class MesswertHerkunftZwillingTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "messwert-herkunft-vectors.json");

    private static JsonNode lies() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    /** Jeder Fall: dasselbe Urteil, dieselben Ereignisse, dieselben fünfzehn Angaben. */
    @TestFactory
    List<DynamicTest> jederFallUrteiltWieDieVektorDatei() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies().path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                Ergebnis e = MesswertHerkunft.stelleFest(eingang(c.path("input")));
                List<String> abweichungen = new ArrayList<>();
                vergleiche(alsJson(e), c.path("expected"), "expected", abweichungen);
                assertThat(abweichungen).as(c.path("why").asText()).isEmpty();
            }));
        }
        return tests;
    }

    /** Die Regel-Zahlen der Datei sind die Konstanten dieser Kopie. */
    @Test
    void dieRegelZahlenStimmenMitDerAbleitung() throws Exception {
        JsonNode r = lies().path("regeln");
        assertThat(MesswertHerkunft.ZUKUNFT_HOECHSTENS_S)
                .isEqualTo(r.path("zukunft_hoechstens_s").asLong());
        assertThat(MesswertHerkunft.VERGANGENHEIT_HOECHSTENS_S)
                .isEqualTo(r.path("vergangenheit_hoechstens_s").asLong());
        assertThat(MesswertHerkunft.ZEITSPRUNG_AB_S).isEqualTo(r.path("zeitsprung_ab_s").asLong());
        assertThat(MesswertHerkunft.NACHGELIEFERT_MINDESTENS_S)
                .isEqualTo(r.path("nachgeliefert_mindestens_s").asLong());
        assertThat((long) MesswertHerkunft.NACHGELIEFERT_FAKTOR)
                .isEqualTo(r.path("nachgeliefert_faktor_kadenz").asLong());
        assertThat(MesswertHerkunft.UNASSIGNED_READER_HOECHSTENS_JE_S)
                .isEqualTo(r.path("unassigned_reader_hoechstens_je_s").asLong());
    }

    /**
     * Die Wertarten, die der Nachschlag durchlässt, sind GENAU die des Vertrags — der Katalog
     * kennt zusätzlich {@code event} und {@code none}, und die sind keine Wertart (E12).
     */
    @Test
    void dieWertartenSindDieDesVertrags() throws Exception {
        Set<String> ausDerDatei = new HashSet<>();
        lies().path("vokabular").path("wertart").forEach(n -> ausDerDatei.add(n.asText()));
        assertThat(HerkunftNachschlag.WERTARTEN).isEqualTo(ausDerDatei);
        assertThat(HerkunftNachschlag.wertart("gauge")).isEqualTo("gauge");
        assertThat(HerkunftNachschlag.wertart("event")).isNull();
        assertThat(HerkunftNachschlag.wertart("none")).isNull();
        assertThat(HerkunftNachschlag.wertart(null)).isNull();
    }

    /**
     * Kein Ahrenberg-Messkanal hat mehr als 100 s Kadenz — den Zweig, in dem 3 × Kadenz die
     * Schwelle bestimmt, prüft deshalb dieser Test statt eines Vektors.
     */
    @Test
    void dieNachlieferungsSchwelleWaechstMitDerKadenz() {
        assertThat(MesswertHerkunft.nachgeliefertSchwelleS(10)).isEqualTo(300);
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

}
