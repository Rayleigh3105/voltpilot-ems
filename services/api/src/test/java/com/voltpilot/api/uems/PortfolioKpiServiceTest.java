package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.voltpilot.api.uems.PortfolioKpiService.AnlageKpiRoh;
import com.voltpilot.api.web.dto.BilanzDto;
import com.voltpilot.api.web.dto.PortfolioKpiDto;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Die REINE Aggregation der Portfolio-Kennzahlen ({@link PortfolioKpiService#aggregiere}
 * und {@link PortfolioKpiService#netzbezugAus}) - ohne Datenbank. Prüft die Summen,
 * die Kosten (Menge × Arbeitspreis), die Lastspitzen-Auswahl samt Zeitpunkt und
 * Abrechnungszeitraum, die Datenlage und vor allem die Ehrlichkeit „Fehlend ist keine
 * Null" (fehlende Quelle → null, nie 0). Die echten DB-Lesungen deckt die E2E-Abnahme ab.
 */
class PortfolioKpiServiceTest {

    private static final PortfolioKpiDto.Periode SEPTEMBER = new PortfolioKpiDto.Periode(
            LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"), 2026, 9);
    private static final Instant SPITZE_AM = Instant.parse("2026-10-05T18:15:00Z");

    @Test
    void aggregiertVerbrauchKostenUndLastspitzeUeberAnlagen() {
        AnlageKpiRoh halle1 = new AnlageKpiRoh("Werk Ahrenberg – Halle 1",
                bd(199_500), true, bd(207_000), bd("22.4"), bd(412), bd(550), SPITZE_AM, "2026");
        AnlageKpiRoh halle2 = new AnlageKpiRoh("Werk Ahrenberg – Halle 2",
                bd(36_900), true, bd(35_000), bd("23.1"), bd(120), bd(200), SPITZE_AM, "2026");

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(halle1, halle2), null, null);

        // Verbrauch = Σ Netzbezug (dieser Monat / Vorjahr)
        assertThat(dto.verbrauch().kwh()).isEqualByComparingTo("236400");
        assertThat(dto.verbrauch().kwhVorjahr()).isEqualByComparingTo("242000");
        assertThat(dto.verbrauch().vollstaendig()).isTrue();

        // Kosten = Σ(Netzbezug × Arbeitspreis): 199500·0,224 + 36900·0,231 = 53211,9 → 53212 €
        assertThat(dto.kosten().eur()).isEqualByComparingTo("53212");
        assertThat(dto.kosten().eurVorjahr()).isEqualByComparingTo("54453"); // 207000·0,224 + 35000·0,231
        assertThat(dto.kosten().tarifHinterlegt()).isTrue();

        // Lastspitze = die höchste gemessene Spitze samt vereinbarter Leistung, Zeitpunkt und Abrechnungszeitraum IHRER Anlage
        assertThat(dto.lastspitze().kw()).isEqualByComparingTo("412.0");
        assertThat(dto.lastspitze().vereinbartKw()).isEqualByComparingTo("550");
        assertThat(dto.lastspitze().anteilProzent()).isEqualTo(75); // 412/550 = 74,9 → 75
        assertThat(dto.lastspitze().anlage()).isEqualTo("Werk Ahrenberg – Halle 1");
        assertThat(dto.lastspitze().zeitpunkt()).isEqualTo("2026-10-05T18:15:00Z");
        assertThat(dto.lastspitze().zeitraum()).isEqualTo("2026");

        assertThat(dto.periode().jahr()).isEqualTo(2026);
        assertThat(dto.periode().monat()).isEqualTo(9);
    }

    @Test
    void fehlendIstKeineNull() {
        AnlageKpiRoh leer = new AnlageKpiRoh("Werk Lindach", null, true, null, null, null, null, null, null);

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(leer), null, null);

        assertThat(dto.verbrauch().kwh()).isNull();
        assertThat(dto.verbrauch().kwhVorjahr()).isNull();
        assertThat(dto.kosten().eur()).isNull();
        assertThat(dto.kosten().eurVorjahr()).isNull();
        assertThat(dto.kosten().tarifHinterlegt()).isFalse();
        assertThat(dto.lastspitze().kw()).isNull();
        assertThat(dto.lastspitze().vereinbartKw()).isNull();
        assertThat(dto.lastspitze().anteilProzent()).isNull();
        assertThat(dto.lastspitze().anlage()).isNull();
        assertThat(dto.lastspitze().zeitpunkt()).isNull();
        assertThat(dto.lastspitze().zeitraum()).isNull();
        assertThat(dto.datenlage()).isNull();
        assertThat(dto.leit()).isNull();
    }

    @Test
    void verbrauchOhneTarifTraegtKeineKosten() {
        // Anlage mit Netzbezug, aber tarif_art='ohne' (kein Arbeitspreis): Verbrauch zählt, Kosten bleibt leer.
        AnlageKpiRoh ohneTarif = new AnlageKpiRoh("Werk Ahrenberg – Halle 1",
                bd(199_500), true, bd(207_000), null, null, null, null, null);

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(ohneTarif), null, null);

        assertThat(dto.verbrauch().kwh()).isEqualByComparingTo("199500");
        assertThat(dto.kosten().eur()).isNull();
        assertThat(dto.kosten().tarifHinterlegt()).isFalse();
    }

    @Test
    void lastspitzeNimmtDieHoechsteSpitzeUndDerenVereinbarung() {
        AnlageKpiRoh a = new AnlageKpiRoh("A", bd(100), true, null, null, bd(100), bd(500), SPITZE_AM, "2026");
        AnlageKpiRoh b = new AnlageKpiRoh("B", bd(100), true, null, null, bd(300), bd(400),
                Instant.parse("2026-07-01T10:00:00Z"), "2026"); // höhere Spitze

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(a, b), null, null);

        assertThat(dto.lastspitze().kw()).isEqualByComparingTo("300.0");
        assertThat(dto.lastspitze().vereinbartKw()).isEqualByComparingTo("400");
        assertThat(dto.lastspitze().anteilProzent()).isEqualTo(75); // 300/400
        assertThat(dto.lastspitze().anlage()).isEqualTo("B");
        assertThat(dto.lastspitze().zeitpunkt()).isEqualTo("2026-07-01T10:00:00Z"); // der Zeitpunkt DIESER Spitze
    }

    @Test
    void teilmonatMachtDenVerbrauchUnvollstaendig() {
        AnlageKpiRoh teil = new AnlageKpiRoh("A", bd(100), false, null, null, null, null, null, null);
        assertThat(PortfolioKpiService.aggregiere(SEPTEMBER, List.of(teil), null, null).verbrauch().vollstaendig())
                .isFalse();
    }

    @Test
    void datenlageReichtDurch() {
        PortfolioKpiDto.Datenlage datenlage = new PortfolioKpiDto.Datenlage(10, 10);
        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(), datenlage, null);
        assertThat(dto.datenlage()).isEqualTo(datenlage);
        assertThat(dto.datenlage().aktuell()).isEqualTo(10);
        assertThat(dto.datenlage().gesamt()).isEqualTo(10);
    }

    @Test
    void reichtDieLeitkennzahlDurch() {
        PortfolioKpiDto.Leitkennzahl leit = new PortfolioKpiDto.Leitkennzahl("KZ-0004",
                "Stromeinsatz Spritzguss je kg", bd("0.2837"), "kWh/kg", 2026, 9, "vollständig",
                bd("5"), "2028-01/2028-12", "5 % unter Bezugsbasis", bd("-3.4"), "besser");

        PortfolioKpiDto dto = PortfolioKpiService.aggregiere(SEPTEMBER, List.of(), null, leit);

        assertThat(dto.leit()).isEqualTo(leit);
    }

    @Test
    void netzbezugSummiertZuflussMengen() {
        BilanzDto.Bilanz b = bilanzMit(summe(bd(199_500), "vollständig", 100));
        PortfolioKpiService.Netzbezug nb = PortfolioKpiService.netzbezugAus(b);
        assertThat(nb.kwh()).isEqualByComparingTo("199500");
        assertThat(nb.vollstaendig()).isTrue();
    }

    @Test
    void netzbezugOhneGemesseneMengeIstNull() {
        BilanzDto.Bilanz b = bilanzMit(summe(null, "keine_werte", null));
        assertThat(PortfolioKpiService.netzbezugAus(b).kwh()).isNull();
    }

    @Test
    void netzbezugUnterAbdeckungIstUnvollstaendig() {
        BilanzDto.Bilanz b = bilanzMit(summe(bd(90_000), "unvollständig", 60));
        PortfolioKpiService.Netzbezug nb = PortfolioKpiService.netzbezugAus(b);
        assertThat(nb.kwh()).isEqualByComparingTo("90000");
        assertThat(nb.vollstaendig()).isFalse();
    }

    // ------------------------------------------------------------------ Fensterwahl (rein, Review R2)

    @Test
    void fensterwahlGemischtBrauchtBeideFensterMitBerlinGrenzen() {
        LocalDate heute = LocalDate.parse("2026-10-05");
        PortfolioKpiService.Fenster f = PortfolioKpiService.fenster(List.of("monat", "jahr"), heute);
        assertThat(f.brauchtMonat()).isTrue();
        assertThat(f.brauchtJahr()).isTrue();
        // 01.01.2026 00:00 Berlin = CET (UTC+1) → 31.12.2025 23:00 UTC
        assertThat(f.jahrVon()).isEqualTo(Instant.parse("2025-12-31T23:00:00Z"));
        // 01.10.2026 00:00 Berlin = CEST (UTC+2, DST bis 25.10.) → 30.09.2026 22:00 UTC
        assertThat(f.monatVon()).isEqualTo(Instant.parse("2026-09-30T22:00:00Z"));
        assertThat(f.jahrLabel()).isEqualTo("2026");
        assertThat(f.monatLabel()).isEqualTo("Oktober 2026");
    }

    @Test
    void fensterwahlNurJahrLaesstDasMonatsfensterWeg() {
        PortfolioKpiService.Fenster f = PortfolioKpiService.fenster(List.of("jahr", "jahr"), LocalDate.parse("2026-10-05"));
        assertThat(f.brauchtJahr()).isTrue();
        assertThat(f.brauchtMonat()).isFalse();
    }

    @Test
    void fensterwahlNurMonatLaesstDasJahresfensterWeg() {
        PortfolioKpiService.Fenster f = PortfolioKpiService.fenster(List.of("monat"), LocalDate.parse("2026-10-05"));
        assertThat(f.brauchtMonat()).isTrue();
        assertThat(f.brauchtJahr()).isFalse();
    }

    @Test
    void fensterwahlNullAbrechnungZaehltAlsJahr() {
        // abrechnungLeistung == null → Jahresfenster (wie die Produktion), nie „monat".
        List<String> mitNull = new java.util.ArrayList<>();
        mitNull.add(null);
        PortfolioKpiService.Fenster f = PortfolioKpiService.fenster(mitNull, LocalDate.parse("2026-10-05"));
        assertThat(f.brauchtJahr()).isTrue();
        assertThat(f.brauchtMonat()).isFalse();
    }

    @Test
    void fensterwahlOhneAnlageBrauchtKeinFenster() {
        PortfolioKpiService.Fenster f = PortfolioKpiService.fenster(List.of(), LocalDate.parse("2026-10-05"));
        assertThat(f.brauchtJahr()).isFalse();
        assertThat(f.brauchtMonat()).isFalse();
    }

    // ------------------------------------------------------------------ Trend (rein, Review R2)

    @Test
    void trendProzentRechnetGegenDenVormonat() {
        // (0,2837 − 0,30) ÷ 0,30 × 100 = −5,43… → 1 Stelle −5,4
        assertThat(PortfolioKpiService.trendProzent(bd("0.2837"), bd("0.30"))).isEqualByComparingTo("-5.4");
        // Anstieg: (0,33 − 0,30) ÷ 0,30 × 100 = +10,0
        assertThat(PortfolioKpiService.trendProzent(bd("0.33"), bd("0.30"))).isEqualByComparingTo("10.0");
    }

    @Test
    void trendProzentOhneTauglichenVormonatIstNull() {
        assertThat(PortfolioKpiService.trendProzent(bd("0.30"), null)).isNull();
        assertThat(PortfolioKpiService.trendProzent(null, bd("0.30"))).isNull();
        // Vormonat 0 → keine Division, kein irreführender Pfeil.
        assertThat(PortfolioKpiService.trendProzent(bd("0.30"), bd("0"))).isNull();
    }

    // ------------------------------------------------------------------ Helfer

    private static BigDecimal bd(Object o) {
        return new BigDecimal(o.toString());
    }

    private static BilanzDto.Summe summe(BigDecimal menge, String zustand, Integer abdeckung) {
        return new BilanzDto.Summe(menge, zustand, abdeckung, menge == null ? 0 : 1, 1, List.of(), List.of(), null);
    }

    private static BilanzDto.Bilanz bilanzMit(BilanzDto.Summe zufluss) {
        BilanzDto.Werte werte = new BilanzDto.Werte(LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"),
                zufluss, null, null, null, List.of());
        BilanzDto.Abschnitt abschnitt = new BilanzDto.Abschnitt(LocalDate.parse("2026-09-01"),
                LocalDate.parse("2026-09-30"), "monat", List.of(), List.of(), List.of(werte));
        BilanzDto.Hauptzaehler hz = new BilanzDto.Hauptzaehler(null, null, null, false, List.of(abschnitt), null);
        return new BilanzDto.Bilanz(null, "monat", LocalDate.parse("2026-09-15"),
                LocalDate.parse("2026-09-01"), LocalDate.parse("2026-09-30"), "Europe/Berlin", List.of(hz));
    }
}
