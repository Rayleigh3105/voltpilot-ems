package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Der Berichts-CSV aus dem Abzug (UEMS AP-12 IP-10, E11 DA3) gegen den Vektor B14 — rein, ohne Datenbank. Route, Rechte und
 * Abruf-Protokoll prüft {@code BerichtApiTest}.
 */
class BerichtCsvTest {

    private static final ObjectMapper EXAKT = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    /** Die Spalten {@code ort} und {@code endgueltig_ab}. */
    private static final int ORT = 2;
    private static final int ENDGUELTIG_AB = 10;

    private static JsonNode nummerEins;
    private static BerichtCsv.Stand standEins;
    private static final List<JsonNode> B14 = new ArrayList<>();

    @BeforeAll
    static void lies() throws Exception {
        JsonNode vektoren = EXAKT.readTree(Files.readString(V2.resolve("bericht-vectors.json")));
        String text = BerichtRegeln.kanonisch(vektoren.path("abzuege").path("BR-2026-0001/1"));
        nummerEins = EXAKT.readTree(text);
        standEins = new BerichtCsv.Stand(1, t("2026-11-10T09:02:00+01:00"), "Ines Kaltenbach",
                BerichtRegeln.pruefsumme(text), null, null);
        vektoren.path("cases").forEach(c -> {
            if ("B14".equals(c.path("id").asText())) {
                c.path("pruefungen").forEach(B14::add);
            }
        });
        assertThat(B14).extracting(p -> p.path("regel").asText())
                .startsWith("csv_kopf", "csv_zeile", "csv_zeile", "csv_zeile", "csv_kopf");
    }

    /** B14: Jonas, 20.11.2026 17:45 — der Kopf ist Zeile für Zeile der Vektor, dann die 13 Spalten und MS-12 byte-gleich. */
    @Test
    void b14KopfSpaltenUndMs12SindDerVektor() {
        List<String> zeilen = jonas(nummerEins, standEins);
        assertThat(zeilen.subList(0, 16)).containsExactlyElementsOf(texte(B14.get(0).path("ergebnis").path("zeilen")));
        assertThat(zeilen.get(12)).startsWith("# pruefsumme=sha256:b113527d");
        assertThat(zeilen.get(16)).isEqualTo(String.join(";", BerichtRegeln.CSV_SPALTEN));
        assertThat(zeilen.get(16).split(";")).hasSize(13);
        assertThat(zeilen.get(17)).isEqualTo("# abschnitt=verbrauch_je_messstelle");
        assertThat(zeilen.subList(18, 34)).as("eine Zeile je Wert, in der Folge des Abzugs")
                .extracting(z -> z.substring(0, z.indexOf(';')))
                .containsExactlyElementsOf(quellen(nummerEins.path("werte")));
        assertThat(zeilen.stream().filter(z -> z.startsWith("MS-12;")).toList())
                .containsExactly(B14.get(1).path("ergebnis").path("zeile").asText());
        assertThat(zeilen.get(34)).isEqualTo("# abschnitt=kennzahlen");
        assertThat(zeilen.subList(35, 37)).extracting(z -> z.substring(0, z.indexOf(';')))
                .containsExactly("KZ-0001", "KZ-0005");
        assertThat(zeilen).hasSize(37).allSatisfy(z -> assertThat(z.startsWith("#") || z.split(";", -1).length == 13)
                .as(z).isTrue());
    }

    /**
     * B14/KZ-0001 vollständig (Vertrag 1.2): die Zeile ist Zelle für Zelle der Vektor — alle DREIZEHN, auch
     * {@code ort_zum_datenstand} ({@code G-2}) und {@code endgueltig_ab} ({@code 2026-11-08}). Die beiden waren bis
     * zum Folgepaket {@code vp-uems-b12-tagesverlauf-speicher} leer; das Mapping las sie schon immer, es fehlte nur
     * der Abzug.
     */
    @Test
    void kz0001_istZelleFuerZelleDerVektor_auchOrtUndEndgueltigAb() {
        JsonNode kz = nummerEins.path("kennzahlen").get(0);
        assertThat(kz.path("quelle").asText()).isEqualTo("KZ-0001");
        assertThat(kz.path("ort_zum_datenstand").asText()).isEqualTo("G-2");
        assertThat(kz.path("endgueltig_ab").asText()).isEqualTo("2026-11-08T00:00:00+01:00");

        String[] vektor = B14.get(2).path("ergebnis").path("zeile").asText().split(";", -1);
        String[] ist = jonas(nummerEins, standEins).get(35).split(";", -1);
        assertThat(ist).hasSize(13);
        assertThat(ist[ORT]).as("die Zelle, die bis 1.2 leer blieb").isEqualTo("G-2");
        assertThat(ist[ENDGUELTIG_AB]).as("die zweite Zelle, die bis 1.2 leer blieb").isNotEmpty();
        for (int i = 0; i < 13; i++) {
            assertThat(ist[i]).as(BerichtRegeln.CSV_SPALTEN.get(i)).isEqualTo(vektor[i]);
        }
    }

