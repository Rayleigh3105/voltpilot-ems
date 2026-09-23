package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Der Abzug des Leistungsvergleichs (UEMS AP-17 IP-21b, S1–S3) — rein, ohne Datenbank: R8, Dezember 2027 für KZ-0004
 * gegen BB-0001 Fassung 2 (78 000 kWh gemessen, 69 098 kWh erwartet, +12,9 %, schlechter). Die Container-Seite (Stand
 * Nr. 1 mit Prüfsumme, 409 an der Archivierung, 422 ohne Basis, Zaun) prüft {@code UemsLeistungsvergleichApiTest}.
 */
class BerichtLeistungsvergleichTest {

    /** Wie der Mapper von Spring: Daten als ISO-Text. */
    private static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules()
            .disable(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");
    private static final UUID KZ = UUID.fromString("00000000-0000-0000-0000-00000000a004");
    private static final UUID BB = UUID.fromString("00000000-0000-0000-0000-00000000bb01");
    private static final UUID BB_F2 = UUID.fromString("00000000-0000-0000-0000-00000000bb02");
    private static final UUID MS20 = UUID.fromString("00000000-0000-0000-0000-000000000020");
    private static final UUID BZ1 = UUID.fromString("00000000-0000-0000-0000-00000000b201");

    @Test
    void r8DezemberTraegtDieAbschnitteDerVorlageUndPasstZumSchema() throws Exception {
        BerichtLeistungsvergleich.Ergebnis e = r8("endgültig");
        ObjectNode abzug = e.abzug();

        JsonNode vorlagen = JSON.readTree(Files.readString(V2.resolve("bericht-vorlagen.json")));
        List<String> abschnitte = new ArrayList<>();
        for (JsonNode v : vorlagen.path("vorlagen")) {
            if (BerichtRegeln.LEISTUNGSVERGLEICH.equals(v.path("schluessel").asText())) {
                v.path("abschnitte").forEach(a -> abschnitte.add(a.path("schluessel").asText()));
            }
        }
        assertThat(abschnitte).hasSize(8);
        List<String> schluessel = new ArrayList<>();
        abzug.fieldNames().forEachRemaining(schluessel::add);
        assertThat(schluessel).containsExactlyElementsOf(abschnitte);
        assertThat(BerichtLeistungsvergleich.ABSCHNITTE).isEqualTo(abschnitte.subList(0, 7));

        assertThat(UemsSchemaLaeufer.verstoesse(abzug, schemaAbzug())).as("bericht.schema.json $defs/abzug").isEmpty();

        JsonNode kopf = abzug.path("kopf");
        assertThat(kopf.path("vorlage").asText()).isEqualTo("leistungsvergleich");
        assertThat(kopf.path("zeitraum").path("schluessel").asText()).isEqualTo("2027-12");
        // W8/B18: das Zeitraum-Paar — Berichtsperiode und Referenzperiode der zitierten Fassung.
        assertThat(kopf.path("referenzperiode").path("bezeichnung").asText()).isEqualTo("November 2026 bis Oktober 2027");
        assertThat(kopf.path("bezugsbasis").path("kennzeichen").asText()).isEqualTo("BB-0001");
        assertThat(kopf.path("bezugsbasis").path("fassung").asInt()).isEqualTo(2);
        assertThat(kopf.path("grenz_satz").asText()).isEqualTo(BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        assertThat(texte(kopf.path("quellenverzeichnis"))).containsExactly("BB-0001", "BZ-1", "KZ-0004", "MS-20");

        JsonNode dezember = abzug.path("vergleich_je_periode").get(0).path("bereinigt");
        assertThat(dezember.path("gemessen").path("wert").asText()).isEqualTo("78000");
        assertThat(dezember.path("gemessen").path("version").asInt()).isEqualTo(1);
        assertThat(dezember.path("bedingung").get(0).path("fassung").asInt()).isEqualTo(1);
        assertThat(dezember.path("erwartet").asText()).isEqualTo("69098");
        assertThat(dezember.path("urteil").asText()).isEqualTo("schlechter");
        // U1: die rohe Veränderung trägt nie ein Urteil.
        assertThat(abzug.path("vergleich_je_periode").get(0).path("roh").path("urteil").asText()).isEqualTo("ohne_urteil");
        assertThat(abzug.path("urteil").path("urteil").asText()).isEqualTo("schlechter");
        assertThat(abzug.path("bezugsbasis").path("koeffizienten").path("b").decimalValue())
                .isEqualByComparingTo("0.2343");
        assertThat(abzug.path("statische_faktoren").get(0).path("wortlaut").asText()).isEqualTo("Zwei Schichten");
    }

    @Test
    void jedeZahlMitVersionDieBasisMitFassungVierQuellen() {
        BerichtLeistungsvergleich.Ergebnis e = r8("endgültig");
        assertThat(e.quellen()).extracting(BerichtAbzugBildung.Quelle::art, BerichtAbzugBildung.Quelle::kennzeichen,
                BerichtAbzugBildung.Quelle::bezug, BerichtAbzugBildung.Quelle::version, BerichtAbzugBildung.Quelle::fassung)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("kennzahl", "KZ-0004", "unmittelbar", 1, null),
                        org.assertj.core.groups.Tuple.tuple("messstelle", "MS-20", "mittelbar", 1, null),
                        org.assertj.core.groups.Tuple.tuple("bezugsgroesse", "BZ-1", "unmittelbar", null, 1),
                        org.assertj.core.groups.Tuple.tuple("bezugsbasis", "BB-0001", "vergleich", null, 2));
        assertThat(e.quellen()).allSatisfy(q -> {
            assertThat(q.ersterTag()).isEqualTo(LocalDate.of(2027, 12, 1));
            assertThat(q.letzterTag()).isEqualTo(LocalDate.of(2027, 12, 31));
        });
        assertThat(e.abzug().path("quellenverzeichnis")).hasSize(4);
    }

    /** A1/A6: gleiche Eingänge → derselbe kanonische Text und dieselbe Prüfsumme. */
    @Test
    void derAbzugIstKanonischUndSeinePruefsummeStabil() {
        String a = BerichtRegeln.kanonisch(r8("endgültig").abzug());
        String b = BerichtRegeln.kanonisch(r8("endgültig").abzug());
        assertThat(a).isEqualTo(b);
        assertThat(BerichtRegeln.pruefsumme(a)).isEqualTo(BerichtRegeln.pruefsumme(b)).matches("sha256:[0-9a-f]{64}");
        assertThat(BerichtRegeln.pruefsumme(BerichtRegeln.kanonisch(r8("vorläufig").abzug())))
                .isNotEqualTo(BerichtRegeln.pruefsumme(a));
    }

    /** S3/F2: ein vorläufiger Dezember hält die Freigabe auf; endgültig nicht. */
    @Test
    void dieFreigabePrueftGemessenUndBedingung() {
        assertThat(BerichtService.freigabeWerte(r8("endgültig").abzug()))
                .noneMatch(w -> KennzahlRegeln.VORLAEUFIG.equals(w.fassung()));
        List<BerichtRegeln.FreigabeWert> vorlaeufig = BerichtService.freigabeWerte(r8("vorläufig").abzug());
        assertThat(vorlaeufig).filteredOn(w -> KennzahlRegeln.VORLAEUFIG.equals(w.fassung()))
                .extracting(BerichtRegeln.FreigabeWert::quelle).containsExactly("KZ-0004");
        BerichtRegeln.Freigabe f = BerichtRegeln.freigabe(new BerichtRegeln.FreigabeAntrag("monat", "2027-12", ZONE,
                Instant.parse("2028-01-12T08:52:00Z"), vorlaeufig, Instant.parse("2028-01-12T08:40:00Z"),
                Instant.parse("2028-01-12T08:40:00Z"), 0, null, 0));
        assertThat(f.erlaubt()).isFalse();
        assertThat(f.code()).isEqualTo(BerichtRegeln.WERTE_VORLAEUFIG);
    }

    /** S5: die Vergleich-Fläche nennt den jüngsten Stand. */
    @Test
    void derStandSatzDerVergleichFlaeche() {
        assertThat(BezugsbasisVergleichSatz.stand(List.of())).isEqualTo("ungesichert — noch kein Stand");
        assertThat(BezugsbasisVergleichSatz.stand(List.of(new BezugsbasisVergleichDto.Stand(1, LocalDate.of(2028, 1, 12)))))
                .isEqualTo("Stand Nr. 1 vom 12.01.2028");
    }

    // ================================================================================ R8

    /** R8 Dezember 2027 (VB-2028-0001): auch der Abzug der PDF-/CSV-Tests (IP-22). */
    static BerichtLeistungsvergleich.Ergebnis r8(String zustand) {
        BezugsbasisVergleichDto.Fassung fassung = new BezugsbasisVergleichDto.Fassung(2, "regression_eine_variable",
                "2026-11/2027-10", "vollstaendig", LocalDate.of(2027, 11, 1), null);
        BezugsbasisVergleichDto.Bedingung bz1 = new BezugsbasisVergleichDto.Bedingung(1, "bezugsgroesse", "BZ-1",
                "Produktionsmenge Spritzguss", "250000", "kg", 1, null, "endgültig");
        BezugsbasisVergleichDto.Monat dezember = new BezugsbasisVergleichDto.Monat("2027-12", "Dezember 2027",
                new BezugsbasisVergleichDto.Roh("78000", "85500", "-8.8", "gesunken", "-21.9", "ohne_urteil"),
                new BezugsbasisVergleichDto.Bereinigt(fassung,
                        new BezugsbasisVergleichDto.Gemessen("78000", "kWh", 1, zustand), List.of(bz1), "69098",
                        "12.9", "2.0", "ueber", "schlechter", null, List.of()),
                "Dezember 2027: 12,9 % über dem Erwarteten — schlechter.");
        BezugsbasisVergleichDto.Zeitraum zeitraum = new BezugsbasisVergleichDto.Zeitraum(2, "78000", "69098", "12.9",
                "2.0", "ueber", "schlechter", null, "1 von 1", List.of(), "Dezember 2027: schlechter.");
        BezugsbasisVergleichDto.Vergleich v = new BezugsbasisVergleichDto.Vergleich(
                new KennzahlDto.WerteKennzahl(KZ, "KZ-0004", "Spritzguss", "quotient", "kWh/kg", "kWh je kg"),
                new BezugsbasisVergleichDto.Basis(BB, "BB-0001", null, null), "2027-12", "2027-12", "Europe/Berlin",
                List.of(dezember), zeitraum, List.of(), "ungesichert — noch kein Stand", null);
        BerichtLeistungsvergleich.Fassung f = new BerichtLeistungsvergleich.Fassung(BB, "BB-0001", BB_F2, 2,
                "regression_eine_variable", "2026-11/2027-10", "vollstaendig", LocalDate.of(2027, 11, 1), null, null,
                "{\"a\": 10523, \"b\": 0.2343}", new BigDecimal("0.94"), new BigDecimal("3.1"), new BigDecimal("2.0"),
                "sha256:c07b", "Ines Kaltenbach", "Energiemanagerin", Instant.parse("2027-11-12T09:00:00Z"));
        List<BerichtLeistungsvergleich.Faktor> faktoren = List.of(new BerichtLeistungsvergleich.Faktor(1, "wortlaut",
                null, "Zwei Schichten", null, null, null, LocalDate.of(2027, 11, 12)));
        List<BerichtLeistungsvergleich.Eingang> eingaenge = List.of(
                new BerichtLeistungsvergleich.Eingang("messstelle", "MS-20", MS20, "Spritzguss Halle 2", 1, null,
                        LocalDate.of(2027, 12, 1), LocalDate.of(2027, 12, 31)),
                new BerichtLeistungsvergleich.Eingang("bezugsgroesse", "BZ-1", BZ1, "Produktionsmenge Spritzguss", null,
                        1, LocalDate.of(2027, 12, 1), LocalDate.of(2027, 12, 31)));
        BerichtAbzugBildung.Geltung g = new BerichtAbzugBildung.Geltung(BerichtRegeln.UNTERNEHMEN,
                "Kunststoffwerk Ahrenberg GmbH", "U", null, "Kunststoffwerk Ahrenberg GmbH", "Industriestraße 12, 57000 Ahrenberg");
        BerichtLeistungsvergleich.Kopf kopf = new BerichtLeistungsvergleich.Kopf("BR-2028-0001", g,
                BerichtRegeln.zeitraum("monat", "2027-12", ZONE), ZONE, Instant.parse("2028-01-12T08:40:00Z"),
                BerichtRegelwerk.heute(null, null, "ip21b-test"));
        return BerichtLeistungsvergleich.abzug(JSON, kopf, v, f, faktoren, eingaenge, Map.of("BZ-1", BZ1));
    }

    private static List<String> texte(JsonNode n) {
        List<String> aus = new ArrayList<>();
        n.forEach(x -> aus.add(x.asText()));
        return aus;
    }

    private static JsonNode schemaAbzug() throws Exception {
        JsonNode schema = JSON.readTree(Files.readString(V2.resolve("bericht.schema.json")));
        ObjectNode wurzel = JSON.createObjectNode();
        wurzel.set("$defs", schema.path("$defs"));
        wurzel.put("$ref", "#/$defs/abzug");
        return wurzel;
    }
}
