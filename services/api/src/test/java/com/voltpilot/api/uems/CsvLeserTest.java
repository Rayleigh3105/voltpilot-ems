package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Der Vertrag des CSV-LESERS (UEMS AP-09 §4.6 C1, IP-11): {@link CsvLeser} liest jede Prüfung des
 * Blocks {@code csv} der Vektor-Datei genau so, wie sie dort steht; seine Grenzen, Vokabulare und
 * Sätze SIND die der Datei; und keine Datei — auch keine zufällige — lässt ihn werfen. Die Regel
 * {@code csv} an B1, B12 und B13 fährt {@code BezugsdatenVectorsTest}.
 *
 * <p>Rein; läuft immer (kein Spring, kein Docker, keine DB, keine Uhr).
 */
class CsvLeserTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Arbeitsverzeichnis ist services/api; das Repo-Wurzelverzeichnis liegt zwei Ebenen darüber.
    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final Path EXPORT =
            Path.of("src", "main", "java", "com", "voltpilot", "api", "measurement", "MeasurementHistoryService.java");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    private static JsonNode csv() throws Exception {
        return vektoren().path("csv");
    }

    // ---------------------------------------------------------------------- Die Datei ist die Wahrheit

    @Test
    void grenzenUndVokabulareStehenInDerDatei() throws Exception {
        JsonNode c = csv();
        assertThat(c.path("grenzen").path("bytes_hoechstens").asInt()).isEqualTo(CsvLeser.BYTES_HOECHSTENS);
        assertThat(c.path("grenzen").path("datenzeilen_hoechstens").asInt()).isEqualTo(CsvLeser.DATENZEILEN_HOECHSTENS);
        assertThat(CsvLeser.BYTES_HOECHSTENS).as("5 MB = 5 × 1 024 × 1 024 Bytes").isEqualTo(5_242_880);
        assertThat(c.path("erkennung_zeilen").asInt()).isEqualTo(CsvLeser.ERKENNUNG_ZEILEN);
        assertThat(CsvVektoren.texte(c.path("kodierungen"))).isEqualTo(CsvLeser.KODIERUNGEN);
        assertThat(CsvVektoren.texte(c.path("trennzeichen"))).isEqualTo(CsvLeser.TRENNZEICHEN);
        assertThat(CsvVektoren.texte(c.path("reihenfolge"))).isEqualTo(CsvLeser.REIHENFOLGE);
        assertThat(String.join("", CsvVektoren.texte(c.path("neutralisieren").path("zeichen"))))
                .isEqualTo(CsvLeser.NEUTRALISIEREN);
        assertThat(c.path("neutralisieren").path("praefix").asText()).isEqualTo(CsvLeser.NEUTRALISIEREN_PRAEFIX);
        assertThat(CsvVektoren.texte(c.path("befunde"))).containsExactlyInAnyOrderElementsOf(CsvLeser.SAETZE.keySet());
        assertThat(CsvLeser.KEINE_DATENZEILEN).isEqualTo(BezugsdatenRegeln.KEINE_DATENZEILEN);
    }

    /** Die Befunde des Lesers sind Wörter aus C8, und ihre Sätze sind die der Datei — kein zweiter Wortlaut. */
    @Test
    void befundeUndZusaetzeSprechenDenSatzDesVertrags() throws Exception {
        JsonNode v = vektoren();
        List<String> c8 = CsvVektoren.texte(v.path("vokabulare").path("befunde"));
        CsvLeser.SAETZE.forEach((befund, satz) -> {
            assertThat(c8).as("C8 kennt " + befund).contains(befund);
            assertThat(satz).as("Kundensatz " + befund).isEqualTo(v.path("befund_saetze").path(befund).asText());
            assertThat(CsvLeser.satz(befund)).isEqualTo(satz);
        });
        Map<String, String> zusaetze = new LinkedHashMap<>();
        v.path("csv").path("zusaetze").fields().forEachRemaining(e -> {
            zusaetze.put(e.getKey(), e.getValue().path("satz").asText());
            assertThat(CsvLeser.SAETZE).as("Befund des Zusatzes " + e.getKey())
                    .containsKey(e.getValue().path("befund").asText());
        });
        assertThat(CsvLeser.ZUSAETZE).isEqualTo(zusaetze);
        CsvLeser.ZUSAETZE.forEach((z, satz) -> assertThat(CsvLeser.zusatz(z)).isEqualTo(satz));
    }

    /** C1 „Spiegel des Exports“: der Export schreibt dieselben Zeichen mit demselben Präfix. */
    @Test
    void dieNeutralisierungSpiegeltDenExport() throws Exception {
        assertThat(csv().path("neutralisieren").path("spiegel").asText())
                .isEqualTo("services/api/" + EXPORT.toString().replace('\\', '/'));
        String export = Files.readString(EXPORT);
        assertThat(export)
                .as("MeasurementHistoryService.csv neutralisiert dieselben Zeichen")
                .contains("\"=+-@\\t\\r\".indexOf(value.charAt(0))")
                .contains("value = \"'\" + value");
    }

    /** Jeder Zusatz gehört zu genau dem Befund, bei dem er steht — und ohne Befund gibt es keinen. */
    @Test
    void jederZusatzStehtBeiSeinemBefund() throws Exception {
        JsonNode v = vektoren();
        List<JsonNode> ergebnisse = new ArrayList<>();
        v.path("csv").path("pruefungen").forEach(p -> ergebnisse.add(p.path("ergebnis")));
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if ("csv".equals(p.path("regel").asText())) {
                    ergebnisse.add(p.path("ergebnis").path("csv"));
                }
            }
        }
        assertThat(ergebnisse).hasSizeGreaterThanOrEqualTo(30);
        List<String> genutzt = new ArrayList<>();
        for (JsonNode e : ergebnisse) {
            if (e.path("befund").isNull()) {
                assertThat(e.path("zusatz").isNull()).as("gelesen ohne Zusatz").isTrue();
                continue;
            }
            String zusatz = e.path("zusatz").asText();
            genutzt.add(zusatz);
            assertThat(v.path("csv").path("zusaetze").path(zusatz).path("befund").asText())
                    .as("Befund des Zusatzes " + zusatz)
                    .isEqualTo(e.path("befund").asText());
        }
        assertThat(genutzt).as("jeder Zusatz hat einen Fall").containsAll(CsvLeser.ZUSAETZE.keySet());
    }

    /** Jede Erkennungs-Prüfung des Blocks {@code csv}: der Leser liest genau das, was dort steht. */
    @TestFactory
    List<DynamicTest> erkennungsFaelle() throws Exception {
        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode p : csv().path("pruefungen")) {
            String name = "csv :: " + p.path("name").asText();
            tests.add(DynamicTest.dynamicTest(name, () -> CsvVektoren.pruefe(name, p.path("eingang"), p.path("ergebnis"))));
        }
        assertThat(tests).hasSizeGreaterThanOrEqualTo(20);
        return tests;
    }

    // ---------------------------------------------------------------------- Anzeigen, nicht verändern

    @Test
    void neutralisiertWirdBeimAnzeigenDerGelesenenWertBleibt() {
        byte[] datei = "Periode;Bemerkung;Menge\n2026-10;=HYPERLINK(\"x\");-5\n2026-11;@Ines;'=1\n"
                .getBytes(StandardCharsets.UTF_8);
        CsvLeser.Ergebnis e = CsvLeser.lies(datei);

        assertThat(e.gelesen()).isTrue();
        CsvLeser.Zeile z = e.zeilen().get(0);
        assertThat(z.felder()).as("gelesen = was in der Datei steht").containsExactly("2026-10", "=HYPERLINK(\"x\")", "-5");
        assertThat(z.text()).isEqualTo("2026-10;=HYPERLINK(\"x\");-5");
        assertThat(z.anzeige()).containsExactly("2026-10", "'=HYPERLINK(\"x\")", "'-5");
        assertThat(z.felder()).as("die Anzeige ändert den gelesenen Wert nicht").containsExactly(
                "2026-10", "=HYPERLINK(\"x\")", "-5");
        assertThat(e.zeilen().get(1).anzeige()).as("schon neutralisiert bleibt, wie es ist")
                .containsExactly("2026-11", "'@Ines", "'=1");
        assertThat(CsvLeser.anzeige("")).isEmpty();
        assertThat(CsvLeser.anzeige(null)).isNull();
        assertThat(CsvLeser.anzeige("\tx")).isEqualTo("'\tx");
        assertThat(CsvLeser.anzeige("Spritzguss = 1")).isEqualTo("Spritzguss = 1");
    }

    // ---------------------------------------------------------------------- Keine Datei wirft

    @Test
    void nullIstEineLeereDatei() {
        CsvLeser.Ergebnis e = CsvLeser.lies(null, null);
        assertThat(e.befund()).isEqualTo(CsvLeser.KEINE_DATENZEILEN);
        assertThat(e.zusatz()).isEqualTo(CsvLeser.LEER_0_BYTE);
    }

    /** 5 MB nur aus Trennzeichen oder nur aus Anführungszeichen: eine ruhige Antwort, kein Absturz. */
    @Test
    void grosseEntarteteDateienEndenRuhig() {
        byte[] trenner = new byte[CsvLeser.BYTES_HOECHSTENS];
        Arrays.fill(trenner, (byte) ';');
        assertThat(CsvLeser.lies(trenner).zusatz()).isEqualTo(CsvLeser.NUR_LEERZEILEN);

        byte[] anfuehrung = new byte[CsvLeser.BYTES_HOECHSTENS];
        Arrays.fill(anfuehrung, (byte) '"');
        CsvLeser.Ergebnis e = CsvLeser.lies(anfuehrung);
        assertThat(e.befund()).isEqualTo(CsvLeser.KEINE_DATENZEILEN);
        assertThat(e.zusatz()).isEqualTo(CsvLeser.NUR_KOPFZEILE);

        byte[] offen = new byte[CsvLeser.BYTES_HOECHSTENS - 1];
        Arrays.fill(offen, (byte) '"');
        assertThat(CsvLeser.lies(offen).zusatz()).isEqualTo(CsvLeser.ANFUEHRUNGSZEICHEN_OFFEN);

        byte[] zeilen = new byte[CsvLeser.BYTES_HOECHSTENS];
        Arrays.fill(zeilen, (byte) '\n');
        assertThat(CsvLeser.lies(zeilen).zusatz()).isEqualTo(CsvLeser.NUR_LEERZEILEN);
    }

    /**
     * Zufällige Dateien — aus den Zeichen, an denen ein Leser bricht, und aus rohen Bytes: jede
     * endet in einem Ergebnis, und das Ergebnis ist in sich stimmig.
     */
    @Test
    void keineDateiLaesstDenLeserWerfen() {
        byte[] alphabet = ";,\t\r\n\"\"=+-@ 0129.aZü".getBytes(StandardCharsets.UTF_8);
        byte[] fremd = {(byte) 0xFC, (byte) 0x81, 0x00, (byte) 0xEF, (byte) 0xBB, (byte) 0xBF, (byte) 0xC3, (byte) 0xFF};
        Random zufall = new Random(20260913L);
        for (int i = 0; i < 4_000; i++) {
            byte[] datei = new byte[zufall.nextInt(400)];
            for (int k = 0; k < datei.length; k++) {
                int wahl = zufall.nextInt(100);
                datei[k] = i % 4 == 3 ? (byte) zufall.nextInt(256)
                        : wahl < 3 ? fremd[zufall.nextInt(fremd.length)] : alphabet[zufall.nextInt(alphabet.length)];
            }
            CsvLeser.Vorgabe vorgabe = switch (i % 5) {
                case 1 -> new CsvLeser.Vorgabe(CsvLeser.WINDOWS_1252, null, null);
                case 2 -> new CsvLeser.Vorgabe(null, "\t", true);
                case 3 -> new CsvLeser.Vorgabe(CsvLeser.UTF_8, ",", false);
                default -> CsvLeser.Vorgabe.ERKENNEN;
            };
            String hex = java.util.HexFormat.of().formatHex(datei);
            assertThatCode(() -> stimmig(CsvLeser.lies(datei, vorgabe))).as(hex).doesNotThrowAnyException();
        }
    }

    private static void stimmig(CsvLeser.Ergebnis e) {
        if (e.gelesen()) {
            assertThat(e.zusatz()).isNull();
            assertThat(e.zeilen()).isNotEmpty().hasSize(e.datenzeilen());
            assertThat(e.kodierung()).isIn(CsvLeser.KODIERUNGEN);
            assertThat(e.trennzeichen()).isIn(CsvLeser.TRENNZEICHEN);
            e.zeilen().forEach(z -> assertThat(z.felder()).isNotEmpty().anyMatch(f -> !f.isBlank()));
        } else {
            assertThat(CsvLeser.SAETZE).containsKey(e.befund());
            assertThat(CsvLeser.ZUSAETZE).containsKey(e.zusatz());
            assertThat(e.zeilen()).isEmpty();
        }
    }

    /** Ein Wort außerhalb des Vokabulars in der VORGABE ist ein Fehler des Aufrufers, nicht der Datei. */
    @Test
    void eineVorgabeAusserhalbDesVokabularsIstEinProgrammierfehler() {
        assertThatThrownBy(() -> new CsvLeser.Vorgabe("utf-16", null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new CsvLeser.Vorgabe(null, "|", null)).isInstanceOf(IllegalArgumentException.class);
    }
}
