package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings: {@link ZustandAbleitung} zieht aus JEDEM Fall
 * der EINEN geteilten Vektor-Datei
 * ({@code docs/contracts/v2/uems-zustand-vectors.json}) dasselbe Urteil und
 * denselben Kundensatz wie der TS-Zwilling
 * ({@code frontend/portal/src/uemsZustand.test.ts} fährt dieselbe Datei).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr) — das
 * {@code AnwendungDerivationTest}/{@code EigeneAuswertungTest}-Muster.
 */
class ZustandAbleitungVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "uems-zustand-vectors.json");

    private static JsonNode vectors() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    // ------------------------------------------------------------------ Hilfen

    private static Instant instant(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        return OffsetDateTime.parse(n.asText()).toInstant();
    }

    private static ZoneId zone(JsonNode in) {
        JsonNode z = in.path("zeitzone");
        return z.isMissingNode() || z.isNull()
                ? ZustandAbleitung.VORGABE_ZEITZONE
                : ZoneId.of(z.asText());
    }

    private static String text(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    // ------------------------------------------------------ die Vektor-Fälle

    @TestFactory
    List<DynamicTest> liefertDatenEinzel() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (!"liefert_daten".equals(c.path("familie").asText())
                    || !"einzel".equals(c.path("ableitung").asText())) {
                continue;
            }
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            ZustandAbleitung.LiefertDatenEingang eingang =
                    new ZustandAbleitung.LiefertDatenEingang(
                            in.path("quelle_vorhanden").asBoolean(),
                            instant(in.get("letzter_guter_wert")),
                            in.path("je_ein_wert").asBoolean(),
                            in.path("kadenz_s").asLong(),
                            instant(in.get("jetzt")),
                            zone(in));
            tests.add(
                    DynamicTest.dynamicTest(
                            "liefert Daten · " + c.path("name").asText(),
                            () -> {
                                ZustandAbleitung.LiefertDatenErgebnis ist =
                                        ZustandAbleitung.liefertDaten(eingang);
                                assertThat(ist.zustand().code())
                                        .isEqualTo(exp.path("zustand").asText());
                                assertThat(ist.seit()).isEqualTo(instant(exp.get("seit")));
                                assertThat(ist.toleranzS())
                                        .isEqualTo(exp.path("toleranz_s").asLong());
                                assertThat(ist.lueckeOffen())
                                        .isEqualTo(exp.path("luecke_offen").asBoolean());
                                assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> liefertDatenAnlage() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (!"anlage".equals(c.path("ableitung").asText())) {
                continue;
            }
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            List<ZustandAbleitung.BoxZustand> boxen = new ArrayList<>();
            for (JsonNode b : in.path("boxen")) {
                boxen.add(
                        new ZustandAbleitung.BoxZustand(
                                b.path("name").asText(), b.path("verbunden").asBoolean()));
            }
            JsonNode hz = in.get("hauptzaehler");
            ZustandAbleitung.Quellzustand hauptzaehler =
                    hz == null || hz.isNull()
                            ? null
                            : new ZustandAbleitung.Quellzustand(
                                    ZustandAbleitung.LiefertDaten.vonCode(
                                            hz.path("zustand").asText()),
                                    instant(hz.get("seit")));
            ZustandAbleitung.AnlageEingang eingang =
                    new ZustandAbleitung.AnlageEingang(
                            boxen, hauptzaehler, instant(in.get("jetzt")), zone(in));
            tests.add(
                    DynamicTest.dynamicTest(
                            "Anlage · " + c.path("name").asText(),
                            () -> {
                                ZustandAbleitung.AnlageErgebnis ist =
                                        ZustandAbleitung.liefertDatenAnlage(eingang);
                                assertThat(ist.liefert() ? "liefert" : "liefert_nicht")
                                        .isEqualTo(exp.path("zustand").asText());
                                assertThat(ist.grund() == null ? null : ist.grund().code())
                                        .isEqualTo(text(exp.path("grund")));
                                assertThat(ist.seit()).isEqualTo(instant(exp.get("seit")));
                                assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> aggregate() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (!"aggregat".equals(c.path("ableitung").asText())) {
                continue;
            }
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            ZustandAbleitung.Einheit einheit =
                    ZustandAbleitung.Einheit.vonCode(in.path("einheit").asText());
            boolean steuertFamilie = "steuert".equals(c.path("familie").asText());
            tests.add(
                    DynamicTest.dynamicTest(
                            "Aggregat · " + c.path("name").asText(),
                            () -> {
                                ZustandAbleitung.AggregatErgebnis ist;
                                int erwartetErfuellt;
                                if (steuertFamilie) {
                                    List<Boolean> einzel = new ArrayList<>();
                                    for (JsonNode z : in.path("einzel")) {
                                        einzel.add("steuert".equals(z.asText()));
                                    }
                                    ist = ZustandAbleitung.aggregatSteuert(einzel, einheit);
                                    erwartetErfuellt = exp.path("steuernd").asInt();
                                } else {
                                    List<ZustandAbleitung.LiefertDaten> einzel = new ArrayList<>();
                                    for (JsonNode z : in.path("einzel")) {
                                        einzel.add(
                                                ZustandAbleitung.LiefertDaten.vonCode(z.asText()));
                                    }
                                    ist = ZustandAbleitung.aggregatLiefertDaten(einzel, einheit);
                                    erwartetErfuellt = exp.path("liefernd").asInt();
                                }
                                assertThat(ist.erfuellt()).isEqualTo(erwartetErfuellt);
                                assertThat(ist.gesamt()).isEqualTo(exp.path("gesamt").asInt());
                                assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> berechneteMessstelle() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (!"berechnet".equals(c.path("ableitung").asText())) {
                continue;
            }
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            List<ZustandAbleitung.BerechnetEingang> eingaenge = new ArrayList<>();
            for (JsonNode e : in.path("eingaenge")) {
                eingaenge.add(
                        new ZustandAbleitung.BerechnetEingang(
                                e.path("kennzeichen").asText(),
                                ZustandAbleitung.LiefertDaten.vonCode(e.path("zustand").asText()),
                                instant(e.get("seit"))));
            }
            Instant jetzt = instant(in.get("jetzt"));
            ZoneId zone = zone(in);
            tests.add(
                    DynamicTest.dynamicTest(
                            "berechnet · " + c.path("name").asText(),
                            () -> {
                                ZustandAbleitung.BerechnetErgebnis ist =
                                        ZustandAbleitung.berechnet(eingaenge, jetzt, zone);
                                assertThat(ist.vollstaendig() ? "vollstaendig" : "unvollstaendig")
                                        .isEqualTo(exp.path("zustand").asText());
                                List<String> fehlend = new ArrayList<>();
                                for (JsonNode f : exp.path("fehlend")) {
                                    fehlend.add(f.asText());
                                }
                                assertThat(ist.fehlend()).containsExactlyElementsOf(fehlend);
                                assertThat(ist.seit()).isEqualTo(instant(exp.get("seit")));
                                assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    @TestFactory
    List<DynamicTest> steuert() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (!"steuert".equals(c.path("familie").asText())
                    || !"einzel".equals(c.path("ableitung").asText())) {
                continue;
            }
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            ZustandAbleitung.SteuertEingang eingang =
                    new ZustandAbleitung.SteuertEingang(
                            in.path("freigabe_erteilt").asBoolean(),
                            in.path("funktion_gestartet").asBoolean(),
                            in.path("laeuft").asBoolean(),
                            text(in.path("laeuft_art")),
                            text(in.path("laeuft_name")),
                            in.path("box_verbunden").asBoolean(),
                            in.path("box_bestaetigt").asBoolean(),
                            in.path("ruhe_eintrag").asBoolean());
            tests.add(
                    DynamicTest.dynamicTest(
                            "steuert · " + c.path("name").asText(),
                            () -> {
                                ZustandAbleitung.SteuertErgebnis ist =
                                        ZustandAbleitung.steuert(eingang);
                                assertThat(ist.steuert() ? "steuert" : "steuert_nicht")
                                        .isEqualTo(exp.path("zustand").asText());
                                assertThat(ist.grund() == null ? null : ist.grund().code())
                                        .isEqualTo(text(exp.path("grund")));
                                assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                            }));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    // ---------------------------------------------------- die Datei als Ganzes

    /**
     * Die Konstanten der Regel stehen in der Vektor-Datei UND im Code. Sie hier
     * gegeneinander zu prüfen ist der Unterschied zwischen „dokumentiert“ und
     * „bewiesen“ — ein geänderter Faktor fällt sonst erst in einem einzelnen
     * Zahlenfall auf.
     */
    @Test
    void dieRegelKonstantenStimmenMitDerDateiUeberein() throws Exception {
        JsonNode t = vectors().path("toleranz");
        assertThat(t.path("faktor").asInt()).isEqualTo(ZustandAbleitung.TOLERANZ_FAKTOR);
        assertThat(t.path("mindestens_s").asLong())
                .isEqualTo(ZustandAbleitung.TOLERANZ_MINDESTENS_S);
        assertThat(t.path("hoechstens_s").asLong())
                .isEqualTo(ZustandAbleitung.TOLERANZ_HOECHSTENS_S);
        assertThat(t.path("luecke_faktor").asInt()).isEqualTo(ZustandAbleitung.LUECKE_FAKTOR);
        assertThat(t.path("kante_gehoert_zu_liefert").asBoolean()).isTrue();
        assertThat(vectors().path("zeitzone").asText())
                .isEqualTo(ZustandAbleitung.VORGABE_ZEITZONE.getId());
    }

    /** Das geschlossene Vokabular ist wirklich geschlossen — beide Listen, beide Richtungen. */
    @Test
    void dasVokabularIstDasselbe() throws Exception {
        JsonNode root = vectors();
        List<String> zustaende = new ArrayList<>();
        for (JsonNode n : root.path("zustaende_liefert_daten")) {
            zustaende.add(n.asText());
        }
        assertThat(zustaende)
                .containsExactly(
                        ZustandAbleitung.LiefertDaten.LIEFERT.code(),
                        ZustandAbleitung.LiefertDaten.LIEFERT_NICHT_SEIT.code(),
                        ZustandAbleitung.LiefertDaten.WARTET_AUF_ERSTE_DATEN.code(),
                        ZustandAbleitung.LiefertDaten.KEINE_DATENQUELLE.code());

        List<String> anlage = new ArrayList<>();
        for (JsonNode n : root.path("gruende_anlage")) {
            anlage.add(n.asText());
        }
        List<String> anlageCode = new ArrayList<>();
        for (ZustandAbleitung.AnlageGrund g : ZustandAbleitung.AnlageGrund.values()) {
            anlageCode.add(g.code());
        }
        assertThat(anlage).containsExactlyElementsOf(anlageCode);

        List<String> steuert = new ArrayList<>();
        for (JsonNode n : root.path("gruende_steuert")) {
            steuert.add(n.asText());
        }
        List<String> steuertCode = new ArrayList<>();
        for (ZustandAbleitung.SteuertGrund g : ZustandAbleitung.SteuertGrund.values()) {
            steuertCode.add(g.code());
        }
        // Die Reihenfolge IST die Regel: sie entscheidet, welcher Grund gilt,
        // wenn mehrere zutreffen.
        assertThat(steuert).containsExactlyElementsOf(steuertCode);
    }

    /** Ein- und Mehrzahl der gezählten Dinge stehen in der Datei und im Code — dieselbe Tabelle. */
    @Test
    void dieEinheitenTabelleIstDieselbe() throws Exception {
        Map<String, List<String>> ausDerDatei = new LinkedHashMap<>();
        JsonNode e = vectors().path("einheiten");
        e.fieldNames()
                .forEachRemaining(
                        k ->
                                ausDerDatei.put(
                                        k,
                                        List.of(
                                                e.path(k).path("singular").asText(),
                                                e.path(k).path("plural").asText())));
        Map<String, List<String>> ausDemCode = new LinkedHashMap<>();
        for (ZustandAbleitung.Einheit einheit : ZustandAbleitung.Einheit.values()) {
            ausDemCode.put(einheit.code(), List.of(einheit.singular(), einheit.plural()));
        }
        assertThat(ausDerDatei).isEqualTo(ausDemCode);
    }

    /** Jeder Fall trägt einen Grund, warum er in der Datei steht. */
    @Test
    void jederFallSagtWarumErDaIst() throws Exception {
        for (JsonNode c : vectors().path("cases")) {
            assertThat(c.path("why").asText())
                    .as("why für %s", c.path("name").asText())
                    .isNotBlank();
        }
    }
}