    /** Das Mapping liest beide Felder schon: trägt ein Abzug sie, ist die Zeile KZ-0001 Byte für Byte der Vektor. */
    @Test
    void kz0001_traegtDerAbzugOrtUndEndgueltigAb_istDieZeileDerVektor() {
        ObjectNode abzug = nummerEins.deepCopy();
        ObjectNode kz = (ObjectNode) abzug.path("kennzahlen").get(0);
        kz.put("ort_zum_datenstand", "G-2");
        kz.put("endgueltig_ab", "2026-11-08T00:00:00+01:00");
        assertThat(jonas(abzug, standEins).get(35)).isEqualTo(B14.get(2).path("ergebnis").path("zeile").asText());
    }

    /** Die Datei: BOM, CRLF nach jeder Zeile, kein nacktes LF; zwei Erzeugungen desselben Abrufs sind byte-gleich. */
    @Test
    void dieDateiHatBomUndCrlfUndIstDeterministisch() {
        byte[] eins = datei(standEins, "2026-11-20T17:45:00+01:00", "Jonas Wendlinger", null);
        byte[] zwei = datei(standEins, "2026-11-20T17:45:00+01:00", "Jonas Wendlinger", null);
        assertThat(eins).isEqualTo(zwei);
        assertThat(new byte[] {eins[0], eins[1], eins[2]}).containsExactly(0xEF, 0xBB, 0xBF);
        String text = new String(eins, StandardCharsets.UTF_8);
        assertThat(text).endsWith("\r\n");
        assertThat(text.replace("\r\n", "")).doesNotContain("\n").doesNotContain("\r");

        // Ein späterer Abruf einer anderen Person: nur erzeugt_am und erzeugt_von unterscheiden sich
        List<String> a = List.of(text.substring(1).split("\r\n"));
        List<String> b = List.of(new String(datei(standEins, "2026-11-21T08:00:00+01:00", "Ines Kaltenbach", null),
                StandardCharsets.UTF_8).substring(1).split("\r\n"));
        List<Integer> anders = new ArrayList<>();
        for (int i = 0; i < a.size(); i++) {
            if (!a.get(i).equals(b.get(i))) {
                anders.add(i);
            }
        }
        assertThat(anders).extracting(a::get).allSatisfy(z -> assertThat(z).matches("# erzeugt_(am|von)=.*"));
        assertThat(anders).hasSize(2);
    }

