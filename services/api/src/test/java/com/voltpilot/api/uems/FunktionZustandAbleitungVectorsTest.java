package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Aktion;
import com.voltpilot.api.uems.FunktionZustandAbleitung.StandortErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.TeilnahmeStand;
import com.voltpilot.api.uems.FunktionZustandAbleitung.UebergangErgebnis;
import com.voltpilot.api.uems.FunktionZustandAbleitung.Zustand;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des Java-Zwillings: {@link FunktionZustandAbleitung} zieht aus JEDEM Fall der
 * EINEN geteilten Vektor-Datei ({@code docs/contracts/v2/funktion-zustand-vectors.json})
 * denselben Zustand, dieselbe „es fehlt“-Liste und denselben Kundensatz wie der TS-Zwilling
 * ({@code frontend/portal/src/uemsFunktion.test.ts} fährt dieselbe Datei).
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr) — das {@link
 * ZustandAbleitungVectorsTest}-Muster.
 */
class FunktionZustandAbleitungVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei
    // Ebenen darüber.
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "funktion-zustand-vectors.json");

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
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static List<String> texte(JsonNode n) {
        List<String> out = new ArrayList<>();
        for (JsonNode x : n) {
            out.add(x.asText());
        }
        return out;
    }

    private static List<ZustandAbleitung.BoxZustand> boxen(JsonNode n) {
        List<ZustandAbleitung.BoxZustand> out = new ArrayList<>();
        for (JsonNode b : n) {
            out.add(
                    new ZustandAbleitung.BoxZustand(
                            b.path("name").asText(), b.path("verbunden").asBoolean()));
        }
        return out;
    }

    private static TeilnahmeStand stand(JsonNode t) {
        return new TeilnahmeStand(
                t.path("anlage").asText(),
                Zustand.vonCode(t.path("zustand").asText()),
                instant(t.get("seit")),
                texte(t.path("fehlt")));
    }

    private static List<TeilnahmeStand> staende(JsonNode n) {
        List<TeilnahmeStand> out = new ArrayList<>();
        for (JsonNode t : n) {
            out.add(stand(t));
        }
        return out;
    }

    private static FunktionZustandAbleitung.TeilnahmeEingang teilnahmeEingang(JsonNode in) {
        JsonNode r = in.get("ruhe_eintrag");
        JsonNode hz = in.get("hauptzaehler");
        JsonNode a = in.get("ausfuehrung");
        List<FunktionZustandAbleitung.Komponente> komponenten = new ArrayList<>();
        for (JsonNode k : in.path("komponenten")) {
            komponenten.add(
                    new FunktionZustandAbleitung.Komponente(
                            k.path("name").asText(),
                            FunktionZustandAbleitung.KomponentenArt.vonCode(k.path("art").asText()),
                            k.path("freigegeben").asBoolean(),
                            k.path("verbindungstest_bestanden").asBoolean(),
                            text(k.get("steuerart"))));
        }
        return new FunktionZustandAbleitung.TeilnahmeEingang(
                in.path("anlage").asText(),
                in.path("aufgenommen").asBoolean(),
                instant(in.get("eingerichtet_am")),
                instant(in.get("gestartet_am")),
                in.path("uebernommen").asBoolean(),
                r == null || r.isNull()
                        ? null
                        : new FunktionZustandAbleitung.RuheEintrag(
                                instant(r.get("seit")), instant(r.get("ende"))),
                instant(in.get("beendet_am")),
                boxen(in.path("boxen")),
                hz == null || hz.isNull()
                        ? null
                        : new FunktionZustandAbleitung.Hauptzaehler(
                                hz.path("kennzeichen").asText(),
                                ZustandAbleitung.LiefertDaten.vonCode(hz.path("zustand").asText()),
                                instant(hz.get("seit"))),
                komponenten,
                text(in.get("betriebsmodell")),
                in.path("grenze_plausibel").asBoolean(),
                a == null || a.isNull()
                        ? null
                        : new FunktionZustandAbleitung.Ausfuehrung(
                                a.path("laeuft").asBoolean(),
                                text(a.get("laeuft_art")),
                                text(a.get("laeuft_name")),
                                a.path("box_bestaetigt").asBoolean()),
                instant(in.get("jetzt")),
                zone(in));
    }

    private static FunktionZustandAbleitung.BestandEingang bestandEingang(JsonNode b) {
        return new FunktionZustandAbleitung.BestandEingang(
                b.path("anlage").asText(),
                b.path("betriebsmodell_an").asBoolean(),
                instant(b.get("betriebsmodell_seit")),
                b.path("eigenverbrauch_laeuft").asBoolean(),
                instant(b.get("eigenverbrauch_seit")),
                b.path("steuerart_oder_regel_aktiv").asBoolean(),
                instant(b.get("steuerart_seit")),
                b.path("scharfschaltung").asBoolean());
    }

    private static void standortPasst(StandortErgebnis ist, JsonNode exp) {
        assertThat(ist.zustand().code()).isEqualTo(exp.path("zustand").asText());
        assertThat(ist.seit()).isEqualTo(instant(exp.get("seit")));
        assertThat(ist.text()).isEqualTo(exp.path("text").asText());
    }

    private static void uebergangPasst(UebergangErgebnis ist, JsonNode exp) {
        assertThat(ist.erlaubt()).isEqualTo(exp.path("erlaubt").asBoolean());
        assertThat(ist.grund() == null ? null : ist.grund().code())
                .isEqualTo(text(exp.get("grund")));
        assertThat(ist.nachher().code()).isEqualTo(exp.path("nachher").asText());
        assertThat(ist.betroffen()).containsExactlyElementsOf(texte(exp.path("betroffen")));
        assertThat(ist.text()).isEqualTo(text(exp.get("text")));
    }

    /** Ein dynamischer Test je Fall der Familie (und Ableitung, wenn gegeben). */
    private static List<DynamicTest> faelle(
            String familie, String ableitung, BiConsumer<JsonNode, JsonNode> pruefe)
            throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : vectors().path("cases")) {
            if (!familie.equals(c.path("familie").asText())
                    || (ableitung != null && !ableitung.equals(c.path("ableitung").asText()))) {
                continue;
            }
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            tests.add(
                    DynamicTest.dynamicTest(
                            familie + " · " + c.path("name").asText(), () -> pruefe.accept(in, exp)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    // ------------------------------------------------------ die Vektor-Fälle

    @TestFactory
    List<DynamicTest> teilnahme() throws Exception {
        return faelle(
                "teilnahme",
                "anlage",
                (in, exp) -> {
                    FunktionZustandAbleitung.TeilnahmeErgebnis ist =
                            FunktionZustandAbleitung.teilnahme(teilnahmeEingang(in));
                    assertThat(ist.zustand().code()).isEqualTo(exp.path("zustand").asText());
                    assertThat(ist.seit()).isEqualTo(instant(exp.get("seit")));
                    List<Map<String, Object>> zeilen = new ArrayList<>();
                    for (FunktionZustandAbleitung.PruefZeile z : ist.pruefliste()) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("pruefung", z.pruefung().code());
                        m.put("bestanden", z.bestanden());
                        zeilen.add(m);
                    }
                    JsonNode istZeilen = MAPPER.valueToTree(zeilen);
                    assertThat(istZeilen).isEqualTo(exp.path("pruefliste"));
                    assertThat(ist.fehlt()).containsExactlyElementsOf(texte(exp.path("fehlt")));
                    assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                    JsonNode st = exp.get("steuert");
                    if (st == null || st.isNull()) {
                        assertThat(ist.steuert()).isNull();
                    } else {
                        assertThat(ist.steuert()).isNotNull();
                        assertThat(ist.steuert().steuert() ? "steuert" : "steuert_nicht")
                                .isEqualTo(st.path("zustand").asText());
                        assertThat(ist.steuert().grund() == null ? null : ist.steuert().grund().code())
                                .isEqualTo(text(st.get("grund")));
                        assertThat(ist.steuert().text()).isEqualTo(st.path("text").asText());
                    }
                });
    }

    @TestFactory
    List<DynamicTest> standort() throws Exception {
        return faelle(
                "standort",
                "standort",
                (in, exp) ->
                        standortPasst(
                                FunktionZustandAbleitung.standort(
                                        staende(in.path("teilnahmen")), zone(in)),
                                exp));
    }

    @TestFactory
    List<DynamicTest> messen() throws Exception {
        return faelle(
                "messen",
                "standort",
                (in, exp) -> {
                    List<FunktionZustandAbleitung.Messstelle> messstellen = new ArrayList<>();
                    for (JsonNode m : in.path("messstellen")) {
                        messstellen.add(
                                new FunktionZustandAbleitung.Messstelle(
                                        m.path("kennzeichen").asText(),
                                        m.path("manuell").asBoolean(),
                                        m.path("quelle_vorhanden").asBoolean(),
                                        instant(m.get("letzter_guter_wert")),
                                        m.path("je_ein_wert").asBoolean(),
                                        m.path("kadenz_s").asLong()));
                    }
                    // AP-13 IP-7 (E13): die Datenlage liest die Zeilen des Registers — jeder Fall trägt sie.
                    assertThat(in.has("register_zeilen")).as("register_zeilen").isTrue();
                    List<ZustandAbleitung.LiefertDaten> registerZeilen = new ArrayList<>();
                    for (JsonNode z : in.path("register_zeilen")) {
                        registerZeilen.add(ZustandAbleitung.LiefertDaten.vonCode(z.asText()));
                    }
                    List<FunktionZustandAbleitung.MessenAnlage> anlagen = new ArrayList<>();
                    for (JsonNode a : in.path("anlagen")) {
                        anlagen.add(
                                new FunktionZustandAbleitung.MessenAnlage(
                                        a.path("name").asText(), a.path("hauptzaehler_anzahl").asInt()));
                    }
                    FunktionZustandAbleitung.MessenErgebnis ist =
                            FunktionZustandAbleitung.messen(
                                    new FunktionZustandAbleitung.MessenEingang(
                                            in.path("standort").asText(),
                                            in.path("angelegt").asBoolean(),
                                            in.path("standort_eingerichtet").asBoolean(),
                                            instant(in.get("standort_archiviert_am")),
                                            instant(in.get("eingerichtet_am")),
                                            boxen(in.path("boxen")),
                                            messstellen,
                                            registerZeilen,
                                            anlagen,
                                            instant(in.get("jetzt")),
                                            zone(in)));
                    assertThat(ist.zustand().code()).isEqualTo(exp.path("zustand").asText());
                    assertThat(ist.seit()).isEqualTo(instant(exp.get("seit")));
                    assertThat(ist.fehlt()).containsExactlyElementsOf(texte(exp.path("fehlt")));
                    assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                    assertThat(ist.datenlage()).isEqualTo(text(exp.get("datenlage")));
                });
    }

    @TestFactory
    List<DynamicTest> uebergaenge() throws Exception {
        return faelle(
                "uebergaenge",
                null,
                (in, exp) -> {
                    Aktion aktion = Aktion.vonCode(in.path("aktion").asText());
                    UebergangErgebnis ist =
                            switch (in.path("funktion").asText()) {
                                case "messen" ->
                                        FunktionZustandAbleitung.uebergangMessen(
                                                aktion, Zustand.vonCode(in.path("zustand").asText()));
                                default ->
                                        in.has("teilnahmen")
                                                ? FunktionZustandAbleitung.uebergangStandort(
                                                        aktion,
                                                        staende(in.path("teilnahmen")),
                                                        zone(in))
                                                : FunktionZustandAbleitung.uebergangAnlage(
                                                        aktion, stand(in.path("teilnahme")));
                            };
                    uebergangPasst(ist, exp);
                });
    }

    @TestFactory
    List<DynamicTest> bestandAnlage() throws Exception {
        return faelle(
                "bestand",
                "anlage",
                (in, exp) -> {
                    FunktionZustandAbleitung.BestandErgebnis ist =
                            FunktionZustandAbleitung.bestand(
                                    bestandEingang(in.path("anlage")), zone(in));
                    assertThat(ist.zustand().code()).isEqualTo(exp.path("zustand").asText());
                    assertThat(ist.gestartetAm()).isEqualTo(instant(exp.get("gestartet_am")));
                    assertThat(ist.text()).isEqualTo(exp.path("text").asText());
                });
    }

    @TestFactory
    List<DynamicTest> bestandStandort() throws Exception {
        return faelle(
                "bestand",
                "standort",
                (in, exp) -> {
                    List<FunktionZustandAbleitung.BestandEingang> anlagen = new ArrayList<>();
                    for (JsonNode b : in.path("anlagen")) {
                        anlagen.add(bestandEingang(b));
                    }
                    standortPasst(FunktionZustandAbleitung.bestandStandort(anlagen, zone(in)), exp);
                });
    }

    // ---------------------------------------------------- die Datei als Ganzes

    /** Das geschlossene Vokabular ist wirklich geschlossen — und die Reihenfolge IST die Regel. */
    @Test
    void dasVokabularIstDasselbe() throws Exception {
        JsonNode root = vectors();
        List<String> zustaende = new ArrayList<>();
        for (Zustand z : Zustand.values()) {
            zustaende.add(z.code());
        }
        // Die Rangfolge: der „höchste Zustand“ ist der letzte.
        assertThat(texte(root.path("zustaende"))).containsExactlyElementsOf(zustaende);

        List<String> pruefungen = new ArrayList<>();
        for (FunktionZustandAbleitung.Pruefung p : FunktionZustandAbleitung.Pruefung.values()) {
            pruefungen.add(p.code());
        }
        assertThat(texte(root.path("pruefungen"))).containsExactlyElementsOf(pruefungen);

        List<String> aktionen = new ArrayList<>();
        for (Aktion a : Aktion.values()) {
            aktionen.add(a.code());
        }
        assertThat(texte(root.path("aktionen"))).containsExactlyElementsOf(aktionen);

        Map<String, String> gruende = new LinkedHashMap<>();
        for (FunktionZustandAbleitung.Grund g : FunktionZustandAbleitung.Grund.values()) {
            gruende.put(g.code(), g.text());
        }
        assertThat(MAPPER.convertValue(root.path("gruende"), Map.class)).isEqualTo(gruende);

        Map<String, String> funktionen = new LinkedHashMap<>();
        for (FunktionZustandAbleitung.Funktion f : FunktionZustandAbleitung.Funktion.values()) {
            funktionen.put(f.code(), f.kundenwort());
        }
        assertThat(MAPPER.convertValue(root.path("funktionen"), Map.class)).isEqualTo(funktionen);
        assertThat(root.path("zeitzone").asText())
                .isEqualTo(ZustandAbleitung.VORGABE_ZEITZONE.getId());
    }

    /** Messen kennt weder „eingerichtet“ noch „angehalten“ — kein Fall darf es behaupten. */
    @Test
    void messenBleibtInSeinemVokabular() throws Exception {
        JsonNode root = vectors();
        Set<String> erlaubt = new LinkedHashSet<>(texte(root.path("zustaende_messen")));
        assertThat(erlaubt).doesNotContain("eingerichtet", "angehalten");
        for (JsonNode c : root.path("cases")) {
            if ("messen".equals(c.path("familie").asText())) {
                assertThat(erlaubt).contains(c.path("expected").path("zustand").asText());
            }
        }
    }

    /** Jede Familie hat Fälle, und jeder genannte Abnahmefall ist mindestens einmal gepinnt. */
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
        assertThat(abnahmen).containsAll(texte(root.path("abnahmefaelle")));
    }

    /** Jeder Fall trägt einen Grund, warum er in der Datei steht — und einen eigenen Namen. */
    @Test
    void jederFallSagtWarumErDaIst() throws Exception {
        Set<String> namen = new LinkedHashSet<>();
        Consumer<JsonNode> pruefe =
                c -> {
                    assertThat(c.path("why").asText())
                            .as("why für %s", c.path("name").asText())
                            .isNotBlank();
                    assertThat(namen.add(c.path("name").asText()))
                            .as("doppelter Name %s", c.path("name").asText())
                            .isTrue();
                };
        vectors().path("cases").forEach(pruefe);
    }
}
