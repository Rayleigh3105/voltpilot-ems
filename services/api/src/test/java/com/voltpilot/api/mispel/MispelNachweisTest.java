package com.voltpilot.api.mispel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Ergebnis;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.Viertelstunde;
import com.voltpilot.api.mispel.MispelAbgrenzungRechenwerk.ViertelstundeWerte;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;

/**
 * MiSpeL MP-16, rein: der Nachweis trägt genau die Werte des Rechenwerks (exakt, aus dem Nachweis-Text mit geprüfter
 * Prüfsumme), rundet nur die Anzeigezahl, bildet ∑J wie das Rechenwerk, markiert vorläufige Zeiträume und ist byte-gleich
 * bei jeder Erzeugung (CSV mit festgenagelter SHA-256). Die Läufe sind aus den Vektorfällen des Vertrags gerechnet und in
 * der Form gespeichert, die {@link MispelAbgrenzungService} schreibt; den echten Monatslauf prüft
 * {@code MispelNachweisApiTest}.
 */
class MispelNachweisTest {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);
    private static final UUID ANLAGE = UUID.fromString("5e1f0000-0000-4000-8000-000000000016");
    private static final Instant GERECHNET = Instant.parse("2027-06-10T08:00:00Z");

    /**
     * Die Prüfsumme des Monats-CSV für den Netzbetreiber im Fall {@code a1-monat-alle-formeln} — jede Änderung am Format
     * ändert sie (und gehört dann bewusst hierher).
     */
    private static final String CSV_SHA256 = "eb6f4d966ab9361900e537e3e6d21008a16662790427b2b2b27ab734cba611b2";

    // ------------------------------------------------------------------ Werte gleich dem Rechenwerk

    @Test
    void derMonatsnachweisTraegtJedeZahlDesRechenwerksExakt() {
        JsonNode fall = fall("a1-monat-alle-formeln");
        Ergebnis e = MispelAbgrenzungRechenwerkTest.rechne(fall);
        MispelNachweis.Monat m = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 4), laeufe(fall, e, "endgueltig"));
        Map<String, List<Map<String, String>>> csv = csv(MispelNachweis.csv(m, empfaenger("netzbetreiber")));

        Map<String, Bruch> soll = e.monate().get("2027-04");
        List<Map<String, String>> formelsatz = csv.get("formelsatz");
        assertThat(formelsatz).extracting(r -> r.get("nr")).containsExactlyElementsOf(soll.keySet());
        for (Map<String, String> r : formelsatz) {
            Bruch w = soll.get(r.get("nr"));
            assertThat(r.get("wert_exakt")).as(r.get("nr")).isEqualTo(w == null ? "" : w.text().replace(".", ","));
            assertThat(r.get("begriff")).as(r.get("nr")).isEqualTo(MispelNachweis.KATALOG.get(r.get("nr")).begriff());
        }
        // Jede Viertelstunde mit jedem Zwischenwert, wie gerechnet.
        List<Map<String, String>> qh = csv.get("viertelstunden");
        assertThat(qh).hasSize(e.viertelstunden().size());
        for (int i = 0; i < qh.size(); i++) {
            ViertelstundeWerte w = e.viertelstunden().get(i);
            Map<String, String> zeile = qh.get(i);
            assertThat(zeile.get("beginn")).isEqualTo(w.beginn().toString());
            w.werte().forEach((nr, b) -> assertThat(zeile.get(nr)).as(nr).isEqualTo(b.text().replace(".", ",")));
        }
        // Der Kopf nennt die Prüfsumme des gespeicherten Nachweis-Texts.
        assertThat(kopf(MispelNachweis.csv(m, empfaenger("netzbetreiber"))).get("nachweis_pruefsummen"))
                .isEqualTo(m.laeufe().get(0).zeile().pruefsumme());
    }

    @Test
    void derEmpfaengerWaehltNurSeineErgebnisseUndAlleBekommenDenGanzenFormelsatz() throws Exception {
        JsonNode fall = fall("a1-monat-alle-formeln");
        MispelNachweis.Monat m = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 4),
                laeufe(fall, MispelAbgrenzungRechenwerkTest.rechne(fall), "endgueltig"));
        assertThat(nrs(m, "lieferant")).containsExactly("(3)", "(16)", "(19)A1,A4", "(20)", "(21)");
        assertThat(nrs(m, "direktvermarkter")).containsExactly("(4)", "(26)", "(31)", "(32)");
        assertThat(nrs(m, "netzbetreiber")).containsExactly("(3)", "(4)", "(16)", "(19)A1,A4", "(20)", "(21)", "(26)",
                "(31)", "(32)");
        for (String e : MispelNachweis.EMPFAENGER.keySet()) {
            assertThat(csv(MispelNachweis.csv(m, empfaenger(e))).get("formelsatz")).hasSize(23);
        }
        // Nur der Lieferant trägt die Mitteilungsfrist (§ 21 Abs. 7 EnFG).
        assertThat(kopf(MispelNachweis.csv(m, empfaenger("lieferant"))).get("frist"))
                .isEqualTo("Mitteilung bis 31.05.2028 (§ 21 Abs. 7 EnFG)");
        assertThat(kopf(MispelNachweis.csv(m, empfaenger("direktvermarkter")))).doesNotContainKey("frist");

        JsonNode a5 = fall("a5-zwei-anlagen-unterschiedliche-aw");
        MispelNachweis.Monat m5 = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 6),
                laeufe(a5, MispelAbgrenzungRechenwerkTest.rechne(a5), "endgueltig"));
        assertThat(nrs(m5, "direktvermarkter")).containsExactly("(4)", "(26a)", "(31a)", "(32a)", "(26b)", "(31b)",
                "(32b)");
        assertThat(MispelNachweis.ergebnis(m5, empfaenger("direktvermarkter"))).allSatisfy(w ->
                assertThat(w.formel().fundstelle()).startsWith("A1 S. "));

        // A10 hat keine Förderseite (Anlage 1 Abschn. 10): der Direktvermarkter bekommt den Satz statt einer Zahl.
        JsonNode a10 = fall("a10-voller-zyklus");
        MispelNachweis.Monat m10 = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 4),
                laeufe(a10, MispelAbgrenzungRechenwerkTest.rechne(a10), "endgueltig"));
        assertThat(nrs(m10, "direktvermarkter")).isEmpty();
        assertThat(nrs(m10, "lieferant")).containsExactly("(3)", "(20)A10", "(21)A10");
        assertThat(pdfText(MispelNachweisPdf.datei(m10, empfaenger("direktvermarkter"))))
                .contains("A10 und A11 haben keine Förderseite");
    }

    @Test
    void derJahresnachweisSummiertDieMonateWieDasRechenwerk() {
        JsonNode fall = fall("a1-monatsgrenze-speicherinhalt-als-fremdtankstrom");
        Ergebnis e = MispelAbgrenzungRechenwerkTest.rechne(fall);
        MispelNachweis.Jahr j = MispelNachweis.jahr(ANLAGE, 2027, laeufe(fall, e, "endgueltig"));
        assertThat(j.jahreswerte()).isEqualTo(e.jahre().get("2027"));
        // Der Jahresnachweis reicht nur bis 31.10.: vorläufig, mit der offenen Strecke als Grund.
        assertThat(j.stand()).isEqualTo("vorlaeufig");
        assertThat(j.gruende()).containsExactly("nicht_bis_jahresende:2027-11-01/2027-12-31");
        assertThat(j.abdeckung().get(0)).isEqualTo(new MispelNachweis.Abschnitt(LocalDate.of(2027, 1, 1),
                LocalDate.of(2027, 8, 31), null));
        Map<String, List<Map<String, String>>> csv = csv(MispelNachweis.csv(j, empfaenger("lieferant")));
        assertThat(csv.get("ergebnis")).singleElement().satisfies(r -> {
            assertThat(r.get("nr")).isEqualTo("(22)");
            assertThat(r.get("wert_exakt")).isEqualTo(e.jahre().get("2027").get("(22)").text().replace(".", ","));
        });
        assertThat(csv.get("monatswerte")).extracting(r -> r.get("schluessel") + " " + r.get("nr"))
                .contains("2027-09 (21)", "2027-10 (21)");

        // A11 über einen Jahreswechsel: jedes Jahr nur seine Monate.
        JsonNode a11 = fall("a11-monatsgrenzen-in-ortszeit");
        Ergebnis e11 = MispelAbgrenzungRechenwerkTest.rechne(a11);
        assertThat(MispelNachweis.jahr(ANLAGE, 2026, laeufe(a11, e11, "endgueltig").stream()
                .filter(z -> z.monat().getYear() == 2026).toList()).jahreswerte()).isEqualTo(e11.jahre().get("2026"));
        assertThat(MispelNachweis.jahr(ANLAGE, 2027, laeufe(a11, e11, "endgueltig").stream()
                .filter(z -> z.monat().getYear() == 2027).toList()).jahreswerte()).isEqualTo(e11.jahre().get("2027"));
    }

    @Test
    void rumpfmonateStehenJeEinzelnImMonat() {
        JsonNode fall = fall("a5-rumpfmonate-leistungsaenderung");
        Ergebnis e = MispelAbgrenzungRechenwerkTest.rechne(fall);
        MispelNachweis.Monat m = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 5), laeufe(fall, e, "endgueltig"));
        assertThat(m.laeufe()).extracting(MispelNachweis.Lauf::schluessel).containsExactly("2027-05/1", "2027-05/15");
        assertThat(m.stand()).isEqualTo("endgueltig");
        Map<String, List<Map<String, String>>> csv = csv(MispelNachweis.csv(m, empfaenger("direktvermarkter")));
        for (Map<String, String> r : csv.get("ergebnis")) {
            Bruch soll = e.monate().get(r.get("schluessel")).get(r.get("nr"));
            assertThat(r.get("wert_exakt")).isEqualTo(soll.text().replace(".", ","));
        }
        assertThat(csv.get("laeufe")).extracting(r -> r.get("erster_tag") + "–" + r.get("letzter_tag"))
                .containsExactly("2027-05-01–2027-05-14", "2027-05-15–2027-05-31");
    }

    // ------------------------------------------------------------------ Prüfsumme und Byte-Gleichheit

    @Test
    void einNachweisTextOhnePassendePruefsummeGehtNichtHinaus() {
        JsonNode fall = fall("a1-monat-alle-formeln");
        Zeile z = laeufe(fall, MispelAbgrenzungRechenwerkTest.rechne(fall), "endgueltig").get(0);
        Zeile verbogen = new Zeile(z.id(), z.siteId(), z.monat(), z.zeitraumVon(), z.zeitraumBis(), z.fassung(),
                z.formelsatz(), z.stand(), z.wertequelle(), z.viertelstundenErwartet(), z.viertelstundenGerechnet(),
                z.rechenwerkVersion(), z.vertragVersion(), z.nachweis().replace("\"(32)\":\"", "\"(32)\":\"1"),
                z.pruefsumme(), z.gerechnetAm());
        assertThatThrownBy(() -> MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 4), List.of(verbogen)))
                .isInstanceOfSatisfying(MispelNachweisAbgelehnt.class, a -> {
                    assertThat(a.code()).isEqualTo("pruefsumme_abweichend");
                    assertThat(a.status()).isEqualTo(409);
                });
    }

    @Test
    void csvUndPdfSindByteGleichUndTragenDiePruefsumme() throws Exception {
        JsonNode fall = fall("a1-monat-alle-formeln");
        Ergebnis e = MispelAbgrenzungRechenwerkTest.rechne(fall);
        MispelNachweis.Monat m = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 4), laeufe(fall, e, "endgueltig"));
        MispelNachweis.Empfaenger nb = empfaenger("netzbetreiber");

        byte[] csv = MispelNachweis.csv(m, nb);
        byte[] pdf = MispelNachweisPdf.datei(m, nb);
        // Über eine Sekundengrenze: ohne feste /ID schriebe PDFBox eine aus der Uhr.
        long jetzt = System.currentTimeMillis();
        Thread.sleep(1000 - jetzt % 1000 + 5);
        assertThat(MispelNachweis.csv(m, nb)).isEqualTo(csv);
        assertThat(MispelNachweisPdf.datei(m, nb)).isEqualTo(pdf);
        assertThat(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(csv)))
                .as("Prüfsumme des CSV (bei bewusster Formatänderung hier nachziehen)").isEqualTo(CSV_SHA256);

        String text = pdfText(pdf);
        assertThat(text).contains("Mengenbestimmung nach Anlage 1 (Abgrenzungsoption) – Kalendermonat April 2027")
                .contains(m.laeufe().get(0).zeile().pruefsumme())
                .contains("Ergebnis für den Netzbetreiber")
                .doesNotContain(MispelNachweisPdf.WASSERZEICHEN);
        // Die Anzeigezahl ist die kaufmännisch gerundete des Rechenwerks.
        Bruch w32 = e.monate().get("2027-04").get("(32)");
        assertThat(text).contains(MispelNachweis.zahl(MispelNachweis.gerundet("(32)", w32)) + " kWh");
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            assertThat(doc.getDocumentInformation().getCreationDate().toInstant()).isEqualTo(GERECHNET);
        }
    }

    @Test
    void vorlaeufigGehtSichtbarAlsVorlaeufigHinausUndHeisstNieMengenbestimmung() throws Exception {
        JsonNode fall = fall("a1-monat-alle-formeln");
        MispelNachweis.Monat m = MispelNachweis.monat(ANLAGE, YearMonth.of(2027, 4),
                laeufe(fall, MispelAbgrenzungRechenwerkTest.rechne(fall), "vorlaeufig"));
        assertThat(m.giltAlsNachweis()).isFalse();
        assertThat(m.gruende()).containsExactly("lauf_vorlaeufig:2027-04");
        Map<String, String> kopf = kopf(MispelNachweis.csv(m, empfaenger("lieferant")));
        assertThat(kopf.get("gilt_als_nachweis")).isEqualTo("nein");
        assertThat(kopf.get("stand")).isEqualTo("vorlaeufig");
        assertThat(kopf.get("nachweis")).startsWith("Vorläufige Rechnung").contains("keine Mengenbestimmung");
        String text = pdfText(MispelNachweisPdf.datei(m, empfaenger("lieferant")));
        assertThat(text).contains(MispelNachweisPdf.WASSERZEICHEN).contains("Vorläufig – keine Mengenbestimmung")
                .doesNotContain("Mengenbestimmung nach Anlage 1");
    }

    @Test
    void beiUeberschneidungGiltDerZuletztGerechneteLauf() {
        JsonNode fall = fall("a5-rumpfmonate-leistungsaenderung");
        List<Zeile> rumpf = laeufe(fall, MispelAbgrenzungRechenwerkTest.rechne(fall), "endgueltig");
        Zeile ganz = umbenannt(rumpf.get(0), Instant.parse("2027-05-31T22:00:00Z"), GERECHNET.plusSeconds(60), 2);
        assertThat(MispelNachweis.geltende(List.of(rumpf.get(0), rumpf.get(1), ganz))).containsExactly(ganz);
        Zeile zweite = umbenannt(rumpf.get(0), rumpf.get(0).zeitraumBis(), GERECHNET.minusSeconds(60), 2);
        assertThat(MispelNachweis.geltende(List.of(rumpf.get(0), zweite, rumpf.get(1))))
                .containsExactly(zweite, rumpf.get(1));
    }

    @Test
    void derKatalogNenntJedeFormelDesRechenwerksMitBegriffUndFundstelle() {
        for (String fs : MispelAbgrenzungRechenwerk.FORMELSAETZE) {
            assertThat(MispelNachweis.FORMELSAETZE).containsKey(fs);
            for (String ebene : List.of("viertelstunde", "monat", "jahr")) {
                for (String nr : MispelAbgrenzungRechenwerk.formeln(fs, ebene)) {
                    MispelNachweis.Formel f = MispelNachweis.KATALOG.get(nr);
                    assertThat(f).as(fs + " " + nr).isNotNull();
                    assertThat(f.begriff()).as(nr).isNotBlank();
                    assertThat(f.fundstelle()).as(nr).startsWith("A1 S. ");
                }
            }
        }
        assertThatThrownBy(() -> MispelNachweis.empfaenger("Musterwerke GmbH"))
                .isInstanceOfSatisfying(MispelNachweisAbgelehnt.class, a ->
                        assertThat(a.code()).isEqualTo("empfaenger_unbekannt"));
    }

    // ------------------------------------------------------------------ Hilfen

    private static MispelNachweis.Empfaenger empfaenger(String e) {
        return MispelNachweis.empfaenger(e);
    }

    private static List<String> nrs(MispelNachweis.Monat m, String e) {
        return MispelNachweis.ergebnis(m, empfaenger(e)).stream().map(MispelNachweis.Wert::nr).toList();
    }

    private static JsonNode fall(String name) {
        try {
            for (JsonNode f : MAPPER.readTree(Files.readString(MispelAbgrenzungVectorsTest.VECTORS)).get("faelle")) {
                if (f.get("name").asText().equals(name)) {
                    return f;
                }
            }
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        throw new IllegalArgumentException(name);
    }

    /**
     * Je (Rumpf-)Monat des Falls ein gespeicherter Lauf in der Form von {@link MispelAbgrenzungService}: Nachweis-Text
     * mit Monatswerten, dem Jahresbeitrag dieses Laufs und Eingängen und Zwischenwerten je Viertelstunde.
     */
    private static List<Zeile> laeufe(JsonNode fall, Ergebnis e, String stand) {
        String fs = fall.get("formelsatz").asText();
        List<Viertelstunde> eingaenge = MispelAbgrenzungRechenwerkTest.viertelstunden(fall);
        List<Zeile> raus = new ArrayList<>();
        for (Map.Entry<String, Map<String, Bruch>> monat : e.monate().entrySet()) {
            String schluessel = monat.getKey();
            YearMonth ym = YearMonth.parse(schluessel.substring(0, 7));
            LocalDate von = schluessel.contains("/") ? ym.atDay(Integer.parseInt(schluessel.substring(8))) : ym.atDay(1);
            LocalDate bis = ym.plusMonths(1).atDay(1);
            for (String k : e.monate().keySet()) {
                if (k.contains("/") && k.startsWith(ym.toString()) && !k.equals(schluessel)) {
                    LocalDate anderer = ym.atDay(Integer.parseInt(k.substring(8)));
                    if (anderer.isAfter(von) && anderer.isBefore(bis)) {
                        bis = anderer;
                    }
                }
            }
            Instant a = von.atStartOfDay(MispelNachweis.ZONE).toInstant();
            Instant b = bis.atStartOfDay(MispelNachweis.ZONE).toInstant();
            Map<String, Object> n = new LinkedHashMap<>();
            n.put("festlegung", MispelNachweis.FESTLEGUNG);
            n.put("vertrag", MispelAbgrenzungService.VERTRAG);
            n.put("vertrag_version", MispelAbgrenzungService.VERTRAG_VERSION);
            n.put("rechenwerk_version", MispelAbgrenzungService.RECHENWERK_VERSION);
            n.put("anlage", ANLAGE.toString());
            n.put("monat", ym.toString());
            n.put("schluessel", schluessel);
            n.put("formelsatz", fs);
            n.put("stand", stand);
            n.put("stand_gruende", "endgueltig".equals(stand) ? List.of() : List.of("wertequelle_geraet"));
            n.put("wertequelle", "endgueltig".equals(stand) ? "messstellenbetreiber" : "geraet");
            Map<String, Object> z1 = new LinkedHashMap<>();
            z1.put("eingang", "Z1NB¼");
            z1.put("messstelle", "MS-01");
            z1.put("rolle", "Z1");
            z1.put("zaehlpunkt", "DE0001234567890000000000000000001");
            z1.put("messstellenbetreiber", "Netze Musterstadt GmbH");
            z1.put("eichstatus", "eichrechtskonform");
            z1.put("eichfrist_bis", "2034-12-31");
            z1.put("wertequelle", n.get("wertequelle"));
            z1.put("urteil", "tauglich");
            n.put("zaehler", List.of(z1));
            n.put("aw_regeln", new LinkedHashMap<>());
            List<Map<String, Object>> qh = new ArrayList<>();
            int erwartet = 0;
            for (int i = 0; i < eingaenge.size(); i++) {
                Viertelstunde q = eingaenge.get(i);
                if (q.beginn().toInstant().isBefore(a) || !q.beginn().toInstant().isBefore(b)) {
                    continue;
                }
                erwartet++;
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("beginn", q.beginn().toString());
                q.zaehler().forEach((k, w) -> r.put(k, w.stripTrailingZeros().toPlainString()));
                q.awGroesserNull().forEach((k, w) -> r.put(k + " > 0", w));
                e.viertelstunden().stream().filter(w -> w.beginn().equals(q.beginn())).findFirst()
                        .ifPresent(w -> w.werte().forEach((k, b2) -> r.put(k, b2.text())));
                qh.add(r);
            }
            Map<String, Object> zahl = new LinkedHashMap<>();
            zahl.put("erwartet", erwartet);
            zahl.put("gerechnet", erwartet);
            zahl.put("luecken", 0);
            zahl.put("luecken_je_eingang", new LinkedHashMap<>());
            n.put("viertelstunden", zahl);
            n.put("eingaenge_und_viertelstundenwerte", qh);
            Map<String, Object> monatswerte = new LinkedHashMap<>();
            monatswerte.put(schluessel, texte(monat.getValue()));
            n.put("monatswerte", monatswerte);
            Map<String, Object> jahreswerte = new LinkedHashMap<>();
            jahreswerte.put(String.valueOf(ym.getYear()), texte(MispelAbgrenzungRechenwerk.jahr(fs,
                    List.of(monat.getValue()))));
            n.put("jahreswerte_dieses_laufs", jahreswerte);
            String text;
            try {
                text = MAPPER.writeValueAsString(n);
            } catch (IOException ex) {
                throw new IllegalStateException(ex);
            }
            raus.add(new Zeile(UUID.nameUUIDFromBytes(schluessel.getBytes(StandardCharsets.UTF_8)), ANLAGE,
                    ym.atDay(1), a, b, 1, fs, stand, (String) n.get("wertequelle"), Math.max(erwartet, 1),
                    Math.max(erwartet, 1), MispelAbgrenzungService.RECHENWERK_VERSION,
                    MispelAbgrenzungService.VERTRAG_VERSION, text, MispelAbgrenzungService.sha256(text), GERECHNET));
        }
        return raus;
    }

    private static Map<String, String> texte(Map<String, Bruch> werte) {
        Map<String, String> raus = new LinkedHashMap<>();
        werte.forEach((nr, b) -> raus.put(nr, b == null ? null : b.text()));
        return raus;
    }

    private static Zeile umbenannt(Zeile z, Instant bis, Instant gerechnet, int fassung) {
        return new Zeile(UUID.randomUUID(), z.siteId(), z.monat(), z.zeitraumVon(), bis, fassung, z.formelsatz(),
                z.stand(), z.wertequelle(), z.viertelstundenErwartet(), z.viertelstundenGerechnet(),
                z.rechenwerkVersion(), z.vertragVersion(), z.nachweis(), z.pruefsumme(), gerechnet);
    }

    /** Der Kopf {@code # schlüssel=wert} (bei mehrfachem Schlüssel der erste). */
    static Map<String, String> kopf(byte[] datei) {
        Map<String, String> raus = new LinkedHashMap<>();
        for (String z : zeilen(datei)) {
            if (z.startsWith("# abschnitt=")) {
                break;
            }
            int gleich = z.indexOf('=');
            raus.putIfAbsent(z.substring(2, gleich), z.substring(gleich + 1));
        }
        return raus;
    }

    /** Die Abschnitte des CSV: je {@code # abschnitt=name} die Zeilen als Spalte → Zelle. */
    static Map<String, List<Map<String, String>>> csv(byte[] datei) {
        Map<String, List<Map<String, String>>> raus = new LinkedHashMap<>();
        List<String> spalten = null;
        List<Map<String, String>> zeilen = null;
        for (String z : zeilen(datei)) {
            if (z.startsWith("# abschnitt=")) {
                zeilen = new ArrayList<>();
                raus.put(z.substring("# abschnitt=".length()), zeilen);
                spalten = null;
            } else if (zeilen != null && spalten == null) {
                spalten = zellen(z);
            } else if (zeilen != null) {
                List<String> c = zellen(z);
                assertThat(c).as(z).hasSameSizeAs(spalten);
                Map<String, String> r = new LinkedHashMap<>();
                for (int i = 0; i < c.size(); i++) {
                    r.put(spalten.get(i), c.get(i));
                }
                zeilen.add(r);
            }
        }
        return raus;
    }

    private static List<String> zeilen(byte[] datei) {
        String s = new String(datei, StandardCharsets.UTF_8);
        assertThat(s).startsWith("﻿");
        assertThat(s.replace("\r\n", "")).doesNotContain("\n");
        return List.of(s.substring(1).split("\r\n"));
    }

    private static List<String> zellen(String zeile) {
        List<String> raus = new ArrayList<>();
        StringBuilder c = new StringBuilder();
        boolean zitat = false;
        for (int i = 0; i < zeile.length(); i++) {
            char ch = zeile.charAt(i);
            if (zitat) {
                if (ch == '"' && i + 1 < zeile.length() && zeile.charAt(i + 1) == '"') {
                    c.append('"');
                    i++;
                } else if (ch == '"') {
                    zitat = false;
                } else {
                    c.append(ch);
                }
            } else if (ch == '"') {
                zitat = true;
            } else if (ch == ';') {
                raus.add(c.toString());
                c.setLength(0);
            } else {
                c.append(ch);
            }
        }
        raus.add(c.toString());
        return raus;
    }

    static String pdfText(byte[] pdf) throws IOException {
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            return new PDFTextStripper().getText(doc).replaceAll("\\s+", " ");
        }
    }
}
