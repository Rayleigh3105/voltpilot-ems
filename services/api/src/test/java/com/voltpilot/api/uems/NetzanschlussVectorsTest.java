package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.BilanzVectorsTest.bd;
import static com.voltpilot.api.uems.BilanzVectorsTest.lies;
import static com.voltpilot.api.uems.BilanzVectorsTest.str;
import static com.voltpilot.api.uems.BilanzVectorsTest.texte;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings des NETZANSCHLUSSES (UEMS AP-10 IP-1):
 * {@link NetzanschlussRegeln} zieht aus JEDER Prüfung der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/netzanschluss-vectors.json}) genau das Ergebnis, das dort steht — und
 * der TS-Zwilling ({@code frontend/portal/src/uemsNetzanschluss.ts}) aus derselben Datei dasselbe.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class NetzanschlussVectorsTest {

    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("netzanschluss-vectors.json");
    private static final Path SCHEMA = V2.resolve("netzanschluss.schema.json");
    private static final Path PROSA = V2.resolve("netzanschluss.md");
    private static final Path TS_ZWILLING =
            Path.of("..", "..", "frontend", "portal", "src", "uemsNetzanschluss.ts");

    private static JsonNode vektoren() throws Exception {
        return lies(VECTORS);
    }

    private static LocalDate tag(JsonNode n) {
        String s = str(n);
        return s == null ? null : LocalDate.parse(s);
    }

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA)))
                .as("Schema-Verstöße")
                .isEmpty();
    }

    @Test
    void prosaUndTsZwillingLiegen() {
        assertThat(Files.exists(PROSA)).as("netzanschluss.md").isTrue();
        assertThat(Files.exists(TS_ZWILLING)).as("TS-Zwilling").isTrue();
    }

    /** Die Kennzeichen-Form ist die des Messstellen-Vertrags — nur das Präfix ist eigen. */
    @Test
    void dieKennzeichenFormIstDieDesMessstellenVertrags() throws Exception {
        JsonNode k = vektoren().path("kennzeichen_regel");
        assertThat(k.path("praefix").asText()).isEqualTo(NetzanschlussRegeln.KENNZEICHEN_PRAEFIX);
        assertThat(k.path("stellen").asInt()).isEqualTo(NetzanschlussRegeln.KENNZEICHEN_STELLEN);
        assertThat(k.path("muster").asText()).isEqualTo(MessstelleRegeln.KENNZEICHEN_MUSTER);
        assertThat(k.path("min_zeichen").asInt()).isEqualTo(MessstelleRegeln.KENNZEICHEN_MIN_ZEICHEN);
        assertThat(k.path("max_zeichen").asInt()).isEqualTo(MessstelleRegeln.KENNZEICHEN_MAX_ZEICHEN);
        assertThat(vektoren().path("regeln").path("malo_muster").asText())
                .isEqualTo(NetzanschlussRegeln.MALO_MUSTER);
        assertThat(texte(vektoren().path("vokabulare").path("messung")))
                .containsExactlyElementsOf(NetzanschlussRegeln.MESSUNGEN);
        assertThat(vektoren().path("regeln").path("kopfzeile_trenner").asText())
                .isEqualTo(NetzanschlussRegeln.KOPFZEILE_TRENNER);
    }

    /** Jede Regel ist deklariert, jede Lücke begründet; jede Abweichung benannt. */
    @Test
    void jedeRegelIstDeklariertUndJedeAbweichungBenannt() throws Exception {
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
            assertThat(wer).as("Zwillinge von " + e.getKey()).contains("java", "ts");
        });
        assertThat(v.path("_abweichungen")).isNotEmpty();
        v.path("_abweichungen").forEach(a -> assertThat(a.path("grund").asText()).isNotBlank());
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
        assertThat(tests).as("Prüfungen über alle Fälle").hasSizeGreaterThanOrEqualTo(20);
        return tests;
    }

    private void pruefe(JsonNode fall, JsonNode p) {
        String why = fall.path("id").asText() + " (" + fall.path("why").asText() + ")";
        JsonNode ein = p.path("eingang");
        JsonNode soll = p.path("ergebnis");

        switch (p.path("regel").asText()) {
            case "kennzeichen" -> {
                NetzanschlussRegeln.KennzeichenUrteil ist = NetzanschlussRegeln.kennzeichen(
                        str(ein.path("kandidat")), texte(ein.path("belegt")),
                        ein.path("zaehler").asInt());
                assertThat(ist.gueltig()).as(why + " · gültig").isEqualTo(soll.path("gueltig").asBoolean());
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                if (soll.path("vorschlag").isNull()) {
                    assertThat(ist.vorschlag()).as(why + " · kein Vorschlag").isNull();
                } else {
                    assertThat(ist.vorschlag()).as(why + " · Vorschlag").isNotNull();
                    assertThat(ist.vorschlag().kennzeichen())
                            .isEqualTo(soll.path("vorschlag").path("kennzeichen").asText());
                    assertThat(ist.vorschlag().zaehler())
                            .isEqualTo(soll.path("vorschlag").path("zaehler").asInt());
                }
            }
            case "malo" -> {
                NetzanschlussRegeln.MaloUrteil ist = NetzanschlussRegeln.malo(str(ein.path("text")));
                assertThat(ist.malo()).as(why + " · Marktlokation").isEqualTo(str(soll.path("malo")));
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
            }
            case "felder" -> {
                NetzanschlussRegeln.FelderUrteil ist = NetzanschlussRegeln.felder(
                        new NetzanschlussRegeln.Felder(str(ein.path("name")), str(ein.path("standort")),
                                str(ein.path("malo")), str(ein.path("netzbetreiber")),
                                bd(ein.path("anschluss_kva")), bd(ein.path("vereinbart_kw")),
                                str(ein.path("messung"))));
                assertThat(ist.gueltig()).as(why + " · gültig").isEqualTo(soll.path("gueltig").asBoolean());
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                assertThat(ist.feld()).as(why + " · Feld").isEqualTo(str(soll.path("feld")));
                assertThat(ist.hinweise()).as(why + " · Hinweise").isEqualTo(texte(soll.path("hinweise")));
            }
            case "bindung" -> {
                List<NetzanschlussRegeln.Bindung> bestehend = new ArrayList<>();
                for (JsonNode b : ein.path("bestehend")) {
                    bestehend.add(bindung(b));
                }
                NetzanschlussRegeln.BindungUrteil ist = NetzanschlussRegeln.bindung(
                        bestehend, bindung(ein.path("neu")), tag(ein.path("heute")));
                assertThat(text(ist.beendet())).as(why + " · beendet")
                        .isEqualTo(sollText(soll.path("beendet")));
                assertThat(text(ist.eintrag())).as(why + " · Eintrag")
                        .isEqualTo(sollText(soll.path("eintrag")));
                assertThat(ist.fehler()).as(why + " · Fehler").isEqualTo(str(soll.path("fehler")));
                assertThat(ist.rueckwirkend()).as(why + " · rückwirkend")
                        .isEqualTo(soll.path("rueckwirkend").asBoolean());
            }
            case "kopfzeile" -> {
                NetzanschlussRegeln.KopfzeileUrteil ist = NetzanschlussRegeln.kopfzeile(
                        str(ein.path("netzanschluss")), bd(ein.path("vereinbart_kw")),
                        bd(ein.path("anschluss_kva")), bd(ein.path("momentan_kw")));
                assertThat(ist.text()).as(why + " · Kopfzeile").isEqualTo(str(soll.path("text")));
                assertThat(ist.grenzeGeprueft()).as(why + " · hier wird gezeigt, nicht geprüft")
                        .isEqualTo(soll.path("grenze_geprueft").asBoolean());
            }
            default -> throw new IllegalStateException("unbekannte Regel " + p.path("regel").asText());
        }
    }

    private static NetzanschlussRegeln.Bindung bindung(JsonNode b) {
        return new NetzanschlussRegeln.Bindung(b.path("anlage").asText(), b.path("netzanschluss").asText(),
                tag(b.path("gueltig_ab")), tag(b.path("gueltig_bis")));
    }

    private static String text(NetzanschlussRegeln.Bindung b) {
        return b == null ? null : b.anlage() + "→" + b.netzanschluss() + "@" + b.gueltigAb() + ".."
                + b.gueltigBis();
    }

    private static String sollText(JsonNode n) {
        if (n.isNull() || n.isMissingNode()) {
            return null;
        }
        return n.path("anlage").asText() + "→" + n.path("netzanschluss").asText() + "@"
                + n.path("gueltig_ab").asText() + ".." + str(n.path("gueltig_bis"));
    }
}
