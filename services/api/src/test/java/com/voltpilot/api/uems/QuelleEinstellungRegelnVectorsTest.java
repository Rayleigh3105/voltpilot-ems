package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Abgeleitet;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Art;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Bestehende;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Eingang;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Fehler;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Neu;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Urteil;
import com.voltpilot.api.uems.QuelleEinstellungRegeln.Vorgaenger;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Die Einstellungs-Fassungen je Quelle (UEMS AP-04 IP-11) gegen die EINE geteilte Vektor-Datei
 * {@code docs/contracts/v2/quelle-einstellung-vectors.json} — dieselbe, die der TS-Zwilling
 * {@code frontend/portal/src/uemsEinstellung.test.ts} und die SQL-Seite
 * ({@code UemsQuelleEinstellungMigrationTest}) fahren. Dazu: die Datei hält ihr Schema
 * ({@link UemsSchemaLaeufer}), die Konstanten stehen genau so in der Datei, und jeder Fall über ein
 * Ahrenberg-Objekt übernimmt dessen Werte aus dem Referenzunternehmen.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class QuelleEinstellungRegelnVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("quelle-einstellung-vectors.json");
    private static final Path SCHEMA = V2.resolve("quelle-einstellung.schema.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    static Instant zeit(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static List<DynamicTest> faelle(String familie, Consumer<JsonNode> pruefe) throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases").path(familie)) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> pruefe.accept(c)));
        }
        assertThat(tests).as(familie).isNotEmpty();
        return tests;
    }

    /** Ein Fall der Familie {@code fassung} als Eingang der Regel — auch vom API-Test benutzt. */
    static Eingang eingang(JsonNode in) {
        List<Bestehende> bestehende = new ArrayList<>();
        for (JsonNode b : in.path("bestehende")) {
            bestehende.add(new Bestehende(b.path("id").asText(), b.get("wert"), b.path("anwendung").asText(),
                    zeit(b.get("gueltig_ab")), zeit(b.get("gueltig_bis"))));
        }
        JsonNode n = in.path("neu");
        return new Eingang(zeit(in.get("beginn")), zeit(in.get("ende")), bestehende,
                new Neu(n.path("art").asText(), n.get("wert"), n.path("anwendung").asText(),
                        zeit(n.get("gueltig_ab")), zeit(n.get("tatsaechlich_ab"))),
                zeit(in.get("jetzt")));
    }

    // ------------------------------------------------------ Datei und Konstanten

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA))).isEmpty();
    }

    @Test
    void dieKonstantenStehenGenauSoInDerDatei() throws Exception {
        JsonNode v = lies(VECTORS);
        List<Map<String, Object>> arten = new ArrayList<>();
        for (Art a : Art.values()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("art", a.code());
            m.put("kundenwort", a.kundenwort());
            m.put("felder", a.felder());
            m.put("text", a.text());
            arten.add(m);
        }
        assertThat(MAPPER.convertValue(v.get("arten"), List.class)).isEqualTo(arten);
        assertThat(MAPPER.convertValue(v.get("wandler_arten"), List.class)).isEqualTo(
                java.util.Arrays.stream(Art.values()).filter(Art::istWandler).map(Art::code).toList());
        assertThat(v.get("zahl_grenze").decimalValue()).isEqualByComparingTo(QuelleEinstellungRegeln.ZAHL_GRENZE);
        assertThat(v.get("einheit_max_zeichen").asInt()).isEqualTo(QuelleEinstellungRegeln.EINHEIT_MAX_ZEICHEN);
        assertThat(MAPPER.convertValue(v.get("anwendungen"), List.class)).isEqualTo(QuelleEinstellungRegeln.ANWENDUNGEN);
        assertThat(MAPPER.convertValue(v.get("herkuenfte"), List.class)).isEqualTo(QuelleEinstellungRegeln.HERKUENFTE);
        assertThat(MAPPER.convertValue(v.get("zustellungen"), List.class)).isEqualTo(QuelleEinstellungRegeln.ZUSTELLUNGEN);
        assertThat(MAPPER.convertValue(v.get("status"), List.class)).isEqualTo(QuelleEinstellungRegeln.STATUS);
        assertThat(MAPPER.convertValue(v.get("verbindungs_kanaele"), Map.class))
                .isEqualTo(QuelleEinstellungRegeln.VERBINDUNGS_KANAELE);
        assertThat(v.get("selbstbau_kommunikation").asText()).isEqualTo(QuelleEinstellungRegeln.SELBSTBAU_KOMMUNIKATION);
        assertThat(MAPPER.convertValue(v.get("leistungsskalierung_stufen"), List.class))
                .isEqualTo(QuelleEinstellungRegeln.LEISTUNGSSKALIERUNG_STUFEN);
        List<Map<String, Object>> fehler = new ArrayList<>();
        for (Fehler f : Fehler.values()) {
            fehler.add(Map.of("code", f.code(), "status", f.status()));
        }
        assertThat(MAPPER.convertValue(v.get("fehler"), List.class)).isEqualTo(fehler);
        assertThat(MAPPER.convertValue(v.get("texte"), Map.class)).isEqualTo(QuelleEinstellungRegeln.TEXTE);
    }

    // ------------------------------------------------------ die Familien

    @TestFactory
    List<DynamicTest> wert() throws Exception {
        return faelle("wert", c -> {
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            assertThat(QuelleEinstellungRegeln.wertGueltig(in.path("art").asText(), in.get("wert")))
                    .isEqualTo(exp.path("gueltig").asBoolean());
            assertThat(QuelleEinstellungRegeln.wertText(in.path("art").asText(), in.get("wert")))
                    .isEqualTo(text(exp.get("text")));
        });
    }

    @TestFactory
    List<DynamicTest> fassung() throws Exception {
        return faelle("fassung", c -> {
            Urteil u = QuelleEinstellungRegeln.neueFassung(eingang(c.path("input")));
            JsonNode exp = c.path("expected");
            assertThat(u.fehler() == null ? null : u.fehler().code()).isEqualTo(text(exp.get("code")));
            JsonNode beendet = exp.get("beendet");
            if (beendet.isNull()) {
                assertThat(u.beendet()).isNull();
            } else {
                assertThat(u.beendet().id()).isEqualTo(beendet.path("id").asText());
                assertThat(u.beendet().gueltigBis()).isEqualTo(zeit(beendet.get("gueltig_bis")));
            }
            assertThat(u.gueltigAb()).isEqualTo(zeit(exp.get("gueltig_ab")));
            assertThat(u.gueltigBis()).isEqualTo(zeit(exp.get("gueltig_bis")));
            assertThat(u.rueckwirkend()).isEqualTo(exp.get("rueckwirkend").isNull() ? null
                    : exp.get("rueckwirkend").asBoolean());
        });
    }

    @TestFactory
    List<DynamicTest> folgen() throws Exception {
        return faelle("folgen", c -> {
            JsonNode in = c.path("input");
            JsonNode neu = in.path("neu");
            JsonNode v = in.get("vorgaenger");
            List<String> saetze = QuelleEinstellungRegeln.folgen(in.path("art").asText(),
                    in.path("herkunft").asText(), neu.get("wert"), neu.path("anwendung").asText(),
                    zeit(neu.get("gueltig_ab")), zeit(neu.get("tatsaechlich_ab")),
                    v.isNull() ? null : new Vorgaenger(v.get("wert"), v.path("anwendung").asText()));
            assertThat(saetze).isEqualTo(MAPPER.convertValue(c.get("expected"), List.class));
        });
    }

    @TestFactory
    List<DynamicTest> anzeige() throws Exception {
        return faelle("anzeige", c -> {
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            assertThat(QuelleEinstellungRegeln.status(zeit(in.get("gueltig_ab")), zeit(in.get("gueltig_bis")),
                    zeit(in.get("jetzt")))).isEqualTo(exp.path("status").asText());
            assertThat(QuelleEinstellungRegeln.zustellung(in.path("anwendung").asText(), in.path("herkunft").asText()))
                    .isEqualTo(text(exp.get("zustellung")));
            assertThat(QuelleEinstellungRegeln.anwendungText(in.path("anwendung").asText(),
                    in.path("herkunft").asText())).isEqualTo(exp.path("anwendung_text").asText());
        });
    }

    @TestFactory
    List<DynamicTest> verbindung() throws Exception {
        return faelle("verbindung", c -> {
            JsonNode in = c.path("input");
            gleich(QuelleEinstellungRegeln.ausVerbindung(text(in.get("kommunikation")), in.get("verbindung")),
                    c.get("expected"));
        });
    }

    @TestFactory
    List<DynamicTest> aenderung() throws Exception {
        return faelle("aenderung", c -> {
            JsonNode in = c.path("input");
            gleich(QuelleEinstellungRegeln.aenderungen(text(in.get("kommunikation")), in.get("alt"), in.get("neu")),
                    c.get("expected"));
        });
    }

    /** Dieselben Fassungen in derselben Reihenfolge; Zahlen nach ihrem Wert. */
    static void gleich(List<Abgeleitet> ist, JsonNode soll) {
        assertThat(ist).hasSize(soll.size());
        for (int i = 0; i < ist.size(); i++) {
            JsonNode s = soll.get(i);
            assertThat(ist.get(i).kanal()).as("kanal #" + i).isEqualTo(text(s.get("kanal")));
            assertThat(ist.get(i).art()).as("art #" + i).isEqualTo(s.path("art").asText());
            assertThat(QuelleEinstellungRegeln.gleicherWert(ist.get(i).wert(), s.get("wert")))
                    .as("wert #" + i + ": " + ist.get(i).wert() + " ≠ " + s.get("wert")).isTrue();
        }
    }

    // ------------------------------------------------------ Referenzunternehmen

    /**
     * Jeder Fall über ein Ahrenberg-Objekt: Gerät, Einbau und Komponente gibt es in der Referenz;
     * `beginn`/`ende` sind Beginn und Ende des Einbaus (Gerät) bzw. der Komponente (Kanal); und wo
     * eine Fassung den Wandler einer Energiekarte trägt, den die Referenz führt, beginnt sie genau
     * dort, wo die Referenz ihn beginnen lässt (A5: 400/5 A ab 01.02.2027).
     */
    @TestFactory
    List<DynamicTest> jederFallUeberAhrenbergUebernimmtDieWerteDerReferenz() throws Exception {
        JsonNode referenz = lies(REFERENZ);
        return faelle("fassung", c -> {
            JsonNode r = c.get("referenz");
            if (r.isNull()) {
                return;
            }
            JsonNode geraet = element(referenz.get("geraete"), r.path("geraet").asText());
            JsonNode einbau = element(geraet.get("einbauten"), r.path("einbau").asText());
            JsonNode in = c.path("input");
            if (r.get("komponente").isNull()) {
                assertThat(zeit(in.get("beginn"))).isEqualTo(zeit(einbau.get("gueltig_ab")));
                assertThat(zeit(in.get("ende"))).isEqualTo(zeit(einbau.get("gueltig_bis")));
                return;
            }
            JsonNode komponente = element(referenz.get("komponenten"), r.path("komponente").asText());
            assertThat(komponente.path("geraet").asText()).isEqualTo(geraet.path("kennzeichen").asText());
            assertThat(zeit(in.get("beginn"))).isEqualTo(zeit(komponente.get("in_betrieb_ab")));
            // Die bestehenden immer; die neue nur, wo die Regel sie annimmt — eine abgelehnte liegt
            // absichtlich daneben (vor dem Beginn, …).
            List<JsonNode> fassungen = new ArrayList<>();
            in.path("bestehende").forEach(fassungen::add);
            if (c.at("/expected/code").isNull()) {
                fassungen.add(in.get("neu"));
            }
            int getroffen = 0;
            for (JsonNode f : fassungen) {
                for (JsonNode w : komponente.path("wandler")) {
                    if (f.at("/wert/primaer_a").decimalValue().compareTo(w.get("primaer_a").decimalValue()) == 0
                            && f.at("/wert/sekundaer_a").decimalValue()
                                    .compareTo(w.get("sekundaer_a").decimalValue()) == 0) {
                        assertThat(zeit(f.get("gueltig_ab"))).as(f.toString()).isEqualTo(zeit(w.get("gueltig_ab")));
                        getroffen++;
                    }
                }
            }
            if (!fassungen.isEmpty()) {
                assertThat(getroffen).as("mindestens ein Wandler der Referenz").isPositive();
            }
        });
    }

    @Test
    void aFuenfNimmtDenTauschDerReferenzUndDieWerteVonEkZwei() throws Exception {
        JsonNode referenz = lies(REFERENZ);
        JsonNode ek2 = element(referenz.get("komponenten"), "K-8.2").get("wandler");
        assertThat(ek2).hasSize(2);
        assertThat(ek2.get(0).get("primaer_a").decimalValue()).isEqualByComparingTo(new BigDecimal(250));
        assertThat(ek2.get(1).get("primaer_a").decimalValue()).isEqualByComparingTo(new BigDecimal(400));
        assertThat(zeit(ek2.get(1).get("gueltig_ab"))).isEqualTo(Instant.parse("2027-01-31T23:00:00Z"));
    }

    private static JsonNode element(JsonNode liste, String kennzeichen) {
        for (JsonNode e : liste) {
            if (kennzeichen.equals(e.path("kennzeichen").asText())) {
                return e;
            }
        }
        throw new AssertionError("nicht in der Referenzdatei: " + kennzeichen);
    }
}
