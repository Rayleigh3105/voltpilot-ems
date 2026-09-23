package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Das PDF eines Berichtsstands aus dem Abzug (UEMS AP-12 IP-11, E11 DA2) — rein, ohne Datenbank. Die vier Zusagen des
 * Pakets: zwei Erzeugungen byte-gleich, Kennung/Stand/Datenstand/Prüfsumme als Text, eingebettete Schrift, unter 1 MB je
 * Monatsbericht. Route, Rechte und Abruf-Protokoll prüft {@code BerichtApiTest}.
 */
class BerichtPdfTest {

    private static final ObjectMapper EXAKT = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));
    private static final Path V2 = Path.of("..", "..", "docs", "contracts", "v2");
    private static final int EIN_MEGABYTE = 1_000_000;

    private static String textEins;
    private static JsonNode nummerEins;
    private static BerichtCsv.Stand standEins;

    @BeforeAll
    static void lies() throws Exception {
        JsonNode vektoren = EXAKT.readTree(Files.readString(V2.resolve("bericht-vectors.json")));
        textEins = BerichtRegeln.kanonisch(vektoren.path("abzuege").path("BR-2026-0001/1"));
        nummerEins = EXAKT.readTree(textEins);
        standEins = new BerichtCsv.Stand(1, t("2026-11-10T09:02:00+01:00"), "Ines Kaltenbach",
                BerichtRegeln.pruefsumme(textEins), null, null);
    }

    /** Die Kernzusage: derselbe Stand, zweimal erzeugt — über eine Sekundengrenze und aus neu gelesenem Abzug — byte-gleich. */
    @Test
    void zweiErzeugungenDesselbenStandsSindByteGleich() throws Exception {
        byte[] eins = BerichtPdf.datei(nummerEins, standEins);
        Thread.sleep(1_100);
        byte[] zwei = BerichtPdf.datei(EXAKT.readTree(textEins), standEins);
        assertThat(zwei).isEqualTo(eins);
        assertThat(new String(eins, 0, 5, StandardCharsets.US_ASCII)).isEqualTo("%PDF-");

        BerichtCsv.Stand ersetzt = new BerichtCsv.Stand(1, standEins.freigegebenAm(), standEins.freigegebenVon(),
                standEins.pruefsumme(), 2, t("2026-11-16T14:20:00+01:00"));
        assertThat(BerichtPdf.datei(nummerEins, ersetzt)).as("ersetzt, zweimal").isEqualTo(BerichtPdf.datei(nummerEins, ersetzt))
                .as("das Wasserzeichen ändert die Datei").isNotEqualTo(eins);
    }

    /** AP-16 IP-22: die Bewertung ist eine deterministische Tabelle; Grenz-Satz und Kundensprache stehen im PDF-Text. */
    @Test
    void bewertungIstByteGleichHatPruefsummenIdUndAchtTabellen() throws Exception {
        ObjectNode abzug = BerichtBewertungTestdaten.aus(nummerEins);
        String kanonisch = BerichtRegeln.kanonisch(abzug);
        BerichtCsv.Stand stand = new BerichtCsv.Stand(2, t("2026-11-17T15:42:00+01:00"), "Ines Kaltenbach",
                BerichtRegeln.pruefsumme(kanonisch), null, null);

        byte[] eins = BerichtPdf.datei(abzug, stand);
        byte[] zwei = BerichtPdf.datei(EXAKT.readTree(kanonisch), stand);
        assertThat(zwei).isEqualTo(eins);
        String pdfText = text(eins);
        assertThat(pdfText.replaceAll("\\s+", " ")).contains(BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        assertThat(pdfText).contains("Umfang", "Rangliste", "Einstufungen",
                "Messabdeckung", "Messplanung", "Messmittel", "Qualität", "Quellenverzeichnis",
                "EE-1 Spritzguss", "wesentlich", "Fassung 4", "MB-1", "Netzzähler Halle 1");
        assertThat(pdfText).doesNotContain("SEU", "ISO-wesentlich", "automatisch eingestuft");
        assertThat(Files.readString(Path.of("..", "..", "frontend", "portal", "src", "glossar.ts")))
                .contains("'" + BerichtRegeln.BEWERTUNG_GRENZ_SATZ + "'");

        try (PDDocument d = Loader.loadPDF(eins)) {
            byte[] erwartet = java.util.Arrays.copyOf(MessageDigest.getInstance("SHA-256")
                    .digest(stand.pruefsumme().getBytes(StandardCharsets.UTF_8)), 16);
            assertThat(((org.apache.pdfbox.cos.COSString) d.getDocument().getTrailer().getCOSArray(COSName.ID)
                    .getObject(0)).getBytes())
                    .containsExactly(erwartet);
        }
    }

    /**
     * AP-17 IP-22 (S3, R8): zwei Erzeugungen byte-gleich, {@code /ID} aus der Prüfsumme, der Grenz-Satz im Kopf vor dem
     * ersten Abschnitt, Berichts- und Referenzperiode mit der zitierten Fassung; Urteil als Wort mit Band, die rohe
     * Veränderung daneben nur mit Vorzeichen (U1, SP2).
     */
    @Test
    void leistungsvergleichIstByteGleichHatPruefsummenIdUndGrenzSatzImKopf() throws Exception {
        ObjectNode abzug = BerichtLeistungsvergleichTest.r8("endgültig").abzug();
        String kanonisch = BerichtRegeln.kanonisch(abzug);
        BerichtCsv.Stand stand = new BerichtCsv.Stand(1, t("2028-01-12T09:52:00+01:00"), "Ines Kaltenbach",
                BerichtRegeln.pruefsumme(kanonisch), null, null);

        // Wie im Betrieb aus dem gespeicherten, kanonischen Abzug (BerichtService liest den Stand) — zweimal gelesen.
        byte[] eins = BerichtPdf.datei(EXAKT.readTree(kanonisch), stand);
        byte[] zwei = BerichtPdf.datei(EXAKT.readTree(kanonisch), stand);
        assertThat(zwei).isEqualTo(eins);
        String pdfText = text(eins);
        String flach = pdfText.replaceAll("\\s+", " ");
        assertThat(flach).contains(BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        assertThat(flach.indexOf(BerichtRegeln.BEWERTUNG_GRENZ_SATZ)).isLessThan(pdfText.indexOf("\nKennzahl\n"));
        int vorher = -1;
        for (String titel : BerichtPdf.ABSCHNITTE_LEISTUNGSVERGLEICH.values().stream().skip(1).toList()) {
            int stelle = pdfText.indexOf("\n" + titel + "\n", vorher + 1);
            assertThat(stelle).as(titel).isGreaterThan(vorher);
            vorher = stelle;
        }
        assertThat(flach).contains("Leistungsvergleich", "01.12.2027–31.12.2027 (2027-12)", "Referenzperiode",
                "(2026-11/2027-10)", "BB-0001, Fassung 2", "KZ-0004 Spritzguss", "Modell mit einer Einflussgröße",
                "a = 10.523", "b = 0,2343", "Dezember 2027", "Version 1", "BZ-1 250.000 kg", "Fassung 1", "69.098 kWh",
                "+12,9 %", "schlechter", "± 2 %", "−8,8 %", "−21,9 %", "Zwei Schichten", "Bezugsbasis BB-0001",
                "Vergleich", BerichtPdf.GRENZEN_SATZ);
        assertThat(flach).doesNotContain("gesunken", "ohne_urteil", "EnPI", "Baseline", "Normalisierung", "KPI",
                "Verbesserung", "automatisch bewertet");

        try (PDDocument d = Loader.loadPDF(eins)) {
            byte[] erwartet = java.util.Arrays.copyOf(MessageDigest.getInstance("SHA-256")
                    .digest(stand.pruefsumme().getBytes(StandardCharsets.UTF_8)), 16);
            assertThat(((org.apache.pdfbox.cos.COSString) d.getDocument().getTrailer().getCOSArray(COSName.ID)
                    .getObject(0)).getBytes())
                    .containsExactly(erwartet);
        }
    }

    /** Text-Extraktion: Kennung, Stand, Datenstand und Prüfsumme sind lesbar, nicht nur gezeichnet — dazu B1 an MS-12. */
    @Test
    void dasPdfNenntKennungStandDatenstandUndPruefsummeAlsText() throws Exception {
        byte[] pdf = BerichtPdf.datei(nummerEins, standEins);
        String text = text(pdf);
        assertThat(text).contains("BR-2026-0001", "Berichtsstand Nr. 1", "Datenstand 10.11.2026 08:55 (MEZ)",
                "freigegeben 10.11.2026 09:02 von Ines Kaltenbach", standEins.pruefsumme());
        assertThat(standEins.pruefsumme()).startsWith("sha256:");
        assertThat(text).contains("Monatsbericht Standort", "Standort ST-1 Werk Ahrenberg",
                "Kunststoffwerk Ahrenberg GmbH, Gewerbering 7, Ahrenberg", "01.10.2026–31.10.2026 (2026-10)");
        // B1: „6 100 kWh, Version 1, endgültig ab 08.11.2026, gerechnet 01.11.2026“ — in der Darstellung des Stands (DA1)
        assertThat(text).contains("MS-12 Montage Linie M1", "6.100 kWh", "endgültig · Version 1", "endgültig ab 08.11.2026",
                "gerechnet 01.11.2026 00:20");
        assertThat(text).contains("KZ-0001 Stromeinsatz Montage je Stück — Halle 2", "0,15 kWh je Stück",
                "Definition Fassung 1", "berechnet (Kennzahl)");
        assertThat(text).contains("Abdeckung mindestens 100 %", "BZ-6").doesNotContain("ersetzt durch");
        try (PDDocument d = Loader.loadPDF(pdf)) {
            for (int seite = 1; seite <= d.getNumberOfPages(); seite++) {
                assertThat(text(d, seite)).as("Fuß auf Seite " + seite).contains(standEins.pruefsumme())
                        .contains("Seite " + seite + " von " + d.getNumberOfPages());
            }
        }
    }

    /** Deterministisch heißt auch: das Datum im Dokument ist die Freigabe, die Kennung steht fest, die Schrift ist eingebettet. */
    @Test
    void datumIstDieFreigabeKennungStehtFestUndDieSchriftIstEingebettet() throws Exception {
        try (PDDocument d = Loader.loadPDF(BerichtPdf.datei(nummerEins, standEins))) {
            assertThat(d.getDocumentInformation().getCreationDate().toInstant()).isEqualTo(standEins.freigegebenAm());
            assertThat(d.getDocumentInformation().getModificationDate().toInstant()).isEqualTo(standEins.freigegebenAm());
            assertThat(d.getDocumentInformation().getTitle()).isEqualTo("Monatsbericht Standort BR-2026-0001 · Berichtsstand Nr. 1");
            assertThat(d.getDocument().getTrailer().getCOSArray(COSName.ID)).hasSize(2);
            List<String> schriften = new ArrayList<>();
            for (PDPage p : d.getPages()) {
                for (COSName n : p.getResources().getFontNames()) {
                    PDFont f = p.getResources().getFont(n);
                    assertThat(f.isEmbedded()).as(f.getName()).isTrue();
                    schriften.add(f.getName());
                }
            }
            assertThat(schriften).isNotEmpty().allSatisfy(n -> assertThat(n).matches("[A-Z]{6}\\+LiberationSans"));
        }
    }

    /** Unter 1 MB je Monatsbericht — Ahrenberg (16 Werte) und ein großer Standort mit 300 Messstellen über mehrere Seiten. */
    @Test
    void einMonatsberichtBleibtUnterEinemMegabyte() throws Exception {
        byte[] ahrenberg = BerichtPdf.datei(nummerEins, standEins);
        assertThat(ahrenberg.length).isLessThan(EIN_MEGABYTE);

        ObjectNode gross = (ObjectNode) nummerEins.deepCopy();
        ArrayNode werte = gross.putArray("werte");
        for (int i = 0; i < 300; i++) {
            ObjectNode w = (ObjectNode) nummerEins.path("werte").get(i % 16).deepCopy();
            w.put("quelle", String.format("MS-%03d", i)).put("name_zum_datenstand", "Messstelle " + i + " Halle " + (i % 7));
            werte.add(w);
        }
        byte[] pdf = BerichtPdf.datei(gross, standEins);
        assertThat(pdf.length).isLessThan(EIN_MEGABYTE);
        try (PDDocument d = Loader.loadPDF(pdf)) {
            assertThat(d.getNumberOfPages()).isGreaterThan(3);
            assertThat(text(d, d.getNumberOfPages())).contains("Seite " + d.getNumberOfPages() + " von " + d.getNumberOfPages());
            assertThat(text(pdf)).contains("MS-299 Messstelle 299");
        }
    }

    /** R2: ein ersetzter Stand trägt auf JEDER Seite „ersetzt durch Nr. 2 (16.11.2026)“ — der gültige nirgends. */
    @Test
    void einErsetzterStandTraegtAufJederSeiteDasWasserzeichen() throws Exception {
        ObjectNode lang = (ObjectNode) nummerEins.deepCopy();
        ArrayNode werte = (ArrayNode) lang.path("werte");
        for (int i = 0; i < 60; i++) {
            werte.add(nummerEins.path("werte").get(i % 16).deepCopy());
        }
        BerichtCsv.Stand ersetzt = new BerichtCsv.Stand(1, standEins.freigegebenAm(), standEins.freigegebenVon(),
                standEins.pruefsumme(), 2, t("2026-11-16T14:20:00+01:00"));
        String wasserzeichen = BerichtRegeln.ersetztDurch(2, ersetzt.ersetztAm(), java.time.ZoneId.of("Europe/Berlin"));
        assertThat(wasserzeichen).isEqualTo("ersetzt durch Nr. 2 (16.11.2026)");
        try (PDDocument d = Loader.loadPDF(BerichtPdf.datei(lang, ersetzt))) {
            assertThat(d.getNumberOfPages()).isGreaterThan(1);
            for (int seite = 1; seite <= d.getNumberOfPages(); seite++) {
                assertThat(text(d, seite)).as("Zeile oben rechts auf Seite " + seite).contains(wasserzeichen);
                assertThat(gedreht(d, seite)).as("schräg über Seite " + seite).isEqualTo(wasserzeichen.replace(" ", ""));
            }
        }
        assertThat(text(BerichtPdf.datei(lang, standEins))).doesNotContain("ersetzt durch");
    }

    /** Titel und Folge der Abschnitte sind die der Vorlagen (Fassung 1) — ändert eine Vorlage sie, wird dieser Test rot. */
    @Test
    void dieAbschnitteFolgenDenVorlagen() throws Exception {
        JsonNode vorlagen = EXAKT.readTree(Files.readString(V2.resolve("bericht-vorlagen.json"))).path("vorlagen");
        assertThat(vorlagen).hasSize(6);
        for (JsonNode v : vorlagen) {
            String schluessel = v.path("schluessel").asText();
            assertThat(v.path("fassung").asInt()).isEqualTo(1);
            if (BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(schluessel)) {
                assertThat(BerichtPdf.VORLAGEN).containsEntry(schluessel, v.path("name").asText());
            }
            assertThat(BerichtPdf.VORLAGEN).containsEntry(schluessel, v.path("name").asText());
            Map<String, String> soll = new LinkedHashMap<>();
            v.path("abschnitte").forEach(a -> soll.put(a.path("schluessel").asText(), a.path("titel").asText()));
            if (BerichtRegeln.LEISTUNGSVERGLEICH.equals(schluessel)) {
                assertThat(BerichtPdf.ABSCHNITTE_LEISTUNGSVERGLEICH).containsExactlyEntriesOf(soll); // alle acht (IP-22)
                continue;
            }
            Map<String, String> ist = BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(schluessel)
                    ? BerichtPdf.ABSCHNITTE_BEWERTUNG
                    : BerichtRegeln.UNTERNEHMEN.equals(v.path("geltung_art").asText())
                            ? BerichtPdf.ABSCHNITTE_UNTERNEHMEN : BerichtPdf.ABSCHNITTE_STANDORT;
            Map<String, String> vorlageOhneAbzugsLuecken = new LinkedHashMap<>(soll);
            vorlageOhneAbzugsLuecken.keySet().retainAll(ist.keySet());
            assertThat(ist).as(schluessel).containsExactlyEntriesOf(vorlageOhneAbzugsLuecken);
            List<String> fehlen = new ArrayList<>(soll.keySet());
            fehlen.removeAll(ist.keySet());
            assertThat(fehlen).as(schluessel + " — nur, was der Abzug nicht trägt").isSubsetOf("tagesverlauf", "monatswerte");
        }
        String text = text(BerichtPdf.datei(nummerEins, standEins));
        int vorher = -1;
        for (String titel : BerichtPdf.ABSCHNITTE_STANDORT.values().stream().skip(1).toList()) {
            int stelle = text.indexOf("\n" + titel + "\n", vorher + 1);
            assertThat(stelle).as(titel).isGreaterThan(vorher);
            vorher = stelle;
        }
    }

    /** Am Unternehmen: Standorte mit Summen, Messstellen, Kostenstellen (Menge oder Grund, Verteilung zum Tag), Kennzahlen. */
    @Test
    void amUnternehmenStehenStandorteKostenstellenUndKennzahlen() throws Exception {
        ObjectNode u = EXAKT.createObjectNode();
        ObjectNode kopf = ((ObjectNode) nummerEins.path("kopf")).deepCopy();
        u.set("kopf", kopf);
        kopf.put("bericht", "BR-2026-0002").put("vorlage", "monatsbericht_unternehmen");
        ((ObjectNode) kopf.path("geltung")).put("art", BerichtRegeln.UNTERNEHMEN).put("kennzeichen", "U")
                .put("name_zum_datenstand", "Kunststoffwerk Ahrenberg GmbH");
        u.set("zusammenfassung", nummerEins.path("zusammenfassung").deepCopy());
        u.putArray("werte").add(nummerEins.path("werte").get(0).deepCopy());
        ObjectNode st1 = u.putArray("standorte").addObject().put("kennzeichen", "ST-1").put("name_zum_datenstand", "Werk Ahrenberg");
        st1.putObject("summen").put("netzbezug_kwh", new BigDecimal("128400"));
        st1.putArray("messstellen").add("MS-01");
        ObjectNode k4200 = u.putArray("kostenstellen").addObject().put("quelle", "4200").put("name_zum_datenstand", "Montage")
                .put("gueltig_ab", "2026-01-01").putNull("gueltig_bis").put("periode", "2026-10")
                .put("berechnet_am", "2026-11-10T08:55:00+01:00");
        k4200.putObject("summe").put("menge", new BigDecimal("14410")).put("einheit", "kWh").put("zustand", "vollständig")
                .putNull("grund");
        ObjectNode verteilt = k4200.putObject("verteilt").put("menge", new BigDecimal("6100")).put("einheit", "kWh")
                .put("zustand", "vollständig").putNull("grund");
        ObjectNode posten = verteilt.putArray("posten").addObject().put("quelle", "MS-12")
                .put("name_zum_datenstand", "Montage Linie M1").put("menge", new BigDecimal("6100")).put("einheit", "kWh");
        posten.putArray("saetze").addObject().put("von", "2026-10-01").put("bis", "2026-10-31")
                .put("anteil_prozent", new BigDecimal("100"));
        ObjectNode k9000 = ((ArrayNode) u.path("kostenstellen")).addObject().put("quelle", "9000")
                .put("name_zum_datenstand", "Allgemein").put("gueltig_ab", "2026-01-01").put("gueltig_bis", "2026-12-31")
                .put("periode", "2026-10").put("berechnet_am", "2026-11-10T08:55:00+01:00");
        k9000.putObject("summe").putNull("menge").putNull("einheit").putNull("zustand").put("grund", "mehrere Größen");
        u.putArray("kennzahlen");
        u.set("qualitaet", nummerEins.path("qualitaet").deepCopy());

        String text = text(BerichtPdf.datei(u, standEins));
        assertThat(text).contains("Monatsbericht Unternehmen", "Unternehmen Kunststoffwerk Ahrenberg GmbH", "Standorte",
                "ST-1 Werk Ahrenberg", "Netzbezug 128.400 kWh", "MS-01 Netzbezug Halle 1", "Prozesse und Kostenstellen",
                "4200 Montage", "ab 01.01.2026", "14.410 kWh", "verteilt 6.100 kWh", "MS-12 Montage Linie M1: 6.100 kWh",
                "100 %", "01.10.2026–31.10.2026", "9000 Allgemein", "bis 31.12.2026", "mehrere Größen",
                "Kennzahlen des Unternehmens", "Keine Kennzahl in diesem Bericht.");
        assertThat(text).doesNotContain("Verbrauch je Messstelle");
    }

    /** Ein Name mit Zeichen, die die Schrift nicht kennt, und mit Zeilenumbruch: „?“ und Leerzeichen — nie ein Fehler. */
    @Test
    void einZeichenOhneGlypheWirdErsetztStattZuScheitern() throws Exception {
        ObjectNode abzug = (ObjectNode) nummerEins.deepCopy();
        ((ObjectNode) abzug.path("werte").get(0)).put("name_zum_datenstand", "Werk 東京\nNord");
        assertThat(text(BerichtPdf.datei(abzug, standEins))).contains("MS-01 Werk ?? Nord");
    }

    private static String text(byte[] pdf) throws IOException {
        try (PDDocument d = Loader.loadPDF(pdf)) {
            return new PDFTextStripper().getText(d).replace('\u00A0', ' ');
        }
    }

    private static String text(PDDocument d, int seite) throws IOException {
        PDFTextStripper s = new PDFTextStripper();
        s.setStartPage(seite);
        s.setEndPage(seite);
        return s.getText(d).replace('\u00A0', ' ');
    }

    /** Die Zeichen gedrehter Glyphen einer Seite, ohne Leerzeichen — das schräge Wasserzeichen. */
    private static String gedreht(PDDocument d, int seite) throws IOException {
        StringBuilder raus = new StringBuilder();
        PDFTextStripper s = new PDFTextStripper() {
            @Override
            protected void processTextPosition(TextPosition t) {
                if (Math.abs(t.getTextMatrix().getShearY()) > 0.1f && !t.getUnicode().isBlank()) {
                    raus.append(t.getUnicode());
                }
                super.processTextPosition(t);
            }
        };
        s.setStartPage(seite);
        s.setEndPage(seite);
        s.getText(d);
        return raus.toString();
    }

    private static Instant t(String iso) {
        return OffsetDateTime.parse(iso).toInstant();
    }
}
