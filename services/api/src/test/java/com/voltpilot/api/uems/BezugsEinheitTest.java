package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.BezugsEinheit.Einheitswert;
import com.voltpilot.api.uems.BezugsEinheit.Umrechnung;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Das EINHEITEN-Modul (UEMS AP-09 IP-3) gegen die geteilte Vektor-Datei
 * {@code docs/contracts/v2/bezugsdaten-vectors.json} — Familie {@code einheit} — und gegen die
 * drei Zusagen, die kein Referenzfall stellt: die Umrechnungsgrenze, die exakte Rechnung und die
 * Synonyme einer Vorlage.
 *
 * <p>Der Aufruf geht hier DIREKT an {@link BezugsEinheit}, nicht über {@link BezugsdatenRegeln}:
 * das Modul ist die Fassung, die Import, Eingabe, Kennzahlen und Berichte ab IP-5 benutzen.
 * {@code BezugsdatenVectorsTest} fährt dieselben Fälle über den Anruf — beide grün heißt: eine
 * Fassung, zwei Wege dorthin.
 */
class BezugsEinheitTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");

    private static final Path REGELN =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "uems", "BezugsdatenRegeln.java");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static Map<String, List<String>> einheiten(JsonNode wurzel) {
        Map<String, List<String>> je = new LinkedHashMap<>();
        wurzel.path("einheiten").fields().forEachRemaining(e -> {
            List<String> worte = new ArrayList<>();
            e.getValue().forEach(w -> worte.add(w.asText()));
            je.put(e.getKey(), List.copyOf(worte));
        });
        return Map.copyOf(je);
    }

    private static List<Umrechnung> umrechnungen(JsonNode wurzel) {
        List<Umrechnung> alle = new ArrayList<>();
        wurzel.path("umrechnung")
                .forEach(u -> alle.add(new Umrechnung(
                        u.path("von").asText(),
                        u.path("nach").asText(),
                        u.has("zehnerpotenz") ? u.path("zehnerpotenz").asInt() : null,
                        u.has("teiler") ? u.path("teiler").asInt() : null,
                        u.has("nachkommastellen") ? u.path("nachkommastellen").asInt() : null)));
        return List.copyOf(alle);
    }

    /** Jede Prüfung der Familie {@code einheit} — gegen das Modul selbst. */
    @TestFactory
    List<DynamicTest> dieFamilieEinheitDerVektorDatei() throws Exception {
        JsonNode v = vektoren();
        Map<String, List<String>> einheiten = einheiten(v);
        List<Umrechnung> umrechnungen = umrechnungen(v);
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if (!"einheit".equals(p.path("regel").asText())) {
                    continue;
                }
                String name = fall.path("id").asText() + " · " + p.path("name").asText();
                tests.add(DynamicTest.dynamicTest(name, () -> {
                    JsonNode ein = p.path("eingang");
                    JsonNode soll = p.path("ergebnis");
                    Einheitswert ist = BezugsEinheit.einheit(
                            new BigDecimal(ein.path("betrag").asText()),
                            ein.path("geliefert").isNull() ? null : ein.path("geliefert").asText(),
                            ein.path("ziel").asText(),
                            einheiten,
                            umrechnungen);
                    if (soll.path("betrag").isNull()) {
                        assertThat(ist.betrag()).as(name + " · betrag").isNull();
                    } else {
                        assertThat(ist.betrag())
                                .as(name + " · betrag")
                                .isEqualByComparingTo(new BigDecimal(soll.path("betrag").asText()));
                    }
                    assertThat(ist.einheit()).as(name + " · einheit").isEqualTo(soll.path("einheit").asText());
                    List<String> befunde = new ArrayList<>();
                    soll.path("befunde").forEach(b -> befunde.add(b.asText()));
                    assertThat(ist.befunde()).as(name + " · befunde").isEqualTo(befunde);
                }));
            }
        }
        assertThat(tests).as("Prüfungen der Familie einheit").hasSizeGreaterThanOrEqualTo(7);
        return tests;
    }

    /** Die Kundensätze wohnen im Modul — und sind Wort für Wort die des Vertrags. */
    @Test
    void dieKundensaetzeSindDieDesVertrags() throws Exception {
        JsonNode saetze = vektoren().path("befund_saetze");
        BezugsEinheit.SAETZE.forEach((befund, satz) -> assertThat(satz)
                .as("Kundensatz " + befund)
                .isEqualTo(saetze.path(befund).asText()));
        assertThat(BezugsEinheit.SAETZE.keySet())
                .as("jeder Befund des Moduls hat seinen Satz")
                .containsExactlyInAnyOrder(BezugsEinheit.EINHEIT_UNBEKANNT, BezugsEinheit.EINHEIT_UMGERECHNET);
        assertThat(BezugsEinheit.satz(BezugsEinheit.EINHEIT_UMGERECHNET))
                .isEqualTo("Der gelieferte Wert wurde in die Einheit der Bezugsgröße umgerechnet.");
    }

    /**
     * E4/U1 — die Umrechnungsgrenze: KEIN Paar aus zwei verschiedenen Größen wird gerechnet, und
     * innerhalb einer Größe nur mit einem Faktor, der im Vertrag steht.
     */
    @Test
    void ueberGroessenGrenzenWirdNieGerechnet() throws Exception {
        JsonNode v = vektoren();
        Map<String, List<String>> einheiten = einheiten(v);
        List<Umrechnung> umrechnungen = umrechnungen(v);
        int geprueft = 0;
        for (Map.Entry<String, List<String>> a : einheiten.entrySet()) {
            for (Map.Entry<String, List<String>> b : einheiten.entrySet()) {
                if (a.getKey().equals(b.getKey())) {
                    continue;
                }
                for (String geliefert : a.getValue()) {
                    for (String ziel : b.getValue()) {
                        Einheitswert ist = BezugsEinheit.einheit(
                                new BigDecimal("1"), geliefert, ziel, einheiten, umrechnungen);
                        assertThat(ist.betrag())
                                .as(geliefert + " → " + ziel + " (" + a.getKey() + " → " + b.getKey() + ")")
                                .isNull();
                        assertThat(ist.befunde()).containsExactly(BezugsEinheit.EINHEIT_UNBEKANNT);
                        geprueft++;
                    }
                }
            }
        }
        assertThat(geprueft).as("geprüfte Größen-Paare").isGreaterThan(50);
        // Ein Wort, das in KEINER Größe steht, ebenfalls — nie ein geratener Faktor (§7 B13).
        assertThat(BezugsEinheit.einheit(new BigDecimal("688720"), "lbs", "kg", einheiten, umrechnungen)
                        .befunde())
                .containsExactly(BezugsEinheit.EINHEIT_UNBEKANNT);
        assertThat(BezugsEinheit.groesseVon("Paletten", einheiten)).isNull();
    }

    /** U1 — die Umrechnung ist EXAKT: sie rechnet in Dezimalstellen, nicht in Gleitkommazahlen. */
    @Test
    void dieUmrechnungIstExaktNichtGerundet() throws Exception {
        JsonNode v = vektoren();
        Map<String, List<String>> einheiten = einheiten(v);
        List<Umrechnung> umrechnungen = umrechnungen(v);

        // §7 B9: 312,4 t sind GENAU 312 400 kg — nicht 312 399,99999999994.
        assertThat(BezugsEinheit.einheit(new BigDecimal("312.4"), "t", "kg", einheiten, umrechnungen)
                        .betrag())
                .isEqualByComparingTo(new BigDecimal("312400"));
        // Und zurück, mit einem Betrag, den `double` nicht trägt.
        assertThat(BezugsEinheit.einheit(new BigDecimal("1234567.891"), "t", "kg", einheiten, umrechnungen)
                        .betrag())
                .isEqualByComparingTo(new BigDecimal("1234567891"));
        assertThat(BezugsEinheit.einheit(new BigDecimal("312400"), "kg", "t", einheiten, umrechnungen)
                        .betrag())
                .isEqualByComparingTo(new BigDecimal("312.4"));
        // l ↔ m³ ist derselbe Zehnerschritt in die andere Richtung.
        assertThat(BezugsEinheit.einheit(new BigDecimal("1500"), "l", "m³", einheiten, umrechnungen)
                        .betrag())
                .isEqualByComparingTo(new BigDecimal("1.5"));
        // min → h ist der EINZIGE Faktor, der kein Zehnerschritt ist; seine Genauigkeit steht im
        // Vertrag (4 Nachkommastellen) und wird eingehalten, nicht überschritten.
        assertThat(BezugsEinheit.einheit(new BigDecimal("298"), "min", "h", einheiten, umrechnungen)
                        .betrag())
                .isEqualByComparingTo(new BigDecimal("4.9667"));
        assertThat(BezugsEinheit.einheit(new BigDecimal("2.5"), "h", "min", einheiten, umrechnungen)
                        .betrag())
                .isEqualByComparingTo(new BigDecimal("150"));
    }

    /** U2 — ein Synonym der Vorlage ersetzt das WORT vor der Prüfung; es rechnet nie. */
    @Test
    void synonymeSindTextErsetzungKeineUmrechnung() throws Exception {
        JsonNode v = vektoren();
        Map<String, List<String>> einheiten = einheiten(v);
        List<Umrechnung> umrechnungen = umrechnungen(v);
        Map<String, String> synonyme = Map.of("Stk", "Stück", "Std", "h", "Kartons", "Paletten");

        Einheitswert stueck = BezugsEinheit.einheit(
                new BigDecimal("96"), "Stk.", "Stück", einheiten, umrechnungen, synonyme);
        assertThat(stueck.betrag()).as("das Synonym ändert den Betrag nicht").isEqualByComparingTo("96");
        assertThat(stueck.befunde()).as("dasselbe Wort heißt keine Umrechnung").isEmpty();

        Einheitswert stunden =
                BezugsEinheit.einheit(new BigDecimal("120"), "Std", "min", einheiten, umrechnungen, synonyme);
        assertThat(stunden.betrag()).isEqualByComparingTo("7200");
        assertThat(stunden.befunde()).containsExactly(BezugsEinheit.EINHEIT_UMGERECHNET);

        // Ein Synonym auf ein Wort AUSSERHALB des Vokabulars erweitert das Vokabular nicht.
        assertThat(BezugsEinheit.einheit(new BigDecimal("4"), "Kartons", "Stück", einheiten, umrechnungen, synonyme)
                        .befunde())
                .containsExactly(BezugsEinheit.EINHEIT_UNBEKANNT);
        // Ohne Vorlage bleibt „Stk." unbekannt — Synonyme sind eine ENTSCHEIDUNG der Vorlage.
        assertThat(BezugsEinheit.einheit(new BigDecimal("96"), "Stk.", "Stück", einheiten, umrechnungen)
                        .befunde())
                .containsExactly(BezugsEinheit.EINHEIT_UNBEKANNT);
        assertThat(BezugsEinheit.synonym("Stk", Map.of())).isEqualTo("Stk");
        assertThat(BezugsEinheit.synonym(null, synonyme)).isNull();
    }

    /** U5 — Stück, Personen und Schichten nehmen keine Nachkommastellen an. */
    @Test
    void ganzzahlEinheitenNennenSichSelbst() {
        assertThat(BezugsEinheit.istGanzzahlig("Stück")).isTrue();
        assertThat(BezugsEinheit.istGanzzahlig("Personen")).isTrue();
        assertThat(BezugsEinheit.istGanzzahlig("Schichten")).isTrue();
        assertThat(BezugsEinheit.istGanzzahlig("kg")).isFalse();
        assertThat(BezugsEinheit.istGanzzahlig("h")).isFalse();
        // Und die Zahl-Regel liest genau das: „48.200,5" Stück ist unlesbar, „48.200" nicht.
        assertThat(BezugsdatenRegeln.zahl("48.200,5", "de", BezugsEinheit.istGanzzahlig("Stück")).befund())
                .isEqualTo(BezugsdatenRegeln.ZAHL_UNLESBAR);
        assertThat(BezugsdatenRegeln.zahl("48.200", "de", BezugsEinheit.istGanzzahlig("Stück")).betrag())
                .isEqualByComparingTo("48200");
    }

    /**
     * IP-3 — es bleibt KEINE zweite Fassung: die Umrechnung wohnt nur noch hier, und
     * {@link BezugsdatenRegeln} ruft sie an, statt sie zu wiederholen.
     */
    @Test
    void dieEinheitenlogikStehtNurNochInDiesemModul() throws Exception {
        String regeln = Files.readString(REGELN);
        assertThat(regeln)
                .as("kein zweiter Faktor in BezugsdatenRegeln")
                .doesNotContain("scaleByPowerOfTen")
                .doesNotContain("List.of(EINHEIT_UNBEKANNT)")
                .doesNotContain("groesseVon(");
        assertThat(regeln).as("BezugsdatenRegeln ruft das Modul an").contains("BezugsEinheit.einheit(");

        // Und der Anruf liefert dasselbe wie das Modul — Wort für Wort dieselbe Fassung.
        JsonNode v = vektoren();
        Einheitswert ueberDenAnruf = BezugsdatenRegeln.einheit(
                new BigDecimal("312.4"), "t", "kg", einheiten(v), umrechnungen(v));
        Einheitswert direkt =
                BezugsEinheit.einheit(new BigDecimal("312.4"), "t", "kg", einheiten(v), umrechnungen(v));
        assertThat(ueberDenAnruf).isEqualTo(direkt);
    }
}