    /** AP-16 IP-22: acht Abschnitte mit eigener Kopfzeile; Einstufung und Fassung sind getrennte CSV-Zellen. */
    @Test
    void bewertungHatGrenzSatzAbschnittskoepfeUndEinstufungsfassung() {
        ObjectNode abzug = BerichtBewertungTestdaten.aus(nummerEins);
        String kanonisch = BerichtRegeln.kanonisch(abzug);
        BerichtCsv.Stand stand = new BerichtCsv.Stand(2, t("2026-11-17T15:42:00+01:00"), "Ines Kaltenbach",
                BerichtRegeln.pruefsumme(kanonisch), null, null);
        List<String> zeilen = BerichtCsv.zeilen(abzug, stand, t("2026-11-20T17:45:00+01:00"),
                "Jonas Wendlinger", null);

        assertThat(zeilen.get(16)).isEqualTo("# grenz_satz=" + BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        assertThat(zeilen.stream().filter(z -> z.startsWith("# abschnitt=")).toList())
                .containsExactlyElementsOf(BerichtCsv.ABSCHNITTE_BEWERTUNG.stream()
                        .map(a -> "# abschnitt=" + a).toList());
        int einstufungen = zeilen.indexOf("# abschnitt=einstufungen");
        assertThat(zeilen.get(einstufungen + 1))
                .isEqualTo("energieeinsatz;name;einstufung;fassung;gueltig_ab;person;begruendung");
        assertThat(zeilen.get(einstufungen + 2).split(";", -1))
                .containsExactly("EE-1", "Spritzguss", "wesentlich", "4", "2026-11-06", "Ines Kaltenbach",
                        "Größter Einsatz an beiden Hallen.");

        byte[] eins = BerichtCsv.datei(abzug, stand, t("2026-11-20T17:45:00+01:00"), "Jonas Wendlinger", null);
        byte[] zwei = BerichtCsv.datei(abzug.deepCopy(), stand, t("2026-11-20T17:45:00+01:00"),
                "Jonas Wendlinger", null);
        assertThat(zwei).isEqualTo(eins);
    }

    /** B14 Randfall: Claudias Teilansicht (G3) steht im Kopf, Zeiten in UTC übergeben erscheinen in der Zone. */
    @Test
    void dieTeilansichtStehtImKopf() {
        List<String> zeilen = BerichtCsv.zeilen(nummerEins, standEins, t("2026-11-12T07:10:00Z"), "Claudia Berger",
                List.of("Werk Ahrenberg", "Werk Lindach"));
        assertThat(zeilen.subList(0, 16)).containsExactlyElementsOf(texte(B14.get(4).path("ergebnis").path("zeilen")));
    }

    /** R2: ein ersetzter Stand trägt direkt hinter dem Kopf das Wasserzeichen „ersetzt durch Nr. 2 (16.11.2026)“. */
    @Test
    void einErsetzterStandTraegtDasWasserzeichen() {
        Instant am = t("2026-11-16T14:20:00+01:00");
        BerichtCsv.Stand ersetzt = new BerichtCsv.Stand(1, standEins.freigegebenAm(), standEins.freigegebenVon(),
                standEins.pruefsumme(), 2, am);
        List<String> zeilen = jonas(nummerEins, ersetzt);
        assertThat(zeilen.subList(0, 16)).containsExactlyElementsOf(jonas(nummerEins, standEins).subList(0, 16));
        assertThat(zeilen.get(16)).isEqualTo("# wasserzeichen=" + BerichtRegeln.ersetztDurch(2, am, ZoneId.of("Europe/Berlin")))
                .contains("2").contains("(16.11.2026)");
        assertThat(zeilen.get(17)).isEqualTo(String.join(";", BerichtRegeln.CSV_SPALTEN));
        assertThat(zeilen).hasSize(38);
    }

    /** Am Unternehmen: Standorte (die Werte), Kostenstellen (ihr Block „summe“, sonst der Grund), Kennzahlen. */
    @Test
    void amUnternehmenTragenStandorteKostenstellenUndKennzahlenZeilen() {
        ObjectNode u = EXAKT.createObjectNode();
        ObjectNode kopf = ((ObjectNode) nummerEins.path("kopf")).deepCopy();
        u.set("kopf", kopf);
        kopf.put("bericht", "BR-2026-0002");
        kopf.put("vorlage", "monatsbericht_unternehmen");
        ((ObjectNode) kopf.path("geltung")).put("art", BerichtRegeln.UNTERNEHMEN).put("kennzeichen", "U")
                .put("name_zum_datenstand", "Kunststoffwerk Ahrenberg GmbH");
        u.putArray("werte").add(nummerEins.path("werte").get(0).deepCopy());
        u.putArray("standorte").addObject().put("kennzeichen", "ST-1").put("name_zum_datenstand", "Werk Ahrenberg")
                .putArray("messstellen").add("MS-01");
        ObjectNode k4200 = u.putArray("kostenstellen").addObject().put("quelle", "4200")
                .put("name_zum_datenstand", "Montage").put("periode", "2026-10")
                .put("berechnet_am", "2026-11-10T08:55:00+01:00");
        k4200.putObject("summe").put("menge", new java.math.BigDecimal("14410")).put("einheit", "kWh")
                .put("zustand", "vollständig").putNull("grund");
        ObjectNode k9000 = ((com.fasterxml.jackson.databind.node.ArrayNode) u.path("kostenstellen")).addObject()
                .put("quelle", "9000").put("name_zum_datenstand", "Allgemein").put("periode", "2026-10")
                .put("berechnet_am", "2026-11-10T08:55:00+01:00");
        k9000.putObject("summe").putNull("menge").putNull("einheit").putNull("zustand")
                .put("grund", "mehrere Größen");
        u.putArray("kennzahlen");

        List<String> zeilen = jonas(u, standEins);
        assertThat(zeilen.get(2)).isEqualTo("# geltung=" + BerichtRegeln.csvKopf(new BerichtRegeln.CsvKopf("BR-2026-0002",
                "monatsbericht_unternehmen", 1, BerichtRegeln.UNTERNEHMEN, "U", "Kunststoffwerk Ahrenberg GmbH", "monat",
                "2026-10", ZoneId.of("Europe/Berlin"), 1, Instant.EPOCH, Instant.EPOCH, "", "", Instant.EPOCH, "", null))
                .get(2).substring("# geltung=".length()));
        assertThat(zeilen.subList(17, zeilen.size())).containsExactly(
                "# abschnitt=standorte",
                jonas(nummerEins, standEins).get(18),
                "# abschnitt=kostenstellen",
                "4200;Montage;;2026-10;14410;kWh;vollständig;;;;;;2026-11-10T08:55:00+01:00",
                "9000;Allgemein;;2026-10;;;;;mehrere Größen;;;;2026-11-10T08:55:00+01:00",
                "# abschnitt=kennzahlen");
    }

    /** Die Folge der Abschnitte mit Zeilen ist die aller vier Vorlagen — ändert eine Vorlage sie, wird dieser Test rot. */
    @Test
    void dieAbschnitteMitZeilenFolgenDenVorlagen() throws Exception {
        JsonNode vorlagen = EXAKT.readTree(Files.readString(V2.resolve("bericht-vorlagen.json")));
        List<String> mitZeilen = List.of(BerichtCsv.MESSSTELLEN, BerichtCsv.STANDORTE, BerichtCsv.KOSTENSTELLEN,
                BerichtCsv.KENNZAHLEN);
        assertThat(vorlagen.path("vorlagen")).hasSize(5);
        for (JsonNode v : vorlagen.path("vorlagen")) {
            List<String> folge = new ArrayList<>();
            v.path("abschnitte").forEach(a -> {
                if (mitZeilen.contains(a.path("schluessel").asText())) {
                    folge.add(a.path("schluessel").asText());
                }
            });
            if (BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(v.path("schluessel").asText())) {
                List<String> alle = new ArrayList<>();
                v.path("abschnitte").forEach(a -> alle.add(a.path("schluessel").asText()));
                assertThat(alle).containsExactlyElementsOf(BerichtCsv.ABSCHNITTE_BEWERTUNG);
                continue;
            }
            assertThat(folge).as(v.path("schluessel").asText()).containsExactlyElementsOf(
                    BerichtRegeln.UNTERNEHMEN.equals(v.path("geltung_art").asText()) ? BerichtCsv.ABSCHNITTE_UNTERNEHMEN
                            : BerichtCsv.ABSCHNITTE_STANDORT);
        }
    }

    // ================================================================= Hilfen

    private static List<String> jonas(JsonNode abzug, BerichtCsv.Stand stand) {
        return BerichtCsv.zeilen(abzug, stand, t("2026-11-20T17:45:00+01:00"), "Jonas Wendlinger", null);
    }

    private static byte[] datei(BerichtCsv.Stand stand, String erzeugtAm, String von, List<String> teilansicht) {
        return BerichtCsv.datei(nummerEins, stand, t(erzeugtAm), von, teilansicht);
    }

    private static List<String> texte(JsonNode liste) {
        List<String> raus = new ArrayList<>();
        liste.forEach(n -> raus.add(n.asText()));
        return raus;
    }

    private static List<String> quellen(JsonNode liste) {
        List<String> raus = new ArrayList<>();
        liste.forEach(n -> raus.add(n.path("quelle").asText()));
        return raus;
    }

    private static Instant t(String zeit) {
        return OffsetDateTime.parse(zeit).toInstant();
    }
}
