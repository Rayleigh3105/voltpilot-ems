package com.voltpilot.api.repo;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Steuerung MIT BESTAND ({@link SteuerungMitBestand}) gegen
 * {@code docs/contracts/steuerung-tag-vectors.json}, Block {@code mit_bestand}
 * (Bedienkonzept vp-herzogau-p3-kachel-konzept §4.3, Captain 14.10.2026): die
 * Schwellen stehen in der Datei, jeder Tag aller Fälle ergibt seine Zahl und
 * seine Gründe, jeder Zeitpunkt seinen Monat, seine 7 Tage und seinen Tag. Der
 * Oktober der Anlage Herzogau trägt die Zahlen aus Abschnitt 5 des Konzepts -
 * am 13.10. um 08:15 + 0,01 € statt − 8,00 €. Rein, ohne Docker; den echten
 * Walk über dieselben Fälle prüft {@code SteuerungTageszahlTest}.
 */
class SteuerungMitBestandTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Path VECTORS =
            Path.of("..", "..", "docs", "contracts", "steuerung-tag-vectors.json");
    private static final List<String> FAELLE =
            List.of("oktober", "monatsgrenze", "sommerzeit", "luecke");

    private static JsonNode block() throws Exception {
        return MAPPER.readTree(Files.readString(VECTORS)).path("mit_bestand");
    }

    @Test
    void dieSchwellenSindDieDerGrundListe() throws Exception {
        JsonNode g = block().path("grund");
        assertThat(g.path("gestern_verkauft_ab_kwh").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.GESTERN_VERKAUFT_AB_KWH);
        assertThat(g.path("wenig_sonne_unter_anteil").decimalValue())
                .isEqualByComparingTo(SteuerungGrund.WENIG_SONNE_UNTER_ANTEIL);
        assertThat(g.path("hoechstens").asInt()).isEqualTo(SteuerungGrund.HOECHSTENS);
    }

    @Test
    void bewertungIstBezugspreisMalWurzelAusNullKommaNeunZwei() throws Exception {
        JsonNode faelle = block().path("bewertung");
        assertThat(faelle).isNotEmpty();
        for (JsonNode f : faelle) {
            assertThat(SteuerungMitBestand.bewertungCtKwh(f.path("bezug_ct_kwh").decimalValue()))
                    .as("Bezug %s ct", f.path("bezug_ct_kwh").asText())
                    .isEqualByComparingTo(f.path("bewertung_ct_kwh").decimalValue());
        }
        assertThat(SteuerungMitBestand.bewertungCtKwh(null)).isNull();
    }

    @Test
    void jederTagErgibtSeineZahlUndSeineGruende() throws Exception {
        for (String fall : FAELLE) {
            JsonNode tage = block().path(fall).path("tage");
            assertThat(tage).as(fall).isNotEmpty();
            for (JsonNode t : tage) {
                SteuerungMitBestand.Bewertet b = SteuerungMitBestand.bewerte(tag(t));
                JsonNode e = t.path("erwartet");
                String was = fall + " " + t.path("tag").asText();
                assertDec(b.bewertungCtKwh(), e.path("bewertung_ct_kwh"), was + " Bewertung");
                assertDec(b.bestandEur(), e.path("bestand_eur"), was + " Bestand");
                assertDec(b.mitBestandEur(), e.path("mit_bestand_eur"), was + " mit Bestand");
                assertThat(b.gruende()).as(was + " Gründe").containsExactlyElementsOf(texte(e.path("gruende")));
                if (b.mitBestandEur() != null) {
                    // Der Rechenweg rechnet sichtbar nach: Kasse + Bestand = Tag, auf den Cent.
                    assertThat(b.steuerungEur().add(b.bestandEur()))
                            .as(was).isEqualByComparingTo(b.mitBestandEur());
                }
            }
        }
    }

    @Test
    void jederZeitpunktErgibtMonatSiebenTageUndTag() throws Exception {
        for (String fall : FAELLE) {
            JsonNode zeitpunkte = block().path(fall).path("zeitpunkte");
            assertThat(zeitpunkte).as(fall).isNotEmpty();
            for (JsonNode z : zeitpunkte) {
                SteuerungMitBestand.Zeitraum r = zeitraum(block().path(fall), z);
                pruefe(fall + " / " + z.path("name").asText(), r, z.path("erwartet"));
            }
        }
    }

    /**
     * Abschnitt 6 des Konzepts: am 13.10. um 08:15 steht + 0,01 € statt
     * − 8,00 €, der Monat + 25,86 €, die 7 Tage 6.–12.10. + 9,45 €; am 14.10.
     * stehen die 7 Tage 7.–13.10. ehrlich bei − 0,29 € neben + 23,53 €.
     */
    @Test
    void oktoberHerzogauDieZahlenDesKonzepts() throws Exception {
        JsonNode okt = block().path("oktober");
        SteuerungMitBestand.Zeitraum frueh = zeitraum(okt, zeitpunkt(okt, "2026-10-13", true));
        assertThat(frueh.heute().steuerungEur()).isEqualByComparingTo("-8.00");
        assertThat(frueh.heute().mitBestandEur()).isEqualByComparingTo("0.01");
        assertThat(frueh.heute().gruende()).containsExactly(SteuerungGrund.GESTERN_VERKAUFT);
        assertThat(frueh.monat().mitBestandEur()).isEqualByComparingTo("25.86");
        assertThat(frueh.sieben().von()).isEqualTo(LocalDate.parse("2026-10-06"));
        assertThat(frueh.sieben().mitBestandEur()).isEqualByComparingTo("9.45");
        assertThat(frueh.bewertungCtKwh()).isEqualByComparingTo("23.98");

        SteuerungMitBestand.Zeitraum danach = zeitraum(okt, zeitpunkt(okt, "2026-10-14", true));
        assertThat(danach.heute()).isNull();
        assertThat(danach.sieben().von()).isEqualTo(LocalDate.parse("2026-10-07"));
        assertThat(danach.sieben().bis()).isEqualTo(LocalDate.parse("2026-10-13"));
        assertThat(danach.sieben().mitBestandEur()).isEqualByComparingTo("-0.29");
        assertThat(danach.monat().mitBestandEur()).isEqualByComparingTo("23.53");
        assertThat(danach.tage()).hasSize(7);
        assertThat(danach.tage().get(0).tag()).isEqualTo(LocalDate.parse("2026-10-13"));
        assertThat(danach.tage().get(0).mitBestandEur()).isEqualByComparingTo("-2.32");
        assertThat(danach.tage().get(1).mitBestandEur()).isEqualByComparingTo("1.70");

        // 6 Minus-Tage als Kalendertag, 4 mit Bestand; der Monat nie unter null.
        int minusKasse = 0;
        int minusBestand = 0;
        BigDecimal monat = BigDecimal.ZERO;
        for (JsonNode t : okt.path("tage")) {
            SteuerungMitBestand.Bewertet b = SteuerungMitBestand.bewerte(tag(t));
            minusKasse += b.steuerungEur().signum() < 0 ? 1 : 0;
            minusBestand += b.mitBestandEur().signum() < 0 ? 1 : 0;
            monat = monat.add(b.mitBestandEur());
            assertThat(monat.signum()).as("Monat bis %s", b.tag()).isPositive();
        }
        assertThat(minusKasse).isEqualTo(okt.path("minus_tage").path("kalendertag").asInt())
                .isEqualTo(6);
        assertThat(minusBestand).isEqualTo(okt.path("minus_tage").path("mit_bestand").asInt())
                .isEqualTo(4);
    }

    /**
     * Eigenschaft (Konzept §6): Σ Tage mit Bestand = Monat mit Bestand = Monat
     * ohne Bestand + Vorsprung jetzt × Bewertung - die letzte Gleichung bis auf
     * die Rundung je Tag (höchstens ein halber Cent für Kasse und Bestand).
     */
    @Test
    void summeDerTageIstDerMonatUndDieKasseMitDemVorsprungJetzt() throws Exception {
        JsonNode okt = block().path("oktober");
        List<SteuerungMitBestand.Bewertet> tage = new ArrayList<>();
        BigDecimal kasse = BigDecimal.ZERO;
        for (JsonNode t : okt.path("tage")) {
            SteuerungMitBestand.Bewertet b = SteuerungMitBestand.bewerte(tag(t));
            tage.add(b);
            kasse = kasse.add(t.path("steuerung_eur").decimalValue());
            BigDecimal summe = tage.stream().map(SteuerungMitBestand.Bewertet::mitBestandEur)
                    .reduce(BigDecimal.ZERO, BigDecimal::add);
            SteuerungMitBestand.Fenster monat = SteuerungMitBestand.fenster(tage,
                    b.tag().withDayOfMonth(1), b.tag());
            assertThat(monat.mitBestandEur()).as("bis %s", b.tag()).isEqualByComparingTo(summe);
            BigDecimal ueberVorsprung = kasse.add(b.vorsprungEndeKwh()
                    .multiply(b.bewertungCtKwh()).movePointLeft(2));
            assertThat(summe.subtract(ueberVorsprung).abs())
                    .as("bis %s", b.tag())
                    .isLessThanOrEqualTo(new BigDecimal("0.01").multiply(BigDecimal.valueOf(tage.size())));
        }
    }

    @Test
    void siebenTageSindKalendertage() {
        LocalDate d = LocalDate.parse("2026-11-01");
        assertThat(SteuerungMitBestand.siebenTage(d, true).von()).isEqualTo(LocalDate.parse("2026-10-25"));
        assertThat(SteuerungMitBestand.siebenTage(d, true).bis()).isEqualTo(LocalDate.parse("2026-10-31"));
        assertThat(SteuerungMitBestand.siebenTage(d, false).von()).isEqualTo(LocalDate.parse("2026-10-26"));
        assertThat(SteuerungMitBestand.siebenTage(d, false).bis()).isEqualTo(d);
    }

    @Test
    void einFensterOhneGemessenenTagIstLeerNichtNull() {
        assertThat(SteuerungMitBestand.fenster(List.of(), LocalDate.parse("2026-10-01"),
                LocalDate.parse("2026-10-07")).mitBestandEur()).isNull();
    }

    // ---------------------------------------------------------------- Hilfen

    static SteuerungMitBestand.Tag tag(JsonNode t) {
        return new SteuerungMitBestand.Tag(LocalDate.parse(t.path("tag").asText()),
                dec(t, "steuerung_eur"), dec(t, "vorsprung_start_kwh"), dec(t, "vorsprung_ende_kwh"),
                dec(t, "bezug_ct_kwh"), dec(t, "pv_kwh"), dec(t, "load_kwh"), null);
    }

    /** Der Zeitraum eines Zeitpunkts aus den Tagen des Falls (ein eigener Teil-Tag ersetzt den Tag). */
    static SteuerungMitBestand.Zeitraum zeitraum(JsonNode fall, JsonNode z) {
        Map<LocalDate, SteuerungMitBestand.Bewertet> tage = new HashMap<>();
        for (JsonNode t : fall.path("tage")) {
            SteuerungMitBestand.Bewertet b = SteuerungMitBestand.bewerte(tag(t));
            tage.put(b.tag(), b);
        }
        if (z.has("heute")) {
            SteuerungMitBestand.Bewertet h = SteuerungMitBestand.bewerte(tag(z.path("heute")));
            tage.put(h.tag(), h);
        }
        return SteuerungMitBestand.zeitraum(tage, LocalDate.parse(z.path("angefragt").asText()),
                z.path("laeuft").asBoolean(), true);
    }

    static JsonNode zeitpunkt(JsonNode fall, String angefragt, boolean laeuft) {
        for (JsonNode z : fall.path("zeitpunkte")) {
            if (z.path("angefragt").asText().equals(angefragt) && z.path("laeuft").asBoolean() == laeuft) {
                return z;
            }
        }
        throw new AssertionError("kein Zeitpunkt " + angefragt + " laeuft=" + laeuft);
    }

    /** Heute, Monat, 7 Tage und die Reihenfolge der Tage eines Zeitpunkts. */
    static void pruefe(String was, SteuerungMitBestand.Zeitraum r, JsonNode e) {
        JsonNode heute = e.path("heute");
        if (heute.isNull()) {
            assertThat(r.heute()).as(was + " heute").isNull();
        } else {
            assertThat(r.heute()).as(was + " heute").isNotNull();
            assertThat(r.heute().tag()).as(was).isEqualTo(LocalDate.parse(heute.path("tag").asText()));
            assertDec(r.heute().mitBestandEur(), heute.path("mit_bestand_eur"), was + " heute");
            assertThat(r.heute().gruende()).as(was + " heute Gründe")
                    .containsExactlyElementsOf(texte(heute.path("gruende")));
        }
        fenster(was + " monat", r.monat(), e.path("monat"));
        fenster(was + " sieben", r.sieben(), e.path("sieben"));
        assertThat(r.tage().stream().map(t -> t.tag().toString()).toList())
                .as(was + " tage").containsExactlyElementsOf(texte(e.path("tage")));
    }

    private static void fenster(String was, SteuerungMitBestand.Fenster f, JsonNode e) {
        assertThat(f.von()).as(was + " von").isEqualTo(LocalDate.parse(e.path("von").asText()));
        assertThat(f.bis()).as(was + " bis").isEqualTo(LocalDate.parse(e.path("bis").asText()));
        assertDec(f.mitBestandEur(), e.path("mit_bestand_eur"), was);
    }

    static void assertDec(BigDecimal ist, JsonNode soll, String was) {
        if (soll.isNull() || soll.isMissingNode()) {
            assertThat(ist).as(was).isNull();
        } else {
            assertThat(ist).as(was).isNotNull();
            assertThat(ist).as(was).isEqualByComparingTo(soll.decimalValue());
        }
    }

    static List<String> texte(JsonNode liste) {
        List<String> out = new ArrayList<>();
        liste.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static BigDecimal dec(JsonNode n, String feld) {
        JsonNode v = n.path(feld);
        return v.isNull() || v.isMissingNode() ? null : v.decimalValue();
    }
}
