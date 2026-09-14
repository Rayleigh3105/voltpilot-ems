package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Vertrag der VORSCHAU (UEMS AP-09 IP-12) über die Regel {@code vorschau} hinaus: die Sätze und
 * Wörter des Moduls SIND die der Vektor-Datei, zweimal gerechnet ist Zeichen für Zeichen dasselbe,
 * der Zeilen-Fingerabdruck kennt den Schlüssel und nicht den Text, und die Kennung lebt
 * {@link ImportVorschau#GUELTIG} lang. Die Fälle selbst fährt {@code BezugsdatenVectorsTest}.
 *
 * <p>Rein; läuft immer (kein Spring, kein Docker, keine DB, keine Uhr).
 */
class ImportVorschauTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS = Path.of("..", "..", "docs", "contracts", "v2", "bezugsdaten-vectors.json");
    private static final UUID KUNDE_A = UUID.fromString("a0000000-0000-4000-8000-00000000000a");
    private static final UUID KUNDE_B = UUID.fromString("b0000000-0000-4000-8000-00000000000b");

    private static JsonNode vektoren() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS));
    }

    /** Alle Prüfungen der Regel {@code vorschau} mit dem Fall davor. */
    private static List<JsonNode[]> vorschauen(JsonNode v) {
        List<JsonNode[]> aus = new ArrayList<>();
        for (JsonNode fall : v.path("cases")) {
            for (JsonNode p : fall.path("pruefungen")) {
                if ("vorschau".equals(p.path("regel").asText())) {
                    aus.add(new JsonNode[] {fall, p});
                }
            }
        }
        return aus;
    }

    private static JsonNode pruefung(JsonNode v, String fall, String nameBeginnt) {
        return vorschauen(v).stream()
                .filter(fp -> fp[0].path("id").asText().equals(fall) && fp[1].path("name").asText().startsWith(nameBeginnt))
                .findFirst().orElseThrow()[1];
    }

    // ---------------------------------------------------------------------- Die Datei ist die Wahrheit

    @Test
    void jederBefundHatGenauDenSatzDerDatei() throws Exception {
        JsonNode v = vektoren();
        for (JsonNode befund : v.path("vokabulare").path("befunde")) {
            assertThat(ImportVorschau.satz(befund.asText()))
                    .as("Satz für " + befund.asText())
                    .isEqualTo(v.path("befund_saetze").path(befund.asText()).asText());
        }
        assertThat(ImportVorschau.SAETZE.keySet()).allSatisfy(b -> assertThat(CsvVektoren.texte(v.path("vokabulare").path("befunde"))).contains(b));
    }

    @Test
    void woerterUndUmrechnungenSindDieDesVertrags() throws Exception {
        JsonNode v = vektoren();
        assertThat(ImportVorschau.DEUTUNGEN).isEqualTo(CsvVektoren.texte(v.path("vokabulare").path("deutung")));
        List<String> importStatus = CsvVektoren.texte(v.path("vokabulare").path("import_status"));
        assertThat(importStatus).contains(ImportVorschau.VORSCHAU).containsAll(ImportVorschau.SCHREIBENDE_IMPORTE);
        assertThat(ImportVorschau.ZAHLFORMATE).contains(v.path("regeln").path("zahlformat_vorgabe").asText());
        assertThat(BezugsEinheit.UMRECHNUNGEN).isEqualTo(VorschauVektoren.grundlagen(v).umrechnungen());
        assertThat(v.path("zwillinge").path("vorschau").toString()).isEqualTo("[\"java\"]");
    }

    @Test
    void jedeVorschauDesVertragsIstDeklariert() throws Exception {
        JsonNode v = vektoren();
        List<String> faelle = vorschauen(v).stream().map(fp -> fp[0].path("id").asText()).distinct().toList();
        assertThat(faelle).as("IP-12-Abnahme: B1, B2, B9–B13").containsExactly("B1", "B2", "B9", "B10", "B11", "B12", "B13");
    }

    // ---------------------------------------------------------------------- Zweimal = dasselbe

    @Test
    void zweimalGerechnetIstZeichenFuerZeichenDasselbe() throws Exception {
        JsonNode v = vektoren();
        for (JsonNode[] fp : vorschauen(v)) {
            JsonNode ein = fp[1].path("eingang").path("vorschau");
            ImportVorschau.Ergebnis erstes = VorschauVektoren.rechne(v, ein);
            ImportVorschau.Ergebnis zweites = VorschauVektoren.rechne(v, ein);
            assertThat(zweites).as(fp[0].path("id").asText() + " · " + fp[1].path("name").asText()).isEqualTo(erstes);
            assertThat(zweites.ergebnisFingerabdruck()).isEqualTo(erstes.ergebnisFingerabdruck()).hasSize(64);
        }
    }

    // ---------------------------------------------------------------------- C2: Schlüssel, nicht Text

    @Test
    void derZeilenFingerabdruckKenntDenSchluesselUndNichtDenText() throws Exception {
        JsonNode v = vektoren();
        ImportVorschau.Ergebnis erp = VorschauVektoren.rechne(v, pruefung(v, "B1", "ERP-Datei").path("eingang").path("vorschau"));
        ImportVorschau.Ergebnis umgestellt =
                VorschauVektoren.rechne(v, pruefung(v, "B1", "Dieselben Werte").path("eingang").path("vorschau"));
        ImportVorschau.Ergebnis tonnen = VorschauVektoren.rechne(v, pruefung(v, "B9", "312,4 t").path("eingang").path("vorschau"));

        assertThat(umgestellt.datei().sha256()).as("andere Bytes, anderer Datei-Fingerabdruck").isNotEqualTo(erp.datei().sha256());
        assertThat(tonnen.datei().sha256()).isNotEqualTo(erp.datei().sha256());
        String zeile = erp.zeilen().get(0).fingerabdruck();
        assertThat(umgestellt.zeilen().get(0).fingerabdruck()).as("andere Spaltenreihenfolge, dieselbe Zeile").isEqualTo(zeile);
        assertThat(tonnen.zeilen().get(0).fingerabdruck()).as("312,4 t = 312 400 kg, dieselbe Zeile").isEqualTo(zeile);
        assertThat(zeile).isEqualTo(ImportVorschau.zeilenFingerabdruck(
                UUID.fromString("b2000000-0000-4000-8000-000000000001"), "2026-10", new java.math.BigDecimal("312400.000")));
        assertThat(zeile).as("der Zeilentext steckt nicht darin")
                .isNotEqualTo(ImportVorschau.sha256("2026-10;Spritzguss gesamt;312.400,0;kg".getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void einAndererBestandIstEinAnderesErgebnis() throws Exception {
        JsonNode v = vektoren();
        ImportVorschau.Ergebnis leer = VorschauVektoren.rechne(v, pruefung(v, "B13", "„lbs“").path("eingang").path("vorschau"));
        ImportVorschau.Ergebnis nachB1 = VorschauVektoren.rechne(v, pruefung(v, "B13", "Variante").path("eingang").path("vorschau"));
        assertThat(nachB1.datei().sha256()).isEqualTo(leer.datei().sha256());
        assertThat(nachB1.ergebnisFingerabdruck()).isNotEqualTo(leer.ergebnisFingerabdruck());
    }

    // ---------------------------------------------------------------------- Die kurzlebige Kennung

    @Test
    void dieKennungLebtDreissigMinutenUndGehoertZuGenauEinemErgebnis() {
        Instant ausgestellt = Instant.parse("2026-11-03T08:12:00Z");
        String ergebnis = "ab".repeat(32);
        String kennung = ImportVorschau.kennung(KUNDE_A, ergebnis, ausgestellt);

        assertThat(kennung).matches("VS1\\.[0-9]+\\.[0-9a-f]{32}");
        assertThat(ImportVorschau.kennung(KUNDE_A, ergebnis, ausgestellt)).as("zweimal ausgestellt = dieselbe").isEqualTo(kennung);
        assertThat(ImportVorschau.GUELTIG).hasMinutes(30);
        assertThat(ImportVorschau.ausgestellt(kennung)).isEqualTo(ausgestellt);

        assertThat(ImportVorschau.kennungPruefen(kennung, KUNDE_A, ergebnis, ausgestellt)).isEqualTo("gueltig");
        assertThat(ImportVorschau.kennungPruefen(kennung, KUNDE_A, ergebnis, ausgestellt.plusSeconds(29 * 60 + 59)))
                .isEqualTo("gueltig");
        assertThat(ImportVorschau.kennungPruefen(kennung, KUNDE_A, ergebnis, ausgestellt.plus(ImportVorschau.GUELTIG)))
                .as("nach 30 Minuten wird neu gerechnet").isEqualTo("abgelaufen");
        assertThat(ImportVorschau.kennungPruefen(kennung, KUNDE_A, "cd".repeat(32), ausgestellt.plusSeconds(60)))
                .as("der Bestand hat sich seitdem geändert").isEqualTo("veraltet");
        assertThat(ImportVorschau.kennungPruefen(kennung, KUNDE_B, ergebnis, ausgestellt.plusSeconds(60)))
                .as("ein anderer Kundenbereich").isEqualTo("veraltet");
        assertThat(ImportVorschau.kennungPruefen(kennung, KUNDE_A, "cd".repeat(32), ausgestellt.plus(ImportVorschau.GUELTIG)))
                .as("abgelaufen spricht vor veraltet").isEqualTo("abgelaufen");
        String gefaelschteZeit = kennung.replace("." + ausgestellt.getEpochSecond() + ".",
                "." + ausgestellt.plusSeconds(3600).getEpochSecond() + ".");
        assertThat(ImportVorschau.kennungPruefen(gefaelschteZeit, KUNDE_A, ergebnis, ausgestellt.plusSeconds(3700)))
                .as("eine umgeschriebene Zeit passt nicht mehr zur Bindung").isEqualTo("veraltet");
        for (String kaputt : new String[] {null, "", "VS1", "VS2.1.00", "VS1.abc." + "0".repeat(32), "I-2026-0001"}) {
            assertThat(ImportVorschau.kennungPruefen(kaputt, KUNDE_A, ergebnis, ausgestellt)).isEqualTo("unlesbar");
        }
    }

    // ---------------------------------------------------------------------- Keine Datei lässt es werfen

    @Test
    void keineDateiUndKeineLeereZuordnungLaesstEsWerfen() throws Exception {
        JsonNode v = vektoren();
        JsonNode ein = pruefung(v, "B13", "„lbs“").path("eingang").path("vorschau");
        ImportVorschau.Zuordnung zu = VorschauVektoren.zuordnung(ein.path("zuordnung"));
        Map<String, ImportVorschau.Ziel> ziele = VorschauVektoren.ziele(ein.path("bezugsgroessen"));
        Random zufall = new Random(20260914L);
        for (int i = 0; i < 300; i++) {
            byte[] datei = new byte[zufall.nextInt(400)];
            zufall.nextBytes(datei);
            if (i % 3 == 0) {
                String text = "2026-" + zufall.nextInt(15) + ";" + (zufall.nextBoolean() ? "Montage" : "?") + ";"
                        + zufall.nextInt() + (zufall.nextBoolean() ? ",5" : "") + ";" + (zufall.nextBoolean() ? "t" : "") + "\n";
                datei = text.repeat(1 + zufall.nextInt(5)).getBytes(StandardCharsets.UTF_8);
            }
            ImportVorschau.Ergebnis e = ImportVorschau.vorschau(datei, zu, ziele, (z, s) -> null, s -> List.of(),
                    VorschauVektoren.grundlagen(v), Instant.parse("2026-11-03T08:12:00Z"));
            assertThat(e.datei().sha256()).hasSize(64);
            assertThat(e.zeilen()).allSatisfy(z -> assertThat(CsvVektoren.texte(v.path("vokabulare").path("zeilen_urteil")))
                    .contains(z.urteil()));
        }
    }

    @Test
    void eineUnvollstaendigeZuordnungNenntIhrFeld() {
        ImportVorschau.Spalten spalten = new ImportVorschau.Spalten(1, null, 3, 4, 2, null);
        ImportVorschau.Zuordnung gut = new ImportVorschau.Zuordnung(null, spalten, "periode", "de", null, null, Map.of(), Map.of());
        assertThat(ImportVorschau.zuordnungFehler(gut)).isNull();
        assertThat(ImportVorschau.zuordnungFehler(new ImportVorschau.Zuordnung(null,
                new ImportVorschau.Spalten(1, null, null, 4, 2, null), "periode", "de", null, null, Map.of(), Map.of())))
                .isEqualTo("spalten.wert");
        assertThat(ImportVorschau.zuordnungFehler(new ImportVorschau.Zuordnung(null, spalten, "quartal", "de", null, null,
                Map.of(), Map.of()))).isEqualTo("deutung");
        assertThat(ImportVorschau.zuordnungFehler(new ImportVorschau.Zuordnung(null, spalten, "von_bis", "de", null, null,
                Map.of(), Map.of()))).isEqualTo("spalten.bis");
        assertThat(ImportVorschau.zuordnungFehler(new ImportVorschau.Zuordnung(null, spalten, "periode", "fr", null, null,
                Map.of(), Map.of()))).isEqualTo("zahlformat");
        assertThat(ImportVorschau.zuordnungFehler(new ImportVorschau.Zuordnung(null, spalten, "periode", "de", null, "BZ-1",
                Map.of(), Map.of()))).as("Bezug-Spalte UND feste Bezugsgröße").isEqualTo("bezugsgroesse");
        assertThat(ImportVorschau.zuordnungFehler(new ImportVorschau.Zuordnung(null, spalten, "periode", "de", "kg", null,
                Map.of(), Map.of()))).as("Einheitsspalte UND feste Einheit").isEqualTo("einheit");
    }
}
