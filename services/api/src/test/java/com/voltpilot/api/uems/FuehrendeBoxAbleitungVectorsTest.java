package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Ergebnis;
import com.voltpilot.api.uems.FuehrendeBoxAbleitung.Grund;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag der führenden Box, wie ein Dienst sie braucht: {@link FuehrendeBoxAbleitung} zieht aus
 * JEDEM Fall von {@code docs/contracts/v2/lead-device-vectors.json} dieselbe Box und denselben Grund.
 * Dazu: die Vorrang-Reihenfolge ist die des Vertrags (jeder {@code fuehrende_box}-Fall von
 * {@code data-source-vectors.json} gilt unverändert), ohne gespeicherte Wahl ist es in jeder kleinen
 * Welt die Einzel-Gateway-Weiche bis IP-5, die Datei hält ihr Schema ({@link UemsSchemaLaeufer}), und
 * jede Tatsache eines Falls über ein Ahrenberg-Objekt steht so im Referenzunternehmen.
 *
 * <p>Rein; läuft immer (kein Docker, keine DB, keine Uhr).
 */
class FuehrendeBoxAbleitungVectorsTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final Path VECTORS = V2.resolve("lead-device-vectors.json");
    private static final Path SCHEMA = V2.resolve("lead-device.schema.json");
    private static final Path GRUNDLAGE = V2.resolve("data-source-vectors.json");
    private static final Path REFERENZ = V2.resolve("uems-referenzunternehmen.json");

    private static JsonNode lies(Path p) throws Exception {
        return MAPPER.readTree(Files.readString(p));
    }

    private static String text(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : n.asText();
    }

    private static List<String> texte(JsonNode arr) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static Instant instant(JsonNode n) {
        return n == null || n.isNull() || n.isMissingNode() ? null : OffsetDateTime.parse(n.asText()).toInstant();
    }

    /**
     * Die Einzel-Gateway-Weiche, wie sie bis IP-5 in {@code EntityRegistryService.gatewayDevice} und
     * ihrer Kopie in {@code FlowActivationService} stand: die Box des Speichers, sonst die EINZIGE
     * Box, sonst keine. Die Referenz der Verhaltensgleichheit — hier und nirgends sonst.
     */
    static <B> B weicheBisIp5(List<B> boxen, B speicherBox) {
        if (speicherBox != null) {
            return speicherBox;
        }
        return boxen.size() == 1 ? boxen.get(0) : null;
    }

    private static List<DynamicTest> faelle(Consumer<JsonNode> pruefe) throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(VECTORS).path("cases")) {
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> pruefe.accept(c)));
        }
        assertThat(tests).isNotEmpty();
        return tests;
    }

    // ------------------------------------------------------ die Vektor-Fälle

    @TestFactory
    List<DynamicTest> jederFall() throws Exception {
        return faelle(c -> {
            JsonNode in = c.path("input");
            Ergebnis<String> ist = FuehrendeBoxAbleitung.ableiten(texte(in.path("boxen")),
                    text(in.get("speicher_box")), text(in.get("gespeichert")));
            JsonNode exp = c.path("expected");
            assertThat(ist.box()).isEqualTo(text(exp.get("box")));
            assertThat(ist.grund().code()).isEqualTo(exp.path("grund").asText());
        });
    }

    /**
     * {@code weiche_bis_ip5} ist wirklich, was die alte Weiche gewählt hätte — und ohne gespeicherte
     * Wahl (der Stand jeder Bestandsanlage) ist die führende Box genau diese Box.
     */
    @TestFactory
    List<DynamicTest> ohneGespeicherteWahlWaehltDerDienstWieDieWeiche() throws Exception {
        return faelle(c -> {
            JsonNode in = c.path("input");
            JsonNode exp = c.path("expected");
            String weiche = weicheBisIp5(texte(in.path("boxen")), text(in.get("speicher_box")));
            assertThat(text(exp.get("weiche_bis_ip5"))).isEqualTo(weiche);
            if (text(in.get("gespeichert")) == null) {
                assertThat(text(exp.get("box"))).as("Box ohne gespeicherte Wahl").isEqualTo(weiche);
            }
        });
    }

    /**
     * Alle kleinen Welten ohne gespeicherte Wahl: keine bis drei Boxen, der Speicher an keiner, an
     * jeder oder an einer Box AUSSERHALB der Anlage (die Weiche prüfte die Anmeldung nicht, der Dienst
     * auch nicht) — die führende Box ist immer die der Weiche, und wo die Weiche keine hatte, sagt der
     * Grund, warum.
     */
    @Test
    void ohneGespeicherteWahlIstEsInJederKleinenWeltDieWeiche() {
        int welten = 0;
        for (List<String> boxen : kleineBoxenListen()) {
            List<String> speicher = new ArrayList<>(boxen);
            speicher.add(null);
            speicher.add("E-9");
            for (String s : speicher) {
                Ergebnis<String> ist = FuehrendeBoxAbleitung.ableiten(boxen, s, null);
                String weiche = weicheBisIp5(boxen, s);
                assertThat(ist.box()).as("Boxen %s, Speicher %s", boxen, s).isEqualTo(weiche);
                if (weiche == null) {
                    assertThat(ist.grund()).isEqualTo(boxen.isEmpty() ? Grund.KEINE_BOX : Grund.KEINE_WAHL);
                } else {
                    assertThat(ist.grund()).isEqualTo(s != null ? Grund.SPEICHER : Grund.EINZIGE);
                }
                welten++;
            }
        }
        assertThat(welten).isEqualTo(1 * 2 + 1 * 3 + 2 * 4 + 1 * 5);
    }

    /**
     * Eine gespeicherte Wahl außerhalb der Anlage führt nie, und der Dienst weicht nie aus — weder
     * auf die Box des Speichers noch auf die einzige Box. Eine Wahl innerhalb führt immer.
     */
    @Test
    void eineGespeicherteWahlGiltNurInnerhalbDerAnlage() {
        for (List<String> boxen : kleineBoxenListen()) {
            List<String> speicher = new ArrayList<>(boxen);
            speicher.add(null);
            for (String s : speicher) {
                Ergebnis<String> draussen = FuehrendeBoxAbleitung.ableiten(boxen, s, "E-9");
                assertThat(draussen.box()).as("Boxen %s, Speicher %s", boxen, s).isNull();
                assertThat(draussen.grund()).isEqualTo(Grund.GESPEICHERT_NICHT_IN_ANLAGE);
                for (String g : boxen) {
                    Ergebnis<String> drinnen = FuehrendeBoxAbleitung.ableiten(boxen, s, g);
                    assertThat(drinnen.box()).isEqualTo(g);
                    assertThat(drinnen.grund()).isEqualTo(Grund.GESPEICHERT);
                }
            }
        }
    }

    /** Die Boxen einer kleinen Anlage: keine, eine, zwei (beide Reihenfolgen), drei. */
    private static List<List<String>> kleineBoxenListen() {
        return List.of(List.of(), List.of("E-1"), List.of("E-1", "E-2"), List.of("E-2", "E-1"),
                List.of("E-1", "E-2", "E-3"));
    }

    /** Box und Grund passen immer zusammen: eine Box heißt bestimmt, keine heißt ein benannter Grund. */
    @Test
    void eineBoxOhnePassendenGrundGibtEsNicht() {
        assertThatThrownBy(() -> new Ergebnis<>(null, Grund.SPEICHER)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Ergebnis<>("E-1", Grund.KEINE_WAHL)).isInstanceOf(IllegalArgumentException.class);
    }

    // ------------------------------------------ der Vertrag, unverändert

    /**
     * Jeder {@code fuehrende_box}-Fall des Vertrags ergibt hier dieselbe Box und denselben Grund: die
     * Vorrang-Reihenfolge ist die EINE aus {@link DatenquelleRegeln#fuehrung}, nicht eine zweite.
     */
    @TestFactory
    List<DynamicTest> dieFaelleDesVertragsGeltenUnveraendert() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode c : lies(GRUNDLAGE).path("cases")) {
            if (!"fuehrende_box".equals(c.path("familie").asText())) {
                continue;
            }
            tests.add(DynamicTest.dynamicTest(c.path("name").asText(), () -> {
                JsonNode in = c.path("input");
                List<String> boxen = new ArrayList<>();
                in.path("boxen").forEach(b -> boxen.add(b.path("kennzeichen").asText()));
                Ergebnis<String> ist = FuehrendeBoxAbleitung.ableiten(boxen, text(in.get("speicher_box")),
                        text(in.get("gespeichert")));
                assertThat(ist.box()).isEqualTo(text(c.path("expected").get("box")));
                assertThat(ist.grund().code()).isEqualTo(c.path("expected").path("grund").asText());
            }));
        }
        assertThat(tests).hasSize(5);
        return tests;
    }

    /**
     * Das Vokabular ist das des Vertrags plus zwei Gründe: die ersten vier Wörter sind
     * {@code gruende_fuehrende_box} aus {@code data-source-vectors.json}, in derselben Reihenfolge.
     */
    @Test
    void dasVokabularIstDasDesVertragsPlusZweiGruende() throws Exception {
        JsonNode root = lies(VECTORS);
        List<String> codes = Arrays.stream(Grund.values()).map(Grund::code).toList();
        assertThat(codes).containsExactlyElementsOf(texte(root.path("gruende")));
        assertThat(Arrays.stream(Grund.values()).filter(Grund::bestimmt).map(Grund::code).toList())
                .containsExactlyElementsOf(texte(root.path("bestimmt")));
        assertThat(codes.subList(0, 4)).containsExactlyElementsOf(texte(lies(GRUNDLAGE).path("gruende_fuehrende_box")));
        for (DatenquelleRegeln.FuehrungsGrund g : DatenquelleRegeln.FuehrungsGrund.values()) {
            assertThat(Grund.aus(g).code()).isEqualTo(g.code());
        }
    }

    @Test
    void dieDateiHaeltIhrSchema() throws Exception {
        assertThat(UemsSchemaLaeufer.verstoesse(lies(VECTORS), lies(SCHEMA))).isEmpty();
    }

    /** Jeder Fall sagt, warum er da ist; jeder Grund und jeder genannte Abnahmefall ist gepinnt. */
    @Test
    void jederGrundUndJederAbnahmefallIstGepinnt() throws Exception {
        JsonNode root = lies(VECTORS);
        Set<String> namen = new LinkedHashSet<>();
        Set<String> gruende = new LinkedHashSet<>();
        Set<String> abnahmen = new LinkedHashSet<>();
        for (JsonNode c : root.path("cases")) {
            assertThat(c.path("why").asText()).as("why für %s", c.path("name").asText()).isNotBlank();
            assertThat(namen.add(c.path("name").asText())).as("doppelter Name %s", c.path("name").asText()).isTrue();
            gruende.add(c.path("expected").path("grund").asText());
            if (c.hasNonNull("abnahme")) {
                abnahmen.add(c.path("abnahme").asText());
            }
        }
        assertThat(gruende).containsExactlyInAnyOrderElementsOf(texte(root.path("gruende")));
        assertThat(abnahmen).containsExactlyInAnyOrderElementsOf(texte(root.path("abnahmefaelle")));
    }

    // ------------------------------------------------ Referenzunternehmen

    /**
     * Jede Tatsache eines Falls über ein Ahrenberg-Objekt steht so im Referenzunternehmen: der
     * Stichtag steht auf seiner Zeitachse, die bekannten Boxen des Falls sind GENAU die zum Stichtag
     * in der Anlage angemeldeten, nicht ausgebauten Boxen in Anmelde-Reihenfolge, die Box des
     * Speichers gibt es genau dann, wenn die Anlage einen Speicher hat, und eine Box, die führt (oder
     * den Speicher liest), führt die Anlage auch in der Referenz. Wer etwas erfindet, nennt es in
     * {@code annahme}.
     */
    @TestFactory
    List<DynamicTest> jederFallStehtImReferenzunternehmen() throws Exception {
        JsonNode ref = lies(REFERENZ);
        Map<String, JsonNode> boxen = nachKennzeichen(ref.path("boxen"));
        Map<String, JsonNode> anlagen = nachKennzeichen(ref.path("anlagen"));
        Set<Instant> zeitachse = new HashSet<>();
        ref.path("zeitachse").forEach(e -> zeitachse.add(instant(e.get("zeitpunkt"))));
        return faelle(c -> {
            JsonNode in = c.path("input");
            List<String> fehler = new ArrayList<>();
            boolean erfunden = false;
            String anlage = in.path("anlage").asText();
            Instant stichtag = instant(in.get("stichtag"));
            if (!zeitachse.contains(stichtag)) {
                fehler.add("Stichtag " + in.path("stichtag").asText() + " steht nicht auf der Zeitachse");
            }
            List<String> faelleBoxen = texte(in.path("boxen"));
            String speicher = text(in.get("speicher_box"));
            String gespeichert = text(in.get("gespeichert"));
            for (String b : faelleBoxen) {
                erfunden |= !boxen.containsKey(b);
            }
            for (String b : new String[] {speicher, gespeichert}) {
                erfunden |= b != null && !boxen.containsKey(b);
            }
            JsonNode ra = anlagen.get(anlage);
            if (ra == null) {
                erfunden = true;
            } else {
                List<String> soll = boxen.values().stream()
                        .filter(b -> anlage.equals(b.path("heimat_anlage").asText()) && inBetrieb(b, stichtag))
                        .sorted(Comparator.comparing(b -> instant(b.get("in_betrieb_ab"))))
                        .map(b -> b.path("kennzeichen").asText())
                        .toList();
                List<String> bekannt = faelleBoxen.stream().filter(boxen::containsKey).toList();
                if (!bekannt.equals(soll)) {
                    fehler.add("Boxen von " + anlage + " zum Stichtag: Referenz " + soll + ", Fall " + bekannt);
                }
                if (ra.path("speicher_kwh").isNull() == (speicher != null)) {
                    fehler.add(anlage + " hat laut Referenz " + (speicher == null ? "einen" : "keinen") + " Speicher");
                }
            }
            for (String b : new String[] {speicher, text(c.path("expected").get("box"))}) {
                JsonNode rb = b == null ? null : boxen.get(b);
                if (rb != null && !anlage.equals(rb.path("fuehrend_fuer").asText())) {
                    fehler.add(b + " führt laut Referenz " + rb.path("fuehrend_fuer").asText() + ", nicht " + anlage);
                }
            }
            if (erfunden && !c.hasNonNull("annahme")) {
                fehler.add("der Fall erfindet etwas, nennt aber keine `annahme`");
            }
            assertThat(fehler).as(c.path("name").asText()).isEmpty();
        });
    }

    private static boolean inBetrieb(JsonNode box, Instant t) {
        Instant ab = instant(box.get("in_betrieb_ab"));
        Instant ausgebaut = instant(box.get("ausgebaut_am"));
        return !t.isBefore(ab) && (ausgebaut == null || t.isBefore(ausgebaut));
    }

    private static Map<String, JsonNode> nachKennzeichen(JsonNode arr) {
        Map<String, JsonNode> m = new LinkedHashMap<>();
        arr.forEach(n -> m.put(n.path("kennzeichen").asText(), n));
        return m;
    }
}
